/**
 * Walk-Forward Optimization Engine
 *
 * Backtests strategy parameters on recent data windows and selects the parameter
 * set that maximises the **risk-adjusted return**:
 *
 *     riskAdjustedReturn = totalReturn − λ × holdRegret
 *
 * where totalReturn is now NET OF TRADING COSTS, and holdRegret is the sum of
 * |next-bar return| across all candles where the strategy emitted a "hold". λ is
 * the opportunity-cost weight (calibrated in scripts/lambdaSensitivity.ts).
 *
 * ── Why costs must be modelled here ───────────────────────────────────
 * Until 2026-08-15 this backtest transacted at the mid price with no fee. That
 * made the objective a one-way ratchet toward turnover: the λ term actively
 * penalises holding, while trading was free. The optimizer did exactly what it
 * was asked to and drove minConfidence to 0.30 — the floor of its own search
 * range — which on live data produced 695 trades in 93 days. At OKX's 0.10%
 * taker rate that turnover costs roughly 3.3% of the seed per quarter, enough
 * to erase the strategy's entire measured edge.
 *
 * The fee charged here is deliberately INDEPENDENT of TRADING_FEE_BPS, which
 * governs what the paper simulator charges and therefore the continuity of the
 * recorded track record. Those are different questions. The paper ledger may
 * legitimately stay fee-free to keep one equity curve comparable over time, but
 * the optimizer is choosing parameters to run against a real exchange and must
 * always assume real costs. Override with OPTIMIZER_FEE_BPS.
 */

import type { StrategyParameters } from "../../shared/tradingTypes";
import { DEFAULT_STRATEGY_PARAMS, OPPORTUNITY_COST_LAMBDA } from "../../shared/tradingTypes";
import type { CandleData } from "./technicalAnalysis";
import { computeAllMetrics } from "./technicalAnalysis";
import { generateSignal } from "./signalGenerator";

export interface BacktestResult {
  params: StrategyParameters;
  totalReturn: number;
  weeklyReturn: number;
  winRate: number;
  sharpeRatio: number;
  totalTrades: number;
  maxDrawdown: number;
  /** Sum of |next-bar return pct| over all candles where signal was "hold". */
  holdRegret: number;
  /** Number of candles where signal was "hold". */
  holdCount: number;
  /** totalReturn − λ × holdRegret. The optimizer's objective. */
  riskAdjustedReturn: number;
  /** Risk-adjusted return projected to a weekly cadence (objective normalised by duration). */
  riskAdjustedWeekly: number;
  /** Total trading fees charged during the backtest, in the same units as initialCash. */
  feesPaid: number;
  /** Gross notional transacted. feesPaid ≈ turnoverUsd × feeRate. */
  turnoverUsd: number;
  /** Per-side fee rate applied, as a decimal (0.001 = 0.10%). */
  feeRate: number;
}

/**
 * Per-side trading cost the optimizer assumes, as a decimal.
 *
 * Defaults to 10 bps — OKX spot Lv1 taker (0.100%), the rate this strategy
 * pays since it places market orders. Set OPTIMIZER_FEE_BPS to match a
 * different VIP tier; `pnpm okx:check` prints the account's actual rate.
 *
 * Setting this to 0 restores the old fee-blind behaviour and is only sensible
 * for isolating the cost term's effect in analysis.
 */
export function getOptimizerFeeRate(): number {
  const raw = process.env.OPTIMIZER_FEE_BPS;
  if (raw === undefined) return 0.001;
  const bps = parseFloat(raw);
  if (isNaN(bps) || bps < 0) return 0.001;
  return bps / 10000;
}

interface BacktestTrade {
  type: "buy" | "sell";
  price: number;
  ts: number;
}

/**
 * Mulberry32 — fast, seedable RNG. Used so sensitivity tests are reproducible.
 * Returns Math.random when no seed is supplied so live optimization stays stochastic.
 */
function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Backtest a single parameter set on historical candles.
 *
 * The opportunity-cost term is computed per candle: whenever the strategy says
 * "hold", we record |close[i+1] − close[i]| / close[i] as inaction regret. The
 * sum is then weighted by λ and subtracted from realised totalReturn.
 */
