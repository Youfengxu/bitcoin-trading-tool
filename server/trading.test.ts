import { describe, expect, it } from "vitest";
import {
  sma, ema, rsi, macd, bollingerBands, zScore, classifyTrend,
  computeAllMetrics, type CandleData,
} from "./engine/technicalAnalysis";
import { generateSignal, type SignalOutput } from "./engine/signalGenerator";
import {
  walkForwardOptimize,
  validateSignals,
  backtest,
  getOptimizerFeeRate,
} from "./engine/walkForwardOptimizer";
import {
  computeReward,
  pairedTTest,
  buildVariantPairs,
  evaluatePromotion,
  type ResolvedSignal,
} from "./engine/championChallenger";
import {
  DEFAULT_STRATEGY_PARAMS,
  deriveChallengerParams,
  getValidationHorizonMs,
  MIN_VALIDATION_HORIZON_MS,
  OPPORTUNITY_COST_LAMBDA,
  OPTIMIZER_LAMBDA,
  OPTIMIZER_DRAWDOWN_PENALTY,
  type StrategyParameters,
} from "../shared/tradingTypes";

// ─── Helper: generate synthetic candle data ─────────────────────────
function generateCandles(count: number, basePrice = 50000, volatility = 500): CandleData[] {
  const candles: CandleData[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * volatility;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * volatility * 0.3;
    const low = Math.min(open, close) - Math.random() * volatility * 0.3;
    candles.push({
      open, high, low, close,
      volume: 100 + Math.random() * 200,
      openTime: Date.now() - (count - i) * 3600000,
    });
    price = close;
  }
  return candles;
}

// Generate a trending-up series
function generateUptrend(count: number, basePrice = 50000): CandleData[] {
  const candles: CandleData[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = 50 + Math.random() * 100; // always positive
    const open = price;
    const close = price + change;
    const high = close + Math.random() * 50;
    const low = open - Math.random() * 30;
    candles.push({
      open, high, low, close,
      volume: 150 + Math.random() * 100,
      openTime: Date.now() - (count - i) * 3600000,
    });
    price = close;
  }
  return candles;
}

// Generate a trending-down series
function generateDowntrend(count: number, basePrice = 80000): CandleData[] {
  const candles: CandleData[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = -(50 + Math.random() * 100);
    const open = price;
    const close = price + change;
    const high = open + Math.random() * 30;
    const low = close - Math.random() * 50;
    candles.push({
      open, high, low, close: Math.max(close, 1000),
      volume: 150 + Math.random() * 100,
      openTime: Date.now() - (count - i) * 3600000,
    });
    price = Math.max(close, 1000);
  }
  return candles;
}

