import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import {
  fetchCurrentPrice,
  fetch24hStats,
  fetchCandles,
} from "./engine/marketData";
import { computeAllMetrics, type CandleData } from "./engine/technicalAnalysis";
import { generateSignal } from "./engine/signalGenerator";
import { walkForwardOptimize } from "./engine/walkForwardOptimizer";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParameters } from "../shared/tradingTypes";
import * as db from "./db";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Market Data ────────────────────────────────────────────────────
  market: router({
    currentPrice: publicProcedure.query(async () => {
      return fetchCurrentPrice();
    }),
    stats24h: publicProcedure.query(async () => {
      return fetch24hStats();
    }),
    candles: publicProcedure
      .input(z.object({
        interval: z.string().default("1h"),
        limit: z.number().min(1).max(1000).default(200),
      }).optional())
      .query(async ({ input }) => {
        return fetchCandles(input?.interval ?? "1h", input?.limit ?? 200);
      }),
  }),

  // ─── Metrics ────────────────────────────────────────────────────────
  metrics: router({
    current: publicProcedure
      .input(z.object({ interval: z.string().default("1h") }).optional())
      .query(async ({ input }) => {
        const candles = await fetchCandles(input?.interval ?? "1h", 250);
        const candleData: CandleData[] = candles.map((c) => ({
          open: c.open, high: c.high, low: c.low,
          close: c.close, volume: c.volume, openTime: c.openTime,
        }));
        const activeParams = await db.getActiveStrategyParams();
        const params = activeParams
          ? (activeParams.params as StrategyParameters)
          : DEFAULT_STRATEGY_PARAMS;
        return computeAllMetrics(candleData, params.zScoreTrendThreshold, params.zScoreBlipThreshold);
      }),
    history: publicProcedure
      .input(z.object({ limit: z.number().default(100) }).optional())
      .query(async ({ input }) => db.getRecentMetrics(input?.limit ?? 100)),
  }),

  // ─── Signals ────────────────────────────────────────────────────────
  signals: router({
    generate: publicProcedure.mutation(async () => {
      const candles = await fetchCandles("1h", 250);
      const candleData: CandleData[] = candles.map((c) => ({
        open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume, openTime: c.openTime,
      }));
      const activeParams = await db.getActiveStrategyParams();
      const params = activeParams
        ? (activeParams.params as StrategyParameters)
        : DEFAULT_STRATEGY_PARAMS;
      const metrics = computeAllMetrics(candleData, params.zScoreTrendThreshold, params.zScoreBlipThreshold);
      const signal = generateSignal(metrics, params);
      const ts = Date.now();

      await db.insertMetricSnapshot({ ts, ...metrics });
      const simState = await db.getSimulatorState();
      const signalId = await db.insertSignal({
        ts, signal: signal.signal, price: metrics.price,
        confidence: signal.confidence, reasoning: signal.reasoning,
        metricsSnapshot: metrics,
        portfolioValue: simState?.totalValueUsd,
      });

      if (signal.signal !== "hold") {
        await executeSimulatorTrade(signal.signal, metrics.price, signal.reasoning, signalId ?? undefined);
        const updatedSimState = await db.getSimulatorState();
        try {
          await notifyOwner({
            title: `BTC ${signal.signal.toUpperCase()} Signal @ $${metrics.price.toFixed(0)}`,
            content: `Signal: ${signal.signal.toUpperCase()}\nPrice: $${metrics.price.toFixed(2)}\nConfidence: ${(signal.confidence * 100).toFixed(0)}%\nPortfolio Value: $${updatedSimState?.totalValueUsd?.toFixed(2) ?? "N/A"}\n\nReasoning:\n${signal.reasoning}`,
          });
        } catch (e) { console.warn("[Notification] Failed:", e); }
        try {
          await sendTelegramNotification(signal.signal, metrics.price, signal.reasoning, updatedSimState?.totalValueUsd ?? 0);
        } catch (e) { console.warn("[Telegram] Failed:", e); }
      }

      return { signal: signal.signal, confidence: signal.confidence, reasoning: signal.reasoning, price: metrics.price, ts };
    }),

    list: publicProcedure
      .input(z.object({ limit: z.number().default(50) }).optional())
      .query(async ({ input }) => db.getRecentSignals(input?.limit ?? 50)),

    validate: publicProcedure.mutation(async () => {
      const pending = await db.getPendingSignals();
      const { price: currentPrice } = await fetchCurrentPrice();
      let validated = 0;
      for (const sig of pending) {
        if (Date.now() - sig.ts < 60 * 60 * 1000) continue;
        const isWin = (sig.signal === "buy" && currentPrice > sig.price) || (sig.signal === "sell" && currentPrice < sig.price);
        await db.updateSignalOutcome(sig.id, isWin ? "win" : "loss", currentPrice, Date.now());
        validated++;
      }
      if (validated > 0) {
        const allSignals = await db.getRecentSignals(200);
        const resolved = allSignals.filter((s) => s.outcome !== "pending" && s.signal !== "hold" && s.outcomePrice);
        const wins = resolved.filter((s) => s.outcome === "win").length;
        const winRate = resolved.length > 0 ? wins / resolved.length : 0;
        const signalReturns = resolved.map((s) => {
          return s.signal === "buy" ? ((s.outcomePrice! - s.price) / s.price) : ((s.price - s.outcomePrice!) / s.price);
        });
        const avgReturn = signalReturns.length > 0 ? signalReturns.reduce((a, b) => a + b, 0) / signalReturns.length : 0;
        let sharpeRatio: number | undefined;
        if (signalReturns.length >= 2) {
          const variance = signalReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / signalReturns.length;
          const stdDev = Math.sqrt(variance);
          sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0;
        }
        let maxDrawdown: number | undefined;
        if (signalReturns.length > 0) {
          let cumReturn = 1, peak = 1, dd = 0;
          for (const r of signalReturns) {
            cumReturn *= (1 + r);
            if (cumReturn > peak) peak = cumReturn;
            const currentDd = (peak - cumReturn) / peak;
            if (currentDd > dd) dd = currentDd;
          }
          maxDrawdown = dd;
        }
        const activeParams = await db.getActiveStrategyParams();
        await db.insertValidationEntry({
          periodStart: Date.now() - 24 * 60 * 60 * 1000, periodEnd: Date.now(),
          totalSignals: resolved.length, correctSignals: wins, winRate,
          sharpeRatio, maxDrawdown, avgReturn, paramVersionUsed: activeParams?.version,
          notes: `Manual validation: ${validated} signals evaluated`,
        });
      }
      return { validated };
    }),
  }),

  // ─── Simulator ──────────────────────────────────────────────────────
  simulator: router({
    state: publicProcedure.query(async () => {
      let state = await db.getSimulatorState();
      if (!state) state = (await db.initSimulatorState()) ?? null;
      if (state && state.btcHolding > 0) {
        try {
          const { price } = await fetchCurrentPrice();
          const totalValue = state.cashUsd + state.btcHolding * price;
          await db.updateSimulatorState({ totalValueUsd: totalValue, lastPrice: price });
          return { ...state, totalValueUsd: totalValue, lastPrice: price };
        } catch { return state; }
      }
      return state;
    }),
    trades: publicProcedure
      .input(z.object({ limit: z.number().default(50) }).optional())
      .query(async ({ input }) => db.getRecentTrades(input?.limit ?? 50)),
    reset: publicProcedure.mutation(async () => {
      await db.resetSimulator();
      return { success: true };
    }),
    toggleRunning: publicProcedure.mutation(async () => {
      const state = await db.getSimulatorState();
      if (!state) return { isRunning: false };
      await db.updateSimulatorState({ isRunning: !state.isRunning });
      return { isRunning: !state.isRunning };
    }),
  }),

  // ─── Performance ────────────────────────────────────────────────────
  performance: router({
    weekly: publicProcedure
      .input(z.object({ limit: z.number().default(52) }).optional())
      .query(async ({ input }) => db.getWeeklyPerformance(input?.limit ?? 52)),
    validation: publicProcedure
      .input(z.object({ limit: z.number().default(20) }).optional())
      .query(async ({ input }) => db.getValidationHistory(input?.limit ?? 20)),
    summary: publicProcedure.query(async () => {
      const state = await db.getSimulatorState();
      const signals = await db.getRecentSignals(1000);
      const trades = await db.getRecentTrades(1000);
      const weekly = await db.getWeeklyPerformance(52);
      const resolvedSignals = signals.filter((s) => s.outcome !== "pending");
      const wins = resolvedSignals.filter((s) => s.outcome === "win").length;
      const winRate = resolvedSignals.length > 0 ? wins / resolvedSignals.length : 0;
      const totalReturn = state ? ((state.totalValueUsd - state.seedAmountUsd) / state.seedAmountUsd) * 100 : 0;

      // Compute Sharpe ratio from weekly returns
      const weeklyReturns = weekly.map((w) => w.returnPct);
      let sharpeRatio = 0;
      if (weeklyReturns.length >= 2) {
        const avgReturn = weeklyReturns.reduce((a, b) => a + b, 0) / weeklyReturns.length;
        const variance = weeklyReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / weeklyReturns.length;
        const stdDev = Math.sqrt(variance);
        sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0; // annualized
      }

      // Compute max drawdown from trade history
      let maxDrawdown = 0;
      if (trades.length > 0) {
        let peak = trades[trades.length - 1]?.totalValueAfter ?? 10000;
        for (let i = trades.length - 1; i >= 0; i--) {
          const val = trades[i].totalValueAfter;
          if (val > peak) peak = val;
          const dd = (peak - val) / peak;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }

      return {
        portfolioValue: state?.totalValueUsd ?? 10000,
        seedAmount: state?.seedAmountUsd ?? 10000,
        totalReturn,
        totalSignals: signals.length,
        buySignals: signals.filter((s) => s.signal === "buy").length,
        sellSignals: signals.filter((s) => s.signal === "sell").length,
        winRate,
        totalTrades: trades.length,
        weeklyReports: weekly.length,
        sharpeRatio,
        maxDrawdown: maxDrawdown * 100,
      };
    }),
  }),

  // ─── Strategy ───────────────────────────────────────────────────────
  strategy: router({
    active: publicProcedure.query(async () => {
      const active = await db.getActiveStrategyParams();
      if (!active) return { version: 0, params: DEFAULT_STRATEGY_PARAMS, isActive: false };
      return { version: active.version, params: active.params as StrategyParameters, isActive: true };
    }),
    versions: publicProcedure.query(async () => db.getAllStrategyVersions()),
    optimize: publicProcedure.mutation(async () => {
      const candles = await fetchCandles("1h", 1000);
      const candleData: CandleData[] = candles.map((c) => ({
        open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume, openTime: c.openTime,
      }));
      const activeParams = await db.getActiveStrategyParams();
      const currentParams = activeParams ? (activeParams.params as StrategyParameters) : DEFAULT_STRATEGY_PARAMS;
      const result = walkForwardOptimize(candleData, currentParams);
      const currentVersion = activeParams?.version ?? 0;
      await db.insertStrategyParams({
        version: currentVersion + 1,
        params: result.bestParams,
        backtestReturnPct: result.bestResult.totalReturn * 100,
        backtestSharpe: result.bestResult.sharpeRatio,
        backtestWinRate: result.bestResult.winRate * 100,
        isActive: true,
        notes: `Walk-forward optimized. Weekly return: ${(result.bestResult.weeklyReturn * 100).toFixed(2)}%. Trades: ${result.bestResult.totalTrades}. Max drawdown: ${(result.bestResult.maxDrawdown * 100).toFixed(2)}%.`,
      });
      return {
        version: currentVersion + 1,
        weeklyReturn: result.bestResult.weeklyReturn * 100,
        totalReturn: result.bestResult.totalReturn * 100,
        sharpeRatio: result.bestResult.sharpeRatio,
        winRate: result.bestResult.winRate * 100,
        maxDrawdown: result.bestResult.maxDrawdown * 100,
      };
    }),
    updateParams: publicProcedure
      .input(z.object({
        rsiBuyThreshold: z.number().optional(),
        rsiSellThreshold: z.number().optional(),
        macdBuyThreshold: z.number().optional(),
        macdSellThreshold: z.number().optional(),
        bbBuyDeviation: z.number().optional(),
        bbSellDeviation: z.number().optional(),
        zScoreTrendThreshold: z.number().optional(),
        zScoreBlipThreshold: z.number().optional(),
        volumeRatioThreshold: z.number().optional(),
        emaCrossoverWeight: z.number().optional(),
        maxPositionPct: z.number().optional(),
        minConfidence: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const activeParams = await db.getActiveStrategyParams();
        const current = activeParams ? (activeParams.params as StrategyParameters) : DEFAULT_STRATEGY_PARAMS;
        const merged = { ...current, ...input };
        const currentVersion = activeParams?.version ?? 0;
        await db.insertStrategyParams({
          version: currentVersion + 1, params: merged,
          isActive: true, notes: "Manual parameter update",
        });
        return { version: currentVersion + 1, params: merged };
      }),
  }),

  // ─── AI Assistant ────────────────────────────────────────────────────
  ai: router({
    analyze: publicProcedure
      .input(z.object({ question: z.string().optional() }).optional())
      .mutation(async ({ input }) => {
        const [metrics, signals, simState, weekly, validation] = await Promise.all([
          db.getRecentMetrics(10), db.getRecentSignals(20),
          db.getSimulatorState(), db.getWeeklyPerformance(4), db.getValidationHistory(5),
        ]);
        let currentPrice = 0;
        try { const p = await fetchCurrentPrice(); currentPrice = p.price; } catch {}
        const context = `## Current Bitcoin Market State\n- Current Price: $${currentPrice.toFixed(2)}\n- Latest Metrics: ${JSON.stringify(metrics[0] ?? {}, null, 2)}\n\n## Recent Signals (last 20)\n${signals.map((s) => `- ${new Date(s.ts).toISOString()}: ${s.signal} @ $${s.price.toFixed(0)} (confidence: ${((s.confidence ?? 0) * 100).toFixed(0)}%, outcome: ${s.outcome})`).join("\n")}\n\n## Simulator Portfolio\n- Cash: $${simState?.cashUsd?.toFixed(2) ?? "N/A"}\n- BTC Holdings: ${simState?.btcHolding?.toFixed(6) ?? "0"} BTC\n- Total Value: $${simState?.totalValueUsd?.toFixed(2) ?? "10,000"}\n- Return: ${simState ? (((simState.totalValueUsd - simState.seedAmountUsd) / simState.seedAmountUsd) * 100).toFixed(2) : "0"}%\n\n## Recent Weekly Performance\n${weekly.map((w) => `- Week ending ${new Date(w.weekEnd).toLocaleDateString()}: Return ${w.returnPct.toFixed(2)}%, BTC Buy-Hold: ${w.btcBuyHoldReturnPct.toFixed(2)}%`).join("\n") || "No weekly data yet."}\n\n## Validation History\n${validation.map((v) => `- Period ending ${new Date(v.periodEnd).toLocaleDateString()}: Win rate ${(v.winRate * 100).toFixed(1)}%, Signals: ${v.totalSignals}`).join("\n") || "No validation data yet."}`;
        const userQuestion = input?.question || "Provide a comprehensive market analysis and strategy recommendation.";
        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are a Bitcoin trading analyst AI assistant. Analyze the provided market data, technical metrics, signal history, and portfolio performance. Provide actionable insights, market commentary, and strategy recommendations. Be specific about numbers and trends. Format your response in clear sections with markdown." },
            { role: "user", content: `${context}\n\nUser Question: ${userQuestion}` },
          ],
        });
        const content = response.choices[0]?.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((c): c is { type: "text"; text: string } => typeof c === "object" && "type" in c && c.type === "text").map((c) => c.text).join("")
          : "";
        return { analysis: text, timestamp: Date.now() };
      }),
  }),
});

