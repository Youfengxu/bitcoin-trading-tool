/**
 * Champion-Challenger learning loop.
 *
 * On every heartbeat the system emits three signals at the same timestamp —
 * one from the active champion params and two from derived challengers
 * (aggressive + conservative). Only champion's signal executes on the
 * simulator portfolio; challengers are shadow-logged.
 *
 * After enough paired observations accumulate (n ≥ CHALLENGER_PROMOTION_MIN_N),
 * we run a one-sided paired t-test on (challenger_reward − champion_reward).
 * If a challenger has p < CHALLENGER_PROMOTION_PVALUE AND a positive mean
 * difference, it's promoted to champion.
 *
 * Rewards are computed with the same opportunity-cost-aware function from
 * Phase 1: realised return for acted signals, −λ × |price move| for holds.
 */

import {
  OPPORTUNITY_COST_LAMBDA,
  CHALLENGER_PROMOTION_PVALUE,
  CHALLENGER_PROMOTION_MIN_N,
  type StrategyVariant,
} from "../../shared/tradingTypes";

// ─── Reward Function ─────────────────────────────────────────────────
/**
 * Per-signal reward (in fractional return units).
 *   buy  → realised priceMove (positive when correct)
 *   sell → −realised priceMove
 *   hold → −λ × |priceMove| (opportunity cost of inaction)
 */
export function computeReward(
  signal: "buy" | "sell" | "hold",
  price: number,
  outcomePrice: number,
  lambda: number = OPPORTUNITY_COST_LAMBDA
): number {
  const returnPct = (outcomePrice - price) / price;
  if (signal === "buy") return returnPct;
  if (signal === "sell") return -returnPct;
  return -lambda * Math.abs(returnPct);
}

// ─── Normal & Student-t Distributions ────────────────────────────────
/** Abramowitz & Stegun 7.1.26 — max error 1.5e-7. */
function erf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * One-tailed survival function P(T > t | df) for Student's t.
 * Uses the Wallace approximation: for df ≥ 4 the relative error is < 0.5%, which
 * is more than sufficient since our gate is a coarse p < 0.05 test.
 */
function tSurvival(t: number, df: number): number {
  if (df < 1) return 1;
  // Sign-symmetric: P(T > -t) = 1 - P(T > t)
  if (t < 0) return 1 - tSurvival(-t, df);
  const z = t * (1 - 1 / (4 * df)) / Math.sqrt(1 + (t * t) / (2 * df));
  return 1 - normalCdf(z);
}

// ─── Paired t-test ───────────────────────────────────────────────────
export interface TTestResult {
  /** Number of paired observations. */
  n: number;
  /** Mean of differences (challenger − champion). */
  meanDiff: number;
  /** Sample standard deviation of the differences. */
  stdDiff: number;
  /** t-statistic. */
  t: number;
  /** One-tailed p-value (H1: meanDiff > 0). */
  p: number;
}

/**
 * One-sided paired t-test against H0: meanDiff ≤ 0.
 * Returns p ≈ 1 for fewer than two observations or zero-variance series.
 */
export function pairedTTest(differences: number[]): TTestResult {
  const n = differences.length;
  if (n < 2) return { n, meanDiff: n === 1 ? differences[0] : 0, stdDiff: 0, t: 0, p: 1 };
  const meanDiff = differences.reduce((a, b) => a + b, 0) / n;
  const variance = differences.reduce((s, d) => s + (d - meanDiff) ** 2, 0) / (n - 1);
  const stdDiff = Math.sqrt(variance);
  if (stdDiff === 0) {
    return { n, meanDiff, stdDiff, t: meanDiff > 0 ? Infinity : 0, p: meanDiff > 0 ? 0 : 1 };
  }
  const t = meanDiff / (stdDiff / Math.sqrt(n));
  const p = tSurvival(t, n - 1);
  return { n, meanDiff, stdDiff, t, p };
}

