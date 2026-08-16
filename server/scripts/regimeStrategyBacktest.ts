/**
 * Regime-Switching Long/Short Strategy — a candidate overhaul.
 *
 * ── Why an overhaul ───────────────────────────────────────────────────
 * The multi-asset test established what the current strategy actually is: it
 * loses to a same-exposure static blend in rising markets (0/10 assets positive,
 * mean −6.03%) and beats it in falling ones (8/10 positive, mean +3.30%). That
 * behaviour is consistent across ten unrelated assets, so it is a real property
 * and not a BTC curve fit — but what generalises is a defensive posture, not a
 * forecast. It sells into strength, which is protective in a downtrend and
 * expensive in an uptrend.
 *
 * Two consequences follow directly, and this script tests both at once:
 *
 *   1. REGIME FILTER — stop mean-reverting inside confirmed trends. The
 *      behaviour that helps in chop and in bear markets is precisely what costs
 *      money in a bull market.
 *   2. SHORTING — the engine demonstrably identifies weakness. Long-only, it can
 *      only sit out a decline; with a short it can be paid for the same signal.
 *
 * ── The design ────────────────────────────────────────────────────────
 * A regime classifier picks one of three states, and each state gets a
 * different behaviour rather than a different weighting of the same blend:
 *
 *   UPTREND    ADX > threshold, +DI > −DI, price > SMA200
 *              → trend-follow LONG. Ignore overbought signals; do not sell rips.
 *   DOWNTREND  ADX > threshold, −DI > +DI, price < SMA200
 *              → SHORT (or flat when shorting is disabled).
 *   CHOP       everything else — weak ADX or mean-reverting Hurst
 *              → mean-revert, which is what the existing engine is good at.
 *
 * Target exposure runs from −1 (fully short) to +1 (fully long) and is scaled by
 * signal conviction. Trades are the DELTA to the target, with a no-trade band so
 * small drifts do not generate fee-paying churn.
 *
 * ── What this does NOT claim ──────────────────────────────────────────
 * Regime classifiers are lagging by construction: you identify a trend using
 * indicators computed from the move that already happened. A classifier that
 * looks good in backtest often just labels the past cleanly. That is exactly why
 * this is scored across 10 assets and 2 regimes rather than on BTC alone.
 *
 * Shorting is modelled with a funding carry. On OKX perps, funding is usually
 * positive, meaning shorts are PAID to hold — but it flips, and a short in a
 * strong bull market pays both the price move and the carry. Leverage is NOT
 * modelled: everything here is 1x notional. Leverage multiplies the losses this
 * test measures.
 *
 * Usage:
 *   pnpm tsx server/scripts/regimeStrategyBacktest.ts
 *   pnpm tsx server/scripts/regimeStrategyBacktest.ts --no-short   # regime filter only
 */

import { computeAllMetrics, type CandleData, type AllMetrics } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";

/**
 * OKX rate-limits and replies 429 rather than degrading. Fetching six months of
 * hourly history paginates ~43 requests per asset, so a multi-asset loop with no
 * spacing trips the limit and silently drops assets — a run of this script
 * returned 5 pairs and omitted BTC entirely, which looks like "insufficient
 * history" and is not. Space the per-asset fetches out.
 */
const PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
import { getCandleLimit, type StrategyParameters } from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const JSON_OUT = arg("json") ?? null;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const ALLOW_SHORT = !process.argv.includes("--no-short");
/** Per-8h funding paid by the SHORT side. Negative = short receives carry. */
const FUNDING_8H = parseFloat(arg("funding-bps") ?? "-1") / 10000;
/** Rebalance only when the target differs from current by more than this. */
const NO_TRADE_BAND = parseFloat(arg("band") ?? "0.15");
/** ADX above this counts as a confirmed trend. */
const ADX_TREND = parseFloat(arg("adx") ?? "25");

const SEED = 10000;
const HISTORY_START = Date.parse("2026-02-15T00:00:00Z");
const LIVE_START = Date.parse("2026-05-15T00:00:00Z");
/**
 * Fixed end of the scored window. Using Date.now() made every run measure a
 * slightly different period, so two variants could not be compared — an
 * ablation would show a difference that was partly just elapsed time.
 */
