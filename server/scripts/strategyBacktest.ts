/**
 * Strategy Backtest — portfolio-level equity simulation
 *
 * The existing historicalSignalReplay.ts measures *signal* quality
 * (precision / recall of sell signals vs a -2% 24h drop). It does not tell you
 * what the portfolio would have been worth. This script closes that gap: it
 * replays the production trading loop bar-by-bar and produces an equity curve,
 * so candidate improvements can be compared on return, drawdown, Sharpe,
 * turnover and fee drag — the things that actually decide whether a change is
 * worth shipping.
 *
 * Fidelity to production (server/heartbeatHandler.ts::runSignalGeneration):
 *   - 336-bar (14-day) ROLLING window into computeAllMetrics, not an expanding
 *     window. This matters: cusum(), hurst() and adx() consume the entire array
 *     they are handed, so an expanding window silently computes different
 *     indicator values than the live engine ever sees.
 *   - Same external modifier pipeline (applyExternalModifiers + signalFromScores).
 *   - Same "two identical non-hold signals in a row" confirmation buffer.
 *   - Same fractional sizing: buy spends maxPositionPct of *cash*, sell disposes
 *     of maxPositionPct of *BTC held*.
 *
 * Deliberate difference from production: trading costs are modelled. The live
 * simulator applies none, which flatters any high-turnover strategy.
 *
 * Usage:
 *   pnpm tsx server/scripts/strategyBacktest.ts
 *   pnpm tsx server/scripts/strategyBacktest.ts --fee-bps=26
 *   pnpm tsx server/scripts/strategyBacktest.ts --oos      # held-out earlier period
 *   pnpm tsx server/scripts/strategyBacktest.ts --both     # live period + held-out
 *   pnpm tsx server/scripts/strategyBacktest.ts --json=out.json
 *
 * OVERFITTING CAVEAT:
 *   The live window (2026-05-15 → 2026-08-15) is a single sustained BTC
 *   downtrend. Any variant that reduces long exposure will look good on it.
 *   Always read the --oos column before believing a result.
 */

import { computeAllMetrics, type CandleData, type AllMetrics } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import { applyExternalModifiers, signalFromScores } from "../engine/externalModifiers";
import type { ExternalSignals } from "../engine/externalModifiers";
import { getCandleLimit } from "../../shared/tradingTypes";
import type { StrategyParameters } from "../../shared/tradingTypes";
import {
  fetchExternalHistory,
  availabilityReport,
  getExternalAt,
  type ExternalHistory,
} from "./externalHistory";
import * as fs from "fs";
import * as path from "path";

// ─── CLI ──────────────────────────────────────────────────────────────
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const FEE_BPS = arg("fee-bps") ? parseFloat(arg("fee-bps")!) : 10; // 10bps = 0.10% per side
const JSON_OUT = arg("json") ?? null;
const RUN_OOS = process.argv.includes("--oos") || process.argv.includes("--both");
const RUN_LIVE = !process.argv.includes("--oos") || process.argv.includes("--both");
const CACHE_DIR = arg("cache") ?? "/tmp/btc-backtest-cache";
/** Block length in days for the rolling-block robustness table; 0 disables it. */
const WALK_DAYS = arg("walk") ? parseInt(arg("walk")!) : 0;

const FEE = FEE_BPS / 10000;
const HOUR_MS = 3600_000;
const BARS_PER_YEAR = 24 * 365;

/**
 * Production strategy_params version 8, read from the live deployment on
 * 2026-08-15. These are the parameters the walk-forward optimizer converged on
 * and that generated the live track record, so the baseline must use them.
 */
const LIVE_PARAMS: StrategyParameters = {
  rsiBuyThreshold: 25.12404464218533,
  rsiSellThreshold: 78.79435071559678,
  macdBuyThreshold: 0,
  macdSellThreshold: 0,
  bbBuyDeviation: 0,
  bbSellDeviation: 0,
  zScoreTrendThreshold: 2.7968572629458825,
  zScoreBlipThreshold: 0.47023825869920566,
  volumeRatioThreshold: 1,
  emaCrossoverWeight: 0.19452407650816259,
  maxPositionPct: 0.14289201467869658,
  minConfidence: 0.3,
};

/** Live trading started 2026-05-14 17:11 UTC with a $10,000 seed. */
const SEED_USD = 10000;
const LIVE_START_MS = Date.parse("2026-05-15T00:00:00Z");