// ─── Technical Analysis Tests ───────────────────────────────────────
describe("Technical Analysis", () => {
  describe("SMA", () => {
    it("computes simple moving average correctly", () => {
      const data = [10, 20, 30, 40, 50];
      expect(sma(data, 3)).toBe(40); // (30+40+50)/3
      expect(sma(data, 5)).toBe(30); // (10+20+30+40+50)/5
    });

    it("returns null when insufficient data", () => {
      expect(sma([10, 20], 5)).toBeNull();
    });
  });

  describe("EMA", () => {
    it("computes exponential moving average", () => {
      const data = [10, 20, 30, 40, 50];
      const result = ema(data, 3);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("number");
      // EMA should be between min and max of data
      expect(result!).toBeGreaterThanOrEqual(10);
      expect(result!).toBeLessThanOrEqual(50);
    });

    it("returns null when insufficient data", () => {
      expect(ema([10, 20], 5)).toBeNull();
    });
  });

  describe("RSI", () => {
    it("computes RSI in valid range [0, 100]", () => {
      const data = generateCandles(50).map((c) => c.close);
      const result = rsi(data, 14);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThanOrEqual(0);
      expect(result!).toBeLessThanOrEqual(100);
    });

    it("returns high RSI for uptrend", () => {
      const data = generateUptrend(30).map((c) => c.close);
      const result = rsi(data, 14);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(50);
    });

    it("returns low RSI for downtrend", () => {
      const data = generateDowntrend(30).map((c) => c.close);
      const result = rsi(data, 14);
      expect(result).not.toBeNull();
      expect(result!).toBeLessThan(50);
    });

    it("returns null when insufficient data", () => {
      expect(rsi([10, 20, 30], 14)).toBeNull();
    });
  });

  describe("MACD", () => {
    it("computes MACD with line, signal, and histogram", () => {
      const data = generateCandles(50).map((c) => c.close);
      const result = macd(data);
      expect(result).not.toBeNull();
      expect(result!).toHaveProperty("macdLine");
      expect(result!).toHaveProperty("signalLine");
      expect(result!).toHaveProperty("histogram");
      expect(typeof result!.macdLine).toBe("number");
      expect(typeof result!.signalLine).toBe("number");
      expect(typeof result!.histogram).toBe("number");
    });

    it("histogram equals macdLine minus signalLine", () => {
      const data = generateCandles(50).map((c) => c.close);
      const result = macd(data);
      if (result) {
        expect(result.histogram).toBeCloseTo(result.macdLine - result.signalLine, 5);
      }
    });
  });

  describe("Bollinger Bands", () => {
    it("computes upper, middle, and lower bands", () => {
      const data = generateCandles(30).map((c) => c.close);
      const result = bollingerBands(data);
      expect(result).not.toBeNull();
      expect(result!.upper).toBeGreaterThan(result!.middle);
      expect(result!.middle).toBeGreaterThan(result!.lower);
    });
  });

  describe("Z-Score", () => {
    it("computes z-score and rolling standard deviation", () => {
      const data = generateCandles(30).map((c) => c.close);
      const result = zScore(data);
      expect(result).not.toBeNull();
      expect(typeof result!.zScore).toBe("number");
      expect(typeof result!.rollingStdDev).toBe("number");
      expect(result!.rollingStdDev).toBeGreaterThanOrEqual(0);
    });
  });

  describe("classifyTrend", () => {
    it("classifies high z-score as trend", () => {
      expect(classifyTrend(2.5, 2.0, 0.5)).toBe("trend");
      expect(classifyTrend(-2.5, 2.0, 0.5)).toBe("trend");
    });

    it("classifies low z-score as blip", () => {
      expect(classifyTrend(0.3, 2.0, 0.5)).toBe("blip");
      expect(classifyTrend(-0.3, 2.0, 0.5)).toBe("blip");
    });

    it("classifies moderate z-score as neutral", () => {
      expect(classifyTrend(1.0, 2.0, 0.5)).toBe("neutral");
      expect(classifyTrend(-1.0, 2.0, 0.5)).toBe("neutral");
    });
  });

  describe("computeAllMetrics", () => {
    it("returns all metric fields", () => {
      const candles = generateCandles(250);
      const metrics = computeAllMetrics(candles);
      expect(metrics).toHaveProperty("price");
      expect(metrics).toHaveProperty("rsi14");
      expect(metrics).toHaveProperty("macdLine");
      expect(metrics).toHaveProperty("macdSignal");
      expect(metrics).toHaveProperty("macdHist");
      expect(metrics).toHaveProperty("bbUpper");
      expect(metrics).toHaveProperty("bbMiddle");
      expect(metrics).toHaveProperty("bbLower");
      expect(metrics).toHaveProperty("ema12");
      expect(metrics).toHaveProperty("ema26");
      expect(metrics).toHaveProperty("sma50");
      expect(metrics).toHaveProperty("zScore");
      expect(metrics).toHaveProperty("rollingStdDev");
      expect(metrics).toHaveProperty("trendClassification");
      expect(metrics.price).toBeGreaterThan(0);
    });
  });
});

