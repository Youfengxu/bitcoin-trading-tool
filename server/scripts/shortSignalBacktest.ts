/**
 * Short-Specific Signal — designed for the short side, not mirrored from the long.
 *
 * ── Why a mirrored long signal fails ──────────────────────────────────
 * The previous attempt bolted a short onto the mean-reversion engine and lost
 * 15-25% of alpha across ten assets. Shorting is not the negative of going long:
 *
 *   1. CRYPTO DRIFTS UP. A short starts behind, so it must clear a higher bar.
 *      This signal therefore requires ALL conditions to agree rather than
 *      summing components until a threshold is crossed — a blend can be dragged
 *      over the line by one strong reading, which is acceptable when the base
 *      rate is neutral and not when it is against you.
 *   2. CROWDED LONGS CAUSE SHARP DECLINES. Perp funding is the direct measure of
 *      positioning: sustained positive funding means longs are paying to hold,
 *      which is the specific condition preceding liquidation cascades. The
 *      existing engine uses funding only as a weak multiplier on a score built
 *      from price indicators. Here it is a required condition.
 *   3. LOSSES ARE UNBOUNDED. A stop is mandatory, not a refinement.
 *
 * ── Entry: every condition must hold ──────────────────────────────────
 *   structure    price < SMA200            — never short a structural uptrend
 *   positioning  funding > its own median  — longs crowded, for THIS asset
 *   momentum     −DI > +DI and ADX > 20    — the decline is confirmed, not guessed
 *   volatility   ATR(14) > ATR(50)         — expanding, i.e. the move is underway
 *
 * Funding is compared against each asset's own trailing median rather than an
 * absolute number, because normal funding differs a lot between BTC and a
 * small-cap.
 *
 * ── The benchmark that matters ────────────────────────────────────────
 * A short strategy makes money in a bear market by accident. So results are
 * scored against ALWAYS-SHORT at the same average exposure. If the signal cannot
 * beat indiscriminately shorting the same notional, it has no timing skill and
 * is just inverted beta.
 *
 * Usage:
 *   pnpm tsx server/scripts/shortSignalBacktest.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
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
import { getCandleLimit } from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 8;
const JSON_OUT = arg("json") ?? null;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
/** Stop distance above entry, in ATR multiples. Mandatory for an unbounded loss. */
const STOP_ATR = parseFloat(arg("stop-atr") ?? "2.5");
/** Fraction of the book committed per short. */
const SIZE = parseFloat(arg("size") ?? "0.5");
const ADX_MIN = parseFloat(arg("adx") ?? "20");
/** Ablations: drop a required condition to see whether it earns its place. */
const NO_FUNDING = process.argv.includes("--no-funding");
const NO_VOL = process.argv.includes("--no-vol");

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
const PEG_RANGE_PCT = 0.05;

/** ATR as a fraction of price, over `period` bars ending at `end`. */
function atrPct(c: CandleData[], end: number, period: number): number | null {
  if (end < period) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const cur = c[i], prev = c[i - 1];
    s += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return s / period / c[end].close;
}

/** Funding rate in effect at a timestamp, forward-filled from 8h settlements. */
function fundingAt(hist: Array<{ ts: number; rate: number }>, ts: number): number | null {
  let r: number | null = null;
  for (const f of hist) { if (f.ts <= ts) r = f.rate; else break; }
  return r;
}

async function fetchFunding(instId: string): Promise<Array<{ ts: number; rate: number }>> {
  const out: Array<{ ts: number; rate: number }> = [];
  let before: number | undefined;
  for (let page = 0; page < 12; page++) {
    const q = new URLSearchParams({ instId, limit: "100" });
    if (before !== undefined) q.set("after", String(before));
    let rows: Array<{ fundingRate: string; fundingTime: string }> = [];
    try {
      rows = await okx.publicGet(`/api/v5/public/funding-rate-history?${q}`);
    } catch { break; }
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: parseInt(r.fundingTime), rate: parseFloat(r.fundingRate) });
    before = parseInt(rows[rows.length - 1].fundingTime);
    if (before < HISTORY_START) break;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

interface Result {
  instId: string; ret: number; buyHold: number; exposure: number;
  alwaysShort: number; alpha: number; trades: number; wins: number;
  maxDD: number; sharpe: number; barsShort: number;
}

