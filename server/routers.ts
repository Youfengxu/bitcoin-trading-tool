import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import { updateHeartbeatJob, createHeartbeatJob, listHeartbeatJobs, type HeartbeatJobInfo } from "./_core/heartbeat";
import {
  fetchCurrentPrice,
  fetch24hStats,
  fetchCandles,
} from "./engine/marketData";
import { computeAllMetrics, type CandleData } from "./engine/technicalAnalysis";
import { generateSignal } from "./engine/signalGenerator";
import { walkForwardOptimize } from "./engine/walkForwardOptimizer";
import {
  computeReward,
  buildVariantPairs,
  evaluatePromotion,
  type ResolvedSignal,
} from "./engine/championChallenger";
import {
  DEFAULT_STRATEGY_PARAMS,
  type StrategyParameters,
  getCandleLimit,
  getConfidenceMultiplier,
  deriveChallengerParams,
  OPPORTUNITY_COST_LAMBDA,
  CHALLENGER_PROMOTION_MIN_N,
  CHALLENGER_PROMOTION_PVALUE,
} from "../shared/tradingTypes";
import { fetchExternalSignals } from "./heartbeatHandler";
import { applyExternalModifiers } from "./engine/externalModifiers";
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
        const iv = input?.interval ?? "1h";
        const candles = await fetchCandles(iv, getCandleLimit(iv));
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

    /**
     * Fetches current external market signal values from live external APIs:
     * Bybit funding rate, Fear & Greed Index, US 10Y yield velocity, IBIT flow proxy.
     * Also returns the list of active modifier labels (same strings the engine uses).
     * Cached by tRPC for 5 minutes to avoid hammering external APIs.
     */
    externalSignals: publicProcedure.query(async () => {
      const candles = await fetchCandles("1h", 336);
      const currentPrice = candles[candles.length - 1].close;
      const ext = await fetchExternalSignals(currentPrice, candles);
      const { mods } = applyExternalModifiers(0.5, 0.5, ext);
      return { ...ext, activeMods: mods, fetchedAt: Date.now() };
    }),
  }),

  // ─── Signals ────────────────────────────────────────────────────────
  signals: router({
    generate: publicProcedure.mutation(async () => {
      const activeSettings = await db.getActiveStrategyParams();
      const signalInterval = activeSettings?.candleInterval ?? "1h";
      const candles = await fetchCandles(signalInterval, getCandleLimit(signalInterval));
      const candleData: CandleData[] = candles.map((c) => ({
        open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume, openTime: c.openTime,
      }));
      const baseParams = activeSettings
        ? (activeSettings.params as StrategyParameters)
        : DEFAULT_STRATEGY_PARAMS;
      const params: StrategyParameters = {
        ...baseParams,
        minConfidence: Math.min(0.95, baseParams.minConfidence * getConfidenceMultiplier(signalInterval)),
      };
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

      // Manual generate always acts immediately (no confirmation buffer).
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
      if (!active) return {
        version: 0,
        params: DEFAULT_STRATEGY_PARAMS,
        isActive: false,
        candleInterval: "1h",
        heartbeatScheduleMinutes: 60,
      };
      return {
        version: active.version,
        params: active.params as StrategyParameters,
        isActive: true,
        candleInterval: active.candleInterval ?? "1h",
        heartbeatScheduleMinutes: active.heartbeatScheduleMinutes ?? 60,
      };
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
    updateSettings: publicProcedure
      .input(z.object({
        candleInterval: z.enum(["5m", "15m", "30m", "1h", "4h", "1d"]).optional(),
        heartbeatScheduleMinutes: z.number().int().min(0).max(720).optional(),
        sessionToken: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Persist to DB first
        await db.updateStrategySettings({
          candleInterval: input.candleInterval,
          heartbeatScheduleMinutes: input.heartbeatScheduleMinutes,
        });

        // If the heartbeat schedule changed, update the platform cron expression
        if (input.heartbeatScheduleMinutes !== undefined) {
          const active = await db.getActiveStrategyParams();
          const taskUid = active?.heartbeatTaskUid;
          // Derive session token from cookie (needed by the heartbeat SDK)
          const { parse: parseCookie } = await import("cookie");
          const sessionToken = (input.sessionToken ||
            parseCookie(ctx.req.headers.cookie ?? "")["app_session_id"]) ?? "";

          const minutes = input.heartbeatScheduleMinutes;
          // Build the 6-field cron expression (sec min hour dom mon dow)
          let cronExpr: string;
          if (minutes === 0) {
            // OFF: keep cron running hourly but handler will skip signal generation
            cronExpr = "0 0 * * * *";
          } else if (minutes < 60) {
            cronExpr = `0 */${minutes} * * * *`;
          } else {
            const hours = Math.round(minutes / 60);
            cronExpr = `0 0 */${hours} * * *`;
          }

          let nextExecutionAt: string | null = null;
          let cronUpdateWarning: string | null = null;

          if (taskUid && sessionToken) {
            try {
              await updateHeartbeatJob(taskUid, { cron: cronExpr, enable: minutes > 0 }, sessionToken);
              // Read back the job to verify the cron was actually updated on the platform
              const jobList = await listHeartbeatJobs(sessionToken);
              const updatedJob = jobList.jobs.find((j: HeartbeatJobInfo) => j.taskUid === taskUid);
              if (updatedJob) {
                nextExecutionAt = updatedJob.nextExecutionAt ?? null;
                // Verify the cron expression matches what we sent
                if (updatedJob.cronExpression !== cronExpr) {
                  cronUpdateWarning = `Schedule saved locally but platform cron shows '${updatedJob.cronExpression}' instead of '${cronExpr}'. Try again or use the Schedules panel in Settings.`;
                }
              } else {
                nextExecutionAt = null;
              }
            } catch (e: any) {
              const msg = e?.message ?? String(e);
              console.warn("[heartbeat] Failed to update platform cron:", msg);
              // Surface the warning to the client but don't throw — DB throttle still works
              cronUpdateWarning = `Schedule saved locally. Platform cron update failed: ${msg}`;
            }
          } else if (!taskUid && sessionToken) {
            // No task UID stored — first check if the job already exists on the platform
            // (handles the case where the job was created via CLI or a previous deployment)
            try {
              const existingList = await listHeartbeatJobs(sessionToken);
              const existingJob = existingList.jobs.find((j: HeartbeatJobInfo) => j.name === "btc-signal-engine");
              if (existingJob) {
                // Job already exists — persist the UID and update it
                await db.updateStrategySettings({ heartbeatTaskUid: existingJob.taskUid });
                await updateHeartbeatJob(existingJob.taskUid, { cron: cronExpr, enable: minutes > 0 }, sessionToken);
                // Read back to confirm
                const verifyList = await listHeartbeatJobs(sessionToken);
                const verifiedJob = verifyList.jobs.find((j: HeartbeatJobInfo) => j.taskUid === existingJob.taskUid);
                nextExecutionAt = verifiedJob?.nextExecutionAt ?? null;
              } else {
                // Truly no job yet — create it
                const job = await createHeartbeatJob({
                  name: "btc-signal-engine",
                  cron: cronExpr,
                  path: "/api/scheduled/heartbeat",
                  description: "Bitcoin trading signal engine: generates signals, executes simulator trades, runs validation and weekly optimization",
                }, sessionToken);
                await db.updateStrategySettings({ heartbeatTaskUid: job.taskUid });
                nextExecutionAt = job.nextExecutionAt ?? null;
              }
            } catch (e: any) {
              const msg = e?.message ?? String(e);
              console.warn("[heartbeat] Failed to create/find platform cron:", msg);
              cronUpdateWarning = `Schedule saved locally. Platform cron update failed: ${msg}`;
            }
          } else if (!sessionToken) {
            cronUpdateWarning = "Schedule saved locally. To sync with the platform cron, log in first or deploy the site and use the Schedules panel in Settings.";
          }

          if (cronUpdateWarning) {
            console.warn("[heartbeat]", cronUpdateWarning);
          }

          const activeAfter = await db.getActiveStrategyParams();
          return {
            candleInterval: activeAfter?.candleInterval ?? input.candleInterval ?? "1h",
            heartbeatScheduleMinutes: activeAfter?.heartbeatScheduleMinutes ?? input.heartbeatScheduleMinutes ?? 60,
            nextExecutionAt,
            cronUpdateWarning,
          };
        }

        const active = await db.getActiveStrategyParams();
        return {
          candleInterval: active?.candleInterval ?? input.candleInterval ?? "1h",
          heartbeatScheduleMinutes: active?.heartbeatScheduleMinutes ?? input.heartbeatScheduleMinutes ?? 60,
          nextExecutionAt: null,
          cronUpdateWarning: null,
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

  // ─── Champion-Challenger Inspection ──────────────────────────────────
  championChallenger: router({
    /**
     * One-shot snapshot of the current state of the learning loop:
     *   - active champion params + age
     *   - per-variant signal distribution & cumulative reward
     *   - paired t-test stats vs champion + promotion gate status
     *   - chronological cumulative-reward time series for charting
     *   - recent promotion history
     */
    status: publicProcedure.query(async () => {
      const active = await db.getActiveStrategyParams();
      const championEpoch = active?.createdAt
        ? (active.createdAt instanceof Date ? active.createdAt.getTime() : Number(active.createdAt))
        : 0;
      const championParams = (active?.params as StrategyParameters) ?? DEFAULT_STRATEGY_PARAMS;

      const resolved = await db.getResolvedSignalsSince(championEpoch, 5000);
      const resolvedShaped: ResolvedSignal[] = resolved
        .filter((s): s is typeof s & { signal: "buy" | "sell" | "hold" } =>
          s.signal === "buy" || s.signal === "sell" || s.signal === "hold"
        )
        .map((s) => ({
          ts: s.ts,
          signal: s.signal,
          price: s.price,
          outcomePrice: s.outcomePrice,
          strategyVariant: s.strategyVariant,
        }));

      // Per-variant aggregates
      function aggregateVariant(variantName: "champion" | "aggressive" | "conservative") {
        const variantSignals = resolvedShaped.filter((s) => s.strategyVariant === variantName);
        const counts = { buy: 0, sell: 0, hold: 0 };
        let cumulativeReward = 0;
        let acted = 0;
        let actedWins = 0;
        let holdCorrect = 0;
        let holdMissed = 0;
        for (const s of variantSignals) {
          counts[s.signal]++;
          if (s.outcomePrice == null) continue;
          cumulativeReward += computeReward(s.signal, s.price, s.outcomePrice, OPPORTUNITY_COST_LAMBDA);
          if (s.signal !== "hold") {
            acted++;
            const correctBuy = s.signal === "buy" && s.outcomePrice > s.price;
            const correctSell = s.signal === "sell" && s.outcomePrice < s.price;
            if (correctBuy || correctSell) actedWins++;
          } else {
            const absMove = Math.abs(s.outcomePrice - s.price) / s.price;
            if (absMove > 0.005) holdMissed++;
            else holdCorrect++;
          }
        }
        return {
          totalSignals: variantSignals.length,
          counts,
          cumulativeReward,
          actedWinRate: acted > 0 ? actedWins / acted : null,
          holdCorrect,
          holdMissed,
        };
      }

      const champion = aggregateVariant("champion");
      const aggregates = {
        aggressive: aggregateVariant("aggressive"),
        conservative: aggregateVariant("conservative"),
      };

      // Paired t-test + promotion gating
      const aggressiveEval = evaluatePromotion(resolvedShaped, "aggressive", championEpoch);
      const conservativeEval = evaluatePromotion(resolvedShaped, "conservative", championEpoch);

      // Cumulative reward series (chronological), one point per shared ts
      const aggPairs = buildVariantPairs(resolvedShaped, "aggressive", OPPORTUNITY_COST_LAMBDA);
      const consPairs = buildVariantPairs(resolvedShaped, "conservative", OPPORTUNITY_COST_LAMBDA);
      // Build a unified series keyed by ts (champion column shared between both pair sets)
      const tsSet = new Set<number>();
      aggPairs.forEach((p) => tsSet.add(p.ts));
      consPairs.forEach((p) => tsSet.add(p.ts));
      const tsList = Array.from(tsSet).sort((a, b) => a - b);
      const aggMap = new Map(aggPairs.map((p) => [p.ts, p]));
      const consMap = new Map(consPairs.map((p) => [p.ts, p]));

      let champCum = 0, aggCum = 0, consCum = 0;
      const rewardSeries = tsList.map((ts) => {
        const ap = aggMap.get(ts);
        const cp = consMap.get(ts);
        // Champion reward is the same whichever pair set we read it from
        const champReward = ap?.championReward ?? cp?.championReward ?? 0;
        champCum += champReward;
        aggCum += ap?.challengerReward ?? 0;
        consCum += cp?.challengerReward ?? 0;
        return { ts, champion: champCum, aggressive: aggCum, conservative: consCum };
      });

      // Promotion history from strategy_params with auto-promote notes
      const versions = await db.getAllStrategyVersions();
      const promotionHistory = versions
        .filter((v) => v.notes?.toLowerCase().includes("auto-promote"))
        .slice(0, 20)
        .map((v) => ({
          version: v.version,
          ts: v.createdAt instanceof Date ? v.createdAt.getTime() : Number(v.createdAt),
          notes: v.notes,
        }));

      const championAgeMs = championEpoch > 0 ? Date.now() - championEpoch : 0;

      return {
        champion: {
          version: active?.version ?? 0,
          params: championParams,
          createdAt: championEpoch,
          ageMs: championAgeMs,
          aggregates: champion,
          aggressiveDerivedParams: deriveChallengerParams(championParams, "aggressive"),
          conservativeDerivedParams: deriveChallengerParams(championParams, "conservative"),
        },
        aggressive: {
          aggregates: aggregates.aggressive,
          test: aggressiveEval,
        },
        conservative: {
          aggregates: aggregates.conservative,
          test: conservativeEval,
        },
        rewardSeries,
        promotionHistory,
        thresholds: {
          minN: CHALLENGER_PROMOTION_MIN_N,
          pValue: CHALLENGER_PROMOTION_PVALUE,
          lambda: OPPORTUNITY_COST_LAMBDA,
        },
      };
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
  // Use HTML parse mode \u2014 reasoning contains [RSI], [MACD] etc. which break Telegram Markdown.
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const emoji = signal === "buy" ? "\ud83d\udfe2" : "\ud83d\udd34";
  const message =
    `${emoji} <b>BTC ${signal.toUpperCase()} Signal</b>\n\n` +
    `\ud83d\udcb0 Price: $${price.toFixed(2)}\n` +
    `\ud83d\udcca Portfolio: $${portfolioValue.toFixed(2)}\n\n` +
    `\ud83d\udcdd <b>Reasoning:</b>\n<code>${escapeHtml(reasoning.substring(0, 500))}</code>`;
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    if (!tgRes.ok) {
      const detail = await tgRes.text().catch(() => "");
      console.warn(`[Telegram] Rejected (${tgRes.status}): ${detail}`);
    }
  } catch (e) { console.warn("[Telegram] Send failed:", e); }
}

export type AppRouter = typeof appRouter;