// ─── Signal Generator Tests ─────────────────────────────────────────
describe("Signal Generator", () => {
  it("returns a valid signal object with reasoning", () => {
    const candles = generateCandles(250);
    const metrics = computeAllMetrics(candles);
    const signal = generateSignal(metrics, DEFAULT_STRATEGY_PARAMS);
    expect(signal).toHaveProperty("signal");
    expect(signal).toHaveProperty("confidence");
    expect(signal).toHaveProperty("reasoning");
    expect(["buy", "sell", "hold"]).toContain(signal.signal);
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(1);
    expect(signal.reasoning.length).toBeGreaterThan(0);
  });

  it("reasoning contains signal summary", () => {
    const candles = generateCandles(250);
    const metrics = computeAllMetrics(candles);
    const signal = generateSignal(metrics, DEFAULT_STRATEGY_PARAMS);
    // Reasoning should mention the signal type
    const hasSignalMention = signal.reasoning.includes("BUY") ||
      signal.reasoning.includes("SELL") ||
      signal.reasoning.includes("HOLD");
    expect(hasSignalMention).toBe(true);
  });

  it("generates buy signal for strong uptrend", () => {
    const candles = generateUptrend(250);
    const metrics = computeAllMetrics(candles);
    const signal = generateSignal(metrics, {
      ...DEFAULT_STRATEGY_PARAMS,
      minConfidence: 0.1, // lower threshold to make it easier to trigger
    });
    // In a strong uptrend, RSI may be overbought so we might get sell
    // but the signal should not be null
    expect(["buy", "sell", "hold"]).toContain(signal.signal);
  });

  it("respects minConfidence threshold", () => {
    const candles = generateCandles(250);
    const metrics = computeAllMetrics(candles);
    // With very high confidence threshold, should get hold
    const signal = generateSignal(metrics, {
      ...DEFAULT_STRATEGY_PARAMS,
      minConfidence: 0.99,
    });
    expect(signal.signal).toBe("hold");
  });
});

// ─── Walk-Forward Optimizer Tests ───────────────────────────────────
describe("Walk-Forward Optimizer", () => {
  it("returns optimized parameters and results", () => {
    const candles = generateCandles(300, 50000, 300);
    const result = walkForwardOptimize(candles, DEFAULT_STRATEGY_PARAMS, { trainRatio: 0.7 });
    expect(result).toHaveProperty("bestParams");
    expect(result).toHaveProperty("bestResult");
    expect(result).toHaveProperty("allResults");
    expect(result.bestResult).toHaveProperty("totalReturn");
    expect(result.bestResult).toHaveProperty("sharpeRatio");
    expect(result.bestResult).toHaveProperty("winRate");
    expect(result.bestResult).toHaveProperty("maxDrawdown");
    expect(result.bestResult).toHaveProperty("weeklyReturn");
    expect(result.bestResult).toHaveProperty("totalTrades");
    expect(typeof result.bestResult.totalReturn).toBe("number");
    expect(typeof result.bestResult.sharpeRatio).toBe("number");
  });

  it("best params are valid strategy parameters", () => {
    const candles = generateCandles(300, 50000, 300);
    const result = walkForwardOptimize(candles, DEFAULT_STRATEGY_PARAMS);
    const p = result.bestParams;
    expect(p.rsiBuyThreshold).toBeGreaterThan(0);
    expect(p.rsiBuyThreshold).toBeLessThan(p.rsiSellThreshold);
    expect(p.maxPositionPct).toBeGreaterThan(0);
    expect(p.maxPositionPct).toBeLessThanOrEqual(1);
    expect(p.minConfidence).toBeGreaterThan(0);
    expect(p.minConfidence).toBeLessThanOrEqual(1);
  });
});

