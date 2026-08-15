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
import { applyExternalModifiers, signalFromScores, type ExternalSignals } from "./engine/externalModifiers";
import { executeSignalTrade, getRealVenue } from "./engine/executionVenue";
import * as db from "./db";

/**
 * Date stamps (YYYY-MM-DD / ISO week) of the last completed daily and weekly
 * task, so each runs at most once per period.
 *
 * These were previously `lastOptimizeHour` and `lastWeeklyReportDay`, compared
 * against the CURRENT hour and weekday. Once the daily task ran, the marker was
 * set to 0 and `currentHour === 0 && lastOptimizeHour !== currentHour` could
 * never be true again — so "run once per day" actually meant "run once per
 * process restart". The active strategy went unchanged from 2026-06-14 to
 * 2026-08-15 for this reason, and weekly reports had the identical bug.
 *
 * Comparing against the date rather than the hour makes the marker advance with
 * time instead of latching.
 */
let lastOptimizeDate = "";
let lastWeeklyReportWeek = "";

/** UTC calendar day, e.g. "2026-08-15". */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC year+week, e.g. "2026-W33", so the marker advances across year ends. */
export function utcWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO week: Thursday of the current week determines the year and week number.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ─── External Signal Fetching ─────────────────────────────────────────
/**
 * Fetches all external market signals needed by applyExternalModifiers().
 * Each source has a short timeout and fails gracefully — a missing signal
 * simply omits that modifier rather than blocking the heartbeat.
 *
 * @param currentPrice  Latest BTC price (for funding divergence near-high check)
 * @param candles       Recent 1h candles (used to compute rolling 14d high)
 */