function backtest(
  candles: CandleData[],
  params: StrategyParameters,
  initialCash = 10000,
  lambda = OPPORTUNITY_COST_LAMBDA,
  feeRate = getOptimizerFeeRate()
): BacktestResult {
  let cash = initialCash;
  let btc = 0;
  const trades: BacktestTrade[] = [];
  const dailyValues: number[] = [];
  let peakValue = initialCash;
  let maxDrawdown = 0;

  let holdRegret = 0;
  let holdCount = 0;
  let feesPaid = 0;
  let turnoverUsd = 0;

  // SMA-200 needs 200 prior candles before the first valid signal.
  const startIdx = Math.min(200, candles.length - 1);

  for (let i = startIdx; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const metrics = computeAllMetrics(
      window,
      params.zScoreTrendThreshold,
      params.zScoreBlipThreshold
    );
    const signal = generateSignal(metrics, params);
    const price = candles[i].close;

    // Mark-to-market and drawdown
    const totalValue = cash + btc * price;
    dailyValues.push(totalValue);
    if (totalValue > peakValue) peakValue = totalValue;
    const drawdown = (peakValue - totalValue) / peakValue;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (signal.signal === "buy" && cash > 0) {
      // Fee is taken out of the notional, so it buys less BTC than the cash spent.
      const tradeAmount = cash * params.maxPositionPct;
      const fee = tradeAmount * feeRate;
      const btcBought = (tradeAmount - fee) / price;
      cash -= tradeAmount;
      btc += btcBought;
      feesPaid += fee;
      turnoverUsd += tradeAmount;
      trades.push({ type: "buy", price, ts: candles[i].openTime });
    } else if (signal.signal === "sell" && btc > 0) {
      const btcToSell = btc * params.maxPositionPct;
      const gross = btcToSell * price;
      const fee = gross * feeRate;
      btc -= btcToSell;
      cash += gross - fee;
      feesPaid += fee;
      turnoverUsd += gross;
      trades.push({ type: "sell", price, ts: candles[i].openTime });
    } else if (signal.signal === "hold" && i + 1 < candles.length) {
      // Opportunity cost: absolute price move over the next bar
      const nextPrice = candles[i + 1].close;
      holdRegret += Math.abs(nextPrice - price) / price;
      holdCount++;
    }
  }

  const finalPrice = candles[candles.length - 1].close;
  const finalValue = cash + btc * finalPrice;
  const totalReturn = (finalValue - initialCash) / initialCash;

  const durationMs = candles[candles.length - 1].openTime - candles[startIdx].openTime;
  const weeks = Math.max(1, durationMs / (7 * 24 * 60 * 60 * 1000));
  const weeklyReturn = totalReturn / weeks;

  // Win rate from buy/sell pairs
  let wins = 0;
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].type === "sell" && trades[i - 1].type === "buy") {
      if (trades[i].price > trades[i - 1].price) wins++;
    }
  }
  const tradePairs = Math.max(1, Math.floor(trades.length / 2));
  const winRate = wins / tradePairs;

  // Sharpe ratio from per-bar portfolio returns
  const returns: number[] = [];
  for (let i = 1; i < dailyValues.length; i++) {
    returns.push((dailyValues[i] - dailyValues[i - 1]) / dailyValues[i - 1]);
  }
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn =
    returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
      : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(365) : 0;

  const riskAdjustedReturn = totalReturn - lambda * holdRegret;
  const riskAdjustedWeekly = riskAdjustedReturn / weeks;

  return {
    params,
    totalReturn,
    weeklyReturn,
    winRate,
    sharpeRatio,
    totalTrades: trades.length,
    maxDrawdown,
    holdRegret,
    holdCount,
    riskAdjustedReturn,
    riskAdjustedWeekly,
    feesPaid,
    turnoverUsd,
    feeRate,
  };
}

/**
 * Generate parameter variations around a base set. Uses `rng` (defaults to
 * Math.random) so sensitivity tests can supply a seeded RNG for reproducibility.
 */
function generateParamVariations(
  base: StrategyParameters,
  count = 12,
  rng: () => number = Math.random
): StrategyParameters[] {
  const variations: StrategyParameters[] = [base];
  const jitter = () => 0.8 + rng() * 0.4; // 0.8 to 1.2

  for (let i = 0; i < count - 1; i++) {
    variations.push({
      rsiBuyThreshold: Math.max(15, Math.min(45, base.rsiBuyThreshold * jitter())),
      rsiSellThreshold: Math.max(55, Math.min(85, base.rsiSellThreshold * jitter())),
      macdBuyThreshold: base.macdBuyThreshold * jitter(),
      macdSellThreshold: base.macdSellThreshold * jitter(),
      bbBuyDeviation: base.bbBuyDeviation * jitter(),
      bbSellDeviation: base.bbSellDeviation * jitter(),
      zScoreTrendThreshold: Math.max(1.5, Math.min(3.0, base.zScoreTrendThreshold * jitter())),
      zScoreBlipThreshold: Math.max(0.2, Math.min(1.0, base.zScoreBlipThreshold * jitter())),
      volumeRatioThreshold: Math.max(1.0, Math.min(3.0, base.volumeRatioThreshold * jitter())),
      emaCrossoverWeight: Math.max(0.05, Math.min(0.5, base.emaCrossoverWeight * jitter())),
      maxPositionPct: Math.max(0.1, Math.min(0.5, base.maxPositionPct * jitter())),
      minConfidence: Math.max(0.3, Math.min(0.8, base.minConfidence * jitter())),
    });
  }

  return variations;
}