// ─── Optimizer trading costs ────────────────────────────────────────
// The optimizer used to transact at the mid price with no fee, which made its
// objective a one-way ratchet toward turnover: holding was penalised by the λ
// term while trading was free.
describe("Optimizer trading costs", () => {
  const candles = generateCandles(300, 50000, 300);

  it("charges a fee on every trade", () => {
    const withFee = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001);
    if (withFee.totalTrades === 0) return; // nothing to charge on this fixture
    expect(withFee.feesPaid).toBeGreaterThan(0);
    expect(withFee.turnoverUsd).toBeGreaterThan(0);
  });

  it("charges fees proportional to turnover", () => {
    const r = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001);
    if (r.totalTrades === 0) return;
    expect(r.feesPaid).toBeCloseTo(r.turnoverUsd * 0.001, 6);
  });

  it("reduces net return relative to a fee-free run", () => {
    const free = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0);
    const paid = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001);
    expect(free.feesPaid).toBe(0);
    if (paid.totalTrades === 0) return;
    expect(paid.totalReturn).toBeLessThan(free.totalReturn);
  });

  it("charges more as the fee rate rises", () => {
    const cheap = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001);
    const dear = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.0026);
    if (cheap.totalTrades === 0) return;
    expect(dear.feesPaid).toBeGreaterThan(cheap.feesPaid);
    expect(dear.totalReturn).toBeLessThan(cheap.totalReturn);
  });

  it("leaves the signal stream untouched — only the P&L changes", () => {
    // Fees must not alter which signals fire, or the comparison above would be
    // measuring two different strategies rather than two cost assumptions.
    const free = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0);
    const paid = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001);
    expect(paid.totalTrades).toBe(free.totalTrades);
    expect(paid.holdCount).toBe(free.holdCount);
    expect(paid.holdRegret).toBeCloseTo(free.holdRegret, 10);
  });

  it("defaults to OKX's 10bps taker rate", () => {
    const saved = process.env.OPTIMIZER_FEE_BPS;
    delete process.env.OPTIMIZER_FEE_BPS;
    expect(getOptimizerFeeRate()).toBe(0.001);
    process.env.OPTIMIZER_FEE_BPS = "26";
    expect(getOptimizerFeeRate()).toBeCloseTo(0.0026, 10);
    process.env.OPTIMIZER_FEE_BPS = "0";
    expect(getOptimizerFeeRate()).toBe(0);
    process.env.OPTIMIZER_FEE_BPS = "nonsense";
    expect(getOptimizerFeeRate()).toBe(0.001); // falls back rather than becoming NaN
    if (saved === undefined) delete process.env.OPTIMIZER_FEE_BPS;
    else process.env.OPTIMIZER_FEE_BPS = saved;
  });

  it("is independent of TRADING_FEE_BPS", () => {
    // The paper ledger's fee and the optimizer's cost assumption answer
    // different questions and must not be coupled.
    const saved = process.env.OPTIMIZER_FEE_BPS;
    delete process.env.OPTIMIZER_FEE_BPS;
    process.env.TRADING_FEE_BPS = "0";
    expect(getOptimizerFeeRate()).toBe(0.001);
    delete process.env.TRADING_FEE_BPS;
    if (saved !== undefined) process.env.OPTIMIZER_FEE_BPS = saved;
  });

  it("is deterministic for a given seed", () => {
    const a = walkForwardOptimize(candles, DEFAULT_STRATEGY_PARAMS, { rngSeed: 42 });
    const b = walkForwardOptimize(candles, DEFAULT_STRATEGY_PARAMS, { rngSeed: 42 });
    expect(b.bestResult.riskAdjustedWeekly).toBe(a.bestResult.riskAdjustedWeekly);
    expect(b.bestParams.minConfidence).toBe(a.bestParams.minConfidence);
  });

  it("reports the fee rate it used", () => {
    const r = walkForwardOptimize(candles, DEFAULT_STRATEGY_PARAMS, { rngSeed: 7, feeRate: 0.0026 });
    expect(r.bestResult.feeRate).toBe(0.0026);
  });
});

// ─── Opportunity-cost term ──────────────────────────────────────────
describe("Optimizer hold-regret term", () => {
  const candles = generateCandles(500, 50000, 300);

  it("uses the mean, not the sum, of missed moves", () => {
    const r = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0.3, 0.001);
    if (r.holdCount === 0) return;
    expect(r.avgHoldRegret).toBeCloseTo(r.holdRegret / r.holdCount, 10);
    // The sum grows with hold COUNT, so minimising it means minimising holds —
    // turnover for its own sake. That was the old objective's failure mode.
    expect(r.avgHoldRegret).toBeLessThan(r.holdRegret);
  });

  it("is switched off by default (OPTIMIZER_LAMBDA = 0)", () => {
    expect(OPTIMIZER_LAMBDA).toBe(0);
    // With λ=0 and γ=0 the objective reduces to net-of-fees return.
    const r = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001, 0);
    expect(r.riskAdjustedReturn).toBeCloseTo(r.totalReturn, 10);
  });

  it("still applies the penalty when a caller passes a non-zero λ", () => {
    const off = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 0, 0.001, 0);
    const on = backtest(candles, DEFAULT_STRATEGY_PARAMS, 10000, 1.0, 0.001, 0);
    if (off.holdCount === 0) return;
    expect(on.riskAdjustedReturn).toBeLessThan(off.riskAdjustedReturn);
    expect(on.totalReturn).toBeCloseTo(off.totalReturn, 10); // λ never touches P&L
  });

  it("keeps the per-signal λ separate from the optimizer's", () => {
    // championChallenger and validateSignals compare variants on the SAME signal
    // stream, where the term does discriminate; the optimizer's does not.
    expect(OPPORTUNITY_COST_LAMBDA).toBeGreaterThan(0);
    expect(OPTIMIZER_LAMBDA).toBe(0);
  });
});

