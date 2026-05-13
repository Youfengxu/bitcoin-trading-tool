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
import { computeAllMetrics, type CandleData, type AllMetrics, classifyTrend } from "./engine/technicalAnalysis";
import { generateSignal } from "./engine/signalGenerator";
import { walkForwardOptimize } from "./engine/walkForwardOptimizer";
import { evaluatePromotion, type ResolvedSignal } from "./engine/championChallenger";
import {
  DEFAULT_STRATEGY_PARAMS,
  STRATEGY_VARIANTS,
  type StrategyParameters,
  type StrategyVariant,
  getCandleLimit,
  getConfidenceMultiplier,
  getValidationHorizonMs,
  deriveChallengerParams,
  OPPORTUNITY_COST_LAMBDA,
  HOLD_NOISE_THRESHOLD,
} from "../shared/tradingTypes";
import { notifyOwner } from "./_core/notification";
import * as db from "./db";

let lastOptimizeHour = -1;
let lastWeeklyReportDay = -1;
/** Timestamp (ms) of the last successful signal generation run. Used for schedule throttle. */
let lastSignalRunTs = 0;
/** Rolling buffer of the last 2 non-hold signal directions for confirmation. */
let signalConfirmationBuffer: Array<"buy" | "sell"> = [];

export async function handleHeartbeat() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentDay = now.getUTCDay();
  const nowMs = now.getTime();

  console.log(`[Heartbeat] Running at ${now.toISOString()}`);

  try {
    // Read the active strategy settings to get the user-configured schedule throttle.
    const activeStrategy = await db.getActiveStrategyParams();
    const heartbeatScheduleMinutes = activeStrategy?.heartbeatScheduleMinutes ?? 60;
    const candleInterval = activeStrategy?.candleInterval ?? "1h";

    // 1. Generate signal and execute trade — gated by the user-configured schedule throttle.
    //    heartbeatScheduleMinutes === 0 means automation is OFF; skip signal generation only.
    const signalThrottled =
      heartbeatScheduleMinutes === 0 ||
      (lastSignalRunTs > 0 && (nowMs - lastSignalRunTs) / 60000 < heartbeatScheduleMinutes);

    if (signalThrottled) {
      if (heartbeatScheduleMinutes === 0) {
        console.log("[Heartbeat] Signal generation skipped — automation is OFF.");
      } else {
        const elapsed = ((nowMs - lastSignalRunTs) / 60000).toFixed(1);
        console.log(`[Heartbeat] Signal throttled — ${elapsed}m elapsed, schedule requires ${heartbeatScheduleMinutes}m.`);
      }
    } else {
      await runSignalGeneration(candleInterval);
      lastSignalRunTs = nowMs;
    }

    // 2. Validate pending signals — always runs regardless of schedule setting.
    //    Horizon scales with heartbeat cadence to keep validation windows
    //    non-overlapping (preserves t-test independence).
    await runSignalValidation(heartbeatScheduleMinutes);

    // 3. Champion-challenger promotion check (cheap; just a stats test on resolved signals).
    await runPromotionCheck();

    // 4. Run optimization once per day at hour 0 — always runs regardless of schedule setting.
    if (currentHour === 0 && lastOptimizeHour !== currentHour) {
      lastOptimizeHour = currentHour;
      await runOptimization();
    }

    // 4. Generate weekly report on Sundays — always runs regardless of schedule setting.
    if (currentDay === 0 && lastWeeklyReportDay !== currentDay) {
      lastWeeklyReportDay = currentDay;
      await generateWeeklyReport();
    }
  } catch (error) {
    console.error("[Heartbeat] Error:", error);
  }
}

/**
 * Re-classify the trend on an already-computed metrics object using the variant's
 * z-score thresholds. This lets us run all 3 variants without recomputing the
 * expensive Hurst/ADX/SMA fields each heartbeat.
 */
function metricsForVariant(base: AllMetrics, variantParams: StrategyParameters): AllMetrics {
  if (base.zScore === null) return base;
  return {
    ...base,
    trendClassification: classifyTrend(
      base.zScore,
      variantParams.zScoreTrendThreshold,
      variantParams.zScoreBlipThreshold
    ),
  };
}

