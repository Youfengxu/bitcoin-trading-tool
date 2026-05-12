/**
 * Heartbeat handler for scheduled tasks:
 * - Every hour: generate signal, execute simulator trade, validate past signals
 * - Every 24 hours: run walk-forward optimization
 * - Every week: generate weekly performance report
 */

import {
  fetchCurrentPrice,
  fetchCandles,
} from "./engine/marketData";
import { computeAllMetrics, type CandleData } from "./engine/technicalAnalysis";
import { generateSignal } from "./engine/signalGenerator";
import { walkForwardOptimize } from "./engine/walkForwardOptimizer";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParameters } from "../shared/tradingTypes";
import { notifyOwner } from "./_core/notification";
import * as db from "./db";

let lastOptimizeHour = -1;
let lastWeeklyReportDay = -1;

export async function handleHeartbeat() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentDay = now.getUTCDay();

  console.log(`[Heartbeat] Running at ${now.toISOString()}`);

  try {
    // 1. Generate signal and execute trade every heartbeat
    await runSignalGeneration();

    // 2. Validate pending signals
    await runSignalValidation();

    // 3. Run optimization once per day at hour 0
    if (currentHour === 0 && lastOptimizeHour !== currentHour) {
      lastOptimizeHour = currentHour;
      await runOptimization();
    }

    // 4. Generate weekly report on Sundays
    if (currentDay === 0 && lastWeeklyReportDay !== currentDay) {
      lastWeeklyReportDay = currentDay;
      await generateWeeklyReport();
    }
  } catch (error) {
    console.error("[Heartbeat] Error:", error);
  }
}

async function runSignalGeneration() {
  try {
    const candles = await fetchCandles("1h", 250);
    const candleData: CandleData[] = candles.map((c) => ({
      open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, openTime: c.openTime,
    }));

    const activeParams = await db.getActiveStrategyParams();
    const params = activeParams
      ? (activeParams.params as StrategyParameters)
      : DEFAULT_STRATEGY_PARAMS;

    const metrics = computeAllMetrics(
      candleData,
      params.zScoreTrendThreshold,
      params.zScoreBlipThreshold
    );
    const signal = generateSignal(metrics, params);
    const ts = Date.now();

    await db.insertMetricSnapshot({ ts, ...metrics });
    const simStateBefore = await db.getSimulatorState();
    const signalId = await db.insertSignal({
      ts,
      signal: signal.signal,
      price: metrics.price,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      metricsSnapshot: metrics,
      portfolioValue: simStateBefore?.totalValueUsd,
    });

    if (signal.signal !== "hold") {
      // Execute simulator trade
      let state = simStateBefore;
      if (!state) state = (await db.initSimulatorState()) ?? null;
      if (state && state.isRunning) {
        if (signal.signal === "buy" && state.cashUsd > 0) {
          const tradeUsd = state.cashUsd * params.maxPositionPct;
          const btcAmount = tradeUsd / metrics.price;
          const newCash = state.cashUsd - tradeUsd;
          const newBtc = state.btcHolding + btcAmount;
          const totalValue = newCash + newBtc * metrics.price;
          await db.updateSimulatorState({
            cashUsd: newCash, btcHolding: newBtc,
            totalValueUsd: totalValue, lastPrice: metrics.price,
          });
          await db.insertSimulatorTrade({
            signalId: signalId ?? undefined,
            action: "buy", price: metrics.price, btcAmount,
            usdValue: tradeUsd, cashAfter: newCash, btcAfter: newBtc,
            totalValueAfter: totalValue, reasoning: signal.reasoning, ts,
          });
        } else if (signal.signal === "sell" && state.btcHolding > 0) {
          const btcToSell = state.btcHolding * params.maxPositionPct;
          const usdReceived = btcToSell * metrics.price;
          const newCash = state.cashUsd + usdReceived;
          const newBtc = state.btcHolding - btcToSell;
          const totalValue = newCash + newBtc * metrics.price;
          await db.updateSimulatorState({
            cashUsd: newCash, btcHolding: newBtc,
            totalValueUsd: totalValue, lastPrice: metrics.price,
          });
          await db.insertSimulatorTrade({
            signalId: signalId ?? undefined,
            action: "sell", price: metrics.price, btcAmount: btcToSell,
            usdValue: usdReceived, cashAfter: newCash, btcAfter: newBtc,
            totalValueAfter: totalValue, reasoning: signal.reasoning, ts,
          });
        }
      }

      // Notify
      const simState = await db.getSimulatorState();
      try {
        await notifyOwner({
          title: `BTC ${signal.signal.toUpperCase()} Signal @ $${metrics.price.toFixed(0)}`,
          content: `Signal: ${signal.signal.toUpperCase()}\nPrice: $${metrics.price.toFixed(2)}\nConfidence: ${(signal.confidence * 100).toFixed(0)}%\nPortfolio Value: $${simState?.totalValueUsd?.toFixed(2) ?? "N/A"}\n\nReasoning:\n${signal.reasoning}`,
        });
      } catch (e) {
        console.warn("[Heartbeat] Notification failed:", e);
      }

      // Telegram
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        try {
          const msg = `🔔 *BTC ${signal.signal.toUpperCase()} Signal*\n\n💰 Price: $${metrics.price.toFixed(2)}\n📊 Portfolio: $${simState?.totalValueUsd?.toFixed(2) ?? "N/A"}\n\n📝 Reasoning:\n${signal.reasoning.substring(0, 500)}`;
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
          });
        } catch (e) {
          console.warn("[Heartbeat] Telegram failed:", e);
        }
      }
    }

    console.log(`[Heartbeat] Signal: ${signal.signal} @ $${metrics.price.toFixed(2)} (confidence: ${(signal.confidence * 100).toFixed(0)}%)`);
  } catch (error) {
    console.error("[Heartbeat] Signal generation failed:", error);
  }
}