// ─── Variant definition ───────────────────────────────────────────────

interface Position {
  cash: number;
  btc: number;
  /** Highest close seen since the position was last increased — for trailing stops. */
  peakSinceEntry: number;
  /** Bar index of the last executed trade — for cooldowns. */
  lastTradeBar: number;
  /** Bars remaining during which re-entry is blocked (set by a stop-out). */
  reentryBlockedUntil: number;
}

interface Decision {
  action: "buy" | "sell" | "hold";
  /** Fraction of cash (buy) or of BTC held (sell) to transact. */
  fraction: number;
  tag?: string;
}

interface VariantContext {
  bar: number;
  candle: CandleData;
  metrics: AllMetrics;
  /** Post-external-modifier signal, exactly as production computes it. */
  signal: "buy" | "sell" | "hold";
  confidence: number;
  /** True when the same non-hold direction has now appeared twice in a row. */
  confirmed: boolean;
  pos: Position;
  params: StrategyParameters;
  /** Average true range over 14 bars as a fraction of price. */
  atrPct: number | null;
  /** Post-external-modifier raw buy score (pre-threshold). */
  rawBuy: number;
  /** Post-external-modifier raw sell score (pre-threshold). */
  rawSell: number;
  /** Current BTC weight of the portfolio, 0–1. */
  weight: number;
}

interface Variant {
  name: string;
  blurb: string;
  params?: Partial<StrategyParameters>;
  /** Set false to strip external modifiers (ablation). */
  useExternal?: boolean;
  decide: (c: VariantContext) => Decision;
}

// ─── Baseline decision rule (production) ──────────────────────────────
const baselineDecide = (c: VariantContext): Decision =>
  c.confirmed && c.signal !== "hold"
    ? { action: c.signal, fraction: c.params.maxPositionPct }
    : { action: "hold", fraction: 0 };