export async function fetchExternalSignals(
  currentPrice: number,
  candles: { close: number }[],
): Promise<ExternalSignals> {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Rolling 14-day (336 1h candles) high for the funding divergence context filter
  const highLookback = Math.min(336, candles.length);
  const rollingHigh14d = candles
    .slice(candles.length - highLookback)
    .reduce((mx, c) => Math.max(mx, c.close), 0);

  // ── Fetch all sources in parallel with individual timeouts ──────────
  const [fundingRaw, fearGreedRaw, yieldRaw, ibitRaw] = await Promise.allSettled([

    // 1. Bybit perpetual funding rate — last 2 records (need prev to detect flip)
    fetch(
      "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=2",
      { signal: AbortSignal.timeout(6000) }
    ).then(r => r.json()) as Promise<{
      result?: { list?: Array<{ fundingRate: string; fundingRateTimestamp: string }> };
    }>,

    // 2. Fear & Greed — just today
    fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(6000) })
      .then(r => r.json()) as Promise<{ data?: Array<{ value: string }> }>,

    // 3. US 10Y yield — last 5 trading days (need 2 for velocity = daily change)
    fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-signal/1.0)" },
        signal: AbortSignal.timeout(8000),
      }
    ).then(r => r.json()) as Promise<{
      chart?: { result?: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ close: (number | null)[] }> };
      }> };
    }>,

    // 4. IBIT daily — 1 month for the 7-day rolling signed-flow proxy
    fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/IBIT?interval=1d&range=1mo",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-signal/1.0)" },
        signal: AbortSignal.timeout(8000),
      }
    ).then(r => r.json()) as Promise<{
      chart?: { result?: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ close: (number|null)[]; volume: (number|null)[] }> };
      }> };
    }>,
  ]);

  // ── Parse funding rate ──────────────────────────────────────────────
  let fundingRate: number | null = null;
  let fundingNegDivergence = false;
  if (fundingRaw.status === "fulfilled") {
    const list = fundingRaw.value?.result?.list ?? [];
    if (list.length >= 1) fundingRate = parseFloat(list[0].fundingRate);
    if (fundingRate !== null && fundingRate < -0.00003 && list.length >= 2) {
      const prevRate = parseFloat(list[1].fundingRate);
      if (prevRate > 0 && currentPrice >= rollingHigh14d * 0.95) {
        fundingNegDivergence = true;
      }
    }
  }

  // ── Parse Fear & Greed ──────────────────────────────────────────────
  let fearGreed: number | null = null;
  if (fearGreedRaw.status === "fulfilled") {
    const val = fearGreedRaw.value?.data?.[0]?.value;
    if (val !== undefined) fearGreed = parseInt(val, 10);
  }

  // ── Parse yield velocity ────────────────────────────────────────────
  let yieldVelocity: number | null = null;
  if (yieldRaw.status === "fulfilled") {
    const result = yieldRaw.value?.chart?.result?.[0];
    if (result) {
      const closes = result.indicators.quote[0].close.filter((v): v is number => v !== null);
      if (closes.length >= 2) {
        yieldVelocity = closes[closes.length - 1] - closes[closes.length - 2];
      }
    }
  }

  // ── Parse IBIT 7-day signed-flow proxy ─────────────────────────────
  let ibitFlow7d: number | null = null;
  if (ibitRaw.status === "fulfilled") {
    const result = ibitRaw.value?.chart?.result?.[0];
    if (result) {
      const ts  = result.timestamp;
      const q   = result.indicators.quote[0];
      // Build daily signed-flow values (sign(return) × dollar_volume in $M)
      const dailyFlows: number[] = [];
      for (let i = 1; i < ts.length; i++) {
        const c    = q.close[i],   cp = q.close[i - 1];
        const v    = q.volume[i];
        if (!c || !cp || !v) continue;
        const ret  = (c - cp) / cp;
        dailyFlows.push(Math.sign(ret) * (c * v) / 1e6);
      }
      // 7D rolling sum of the most recent 7 trading days
      if (dailyFlows.length >= 7) {
        ibitFlow7d = dailyFlows.slice(-7).reduce((a, b) => a + b, 0);
      }
    }
  }

  // Log summary — shows what fired and what was unavailable
  const parts = [
    `funding=${fundingRate !== null ? (fundingRate * 100).toFixed(4) + "%" : "n/a"}`,
    `F&G=${fearGreed ?? "n/a"}`,
    `US10Y_vel=${yieldVelocity !== null ? yieldVelocity.toFixed(3) + "ppt" : "n/a"}`,
    `IBIT-7d=${ibitFlow7d !== null ? "$" + ibitFlow7d.toFixed(0) + "M" : "n/a"}`,
  ];
  console.log(`[External] ${parts.join("  ")}`);

  // etfNetflow7dSma is always null in the heartbeat — SosoValue is blocked by Cloudflare.
  // The IBIT proxy above handles the ETF demand signal instead.
  return { fundingRate, fundingNegDivergence, fearGreed, yieldVelocity, etfNetflow7dSma: null, ibitFlow7d };
}
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

    // 4. Run optimization once per UTC day at hour 0 — always runs regardless
    //    of the schedule setting.
    const today = utcDateKey(now);
    if (currentHour === 0 && lastOptimizeDate !== today) {
      lastOptimizeDate = today;
      await runOptimization();
    }

    // 5. Generate the weekly report on Sundays — always runs regardless of the
    //    schedule setting.
    const thisWeek = utcWeekKey(now);
    if (currentDay === 0 && lastWeeklyReportWeek !== thisWeek) {
      lastWeeklyReportWeek = thisWeek;
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

    // Fetch external market signals once — shared across all variants.
    // Fails gracefully: missing data means that modifier simply doesn't fire.
    const ext = await fetchExternalSignals(baseMetrics.price, candleData);

    // Generate signals for all variants in parallel-conceptually (no I/O between them).
    // External modifiers are applied identically to all variants so the champion-challenger
    // comparison tests indicator parameter sensitivity under the same external context.
    // Only champion's signal mutates the portfolio + sends notifications.
    let championSignal: { signal: "buy" | "sell" | "hold"; confidence: number; reasoning: string } | null = null;
    let championSignalId: number | undefined;
    let championMetrics: AllMetrics = baseMetrics;
    let championAppliedParams = championParams;
    let championMods: string[] = [];

    for (const variant of STRATEGY_VARIANTS) {
      const variantParams: StrategyParameters =
        variant === "champion" ? championParams : deriveChallengerParams(championParams, variant);
      const variantMetrics = metricsForVariant(baseMetrics, variantParams);
      const baseSig = generateSignal(variantMetrics, variantParams);

      // Apply external modifiers to the raw scores, then re-evaluate the signal
      const { modBuy, modSell, mods } = applyExternalModifiers(
        baseSig.rawBuyScore,
        baseSig.rawSellScore,
        ext,
      );
      const enhanced = signalFromScores(modBuy, modSell, variantParams.minConfidence);

      // Store the enhanced signal; append modifier list to reasoning for audit trail
      const enhancedReasoning = mods.length > 0
        ? `${baseSig.reasoning}\n\n── External modifiers ──\n${mods.join("\n")}`
        : baseSig.reasoning;

      const insertId = await db.insertSignal({
        ts,
        signal: enhanced.signal,
        price: variantMetrics.price,
        confidence: enhanced.confidence,
        reasoning: enhancedReasoning,
        metricsSnapshot: variantMetrics,
        portfolioValue: simStateBefore?.totalValueUsd,
        strategyVariant: variant,
      });

      if (variant === "champion") {
        championSignal = { signal: enhanced.signal, confidence: enhanced.confidence, reasoning: enhancedReasoning };
        championSignalId = insertId ?? undefined;
        championMetrics = variantMetrics;
        championAppliedParams = variantParams;
        championMods = mods;
      } else {
        const flip = baseSig.signal !== enhanced.signal ? ` (base: ${baseSig.signal})` : "";
        console.log(`[Heartbeat] Shadow ${variant}: ${enhanced.signal}${flip} (conf ${(enhanced.confidence * 100).toFixed(0)}%)`);
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

    if (confirmed && signal.signal !== "hold") {
      // Records to the paper ledger always, and to OKX as well when configured.
      // In lockstep mode a failed OKX order skips the paper book too, so the two
      // curves only ever differ by execution quality. See engine/executionVenue.ts.
      const { paper, real } = await executeSignalTrade({
        action: signal.signal,
        price: metrics.price,
        params,
        reasoning: signal.reasoning,
        signalId: signalId ?? undefined,
        ts,
      });
      const describe = (label: string, f: typeof paper) =>
        f
          ? `${label} ${f.action.toUpperCase()} ${f.btcAmount.toFixed(8)} BTC ` +
            `@ $${f.price.toFixed(2)} (fee $${f.feeUsd.toFixed(4)})`
          : `${label} no fill`;

      if (paper || real) {
        const parts = [describe("paper", paper)];
        if (getRealVenue()) parts.push(describe(getRealVenue()!.name, real));
        console.log(`[Heartbeat] ${parts.join("  |  ")}`);
      } else {
        console.log(`[Heartbeat] ${signal.signal.toUpperCase()} confirmed but no trade executed`);
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
          // Use HTML parse mode — the reasoning text contains [RSI], [MACD], etc. which
          // break Telegram's Markdown parser (bare square brackets are link syntax in Markdown).
          // HTML mode only interprets explicit <b>, <i>, <code> tags and is safe with
          // arbitrary text as long as we escape < > & in the reasoning body.
          const escapeHtml = (s: string) =>
            s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

          const emoji = signal.signal === "buy" ? "🟢" : "🔴";
          const reasoning = escapeHtml(signal.reasoning.substring(0, 500));
          const modLine = championMods.length > 0
            ? `\n🔧 <b>Modifiers:</b> <code>${escapeHtml(championMods.join("  "))}</code>\n`
            : "";
          const msg =
            `${emoji} <b>BTC ${signal.signal.toUpperCase()} Signal</b>\n\n` +
            `💰 Price: $${metrics.price.toFixed(2)}\n` +
            `📊 Confidence: ${(signal.confidence * 100).toFixed(0)}%\n` +
            `💼 Portfolio: $${simState?.totalValueUsd?.toFixed(2) ?? "N/A"}\n` +
            modLine +
            `\n📝 <b>Reasoning:</b>\n<code>${reasoning}</code>`;

          const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
          });
          if (!tgRes.ok) {
            const detail = await tgRes.text().catch(() => "");
            console.warn(`[Heartbeat] Telegram rejected message (${tgRes.status}): ${detail}`);
          } else {
            console.log(`[Heartbeat] Telegram notified: ${signal.signal.toUpperCase()} @ $${metrics.price.toFixed(0)}`);
          }
        } catch (e) {
          console.warn("[Heartbeat] Telegram failed:", e);
        }
      } else {
        console.log("[Heartbeat] Telegram skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set.");
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