async function runSignalValidation() {
  try {
    const pending = await db.getPendingSignals();
    const { price: currentPrice } = await fetchCurrentPrice();
    let validated = 0;

    for (const sig of pending) {
      if (Date.now() - sig.ts < 60 * 60 * 1000) continue;
      const isWin =
        (sig.signal === "buy" && currentPrice > sig.price) ||
        (sig.signal === "sell" && currentPrice < sig.price);
      await db.updateSignalOutcome(sig.id, isWin ? "win" : "loss", currentPrice, Date.now());
      validated++;
    }

    if (validated > 0) {
      console.log(`[Heartbeat] Validated ${validated} signals`);

      // Log validation entry with Sharpe ratio and drawdown from realized outcomes
      const signals = await db.getRecentSignals(200);
      const resolved = signals.filter((s) => s.outcome !== "pending" && s.signal !== "hold" && s.outcomePrice);
      const wins = resolved.filter((s) => s.outcome === "win").length;
      const winRate = resolved.length > 0 ? wins / resolved.length : 0;

      // Compute per-signal returns for Sharpe and drawdown
      const signalReturns = resolved.map((s) => {
        const returnPct = s.signal === "buy"
          ? ((s.outcomePrice! - s.price) / s.price)
          : ((s.price - s.outcomePrice!) / s.price);
        return returnPct;
      });
      const avgReturn = signalReturns.length > 0
        ? signalReturns.reduce((a, b) => a + b, 0) / signalReturns.length
        : 0;
      let sharpeRatio: number | undefined;
      if (signalReturns.length >= 2) {
        const variance = signalReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / signalReturns.length;
        const stdDev = Math.sqrt(variance);
        sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0;
      }
      // Max drawdown from cumulative signal returns
      let maxDrawdown: number | undefined;
      if (signalReturns.length > 0) {
        let cumReturn = 1;
        let peak = 1;
        let dd = 0;
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
        periodStart: Date.now() - 24 * 60 * 60 * 1000,
        periodEnd: Date.now(),
        totalSignals: resolved.length,
        correctSignals: wins,
        winRate,
        sharpeRatio,
        maxDrawdown,
        avgReturn,
        paramVersionUsed: activeParams?.version,
        notes: `Auto-validation: ${validated} new signals evaluated`,
      });
    }
  } catch (error) {
    console.error("[Heartbeat] Validation failed:", error);
  }
}

async function runOptimization() {
  try {
    console.log("[Heartbeat] Running walk-forward optimization...");
    const candles = await fetchCandles("1h", 1000);
    const candleData: CandleData[] = candles.map((c) => ({
      open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, openTime: c.openTime,
    }));

    const activeParams = await db.getActiveStrategyParams();
    const currentParams = activeParams
      ? (activeParams.params as StrategyParameters)
      : DEFAULT_STRATEGY_PARAMS;

    const result = walkForwardOptimize(candleData, currentParams);
    const currentVersion = activeParams?.version ?? 0;

    await db.insertStrategyParams({
      version: currentVersion + 1,
      params: result.bestParams,
      backtestReturnPct: result.bestResult.totalReturn * 100,
      backtestSharpe: result.bestResult.sharpeRatio,
      backtestWinRate: result.bestResult.winRate * 100,
      isActive: true,
      notes: `[Auto] Walk-forward optimized. Weekly return: ${(result.bestResult.weeklyReturn * 100).toFixed(2)}%.`,
    });

    console.log(`[Heartbeat] Optimization complete. New version: ${currentVersion + 1}`);
  } catch (error) {
    console.error("[Heartbeat] Optimization failed:", error);
  }
}

async function generateWeeklyReport() {
  try {
    console.log("[Heartbeat] Generating weekly report...");
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const trades = await db.getTradesInRange(weekAgo, now);
    const simState = await db.getSimulatorState();

    // Get BTC price at start and end of week for buy-hold comparison
    const candles = await fetchCandles("1d", 8);
    const startPrice = candles.length >= 7 ? candles[candles.length - 8]?.close ?? candles[0].close : candles[0].close;
    const endPrice = candles[candles.length - 1].close;
    const btcBuyHoldReturn = ((endPrice - startPrice) / startPrice) * 100;

    // Calculate strategy return for the week
    const startValue = simState?.seedAmountUsd ?? 10000;
    const endValue = simState?.totalValueUsd ?? 10000;
    const strategyReturn = ((endValue - startValue) / startValue) * 100;

    // Win rate for the week
    const signals = await db.getRecentSignals(200);
    const weekSignals = signals.filter((s) => s.ts >= weekAgo && s.outcome !== "pending" && s.signal !== "hold");
    const wins = weekSignals.filter((s) => s.outcome === "win").length;
    const winRate = weekSignals.length > 0 ? wins / weekSignals.length : 0;

    await db.insertWeeklyPerformance({
      weekStart: weekAgo,
      weekEnd: now,
      startValue,
      endValue,
      returnPct: strategyReturn,
      btcBuyHoldReturnPct: btcBuyHoldReturn,
      totalTrades: trades.length,
      winRate,
    });

    console.log(`[Heartbeat] Weekly report: Strategy ${strategyReturn.toFixed(2)}% vs BTC ${btcBuyHoldReturn.toFixed(2)}%`);
  } catch (error) {
    console.error("[Heartbeat] Weekly report failed:", error);
  }
}