// ─── Candles ──────────────────────────────────────────────────────────
async function fetchHourlyCandles(range: string): Promise<CandleData[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `btc-1h-${range}.json`);
  if (fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < 6 * HOUR_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as CandleData[];
    }
  }

  const res = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1h&range=${range}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-backtest/1.0)" } }
  );
  if (!res.ok) throw new Error(`Yahoo Finance BTC-USD ${res.status}`);
  const data = (await res.json()) as {
    chart: {
      result?: Array<{
        timestamp: number[];
        indicators: {
          quote: Array<{
            open: (number | null)[];
            high: (number | null)[];
            low: (number | null)[];
            close: (number | null)[];
            volume: (number | null)[];
          }>;
        };
      }>;
    };
  };
  const chart = data.chart.result?.[0];
  if (!chart) throw new Error("No chart result from Yahoo Finance");
  const q = chart.indicators.quote[0];
  const candles: CandleData[] = [];
  for (let i = 0; i < chart.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (!o || !h || !l || !c) continue; // skip gap bars
    candles.push({ openTime: chart.timestamp[i] * 1000, open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  candles.sort((a, b) => a.openTime - b.openTime);
  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  return candles;
}

// ─── ATR ──────────────────────────────────────────────────────────────
function atrPct(candles: CandleData[], end: number, period = 14): number | null {
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const cur = candles[i], prev = candles[i - 1];
    sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return sum / period / candles[end].close;
}

// ─── Per-bar precomputation ───────────────────────────────────────────
/**
 * Metrics and external signals depend only on the candle window and the two
 * z-score thresholds, not on the rest of the parameter set, so they are computed
 * once and shared across every variant. This is what makes running a dozen
 * variants over 2,000 bars cheap.
 */
interface BarContext {
  candle: CandleData;
  metrics: AllMetrics;
  ext: ExternalSignals;
  atrPct: number | null;
}

function precompute(
  candles: CandleData[],
  startIdx: number,
  endIdx: number,
  params: StrategyParameters,
  history: ExternalHistory | null
): BarContext[] {
  const scope = getCandleLimit("1h"); // 336 bars — identical to production
  const out: BarContext[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const window = candles.slice(Math.max(0, i - scope + 1), i + 1);
    const metrics = computeAllMetrics(window, params.zScoreTrendThreshold, params.zScoreBlipThreshold);

    let ext: ExternalSignals = {
      fundingRate: null, fundingNegDivergence: false, fearGreed: null,
      yieldVelocity: null, etfNetflow7dSma: null, ibitFlow7d: null,
    };
    if (history) {
      const rollingHigh14d = window.reduce((mx, c) => Math.max(mx, c.close), 0);
      ext = getExternalAt(candles[i].openTime, history, candles[i].close, rollingHigh14d);
    }
    out.push({ candle: candles[i], metrics, ext, atrPct: atrPct(candles, i) });
  }
  return out;
}

// ─── Backtest engine ──────────────────────────────────────────────────
export interface BacktestResult {
  name: string;
  blurb: string;
  finalValue: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  buys: number;
  sells: number;
  feesPaid: number;
  turnoverUsd: number;
  /** Average fraction of portfolio value held in BTC. */
  avgExposure: number;
  /**
   * Return of a zero-effort static blend that buys `avgExposure` of the seed in
   * BTC at bar 0 and never trades again. This is the fair control: any strategy
   * that merely reduces exposure will match it. Alpha is what is left over.
   */
  matchedBlendReturn: number;
  /** totalReturn − matchedBlendReturn. The part not explained by exposure alone. */
  alpha: number;
  equity: number[];
}

/**
 * Return of buying `weight` of the seed in BTC at bar 0 and holding the rest in
 * cash, with no further trading. Used as the exposure-matched control.
 */
function staticBlendReturn(bars: BarContext[], weight: number): number {
  const w = Math.max(0, Math.min(1, weight));
  const entry = bars[0].candle.close;
  const exit = bars[bars.length - 1].candle.close;
  const btc = (SEED_USD * w * (1 - FEE)) / entry;
  const cash = SEED_USD * (1 - w);
  return (cash + btc * exit) / SEED_USD - 1;
}

function runVariant(bars: BarContext[], variant: Variant): BacktestResult {
  const params: StrategyParameters = { ...LIVE_PARAMS, ...(variant.params ?? {}) };
  const useExternal = variant.useExternal !== false;

  const pos: Position = {
    cash: SEED_USD, btc: 0, peakSinceEntry: 0, lastTradeBar: -9999, reentryBlockedUntil: -1,
  };
  const buffer: ("buy" | "sell")[] = [];
  const equity: number[] = [];
  let feesPaid = 0, turnoverUsd = 0, buys = 0, sells = 0, exposureSum = 0;

  for (let i = 0; i < bars.length; i++) {
    const { candle, metrics, ext } = bars[i];
    const price = candle.close;

    // ── Signal, exactly as production derives it ────────────────────
    const base = generateSignal(metrics, params);
    let signal: "buy" | "sell" | "hold";
    let confidence: number;
    let rawBuy = base.rawBuyScore;
    let rawSell = base.rawSellScore;
    if (useExternal) {
      const { modBuy, modSell } = applyExternalModifiers(base.rawBuyScore, base.rawSellScore, ext);
      const enh = signalFromScores(modBuy, modSell, params.minConfidence);
      signal = enh.signal;
      confidence = enh.confidence;
      rawBuy = modBuy;
      rawSell = modSell;
    } else {
      signal = base.signal;
      confidence = base.confidence;
    }

    // ── Two-in-a-row confirmation buffer ────────────────────────────
    if (signal !== "hold") {
      buffer.push(signal);
      if (buffer.length > 2) buffer.shift();
    }
    const confirmed = signal !== "hold" && buffer.length === 2 && buffer[0] === buffer[1];

    if (pos.btc > 0) pos.peakSinceEntry = Math.max(pos.peakSinceEntry, price);

    const valueBefore = pos.cash + pos.btc * price;
    const decision = variant.decide({
      bar: i, candle, metrics, signal, confidence, confirmed, pos, params, atrPct: bars[i].atrPct,
      rawBuy, rawSell,
      weight: valueBefore > 0 ? (pos.btc * price) / valueBefore : 0,
    });

    // ── Execute ─────────────────────────────────────────────────────
    const f = Math.max(0, Math.min(1, decision.fraction));
    if (decision.action === "buy" && f > 0 && pos.cash > 0) {
      const tradeUsd = pos.cash * f;
      const fee = tradeUsd * FEE;
      pos.btc += (tradeUsd - fee) / price;
      pos.cash -= tradeUsd;
      feesPaid += fee;
      turnoverUsd += tradeUsd;
      buys++;
      pos.lastTradeBar = i;
      pos.peakSinceEntry = Math.max(pos.peakSinceEntry, price);
    } else if (decision.action === "sell" && f > 0 && pos.btc > 0) {
      const btcSold = pos.btc * f;
      const gross = btcSold * price;
      const fee = gross * FEE;
      pos.cash += gross - fee;
      pos.btc -= btcSold;
      feesPaid += fee;
      turnoverUsd += gross;
      sells++;
      pos.lastTradeBar = i;
      if (pos.btc <= 1e-12) pos.peakSinceEntry = 0;
    }

    const value = pos.cash + pos.btc * price;
    equity.push(value);
    exposureSum += value > 0 ? (pos.btc * price) / value : 0;
  }

  // ── Metrics ───────────────────────────────────────────────────────
  const finalValue = equity[equity.length - 1];
  let peak = equity[0], maxDrawdown = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }

  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(BARS_PER_YEAR) : 0;

  const avgExposure = exposureSum / bars.length;
  const totalReturn = finalValue / SEED_USD - 1;
  const matchedBlendReturn = staticBlendReturn(bars, avgExposure);

  return {
    name: variant.name,
    blurb: variant.blurb,
    finalValue,
    totalReturn,
    maxDrawdown,
    sharpe,
    trades: buys + sells,
    buys,
    sells,
    feesPaid,
    turnoverUsd,
    avgExposure,
    matchedBlendReturn,
    alpha: totalReturn - matchedBlendReturn,
    equity,
  };
}

function buyAndHold(bars: BarContext[]): BacktestResult {
  const entry = bars[0].candle.close;
  const btc = (SEED_USD * (1 - FEE)) / entry;
  const equity = bars.map((b) => btc * b.candle.close);
  const finalValue = equity[equity.length - 1];
  let peak = equity[0], maxDrawdown = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  return {
    name: "BENCHMARK buy & hold",
    blurb: "Buy BTC at bar 0, never trade",
    finalValue,
    totalReturn: finalValue / SEED_USD - 1,
    maxDrawdown,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(BARS_PER_YEAR) : 0,
    trades: 1, buys: 1, sells: 0,
    feesPaid: SEED_USD * FEE,
    turnoverUsd: SEED_USD,
    avgExposure: 1,
    matchedBlendReturn: finalValue / SEED_USD - 1,
    alpha: 0,
    equity,
  };
}

// ─── Composable rule fragments ────────────────────────────────────────
// Each fragment is a small, independently testable behaviour change. The
// combined variants below are literally these fragments chained, so a
// combination can never silently drift from the option it claims to combine.

/** OPT1: minimum bars between trades and a minimum trade notional. */
function turnoverControl(c: VariantContext, d: Decision, cooldownBars = 12, minNotional = 300): Decision {
  if (d.action === "hold") return d;
  if (c.bar - c.pos.lastTradeBar < cooldownBars) return { action: "hold", fraction: 0, tag: "cooldown" };
  const notional = d.action === "buy" ? c.pos.cash * d.fraction : c.pos.btc * d.fraction * c.candle.close;
  if (notional < minNotional) return { action: "hold", fraction: 0, tag: "too-small" };
  return d;
}

/** OPT2: only trade in the direction the 200-bar SMA sanctions. */
function sma200Gate(c: VariantContext, d: Decision): Decision {
  if (d.action === "hold" || c.metrics.sma200 === null) return d;
  const above = c.candle.close > c.metrics.sma200;
  if (d.action === "buy" && !above) return { action: "hold", fraction: 0, tag: "below-sma200" };
  if (d.action === "sell" && above) return { action: "hold", fraction: 0, tag: "above-sma200" };
  return d;
}

/** OPT3: hard exit on a 3×ATR fall from the running peak, then a re-entry lockout. */
function atrStop(c: VariantContext, mult = 3, lockoutBars = 24): Decision | null {
  if (c.pos.btc > 0 && c.atrPct !== null && c.pos.peakSinceEntry > 0) {
    if (c.candle.close < c.pos.peakSinceEntry * (1 - mult * c.atrPct)) {
      c.pos.reentryBlockedUntil = c.bar + lockoutBars;
      return { action: "sell", fraction: 1, tag: "atr-stop" };
    }
  }
  return null;
}

/**
 * Converts a desired BTC portfolio weight into the fraction-of-cash /
 * fraction-of-BTC form the executor expects, and applies a no-trade band so
 * tiny drifts do not generate a fee-paying trade.
 */
function toTargetWeight(c: VariantContext, target: number, bandPct = 0.05): Decision {
  const t = Math.max(0, Math.min(1, target));
  const w = c.weight;
  if (Math.abs(t - w) < bandPct) return { action: "hold", fraction: 0, tag: "in-band" };
  if (t > w) return { action: "buy", fraction: w >= 1 ? 0 : (t - w) / (1 - w), tag: "rebal-up" };
  return { action: "sell", fraction: w <= 0 ? 0 : (w - t) / w, tag: "rebal-down" };
}

/** OPT4: scale trade size 0.5×–2× with how far confidence clears the threshold. */
function convictionSize(c: VariantContext, d: Decision): Decision {
  if (d.action === "hold") return d;
  const span = Math.max(0.01, 1 - c.params.minConfidence);
  const t = Math.max(0, Math.min(1, (c.confidence - c.params.minConfidence) / span));
  return { action: d.action, fraction: Math.min(1, d.fraction * (0.5 + 1.5 * t)) };
}

// ─── Candidate variants ───────────────────────────────────────────────
export const VARIANTS: Variant[] = [
  {
    name: "A0 baseline (production)",
    blurb: "Current live logic: conf≥0.30, 14.3% fractional sizing, 2-bar confirm",
    decide: baselineDecide,
  },
  {
    name: "A1 baseline, no external mods",
    blurb: "Ablation: same as A0 with funding/F&G/yield modifiers stripped",
    useExternal: false,
    decide: baselineDecide,
  },

  // ── Option 1 — turnover control ────────────────────────────────────
  {
    name: "OPT1 turnover control",
    blurb: "12-bar cooldown between trades + $300 minimum trade notional",
    decide: (c) => turnoverControl(c, baselineDecide(c)),
  },

  // ── Option 2 — trend regime gate ───────────────────────────────────
  {
    name: "OPT2 SMA200 regime gate",
    blurb: "Block buys below SMA200, block sells above SMA200 (trade with the trend)",
    decide: (c) => sma200Gate(c, baselineDecide(c)),
  },

  // ── Option 3 — ATR trailing stop ───────────────────────────────────
  {
    name: "OPT3 ATR trailing stop",
    blurb: "Liquidate BTC on a 3×ATR fall from the running peak; 24-bar re-entry lockout",
    decide: (c) => {
      const stop = atrStop(c);
      if (stop) return stop;
      const d = baselineDecide(c);
      if (d.action === "buy" && c.bar < c.pos.reentryBlockedUntil) {
        return { action: "hold", fraction: 0, tag: "reentry-lockout" };
      }
      return d;
    },
  },

  // ── Option 4 — conviction sizing ───────────────────────────────────
  {
    name: "OPT4 conviction sizing",
    blurb: "minConfidence back to 0.45; size scales 0.5×–2× with confidence above threshold",
    params: { minConfidence: 0.45 },
    decide: (c) => convictionSize(c, baselineDecide(c)),
  },

  // ── Control: is the edge the indicators, or just rebalancing? ──────
  // The production rule buys a slice of cash on dips and sells a slice of BTC
  // on rips. That is structurally a constant-mix portfolio, which harvests a
  // rebalancing premium in choppy markets regardless of whether the signals
  // carry information. This variant strips the signal engine out entirely and
  // keeps only the rebalancing. If it matches the baseline, the eight indicator
  // layers are decoration.
  {
    name: "CTRL constant-mix 50%",
    blurb: "NO SIGNALS. Rebalance to 50% BTC whenever weight drifts >5pp",
    decide: (c) => toTargetWeight(c, 0.5),
  },

  // ── Option 8 — signal-tilted constant mix ──────────────────────────
  {
    name: "OPT8 signal-tilted mix",
    blurb: "Target weight = 50% tilted ±30pp by (buy−sell) score; 5pp no-trade band",
    decide: (c) => toTargetWeight(c, 0.5 + 0.5 * (c.rawBuy - c.rawSell)),
  },

  // ── Ablation of OPT4: is the gain the threshold or the sizing? ─────
  {
    name: "OPT9 minConfidence 0.45",
    blurb: "One-line change: raise minConfidence 0.30→0.45, sizing untouched",
    params: { minConfidence: 0.45 },
    decide: baselineDecide,
  },

  // ── Combinations ───────────────────────────────────────────────────
  {
    name: "OPT5 = 1 + 4",
    blurb: "Turnover control + conviction sizing (no directional regime bet)",
    params: { minConfidence: 0.45 },
    decide: (c) => turnoverControl(c, convictionSize(c, baselineDecide(c))),
  },
  {
    name: "OPT6 = 1 + 2 + 4",
    blurb: "Turnover control + SMA200 gate + conviction sizing",
    params: { minConfidence: 0.45 },
    decide: (c) => turnoverControl(c, sma200Gate(c, convictionSize(c, baselineDecide(c)))),
  },
  {
    name: "OPT7 = 1 + 2 + 3 + 4",
    blurb: "Everything, including the ATR stop — kept to show the stop's cost",
    params: { minConfidence: 0.45 },
    decide: (c) => {
      const stop = atrStop(c);
      if (stop) return stop;
      const d = baselineDecide(c);
      if (d.action === "buy" && c.bar < c.pos.reentryBlockedUntil) return { action: "hold", fraction: 0 };
      return turnoverControl(c, sma200Gate(c, convictionSize(c, d)));
    },
  },
];

// ─── Reporting ────────────────────────────────────────────────────────
function pct(n: number, digits = 2) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}
function pad(s: string | number, w: number, right = false) {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

function printTable(title: string, results: BacktestResult[], bh: BacktestResult) {
  const W = 122;
  console.log(`\n${title}`);
  console.log("─".repeat(W));
  console.log(
    pad("Variant", 28) + pad("Final $", 10, true) + pad("Return", 9, true) +
    pad("Exposure", 10, true) + pad("Blend", 9, true) + pad("ALPHA", 9, true) +
    pad("MaxDD", 8, true) + pad("Sharpe", 8, true) + pad("Trades", 8, true) + pad("Fees $", 8, true)
  );
  console.log(
    pad("", 28) + pad("", 10) + pad("", 9) + pad("", 10) +
    pad("same-exp", 9, true) + pad("ret−blend", 9, true)
  );
  console.log("─".repeat(W));
  for (const r of [bh, ...results]) {
    console.log(
      pad(r.name, 28) +
      pad(r.finalValue.toFixed(0), 10, true) +
      pad(pct(r.totalReturn), 9, true) +
      pad(`${(r.avgExposure * 100).toFixed(0)}%`, 10, true) +
      pad(pct(r.matchedBlendReturn), 9, true) +
      pad(pct(r.alpha), 9, true) +
      pad(`${(r.maxDrawdown * 100).toFixed(1)}%`, 8, true) +
      pad(r.sharpe.toFixed(2), 8, true) +
      pad(r.trades, 8, true) +
      pad(r.feesPaid.toFixed(0), 8, true)
    );
  }
  console.log("─".repeat(W));
  console.log(
    "Blend = buy `Exposure` of the seed in BTC at bar 0 and never trade again (zero-effort control).\n" +
    "ALPHA = the part of the return NOT explained by simply holding that much BTC. This is the only\n" +
    "        column that says whether the signal engine is doing anything a static allocation can't."
  );
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const hr = "═".repeat(118);
  console.log(`\n${hr}`);
  console.log(`BTC Strategy Backtest  ·  seed $${SEED_USD.toLocaleString()}  ·  fee ${FEE_BPS}bps/side  ·  1h bars`);
  console.log(hr);

  // 6mo of hourly bars: enough for a 336-bar warm-up before the live window
  // plus a held-out earlier period of comparable length.
  const candles = await fetchHourlyCandles("6mo");
  console.log(
    `\nCandles: ${candles.length} ` +
    `(${new Date(candles[0].openTime).toISOString().slice(0, 10)} → ` +
    `${new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10)})`
  );

  const history = await fetchExternalHistory(190);
  const avail = availabilityReport(history);
  console.log("External feeds:");
  for (const [k, v] of Object.entries(avail)) console.log(`  ${pad(k + ":", 12)} ${v}`);

  const scope = getCandleLimit("1h");
  const liveStartIdx = candles.findIndex((c) => c.openTime >= LIVE_START_MS);
  if (liveStartIdx < scope) {
    throw new Error(`Not enough warm-up bars before the live window (need ${scope}, have ${liveStartIdx}).`);
  }

  const periods: Array<{ label: string; from: number; to: number }> = [];
  if (RUN_LIVE) {
    periods.push({ label: "LIVE PERIOD (matches the deployed track record)", from: liveStartIdx, to: candles.length - 1 });
  }
  if (RUN_OOS) {
    // Held-out window: everything between the end of warm-up and the live start.
    periods.push({ label: "HELD-OUT PERIOD (before the tool went live)", from: scope, to: liveStartIdx - 1 });
  }

  const report: Record<string, unknown> = { feeBps: FEE_BPS, generatedAt: new Date().toISOString(), periods: [] };

  for (const period of periods) {
    const from = new Date(candles[period.from].openTime).toISOString().slice(0, 10);
    const to = new Date(candles[period.to].openTime).toISOString().slice(0, 10);
    const days = ((candles[period.to].openTime - candles[period.from].openTime) / (24 * HOUR_MS)).toFixed(0);
    console.log(`\n${hr}`);
    console.log(`${period.label}`);
    console.log(`${from} → ${to}  (${period.to - period.from + 1} bars, ~${days} days)`);
    console.log(hr);

    process.stdout.write("Precomputing indicators... ");
    const bars = precompute(candles, period.from, period.to, LIVE_PARAMS, history);
    console.log(`${bars.length} bars ready`);

    const bh = buyAndHold(bars);
    const results = VARIANTS.map((v) => runVariant(bars, v));
    printTable("Results", results, bh);

    (report.periods as unknown[]).push({
      label: period.label, from, to, bars: bars.length,
      results: [bh, ...results].map(({ equity, ...rest }) => rest),
    });
  }

  // ── Rolling-block robustness ────────────────────────────────────────
  // Two hand-picked periods can flatter any variant. This splits the entire
  // usable history into consecutive fixed-length blocks and counts how often
  // each variant beats the production baseline. A change worth shipping should
  // win most blocks, not just the two we chose to look at.
  if (WALK_DAYS > 0) {
    const blockBars = WALK_DAYS * 24;
    console.log(`\n${hr}`);
    console.log(`ROLLING-BLOCK ROBUSTNESS  ·  consecutive ${WALK_DAYS}-day blocks over the full history`);
    console.log(hr);

    const allBars = precompute(candles, scope, candles.length - 1, LIVE_PARAMS, history);
    const blocks: BarContext[][] = [];
    for (let s = 0; s + blockBars <= allBars.length; s += blockBars) {
      blocks.push(allBars.slice(s, s + blockBars));
    }
    console.log(`${blocks.length} blocks of ${blockBars} bars each\n`);

    const perVariant = new Map<string, number[]>();
    const baselineRets: number[] = [];
    for (const block of blocks) {
      const results = VARIANTS.map((v) => runVariant(block, v));
      const base = results.find((r) => r.name.startsWith("A0"))!;
      baselineRets.push(base.totalReturn);
      for (const r of results) {
        if (!perVariant.has(r.name)) perVariant.set(r.name, []);
        perVariant.get(r.name)!.push(r.totalReturn);
      }
    }

    console.log(
      pad("Variant", 28) + pad("Blocks won", 12, true) + pad("Mean ret", 11, true) +
      pad("Worst", 10, true) + pad("Best", 10, true) + pad("Mean vs A0", 12, true)
    );
    console.log("─".repeat(83));
    for (const [name, rets] of Array.from(perVariant.entries())) {
      const isBaseline = name.startsWith("A0");
      const won = rets.filter((r, i) => r > baselineRets[i]).length;
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const baseMean = baselineRets.reduce((a, b) => a + b, 0) / baselineRets.length;
      console.log(
        pad(name, 28) +
        pad(isBaseline ? "— (ref)" : `${won}/${rets.length}`, 12, true) +
        pad(pct(mean), 11, true) +
        pad(pct(Math.min(...rets)), 10, true) +
        pad(pct(Math.max(...rets)), 10, true) +
        pad(pct(mean - baseMean), 12, true)
      );
    }
    console.log("─".repeat(83));
    (report as Record<string, unknown>).rollingBlocks = {
      blockDays: WALK_DAYS,
      blocks: blocks.length,
      perVariant: Object.fromEntries(perVariant),
      baseline: baselineRets,
    };
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${JSON_OUT}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