async function runSignalGeneration(candleInterval = "1h") {
  try {
    const limit = getCandleLimit(candleInterval);
    console.log(`[Heartbeat] Fetching ${limit} candles (${candleInterval}, ~14d scope)`);
    const candles = await fetchCandles(candleInterval, limit);
    const candleData: CandleData[] = candles.map((c) => ({
      open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, openTime: c.openTime,
    }));

    const activeParams = await db.getActiveStrategyParams();
    const baseParams = activeParams
      ? (activeParams.params as StrategyParameters)
      : DEFAULT_STRATEGY_PARAMS;

    // Sub-hourly noise compensation applies to all variants identically.
    const confidenceMultiplier = getConfidenceMultiplier(candleInterval);
    const championParams: StrategyParameters = {
      ...baseParams,
      minConfidence: Math.min(0.95, baseParams.minConfidence * confidenceMultiplier),
    };

    // Compute metrics once with champion's thresholds — Hurst/ADX/SMA are
    // intrinsic and don't depend on threshold params.
    const baseMetrics = computeAllMetrics(
      candleData,
      championParams.zScoreTrendThreshold,
      championParams.zScoreBlipThreshold
    );
    const ts = Date.now();
    await db.insertMetricSnapshot({ ts, ...baseMetrics });

    const simStateBefore = await db.getSimulatorState();

    // Generate signals for all variants in parallel-conceptually (no I/O between them).
    // Only champion's signal mutates the portfolio + sends notifications.
    let championSignal: { signal: "buy" | "sell" | "hold"; confidence: number; reasoning: string } | null = null;
    let championSignalId: number | undefined;
    let championMetrics: AllMetrics = baseMetrics;
    let championAppliedParams = championParams;

    for (const variant of STRATEGY_VARIANTS) {
      const variantParams: StrategyParameters =
        variant === "champion" ? championParams : deriveChallengerParams(championParams, variant);
      const variantMetrics = metricsForVariant(baseMetrics, variantParams);
      const sig = generateSignal(variantMetrics, variantParams);

      const insertId = await db.insertSignal({
        ts,
        signal: sig.signal,
        price: variantMetrics.price,
        confidence: sig.confidence,
        reasoning: sig.reasoning,
        metricsSnapshot: variantMetrics,
        portfolioValue: simStateBefore?.totalValueUsd,
        strategyVariant: variant,
      });

      if (variant === "champion") {
        championSignal = sig;
        championSignalId = insertId ?? undefined;
        championMetrics = variantMetrics;
        championAppliedParams = variantParams;
      } else {
        console.log(`[Heartbeat] Shadow ${variant}: ${sig.signal} (conf ${(sig.confidence * 100).toFixed(0)}%)`);
      }
    }

    if (!championSignal) {
      console.error("[Heartbeat] Champion signal missing — aborting trade execution");
      return;
    }

    // From here on the champion's signal drives the simulator and notifications,
    // reusing the existing confirmation-buffer + execution logic.
    const signal = championSignal;
    const signalId = championSignalId;
    const metrics = championMetrics;
    const params = championAppliedParams;

    // Signal confirmation: only act when the same direction appears twice in a row.
    // Resets on direction change; holds don't affect the buffer.
    if (signal.signal !== "hold") {
      signalConfirmationBuffer.push(signal.signal);
      if (signalConfirmationBuffer.length > 2) signalConfirmationBuffer.shift();
    }
    const confirmed =
      signal.signal !== "hold" &&
      signalConfirmationBuffer.length === 2 &&
      signalConfirmationBuffer[0] === signalConfirmationBuffer[1];

    if (!confirmed && signal.signal !== "hold") {
      console.log(`[Heartbeat] Signal ${signal.signal.toUpperCase()} awaiting confirmation (1/2)`);
    }

    if (confirmed) {
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

    console.log(`[Heartbeat] Champion: ${signal.signal} @ $${metrics.price.toFixed(2)} (confidence: ${(signal.confidence * 100).toFixed(0)}%)`);
  } catch (error) {
    console.error("[Heartbeat] Signal generation failed:", error);
  }
}

async function runSignalValidation(heartbeatScheduleMinutes: number) {
  try {
    const validationHorizonMs = getValidationHorizonMs(heartbeatScheduleMinutes);
    const pending = await db.getPendingSignals();
    const { price: currentPrice } = await fetchCurrentPrice();
    let validated = 0;

    for (const sig of pending) {
      if (Date.now() - sig.ts < validationHorizonMs) continue;

      let outcome: "win" | "loss" | "hold_correct" | "hold_missed";
      if (sig.signal === "hold") {
        const absMove = Math.abs(currentPrice - sig.price) / sig.price;
        outcome = absMove > HOLD_NOISE_THRESHOLD ? "hold_missed" : "hold_correct";
      } else {
        const isWin =
          (sig.signal === "buy" && currentPrice > sig.price) ||
          (sig.signal === "sell" && currentPrice < sig.price);
        outcome = isWin ? "win" : "loss";
      }
      await db.updateSignalOutcome(sig.id, outcome, currentPrice, Date.now());
      validated++;
    }

    if (validated > 0) {
      console.log(`[Heartbeat] Validated ${validated} signals`);

      const signals = await db.getRecentSignals(200);
      const resolved = signals.filter((s) => s.outcome !== "pending" && s.outcomePrice);
      const acted = resolved.filter((s) => s.signal !== "hold");
      const wins = acted.filter((s) => s.outcome === "win").length;
      const winRate = acted.length > 0 ? wins / acted.length : 0;

      // Per-acted-signal returns for Sharpe and drawdown
      const signalReturns = acted.map((s) => {
        return s.signal === "buy"
          ? (s.outcomePrice! - s.price) / s.price
          : (s.price - s.outcomePrice!) / s.price;
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
      let maxDrawdown: number | undefined;
      if (signalReturns.length > 0) {
        let cumReturn = 1;
        let peak = 1;
        let dd = 0;
        for (const r of signalReturns) {
          cumReturn *= 1 + r;
          if (cumReturn > peak) peak = cumReturn;
          const currentDd = (peak - cumReturn) / peak;
          if (currentDd > dd) dd = currentDd;
        }
        maxDrawdown = dd;
      }

      // Hold opportunity-cost accounting
      const holds = resolved.filter((s) => s.signal === "hold");
      let holdRegret = 0;
      let holdMissed = 0;
      let holdCorrect = 0;
      for (const h of holds) {
        const absReturn = Math.abs(h.outcomePrice! - h.price) / h.price;
        holdRegret += absReturn;
        if (h.outcome === "hold_missed") holdMissed++;
        else if (h.outcome === "hold_correct") holdCorrect++;
      }
      const totalForPenalty = acted.length + holds.length;
      const avgHoldRegret = totalForPenalty > 0 ? holdRegret / totalForPenalty : 0;
      const riskAdjustedReturn = avgReturn - OPPORTUNITY_COST_LAMBDA * avgHoldRegret;

      const activeParams = await db.getActiveStrategyParams();
      await db.insertValidationEntry({
        periodStart: Date.now() - 24 * 60 * 60 * 1000,
        periodEnd: Date.now(),
        totalSignals: acted.length,
        correctSignals: wins,
        winRate,
        sharpeRatio,
        maxDrawdown,
        avgReturn,
        holdRegret,
        holdMissed,
        holdCorrect,
        riskAdjustedReturn,
        paramVersionUsed: activeParams?.version,
        notes: `Auto-validation: ${validated} new signals evaluated at ${(validationHorizonMs / 60000).toFixed(0)}min horizon (${holdMissed} holds missed real moves, ${holdCorrect} correctly cautious)`,
      });
    }
  } catch (error) {
    console.error("[Heartbeat] Validation failed:", error);
  }
}

/**
 * Champion-challenger promotion check.
 *
 * For each challenger variant, build paired (champion_reward, challenger_reward)
 * observations from resolved signals since the current champion was activated.
 * If the paired t-test shows a significant positive mean difference, promote
 * the challenger to champion (insert a new strategy_params version).
 */
async function runPromotionCheck() {
  try {
    const activeParams = await db.getActiveStrategyParams();
    if (!activeParams) return;

    const championEpoch = activeParams.createdAt instanceof Date
      ? activeParams.createdAt.getTime()
      : Number(activeParams.createdAt);

    const resolved = await db.getResolvedSignalsSince(championEpoch, 1000);
    if (resolved.length < 10) return; // not enough data yet

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

    const baseParams = activeParams.params as StrategyParameters;

    for (const variant of ["aggressive", "conservative"] as const) {
      const result = evaluatePromotion(resolvedShaped, variant, championEpoch);
      console.log(`[ChampionChallenger] ${variant}: ${result.reason}`);

      if (result.shouldPromote) {
        const newParams = deriveChallengerParams(baseParams, variant);
        const newVersion = (activeParams.version ?? 0) + 1;
        await db.insertStrategyParams({
          version: newVersion,
          params: newParams,
          isActive: true,
          notes: `[Auto-promote] ${variant} challenger beat champion: n=${result.n}, meanDiff=${(result.meanDiff * 100).toFixed(3)}%, p=${result.p.toFixed(4)}`,
        });

        try {
          await notifyOwner({
            title: `Strategy promoted: ${variant} → champion`,
            content: `The ${variant} challenger beat the active champion on a paired t-test (n=${result.n}, mean diff ${(result.meanDiff * 100).toFixed(3)}%, p=${result.p.toFixed(4)}). New params are version ${newVersion}.`,
          });
        } catch (e) {
          console.warn("[ChampionChallenger] Promotion notification failed:", e);
        }

        // Only promote one variant per cycle. The new champion's epoch resets the
        // comparison window for the next round of challengers.
        return;
      }
    }
  } catch (error) {
    console.error("[ChampionChallenger] Promotion check failed:", error);
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