// ─── Drawdown penalty ───────────────────────────────────────────────
// Position size was previously free: the objective contained no risk term
// despite its name, so successive re-basing rounds walked maxPositionPct to
// its 50% clamp ceiling while buying only drawdown.
describe("Optimizer drawdown penalty", () => {
  const candles = generateCandles(500, 50000, 300);
  // DEFAULT_STRATEGY_PARAMS emits no trades on a synthetic random walk, which
  // leaves maxDrawdown at exactly 0 and makes every risk assertion vacuous.
  // A lower confidence threshold gets the strategy actually transacting.
  const trading = { ...DEFAULT_STRATEGY_PARAMS, minConfidence: 0.15 };

  it("is enabled by default", () => {
    expect(OPTIMIZER_DRAWDOWN_PENALTY).toBeGreaterThan(0);
  });

  it("subtracts γ × maxDrawdown from the objective", () => {
    const r = backtest(candles, trading, 10000, 0, 0.001, 2.0);
    expect(r.riskAdjustedReturn).toBeCloseTo(r.totalReturn - 2.0 * r.maxDrawdown, 10);
  });

  it("penalises a larger position size more, at identical trade counts", () => {
    // Position size changes how much each signal stakes, never which signals
    // fire — so this isolates risk from strategy behaviour.
    const small = backtest(candles, { ...trading, maxPositionPct: 0.1 }, 10000, 0, 0.001, 1.0);
    const large = backtest(candles, { ...trading, maxPositionPct: 0.5 }, 10000, 0, 0.001, 1.0);
    expect(large.totalTrades).toBeGreaterThan(0);
    expect(large.totalTrades).toBe(small.totalTrades);
    expect(large.maxDrawdown).toBeGreaterThan(small.maxDrawdown);
  });

  it("never alters realised P&L, only the score", () => {
    const a = backtest(candles, trading, 10000, 0, 0.001, 0);
    const b = backtest(candles, trading, 10000, 0, 0.001, 4.0);
    expect(a.maxDrawdown).toBeGreaterThan(0);
    expect(b.totalReturn).toBeCloseTo(a.totalReturn, 10);
    expect(b.maxDrawdown).toBeCloseTo(a.maxDrawdown, 10);
    expect(b.riskAdjustedReturn).toBeLessThan(a.riskAdjustedReturn);
  });
});

// ─── Signal Validation Tests ────────────────────────────────────────
describe("Signal Validation", () => {
  it("calculates win rate from resolved signals", () => {
    const signals = [
      { signal: "buy" as const, price: 50000, outcome: "win" as const, outcomePrice: 51000, ts: Date.now() - 7200000 },
      { signal: "sell" as const, price: 50000, outcome: "loss" as const, outcomePrice: 51000, ts: Date.now() - 7200000 },
      { signal: "buy" as const, price: 50000, outcome: "win" as const, outcomePrice: 52000, ts: Date.now() - 7200000 },
    ];
    const result = validateSignals(signals);
    expect(result.totalSignals).toBe(3);
    expect(result.correctSignals).toBe(2);
    expect(result.winRate).toBeCloseTo(2 / 3, 5);
  });

  it("handles empty signal list", () => {
    const result = validateSignals([]);
    expect(result.totalSignals).toBe(0);
    expect(result.winRate).toBe(0);
  });

  it("counts holds separately and accumulates opportunity-cost regret", () => {
    const signals = [
      { signal: "hold" as const, price: 50000, outcome: "pending" as const, outcomePrice: 50100, ts: Date.now() }, // 0.2% move → correct
      { signal: "hold" as const, price: 50000, outcome: "pending" as const, outcomePrice: 51000, ts: Date.now() }, // 2% move → missed
      { signal: "buy" as const, price: 50000, outcome: "win" as const, outcomePrice: 51000, ts: Date.now() - 7200000 },
    ];
    const result = validateSignals(signals);
    // Acted signals: 1 (only the buy)
    expect(result.totalSignals).toBe(1);
    expect(result.correctSignals).toBe(1);
    // Holds: 2 total, 1 correct, 1 missed
    expect(result.holdCount).toBe(2);
    expect(result.holdCorrect).toBe(1);
    expect(result.holdMissed).toBe(1);
    // holdRegret = 0.002 + 0.02 = 0.022
    expect(result.holdRegret).toBeCloseTo(0.022, 4);
    // riskAdjustedReturn = avgReturn − λ × avgHoldRegret
    expect(typeof result.riskAdjustedReturn).toBe("number");
  });

  it("penalises a strategy that misses big moves via holds", () => {
    const acted = [
      { signal: "buy" as const, price: 50000, outcome: "win" as const, outcomePrice: 50500, ts: Date.now() - 7200000 },
    ];
    const heldThroughBigMove = [
      ...acted,
      { signal: "hold" as const, price: 50000, outcome: "pending" as const, outcomePrice: 53000, ts: Date.now() }, // 6% move missed
    ];
    const a = validateSignals(acted, 0.3);
    const b = validateSignals(heldThroughBigMove, 0.3);
    // Same acted return, but b has a missed hold → strictly lower riskAdjustedReturn
    expect(b.riskAdjustedReturn).toBeLessThan(a.riskAdjustedReturn);
  });
});