export interface WalkForwardOptions {
  trainRatio?: number;
  lambda?: number;
  rngSeed?: number;
  variationCount?: number;
  /**
   * Per-side trading cost as a decimal. Defaults to the OPTIMIZER_FEE_BPS
   * setting (10 bps). Pass 0 only to reproduce the old fee-blind behaviour.
   */
  feeRate?: number;
}

/**
 * Walk-forward optimization: train on the first `trainRatio` of candles, validate the
 * top candidates on the full dataset, return the best by riskAdjustedWeekly.
 */
export function walkForwardOptimize(
  candles: CandleData[],
  currentParams?: StrategyParameters,
  options: WalkForwardOptions = {}
): {
  bestParams: StrategyParameters;
  bestResult: BacktestResult;
  allResults: BacktestResult[];
} {
  const {
    trainRatio = 0.7,
    lambda = OPPORTUNITY_COST_LAMBDA,
    rngSeed,
    variationCount = 16,
    feeRate = getOptimizerFeeRate(),
  } = options;

  const base = currentParams ?? DEFAULT_STRATEGY_PARAMS;
  const splitIdx = Math.floor(candles.length * trainRatio);
  const trainData = candles.slice(0, splitIdx);
  const testData = candles;

  const rng = makeRng(rngSeed);
  const variations = generateParamVariations(base, variationCount, rng);
  const trainResults = variations.map((p) => backtest(trainData, p, 10000, lambda, feeRate));

  // Rank by risk-adjusted weekly return (new objective)
  trainResults.sort((a, b) => b.riskAdjustedWeekly - a.riskAdjustedWeekly);

  const topCandidates = trainResults.slice(0, 4);
  const testResults = topCandidates.map((tr) =>
    backtest(testData, tr.params, 10000, lambda, feeRate)
  );
  testResults.sort((a, b) => b.riskAdjustedWeekly - a.riskAdjustedWeekly);

  return {
    bestParams: testResults[0].params,
    bestResult: testResults[0],
    allResults: testResults,
  };
}

/**
 * Aggregate signal accuracy with opportunity-cost accounting.
 *
 * For buy/sell signals this is the realised return in the predicted direction.
 * For hold signals it is the inaction regret (|priceMove|), classified as
 * "missed" if the move exceeded HOLD_NOISE_THRESHOLD or "correct" otherwise.
 */
export function validateSignals(
  signals: Array<{
    signal: "buy" | "sell" | "hold";
    price: number;
    ts: number;
    outcomePrice?: number | null;
  }>,
  lambda: number = OPPORTUNITY_COST_LAMBDA,
  holdNoiseThreshold = 0.005
): {
  totalSignals: number;
  correctSignals: number;
  winRate: number;
  avgReturn: number;
  holdRegret: number;
  holdCount: number;
  holdMissed: number;
  holdCorrect: number;
  riskAdjustedReturn: number;
} {
  let correct = 0;
  let totalReturns = 0;
  let evaluatedActed = 0;
  let holdRegret = 0;
  let holdCount = 0;
  let holdMissed = 0;
  let holdCorrect = 0;

  for (const sig of signals) {
    if (!sig.outcomePrice) continue;
    const returnPct = (sig.outcomePrice - sig.price) / sig.price;
    const absReturn = Math.abs(returnPct);

    if (sig.signal === "hold") {
      holdCount++;
      holdRegret += absReturn;
      if (absReturn > holdNoiseThreshold) holdMissed++;
      else holdCorrect++;
      continue;
    }

    evaluatedActed++;
    if (sig.signal === "buy" && returnPct > 0) correct++;
    else if (sig.signal === "sell" && returnPct < 0) correct++;
    totalReturns += sig.signal === "buy" ? returnPct : -returnPct;
  }

  const avgReturn = evaluatedActed > 0 ? totalReturns / evaluatedActed : 0;
  const totalSignalsForPenalty = evaluatedActed + holdCount;
  const avgHoldRegret = totalSignalsForPenalty > 0 ? holdRegret / totalSignalsForPenalty : 0;
  const riskAdjustedReturn = avgReturn - lambda * avgHoldRegret;

  return {
    totalSignals: evaluatedActed,
    correctSignals: correct,
    winRate: evaluatedActed > 0 ? correct / evaluatedActed : 0,
    avgReturn,
    holdRegret,
    holdCount,
    holdMissed,
    holdCorrect,
    riskAdjustedReturn,
  };
}

// Re-export for the sensitivity script
export { backtest };