// ─── Helper: Execute Simulator Trade ─────────────────────────────────
async function executeSimulatorTrade(
  action: "buy" | "sell", price: number, reasoning: string, signalId?: number
) {
  let state = await db.getSimulatorState();
  if (!state) state = (await db.initSimulatorState()) ?? null;
  if (!state || !state.isRunning) return;
  const activeParams = await db.getActiveStrategyParams();
  const params = activeParams ? (activeParams.params as StrategyParameters) : DEFAULT_STRATEGY_PARAMS;

  if (action === "buy" && state.cashUsd > 0) {
    const tradeUsd = state.cashUsd * params.maxPositionPct;
    const btcAmount = tradeUsd / price;
    const newCash = state.cashUsd - tradeUsd;
    const newBtc = state.btcHolding + btcAmount;
    const totalValue = newCash + newBtc * price;
    await db.updateSimulatorState({ cashUsd: newCash, btcHolding: newBtc, totalValueUsd: totalValue, lastPrice: price });
    await db.insertSimulatorTrade({
      signalId, action: "buy", price, btcAmount, usdValue: tradeUsd,
      cashAfter: newCash, btcAfter: newBtc, totalValueAfter: totalValue, reasoning, ts: Date.now(),
    });
  } else if (action === "sell" && state.btcHolding > 0) {
    const btcToSell = state.btcHolding * params.maxPositionPct;
    const usdReceived = btcToSell * price;
    const newCash = state.cashUsd + usdReceived;
    const newBtc = state.btcHolding - btcToSell;
    const totalValue = newCash + newBtc * price;
    await db.updateSimulatorState({ cashUsd: newCash, btcHolding: newBtc, totalValueUsd: totalValue, lastPrice: price });
    await db.insertSimulatorTrade({
      signalId, action: "sell", price, btcAmount: btcToSell, usdValue: usdReceived,
      cashAfter: newCash, btcAfter: newBtc, totalValueAfter: totalValue, reasoning, ts: Date.now(),
    });
  }
}

// ─── Helper: Send Telegram Notification ──────────────────────────────
async function sendTelegramNotification(
  signal: "buy" | "sell", price: number, reasoning: string, portfolioValue: number
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const message = `\ud83d\udd14 *BTC ${signal.toUpperCase()} Signal*\n\n\ud83d\udcb0 Price: $${price.toFixed(2)}\n\ud83d\udcca Portfolio: $${portfolioValue.toFixed(2)}\n\n\ud83d\udcdd Reasoning:\n${reasoning.substring(0, 500)}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (e) { console.warn("[Telegram] Send failed:", e); }
}

export type AppRouter = typeof appRouter;
