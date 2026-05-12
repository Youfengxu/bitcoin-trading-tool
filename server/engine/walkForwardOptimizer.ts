/**
 * Walk-Forward Optimization Engine
 *
 * Backtests strategy parameters on recent data windows and selects
 * the parameter set that maximizes weekly returns.
 */

import type { StrategyParameters } from "../../shared/tradingTypes";
import { DEFAULT_STRATEGY_PARAMS } from "../../shared/tradingTypes";
import type { CandleData } from "./technicalAnalysis";
import { computeAllMetrics } from "./technicalAnalysis";
import { generateSignal } from "./signalGenerator";

interface BacktestResult {
  params: StrategyParameters;
  totalReturn: number;
  weeklyReturn: number;
  winRate: number;
  sharpeRatio: number;
  totalTrades: number;
  maxDrawdown: number;
}

interface BacktestTrade {
  type: "buy" | "sell";
  price: number;
  ts: number;
}

/**
 * Run a backtest simulation on historical candle data with given parameters.
 */
function backtest(
  candles: CandleData[],
  params: StrategyParameters,
  initialCash: number = 10000
): BacktestResult {
  let cash = initialCash;
  let btc = 0;
  const trades: BacktestTrade[] = [];
  const dailyValues: number[] = [];
  let peakValue = initialCash;
  let maxDrawdown = 0;

  // Need at least 200 candles for SMA200
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

    // Track portfolio value
    const totalValue = cash + btc * price;
    dailyValues.push(totalValue);

    // Track drawdown
    if (totalValue > peakValue) peakValue = totalValue;
    const drawdown = (peakValue - totalValue) / peakValue;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Execute trades
    if (signal.signal === "buy" && cash > 0) {
      const tradeAmount = cash * params.maxPositionPct;
      const btcBought = tradeAmount / price;
      cash -= tradeAmount;
      btc += btcBought;
      trades.push({ type: "buy", price, ts: candles[i].openTime });
    } else if (signal.signal === "sell" && btc > 0) {
      const btcToSell = btc * params.maxPositionPct;
      const usdReceived = btcToSell * price;
      btc -= btcToSell;
      cash += usdReceived;
      trades.push({ type: "sell", price, ts: candles[i].openTime });
    }
  }

  const finalPrice = candles[candles.length - 1].close;
  const finalValue = cash + btc * finalPrice;
  const totalReturn = (finalValue - initialCash) / initialCash;

  // Calculate weekly return (annualized to weekly)
  const durationMs = candles[candles.length - 1].openTime - candles[startIdx].openTime;
  const weeks = Math.max(1, durationMs / (7 * 24 * 60 * 60 * 1000));
  const weeklyReturn = totalReturn / weeks;

  // Win rate
  let wins = 0;
  for (let i = 1; i < trades.length; i++) {
    if (trades[i].type === "sell" && trades[i - 1].type === "buy") {
      if (trades[i].price > trades[i - 1].price) wins++;
    }
  }
  const tradePairs = Math.max(1, Math.floor(trades.length / 2));
  const winRate = wins / tradePairs;

  // Sharpe ratio (simplified)
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

  return {
    params,
    totalReturn,
    weeklyReturn,
    winRate,
    sharpeRatio,
    totalTrades: trades.length,
    maxDrawdown,
  };
}

/**
 * Generate parameter variations around a base set for optimization.
 */
function generateParamVariations(base: StrategyParameters, count: number = 12): StrategyParameters[] {
  const variations: StrategyParameters[] = [base];
  const rng = () => 0.8 + Math.random() * 0.4; // 0.8 to 1.2 multiplier

  for (let i = 0; i < count - 1; i++) {
    variations.push({
      rsiBuyThreshold: Math.max(15, Math.min(45, base.rsiBuyThreshold * rng())),
      rsiSellThreshold: Math.max(55, Math.min(85, base.rsiSellThreshold * rng())),
      macdBuyThreshold: base.macdBuyThreshold * rng(),
      macdSellThreshold: base.macdSellThreshold * rng(),
      bbBuyDeviation: base.bbBuyDeviation * rng(),
      bbSellDeviation: base.bbSellDeviation * rng(),
      zScoreTrendThreshold: Math.max(1.5, Math.min(3.0, base.zScoreTrendThreshold * rng())),
      zScoreBlipThreshold: Math.max(0.2, Math.min(1.0, base.zScoreBlipThreshold * rng())),
      volumeRatioThreshold: Math.max(1.0, Math.min(3.0, base.volumeRatioThreshold * rng())),
      emaCrossoverWeight: Math.max(0.05, Math.min(0.5, base.emaCrossoverWeight * rng())),
      maxPositionPct: Math.max(0.1, Math.min(0.5, base.maxPositionPct * rng())),
      minConfidence: Math.max(0.3, Math.min(0.8, base.minConfidence * rng())),
    });
  }

  return variations;
}

/**
 * Run walk-forward optimization: split data into train/test windows,
 * optimize on training data, validate on test data.
 * Returns the best parameter set that maximizes weekly returns.
 */
export function walkForwardOptimize(
  candles: CandleData[],
  currentParams?: StrategyParameters,
  trainRatio = 0.7
): {
  bestParams: StrategyParameters;
  bestResult: BacktestResult;
  allResults: BacktestResult[];
} {
  const base = currentParams ?? DEFAULT_STRATEGY_PARAMS;
  const splitIdx = Math.floor(candles.length * trainRatio);
  const trainData = candles.slice(0, splitIdx);
  const testData = candles; // Full data for final validation

  // Generate variations and backtest on training data
  const variations = generateParamVariations(base, 16);
  const trainResults = variations.map((p) => backtest(trainData, p));

  // Sort by weekly return (our optimization target)
  trainResults.sort((a, b) => b.weeklyReturn - a.weeklyReturn);

  // Take top 4 from training and validate on full data
  const topCandidates = trainResults.slice(0, 4);
  const testResults = topCandidates.map((tr) => backtest(testData, tr.params));

  // Select best by weekly return on test data
  testResults.sort((a, b) => b.weeklyReturn - a.weeklyReturn);

  return {
    bestParams: testResults[0].params,
    bestResult: testResults[0],
    allResults: testResults,
  };
}

/**
 * Validate signal accuracy: compare predicted signals against actual price outcomes.
 */
export function validateSignals(
  signals: Array<{
    signal: "buy" | "sell" | "hold";
    price: number;
    ts: number;
    outcomePrice?: number;
  }>,
  lookAheadPeriodMs: number = 60 * 60 * 1000 // 1 hour
): {
  totalSignals: number;
  correctSignals: number;
  winRate: number;
  avgReturn: number;
} {
  let correct = 0;
  let totalReturns = 0;
  let evaluated = 0;

  for (const sig of signals) {
    if (sig.signal === "hold" || !sig.outcomePrice) continue;
    evaluated++;
    const returnPct = (sig.outcomePrice - sig.price) / sig.price;

    if (sig.signal === "buy" && returnPct > 0) correct++;
    else if (sig.signal === "sell" && returnPct < 0) correct++;

    totalReturns += sig.signal === "buy" ? returnPct : -returnPct;
  }

  return {
    totalSignals: evaluated,
    correctSignals: correct,
    winRate: evaluated > 0 ? correct / evaluated : 0,
    avgReturn: evaluated > 0 ? totalReturns / evaluated : 0,
  };
}