const WINDOW_END = Date.parse("2026-08-16T00:00:00Z");
const MIN_BARS = 1500;
const ANCHOR = "BTC-USDT";
const PEG_RANGE_PCT = 0.05;

const LIVE_PARAMS: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

type Regime = "uptrend" | "downtrend" | "chop";

/**
 * Classifies the regime from indicators the engine already computes.
 *
 * A trend must agree on all three: strength (ADX), direction (DI crossover) and
 * position relative to the long moving average. Requiring agreement makes the
 * classifier slower to call a trend and much less prone to flapping, which is
 * the failure mode that turns a regime filter into a fee generator.
 */
function classifyRegime(m: AllMetrics): Regime {
  if (m.adx === null || m.adxPlus === null || m.adxMinus === null || m.sma200 === null) return "chop";
  if (m.adx <= ADX_TREND) return "chop";
  const above = m.price > m.sma200;
  if (m.adxPlus > m.adxMinus && above) return "uptrend";
  if (m.adxMinus > m.adxPlus && !above) return "downtrend";
  return "chop";
}

/**
 * Target exposure in [-1, +1] for the bar, given regime and signal.
 *
 * The regime decides the BEHAVIOUR; the signal decides the CONVICTION within it.
 */
function targetExposure(regime: Regime, m: AllMetrics, params: StrategyParameters): number {
  const sig = generateSignal(m, params);
  const buy = sig.rawBuyScore, sell = sig.rawSellScore;
  const conviction = Math.min(1, Math.max(buy, sell) / Math.max(0.01, params.minConfidence));

  switch (regime) {
    case "uptrend":
      // Trend-follow. Overbought readings are IGNORED — selling rips in an
      // uptrend is the single most expensive thing the current engine does.
      return Math.min(1, 0.5 + 0.5 * conviction);

    case "downtrend":
      // The engine is good at spotting weakness; here it gets paid for it.
      // Without shorting the best available action is flat.
      if (!ALLOW_SHORT) return 0;
      return -Math.min(1, 0.3 + 0.7 * conviction);

    case "chop":
      // Mean-revert — the behaviour that measurably works, confined to the
      // regime where it works. Long on buy pressure, flat-to-short on sell.
      if (buy > sell) return Math.min(0.6, buy);
      return ALLOW_SHORT ? -Math.min(0.4, sell) : 0;
  }
}

interface Result {
  instId: string; ret: number; buyHold: number; exposure: number;
  blend: number; alpha: number; trades: number; maxDD: number; sharpe: number;
  pctShort: number;
}

function run(candles: CandleData[], from: number, to: number): Result | null {
  const scope = getCandleLimit("1h");
  if (to - from < 200) return null;

  // Tracked as cash + a signed position, so a short is a negative holding.
  let cash = SEED, pos = 0, trades = 0, expSum = 0, shortBars = 0;
  const equity: number[] = [];

  for (let i = from; i <= to; i++) {
    const window = candles.slice(Math.max(0, i - scope + 1), i + 1);
    const m = computeAllMetrics(window, LIVE_PARAMS.zScoreTrendThreshold, LIVE_PARAMS.zScoreBlipThreshold);
    const price = candles[i].close;

    // Funding accrues on the notional of a short, every 8 bars at 1h.
    if (pos < 0 && i % 8 === 0) cash -= Math.abs(pos) * price * FUNDING_8H;

    const value = cash + pos * price;
    if (value <= 0) break; // wiped out — stop rather than report a negative book
    const target = targetExposure(classifyRegime(m), m, LIVE_PARAMS);
    const current = (pos * price) / value;

    if (Math.abs(target - current) > NO_TRADE_BAND) {
      const targetUnits = (target * value) / price;
      const delta = targetUnits - pos;
      const notional = Math.abs(delta) * price;
      cash -= delta * price + notional * FEE;
      pos = targetUnits;
      trades++;
    }

    const v = cash + pos * price;
    equity.push(v);
    expSum += v > 0 ? (pos * price) / v : 0;
    if (pos < 0) shortBars++;
  }

  const final = equity[equity.length - 1];
  let peak = equity[0], maxDD = 0;
  for (const v of equity) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));

  const entry = candles[from].close, exit = candles[to].close;
  const exposure = expSum / equity.length;
  const blend = (SEED * exposure * (exit / entry) + SEED * (1 - exposure)) / SEED - 1;

  return {
    instId: "", ret: final / SEED - 1, buyHold: exit / entry - 1, exposure, blend,
    alpha: final / SEED - 1 - blend, trades, maxDD,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0,
    pctShort: shortBars / equity.length,
  };
}

