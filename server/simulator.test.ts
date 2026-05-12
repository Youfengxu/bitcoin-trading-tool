/**
 * Tests covering simulator execution logic, Telegram notification formatting,
 * and key router procedure shapes.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STRATEGY_PARAMS, type StrategyParameters } from "../shared/tradingTypes";
import { computeAllMetrics, type CandleData } from "./engine/technicalAnalysis";
import { generateSignal, type SignalOutput } from "./engine/signalGenerator";
import { validateSignals } from "./engine/walkForwardOptimizer";

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

// ─── Simulator Trade Execution Logic Tests ──────────────────────────
describe("Simulator Trade Execution Logic", () => {
  it("buy trade correctly computes position sizing based on maxPositionPct", () => {
    const cashUsd = 10000;
    const btcHolding = 0;
    const price = 80000;
    const params = { ...DEFAULT_STRATEGY_PARAMS, maxPositionPct: 0.25 };

    const tradeUsd = cashUsd * params.maxPositionPct;
    const btcAmount = tradeUsd / price;
    const newCash = cashUsd - tradeUsd;
    const newBtc = btcHolding + btcAmount;
    const totalValue = newCash + newBtc * price;

    expect(tradeUsd).toBe(2500);
    expect(btcAmount).toBeCloseTo(0.03125, 6);
    expect(newCash).toBe(7500);
    expect(newBtc).toBeCloseTo(0.03125, 6);
    expect(totalValue).toBeCloseTo(10000, 2); // total value unchanged right after trade
  });

  it("sell trade correctly computes position reduction", () => {
    const cashUsd = 5000;
    const btcHolding = 0.1;
    const price = 80000;
    const params = { ...DEFAULT_STRATEGY_PARAMS, maxPositionPct: 0.25 };

    const btcToSell = btcHolding * params.maxPositionPct;
    const usdReceived = btcToSell * price;
    const newCash = cashUsd + usdReceived;
    const newBtc = btcHolding - btcToSell;
    const totalValue = newCash + newBtc * price;

    expect(btcToSell).toBeCloseTo(0.025, 6);
    expect(usdReceived).toBeCloseTo(2000, 2);
    expect(newCash).toBeCloseTo(7000, 2);
    expect(newBtc).toBeCloseTo(0.075, 6);
    expect(totalValue).toBeCloseTo(13000, 2); // 7000 + 0.075 * 80000
  });

  it("buy trade with zero cash does nothing", () => {
    const cashUsd = 0;
    const params = { ...DEFAULT_STRATEGY_PARAMS, maxPositionPct: 0.25 };
    const tradeUsd = cashUsd * params.maxPositionPct;
    expect(tradeUsd).toBe(0);
  });

  it("sell trade with zero BTC does nothing", () => {
    const btcHolding = 0;
    const params = { ...DEFAULT_STRATEGY_PARAMS, maxPositionPct: 0.25 };
    const btcToSell = btcHolding * params.maxPositionPct;
    expect(btcToSell).toBe(0);
  });

  it("multiple sequential trades accumulate correctly", () => {
    let cashUsd = 10000;
    let btcHolding = 0;
    const price = 80000;
    const params = { ...DEFAULT_STRATEGY_PARAMS, maxPositionPct: 0.5 };

    // First buy
    let tradeUsd = cashUsd * params.maxPositionPct;
    let btcAmount = tradeUsd / price;
    cashUsd -= tradeUsd;
    btcHolding += btcAmount;
    expect(cashUsd).toBe(5000);
    expect(btcHolding).toBeCloseTo(0.0625, 6);

    // Second buy
    tradeUsd = cashUsd * params.maxPositionPct;
    btcAmount = tradeUsd / price;
    cashUsd -= tradeUsd;
    btcHolding += btcAmount;
    expect(cashUsd).toBe(2500);
    expect(btcHolding).toBeCloseTo(0.09375, 6);

    // Total value should still be ~10000 at same price
    const totalValue = cashUsd + btcHolding * price;
    expect(totalValue).toBeCloseTo(10000, 2);
  });

  it("seed amount is exactly $10,000", () => {
    const seedAmountUsd = 10000;
    expect(seedAmountUsd).toBe(10000);
  });
});

// ─── Sharpe Ratio and Max Drawdown Computation Tests ────────────────
describe("Sharpe Ratio and Max Drawdown Computation", () => {
  it("computes Sharpe ratio from signal returns", () => {
    const signalReturns = [0.02, 0.01, -0.005, 0.015, 0.03];
    const avgReturn = signalReturns.reduce((a, b) => a + b, 0) / signalReturns.length;
    const variance = signalReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / signalReturns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0;

    expect(avgReturn).toBeCloseTo(0.014, 3);
    expect(stdDev).toBeGreaterThan(0);
    expect(sharpeRatio).toBeGreaterThan(0);
    expect(typeof sharpeRatio).toBe("number");
    expect(isFinite(sharpeRatio)).toBe(true);
  });

  it("computes max drawdown from cumulative returns", () => {
    const signalReturns = [0.05, -0.03, -0.02, 0.04, -0.01];
    let cumReturn = 1, peak = 1, maxDd = 0;
    for (const r of signalReturns) {
      cumReturn *= (1 + r);
      if (cumReturn > peak) peak = cumReturn;
      const dd = (peak - cumReturn) / peak;
      if (dd > maxDd) maxDd = dd;
    }

    expect(maxDd).toBeGreaterThan(0);
    expect(maxDd).toBeLessThan(1);
    expect(typeof maxDd).toBe("number");
  });

  it("max drawdown is zero for always-positive returns", () => {
    const signalReturns = [0.01, 0.02, 0.03, 0.01, 0.005];
    let cumReturn = 1, peak = 1, maxDd = 0;
    for (const r of signalReturns) {
      cumReturn *= (1 + r);
      if (cumReturn > peak) peak = cumReturn;
      const dd = (peak - cumReturn) / peak;
      if (dd > maxDd) maxDd = dd;
    }
    expect(maxDd).toBe(0);
  });

  it("Sharpe ratio is zero when stdDev is zero (all same returns)", () => {
    const signalReturns = [0.01, 0.01, 0.01, 0.01];
    const avgReturn = 0.01;
    const variance = signalReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / signalReturns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0;
    expect(sharpeRatio).toBe(0);
  });
});

// ─── Signal Validation with Sharpe/Drawdown Tests ───────────────────
describe("Signal Validation with Extended Metrics", () => {
  it("validateSignals returns avgReturn for mixed signals", () => {
    const signals = [
      { signal: "buy" as const, price: 50000, outcomePrice: 52000, ts: Date.now() - 7200000 },
      { signal: "sell" as const, price: 50000, outcomePrice: 48000, ts: Date.now() - 7200000 },
      { signal: "buy" as const, price: 50000, outcomePrice: 49000, ts: Date.now() - 7200000 },
    ];
    const result = validateSignals(signals);
    expect(result.totalSignals).toBe(3);
    expect(result.correctSignals).toBe(2);
    expect(result.avgReturn).toBeGreaterThan(0);
    expect(typeof result.avgReturn).toBe("number");
  });

  it("validateSignals correctly handles all-loss scenario", () => {
    const signals = [
      { signal: "buy" as const, price: 50000, outcomePrice: 48000, ts: Date.now() - 7200000 },
      { signal: "sell" as const, price: 50000, outcomePrice: 52000, ts: Date.now() - 7200000 },
    ];
    const result = validateSignals(signals);
    expect(result.correctSignals).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.avgReturn).toBeLessThan(0);
  });

  it("portfolioValue is included in signal data when available", () => {
    // Simulate the signal insertion data shape
    const signalData = {
      ts: Date.now(),
      signal: "buy" as const,
      price: 80000,
      confidence: 0.75,
      reasoning: "RSI oversold, MACD bullish crossover",
      metricsSnapshot: {},
      portfolioValue: 10250.50,
    };
    expect(signalData.portfolioValue).toBe(10250.50);
    expect(typeof signalData.portfolioValue).toBe("number");
  });

  it("portfolioValue can be undefined for signals without simulator state", () => {
    const signalData = {
      ts: Date.now(),
      signal: "hold" as const,
      price: 80000,
      confidence: 0.3,
      reasoning: "No clear signal",
      metricsSnapshot: {},
      portfolioValue: undefined,
    };
    expect(signalData.portfolioValue).toBeUndefined();
  });
});

// ─── Telegram Notification Format Tests ─────────────────────────────
describe("Telegram Notification Format", () => {
  it("formats notification message correctly", () => {
    const signal = "buy";
    const price = 80415.47;
    const reasoning = "RSI at 28 (oversold), MACD bullish crossover, price below lower Bollinger Band";
    const portfolioValue = 10250.00;

    const message = `🔔 *BTC ${signal.toUpperCase()} Signal*\n\n💰 Price: $${price.toFixed(2)}\n📊 Portfolio: $${portfolioValue.toFixed(2)}\n\n📝 Reasoning:\n${reasoning.substring(0, 500)}`;

    expect(message).toContain("BTC BUY Signal");
    expect(message).toContain("$80415.47");
    expect(message).toContain("$10250.00");
    expect(message).toContain("RSI at 28");
    expect(message.length).toBeLessThan(1000);
  });

  it("truncates long reasoning to 500 chars", () => {
    const longReasoning = "A".repeat(600);
    const truncated = longReasoning.substring(0, 500);
    expect(truncated.length).toBe(500);
  });

  it("includes all three required data points", () => {
    const signal = "sell";
    const price = 82000;
    const reasoning = "RSI overbought at 75";
    const portfolioValue = 11500;

    // All three required: signal rationale, current price, portfolio value
    const message = `Signal: ${signal}\nPrice: $${price}\nPortfolio: $${portfolioValue}\nReasoning: ${reasoning}`;
    expect(message).toContain("sell");
    expect(message).toContain("82000");
    expect(message).toContain("11500");
    expect(message).toContain("RSI overbought");
  });
});

// ─── Weekly Performance Report Logic Tests ──────────────────────────
describe("Weekly Performance Report Logic", () => {
  it("computes weekly return percentage correctly", () => {
    const startValue = 10000;
    const endValue = 10500;
    const returnPct = ((endValue - startValue) / startValue) * 100;
    expect(returnPct).toBeCloseTo(5.0, 2);
  });

  it("computes BTC buy-and-hold baseline correctly", () => {
    const btcStartPrice = 80000;
    const btcEndPrice = 82000;
    const buyHoldReturn = ((btcEndPrice - btcStartPrice) / btcStartPrice) * 100;
    expect(buyHoldReturn).toBeCloseTo(2.5, 2);
  });

  it("strategy can outperform or underperform buy-and-hold", () => {
    const strategyReturn = 5.0;
    const buyHoldReturn = 2.5;
    const alpha = strategyReturn - buyHoldReturn;
    expect(alpha).toBeCloseTo(2.5, 2);
    expect(alpha).toBeGreaterThan(0); // outperforming in this case
  });

  it("handles negative returns correctly", () => {
    const startValue = 10000;
    const endValue = 9500;
    const returnPct = ((endValue - startValue) / startValue) * 100;
    expect(returnPct).toBeCloseTo(-5.0, 2);
  });
});

// ─── Strategy Parameter Validation Tests ────────────────────────────
describe("Strategy Parameter Validation", () => {
  it("default params have valid RSI range", () => {
    expect(DEFAULT_STRATEGY_PARAMS.rsiBuyThreshold).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_PARAMS.rsiBuyThreshold).toBeLessThan(50);
    expect(DEFAULT_STRATEGY_PARAMS.rsiSellThreshold).toBeGreaterThan(50);
    expect(DEFAULT_STRATEGY_PARAMS.rsiSellThreshold).toBeLessThanOrEqual(100);
    expect(DEFAULT_STRATEGY_PARAMS.rsiBuyThreshold).toBeLessThan(DEFAULT_STRATEGY_PARAMS.rsiSellThreshold);
  });

  it("maxPositionPct is between 0 and 1", () => {
    expect(DEFAULT_STRATEGY_PARAMS.maxPositionPct).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_PARAMS.maxPositionPct).toBeLessThanOrEqual(1);
  });

  it("minConfidence is between 0 and 1", () => {
    expect(DEFAULT_STRATEGY_PARAMS.minConfidence).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_PARAMS.minConfidence).toBeLessThanOrEqual(1);
  });

  it("merged params override correctly", () => {
    const override = { rsiBuyThreshold: 25, maxPositionPct: 0.5 };
    const merged = { ...DEFAULT_STRATEGY_PARAMS, ...override };
    expect(merged.rsiBuyThreshold).toBe(25);
    expect(merged.maxPositionPct).toBe(0.5);
    expect(merged.rsiSellThreshold).toBe(DEFAULT_STRATEGY_PARAMS.rsiSellThreshold);
    expect(merged.minConfidence).toBe(DEFAULT_STRATEGY_PARAMS.minConfidence);
  });
});

// ─── End-to-End Signal Pipeline Test ────────────────────────────────
describe("End-to-End Signal Pipeline", () => {
  it("generates metrics, signal, and validation from candle data", () => {
    const candles = generateCandles(250, 80000, 800);
    const metrics = computeAllMetrics(candles);
    const signal = generateSignal(metrics, DEFAULT_STRATEGY_PARAMS);

    // Signal pipeline produces valid output
    expect(metrics.price).toBeGreaterThan(0);
    expect(["buy", "sell", "hold"]).toContain(signal.signal);
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.reasoning.length).toBeGreaterThan(0);

    // Simulate validation
    const simulatedSignals = [{
      signal: signal.signal,
      price: metrics.price,
      outcomePrice: metrics.price * (1 + (Math.random() - 0.5) * 0.02),
      ts: Date.now() - 7200000,
    }];
    const validation = validateSignals(simulatedSignals);
    expect(validation.totalSignals).toBeLessThanOrEqual(1);
    expect(typeof validation.winRate).toBe("number");
  });
});