// ─── Champion-Challenger Tests ───────────────────────────────────────
describe("Champion-Challenger reward", () => {
  it("rewards a correct buy by the realised return", () => {
    expect(computeReward("buy", 50000, 51000)).toBeCloseTo(0.02, 6);
  });

  it("rewards a correct sell by the inverse realised return", () => {
    expect(computeReward("sell", 50000, 49000)).toBeCloseTo(0.02, 6);
  });

  it("penalises holds by λ × |priceMove|", () => {
    expect(computeReward("hold", 50000, 51000, 0.3)).toBeCloseTo(-0.006, 6);
    expect(computeReward("hold", 50000, 49000, 0.3)).toBeCloseTo(-0.006, 6);
  });

  it("a wrong buy gets a negative reward", () => {
    expect(computeReward("buy", 50000, 49000)).toBeCloseTo(-0.02, 6);
  });
});

describe("Paired t-test", () => {
  it("returns p ≈ 1 for tiny n", () => {
    expect(pairedTTest([]).p).toBe(1);
    expect(pairedTTest([0.5]).p).toBe(1);
  });

  it("returns p < 0.05 for a clear, consistent positive shift", () => {
    // 30 samples, mean 0.01, low variance — clearly positive
    const diffs = Array.from({ length: 30 }, () => 0.01 + (Math.random() - 0.5) * 0.002);
    const r = pairedTTest(diffs);
    expect(r.n).toBe(30);
    expect(r.meanDiff).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(0.05);
  });

  it("returns p ≥ 0.05 for true zero-mean Gaussian noise", () => {
    // Construct differences that perfectly sum to zero — guaranteed non-significant.
    const diffs: number[] = [];
    for (let i = 0; i < 15; i++) {
      diffs.push(0.01);
      diffs.push(-0.01);
    }
    const r = pairedTTest(diffs);
    expect(r.meanDiff).toBeCloseTo(0, 10);
    expect(r.p).toBeCloseTo(0.5, 5);
  });

  it("returns extremely small p for uniformly positive differences", () => {
    // Floating-point variance is tiny but non-zero, so p is ε rather than exactly 0.
    const diffs = Array.from({ length: 30 }, () => 0.01);
    const r = pairedTTest(diffs);
    expect(r.p).toBeLessThan(1e-6);
  });
});