const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`Regime-Switching Strategy — shorting ${ALLOW_SHORT ? "ON" : "OFF"}, ` +
              `${(FEE * 10000).toFixed(0)}bps, funding ${(FUNDING_8H * 10000).toFixed(1)}bps/8h, ` +
              `band ${NO_TRADE_BAND}, ADX>${ADX_TREND}`);
  console.log("═".repeat(100));

  const tickers = await okx.publicGet<{ instId: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SPOT");
  const ranked = tickers.filter((t) => t.instId.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0"))
    .map((t) => t.instId);
  const candidates = [ANCHOR, ...ranked.filter((p) => p !== ANCHOR)].slice(0, TOP_N * 3);

  const selected: Array<{ instId: string; candles: CandleData[] }> = [];
  for (const instId of candidates) {
    if (selected.length >= TOP_N) break;
    let candles: CandleData[] | null = null;
    for (let a = 0; a < 3 && !candles; a++) {
      try {
        const raw = await okx.fetchCandlesFrom("1h", HISTORY_START, 5000, instId);
        candles = raw.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, openTime: c.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(PACE_MS);
    if (!candles || candles.length < MIN_BARS) continue;
    const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
    if ((hi - lo) / ((hi + lo) / 2) < PEG_RANGE_PCT) continue;
    selected.push({ instId, candles });
  }
  console.log(`\n${selected.length} pairs: ${selected.map((s) => s.instId).join(", ")}`);

  const report: Record<string, Result[]> = {};
  for (const [label, ws, we] of [
    ["HELD-OUT (Mar–May, bull)", HISTORY_START, LIVE_START],
    ["LIVE (May–Aug, bear)", LIVE_START, WINDOW_END],
  ] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(100));
    console.log("pair".padEnd(13) + pad("return", 10) + pad("buy&hold", 11) + pad("expo", 8) +
                pad("%short", 8) + pad("blend", 10) + pad("ALPHA", 10) + pad("trades", 8) +
                pad("maxDD", 8) + pad("Sharpe", 8));
    console.log("─".repeat(100));
    const rows: Result[] = [];
    for (const { instId, candles } of selected) {
      const from = Math.max(candles.findIndex((c) => c.openTime >= ws), getCandleLimit("1h"));
      let to = candles.findIndex((c) => c.openTime >= we);
      if (to < 0) to = candles.length - 1;
      const r = run(candles, from, to);
      if (!r) continue;
      r.instId = instId; rows.push(r);
      console.log(instId.padEnd(13) + pad(pct(r.ret), 10) + pad(pct(r.buyHold), 11) +
        pad(`${(r.exposure * 100).toFixed(0)}%`, 8) + pad(`${(r.pctShort * 100).toFixed(0)}%`, 8) +
        pad(pct(r.blend), 10) + pad(pct(r.alpha), 10) + pad(r.trades, 8) +
        pad(`${(r.maxDD * 100).toFixed(1)}%`, 8) + pad(r.sharpe.toFixed(2), 8));
    }
    console.log("─".repeat(100));
    const pos = rows.filter((r) => r.alpha > 0).length;
    console.log(`  positive alpha ${pos}/${rows.length}   mean alpha ${pct(rows.reduce((a, r) => a + r.alpha, 0) / rows.length)}` +
                `   mean return ${pct(rows.reduce((a, r) => a + r.ret, 0) / rows.length)}`);
    report[label] = rows;
  }

  const [ho, lv] = Object.values(report);
  const both = ho.filter((h) => { const l = lv.find((x) => x.instId === h.instId); return l && h.alpha > 0 && l.alpha > 0; });
  console.log(`\n${"═".repeat(100)}`);
  console.log(`POSITIVE ALPHA IN BOTH REGIMES: ${both.length}/${ho.length}` +
              (both.length ? ` — ${both.map((r) => r.instId).join(", ")}` : ""));
  console.log(`(the current strategy scores 0/10 on this test)`);
  console.log("═".repeat(100) + "\n");

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); console.log(`Wrote ${JSON_OUT}\n`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