function run(
  candles: CandleData[], funding: Array<{ ts: number; rate: number }>,
  from: number, to: number
): Result | null {
  const scope = getCandleLimit("1h");
  if (to - from < 200) return null;

  let cash = SEED, pos = 0, entry = 0, stop = 0;
  let trades = 0, wins = 0, expSum = 0, barsShort = 0;
  const equity: number[] = [];
  // Trailing median of funding for THIS asset — "crowded" is relative.
  const fundWindow: number[] = [];

  for (let i = from; i <= to; i++) {
    const price = candles[i].close;
    const window = candles.slice(Math.max(0, i - scope + 1), i + 1);
    const m = computeAllMetrics(window);
    const f = fundingAt(funding, candles[i].openTime);
    if (f !== null) { fundWindow.push(f); if (fundWindow.length > 500) fundWindow.shift(); }

    // Funding accrues to the short every 8 bars: positive funding pays shorts.
    if (pos < 0 && i % 8 === 0 && f !== null) cash += Math.abs(pos) * price * f;

    // ── Exit ─────────────────────────────────────────────────────────
    if (pos < 0) {
      const structureBroken = m.sma200 !== null && price > m.sma200;
      if (candles[i].high >= stop || structureBroken) {
        const px = candles[i].high >= stop ? stop : price; // stop fills at the level
        const notional = Math.abs(pos) * px;
        // Realised P&L on a short is (entry − exit) × size, less the exit fee.
        cash += (entry - px) * Math.abs(pos) - notional * FEE;
        if (px < entry) wins++;
        pos = 0;
      }
    }

    // ── Entry: every condition must agree ────────────────────────────
    if (pos === 0 && fundWindow.length >= 30) {
      const sorted = [...fundWindow].sort((a, b) => a - b);
      const medFunding = sorted[Math.floor(sorted.length / 2)];
      const atrFast = atrPct(candles, i, 14), atrSlow = atrPct(candles, i, 50);

      const structure = m.sma200 !== null && price < m.sma200;
      const positioning = NO_FUNDING || (f !== null && f > medFunding);
      const momentum = m.adx !== null && m.adxPlus !== null && m.adxMinus !== null &&
                       m.adx > ADX_MIN && m.adxMinus > m.adxPlus;
      const volatility = NO_VOL || (atrFast !== null && atrSlow !== null && atrFast > atrSlow);

      if (structure && positioning && momentum && volatility) {
        const notional = cash * SIZE;
        pos = -notional / price;
        entry = price;
        stop = price * (1 + STOP_ATR * (atrFast as number));
        cash -= notional * FEE;
        trades++;
      }
    }

    // Mark to market: a short gains as price falls below entry.
    const value = cash + (pos < 0 ? (entry - price) * Math.abs(pos) : 0);
    equity.push(value);
    expSum += pos < 0 ? -SIZE : 0;
    if (pos < 0) barsShort++;
    if (value <= 0) break;
  }

  const final = equity[equity.length - 1];
  let peak = equity[0], maxDD = 0;
  for (const v of equity) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));

  const px0 = candles[from].close, px1 = candles[to].close;
  const exposure = Math.abs(expSum / equity.length);
  // Control: short the same average notional for the whole window, no timing.
  const alwaysShort = exposure * (px0 - px1) / px0;

  return {
    instId: "", ret: final / SEED - 1, buyHold: px1 / px0 - 1, exposure,
    alwaysShort, alpha: final / SEED - 1 - alwaysShort,
    trades, wins, maxDD, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0,
    barsShort: barsShort,
  };
}

const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(102)}`);
  console.log(`Short-Specific Signal — stop ${STOP_ATR}xATR · size ${SIZE} · ${(FEE*10000).toFixed(0)}bps` +
              `${NO_FUNDING ? " · NO funding condition" : ""}${NO_VOL ? " · NO volatility condition" : ""}`);
  console.log("═".repeat(102));

  const tickers = await okx.publicGet<{ instId: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SPOT");
  const swaps = new Set((await okx.publicGet<{ instId: string }>("/api/v5/public/instruments?instType=SWAP")).map((s) => s.instId));
  const ranked = tickers.filter((t) => t.instId.endsWith("-USDT") && swaps.has(t.instId + "-SWAP"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0")).map((t) => t.instId);

  const selected: Array<{ instId: string; candles: CandleData[]; funding: Array<{ ts: number; rate: number }> }> = [];
  for (const instId of ranked) {
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
    const funding = await fetchFunding(instId + "-SWAP");
    if (funding.length < 100) continue;
    selected.push({ instId, candles, funding });
  }
  console.log(`\n${selected.length} pairs with perps + funding history: ${selected.map((s) => s.instId).join(", ")}`);

  const report: Record<string, Result[]> = {};
  for (const [label, ws, we] of [
    ["HELD-OUT (Mar–May, bull — shorts should LOSE here)", HISTORY_START, LIVE_START],
    ["LIVE (May–Aug, bear — shorts should WIN here)", LIVE_START, WINDOW_END],
  ] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(102));
    console.log("pair".padEnd(12) + pad("return", 10) + pad("buy&hold", 11) + pad("%short", 9) +
                pad("alwaysShort", 13) + pad("ALPHA", 10) + pad("trades", 8) + pad("win%", 8) +
                pad("maxDD", 8) + pad("Sharpe", 8));
    console.log("─".repeat(102));
    const rows: Result[] = [];
    for (const { instId, candles, funding } of selected) {
      const from = Math.max(candles.findIndex((c) => c.openTime >= ws), getCandleLimit("1h"));
      let to = candles.findIndex((c) => c.openTime >= we);
      if (to < 0) to = candles.length - 1;
      const r = run(candles, funding, from, to);
      if (!r) continue;
      r.instId = instId; rows.push(r);
      console.log(instId.padEnd(12) + pad(pct(r.ret), 10) + pad(pct(r.buyHold), 11) +
        pad(`${(r.barsShort / (to - from + 1) * 100).toFixed(0)}%`, 9) +
        pad(pct(r.alwaysShort), 13) + pad(pct(r.alpha), 10) + pad(r.trades, 8) +
        pad(r.trades ? `${(r.wins / r.trades * 100).toFixed(0)}%` : "—", 8) +
        pad(`${(r.maxDD * 100).toFixed(1)}%`, 8) + pad(r.sharpe.toFixed(2), 8));
    }
    console.log("─".repeat(102));
    const pos = rows.filter((r) => r.alpha > 0).length;
    console.log(`  beats always-short: ${pos}/${rows.length}   mean alpha ${pct(rows.reduce((a, r) => a + r.alpha, 0) / Math.max(1,rows.length))}` +
                `   mean return ${pct(rows.reduce((a, r) => a + r.ret, 0) / Math.max(1,rows.length))}` +
                `   total trades ${rows.reduce((a, r) => a + r.trades, 0)}`);
    report[label] = rows;
  }

  console.log(`\n${"═".repeat(102)}`);
  console.log("A short signal must beat shorting the same notional indiscriminately.");
  console.log("Losing less than buy&hold in a bear market is not skill — the market did that.");
  console.log("═".repeat(102) + "\n");

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); console.log(`Wrote ${JSON_OUT}\n`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