// ─── Pairing Resolved Signals ────────────────────────────────────────
export interface ResolvedSignal {
  ts: number;
  signal: "buy" | "sell" | "hold";
  price: number;
  outcomePrice: number | null;
  strategyVariant: string | null;
}

export interface VariantPair {
  ts: number;
  championReward: number;
  challengerReward: number;
}

/**
 * Build paired (champion, challenger) reward observations by joining on `ts`.
 * Only timestamps where both the champion and the specified challenger have
 * resolved outcomes are included.
 */
export function buildVariantPairs(
  signals: ResolvedSignal[],
  challengerVariant: "aggressive" | "conservative",
  lambda: number = OPPORTUNITY_COST_LAMBDA
): VariantPair[] {
  // Group by ts → variant → signal
  const byTs = new Map<number, Map<string, ResolvedSignal>>();
  for (const s of signals) {
    if (s.outcomePrice == null || s.strategyVariant == null) continue;
    if (!byTs.has(s.ts)) byTs.set(s.ts, new Map());
    byTs.get(s.ts)!.set(s.strategyVariant, s);
  }

  const pairs: VariantPair[] = [];
  byTs.forEach((group, ts) => {
    const champ = group.get("champion");
    const chall = group.get(challengerVariant);
    if (!champ || !chall) return;
    if (champ.outcomePrice == null || chall.outcomePrice == null) return;
    pairs.push({
      ts,
      championReward: computeReward(champ.signal, champ.price, champ.outcomePrice, lambda),
      challengerReward: computeReward(chall.signal, chall.price, chall.outcomePrice, lambda),
    });
  });
  return pairs.sort((a, b) => a.ts - b.ts);
}

// ─── Promotion Evaluation ────────────────────────────────────────────
export interface PromotionEval {
  variant: "aggressive" | "conservative";
  n: number;
  meanDiff: number;
  stdDiff: number;
  t: number;
  p: number;
  shouldPromote: boolean;
  reason: string;
}

/**
 * Decide whether a challenger should be promoted to champion. A challenger
 * is promoted only when:
 *   1. n ≥ CHALLENGER_PROMOTION_MIN_N paired observations, AND
 *   2. mean(challenger − champion) > 0, AND
 *   3. one-sided p < CHALLENGER_PROMOTION_PVALUE
 *
 * Pairs from before the active champion's epoch (sinceTs) are excluded so the
 * comparison resets whenever the champion is replaced.
 */
export function evaluatePromotion(
  resolvedSignals: ResolvedSignal[],
  variant: "aggressive" | "conservative",
  championEpochMs: number,
  lambda: number = OPPORTUNITY_COST_LAMBDA
): PromotionEval {
  const eligible = resolvedSignals.filter((s) => s.ts >= championEpochMs);
  const pairs = buildVariantPairs(eligible, variant, lambda);
  const diffs = pairs.map((p) => p.challengerReward - p.championReward);
  const test = pairedTTest(diffs);

  let shouldPromote = false;
  let reason: string;
  if (test.n < CHALLENGER_PROMOTION_MIN_N) {
    reason = `insufficient data (${test.n}/${CHALLENGER_PROMOTION_MIN_N} pairs)`;
  } else if (test.meanDiff <= 0) {
    reason = `no improvement (mean diff ${(test.meanDiff * 100).toFixed(3)}%)`;
  } else if (test.p >= CHALLENGER_PROMOTION_PVALUE) {
    reason = `not significant (p=${test.p.toFixed(4)} ≥ ${CHALLENGER_PROMOTION_PVALUE})`;
  } else {
    shouldPromote = true;
    reason = `promoted: mean diff ${(test.meanDiff * 100).toFixed(3)}%, t=${test.t.toFixed(2)}, p=${test.p.toFixed(4)}, n=${test.n}`;
  }

  return {
    variant,
    n: test.n,
    meanDiff: test.meanDiff,
    stdDiff: test.stdDiff,
    t: test.t,
    p: test.p,
    shouldPromote,
    reason,
  };
}

export { CHALLENGER_PROMOTION_MIN_N, CHALLENGER_PROMOTION_PVALUE };