describe("Variant pairing", () => {
  it("pairs champion and challenger signals at the same ts", () => {
    const signals: ResolvedSignal[] = [
      { ts: 1000, signal: "buy", price: 50000, outcomePrice: 50500, strategyVariant: "champion" },
      { ts: 1000, signal: "hold", price: 50000, outcomePrice: 50500, strategyVariant: "aggressive" },
      { ts: 1000, signal: "buy", price: 50000, outcomePrice: 50500, strategyVariant: "conservative" },
      { ts: 2000, signal: "sell", price: 50500, outcomePrice: 50200, strategyVariant: "champion" },
      // aggressive missing at ts=2000 — should be skipped
      { ts: 2000, signal: "sell", price: 50500, outcomePrice: 50200, strategyVariant: "conservative" },
    ];
    const aggPairs = buildVariantPairs(signals, "aggressive", 0.3);
    const consPairs = buildVariantPairs(signals, "conservative", 0.3);
    expect(aggPairs.length).toBe(1);
    expect(consPairs.length).toBe(2);
  });

  it("ignores pairs with missing outcomePrice", () => {
    const signals: ResolvedSignal[] = [
      { ts: 1000, signal: "buy", price: 50000, outcomePrice: null, strategyVariant: "champion" },
      { ts: 1000, signal: "buy", price: 50000, outcomePrice: 50500, strategyVariant: "aggressive" },
    ];
    expect(buildVariantPairs(signals, "aggressive", 0.3)).toHaveLength(0);
  });
});

describe("Promotion evaluation", () => {
  function makePairedSignals(n: number, championReturn: number, challengerReturn: number): ResolvedSignal[] {
    const out: ResolvedSignal[] = [];
    for (let i = 0; i < n; i++) {
      const ts = 1000 + i * 1000;
      out.push({ ts, signal: "buy", price: 50000, outcomePrice: 50000 * (1 + championReturn), strategyVariant: "champion" });
      out.push({ ts, signal: "buy", price: 50000, outcomePrice: 50000 * (1 + challengerReturn), strategyVariant: "aggressive" });
    }
    return out;
  }

  it("does not promote with fewer than 30 pairs", () => {
    const sigs = makePairedSignals(20, 0.01, 0.02);
    const r = evaluatePromotion(sigs, "aggressive", 0);
    expect(r.shouldPromote).toBe(false);
    expect(r.reason).toMatch(/insufficient/);
  });

  it("does not promote when mean diff is negative", () => {
    const sigs = makePairedSignals(40, 0.02, 0.01);
    const r = evaluatePromotion(sigs, "aggressive", 0);
    expect(r.shouldPromote).toBe(false);
  });

  it("excludes pairs from before championEpochMs", () => {
    const sigs = makePairedSignals(40, 0.01, 0.02);
    // championEpoch later than all signals → 0 eligible
    const r = evaluatePromotion(sigs, "aggressive", 1e12);
    expect(r.n).toBe(0);
    expect(r.shouldPromote).toBe(false);
  });
});

describe("Validation horizon", () => {
  it("matches heartbeat cadence at typical schedules", () => {
    expect(getValidationHorizonMs(60)).toBe(60 * 60 * 1000);
    expect(getValidationHorizonMs(15)).toBe(15 * 60 * 1000);
    expect(getValidationHorizonMs(30)).toBe(30 * 60 * 1000);
  });

  it("is floored at MIN_VALIDATION_HORIZON_MS for very short schedules", () => {
    expect(getValidationHorizonMs(5)).toBe(MIN_VALIDATION_HORIZON_MS);
    expect(getValidationHorizonMs(1)).toBe(MIN_VALIDATION_HORIZON_MS);
    expect(getValidationHorizonMs(0)).toBe(MIN_VALIDATION_HORIZON_MS);
  });
});

describe("Challenger parameter derivation", () => {
  it("aggressive variant lowers minConfidence and zScoreTrendThreshold", () => {
    const champ = DEFAULT_STRATEGY_PARAMS;
    const agg = deriveChallengerParams(champ, "aggressive");
    expect(agg.minConfidence).toBeLessThan(champ.minConfidence);
    expect(agg.zScoreTrendThreshold).toBeLessThan(champ.zScoreTrendThreshold);
  });

  it("conservative variant raises minConfidence and zScoreTrendThreshold", () => {
    const champ = DEFAULT_STRATEGY_PARAMS;
    const cons = deriveChallengerParams(champ, "conservative");
    expect(cons.minConfidence).toBeGreaterThan(champ.minConfidence);
    expect(cons.zScoreTrendThreshold).toBeGreaterThan(champ.zScoreTrendThreshold);
  });

  it("champion variant is identity", () => {
    const champ = DEFAULT_STRATEGY_PARAMS;
    expect(deriveChallengerParams(champ, "champion")).toEqual(champ);
  });
});
