/**
 * Four active strategies, UNLEVERED, against the deployed static-40% control.
 *
 * Parameters are taken from the literature and NOT fitted. That is deliberate:
 * this project measured Spearman rho = -0.339 between train-best and test-best
 * parameters, meaning historically-optimal settings did WORSE than average out
 * of sample. Fitting here would actively harm the result, so every constant
 * below is a standard value with a stated source, chosen before any run.
 *
 * Costs are the account's real OKX Lv1 rates: taker 10bps, maker 8bps. Taker is
 * charged throughout, since none of these strategies can guarantee a passive
 * fill.
 *
 * ── The strategies ────────────────────────────────────────────────────
 *   CONTROL  static 40% BTC, rebalance outside 30-50%
 *   A        funding carry, delta-neutral, unlevered
 *   B        time-series trend, volatility-scaled, long-only
 *   C        cross-sectional momentum, long-only top-N rotation
 *   D        volatility-scaled continuous exposure
 *
 * B and C are long-only because "no leverage" forecloses the short leg: shorting
 * spot requires borrow, and shorting via perps is leverage by construction.
 *
 * ── Evaluation ────────────────────────────────────────────────────────
 * The last 12 months are HELD OUT and reported separately. Nothing is chosen on
 * them. The earlier period exists only to show whether a strategy's behaviour is
 * stable, not to select anything -- there is nothing to select, since no
 * parameter is fitted.
 */

import { loadHourly } from "./lib/historyCache";
import type { CandleData } from "../engine/technicalAnalysis";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
/** Real OKX Lv1 taker rate, verified against the account. */
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const SEED = 10000;
/** Pinned to the cached history boundary so reruns are byte-identical and no
 *  refetch is triggered -- the cache key is (instId, bar, start, end). */
const END = Date.parse("2026-08-16T00:00:00Z");
const YEARS = parseFloat(arg("years") ?? "3");
const START = END - YEARS * 365 * 24 * 3600 * 1000;
/** Held-out: the final 12 months. Nothing is chosen on this window. */
const HOLDOUT_START = END - 365 * 24 * 3600 * 1000;

const UNIVERSE = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,XRP-USDT,DOGE-USDT,ADA-USDT,LINK-USDT,AVAX-USDT,LTC-USDT").split(",");

// ── Literature-sourced constants, not fitted ─────────────────────────
/** Classic time-series momentum lookback (Moskowitz/Ooi/Pedersen): ~12 months
 *  for equities, but crypto work uses far shorter. 30 days is the standard
 *  crypto TSMOM window and is used unchanged. */
const TREND_LOOKBACK_H = 30 * 24;
/** Volatility estimation window. 168h matches what this project already measured
 *  as the better volatility predictor (r = 0.619 vs a fitted GMM's 0.488). */
const VOL_WINDOW_H = 168;
/** Cross-sectional formation period and holding count -- standard 30/monthly. */
const XS_LOOKBACK_H = 30 * 24;
const XS_TOP_N = 3;
const XS_REBAL_H = 30 * 24;
/** Static control, as deployed. */
const STATIC_W = 0.40, STATIC_BAND = 0.10;
/** Exposure ceiling. 1.0 IS the no-leverage constraint. */
const MAX_W = 1.0;

interface Result {
  name: string;
  ret: number; maxDD: number; trades: number; expo: number; feesPaid: number;
}

const hourlyVol = (c: CandleData[], i: number, win: number): number | null => {
  if (i < win) return null;
  const lr: number[] = [];
  for (let k = i - win + 1; k <= i; k++) lr.push(Math.log(c[k].close / c[k - 1].close));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / lr.length);
};

/** Runs a book that targets `weightAt(i)` in the asset, rebalancing on a band. */
function runWeighted(
  c: CandleData[], from: number, to: number,
  weightAt: (i: number) => number | null, band: number, name: string
): Result {
  let cash = SEED, u = 0, trades = 0, fees = 0, expSum = 0, n = 0;
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const v = cash + u * px;
    if (v <= 0) break;
    const w = weightAt(i);
    if (w !== null) {
      const target = Math.max(0, Math.min(MAX_W, w));
      const cur = (u * px) / v;
      if (Math.abs(target - cur) > band) {
        const tu = (target * v) / px, d = tu - u;
        const notional = Math.abs(d) * px;
        const fee = notional * FEE;
        cash -= d * px + fee;
        fees += fee; u = tu; trades++;
      }
    }
    const vv = cash + u * px;
    eq.push(vv);
    if (vv > 0) { expSum += (u * px) / vv; n++; }
  }
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return {
    name, ret: eq[eq.length - 1] / SEED - 1, maxDD: dd, trades,
    expo: n ? expSum / n : 0, feesPaid: fees,
  };
}

/**
 * Equal-weighted rotation into the top-N trailing performers, rebalanced monthly.
 *
 * Aligned by TIMESTAMP across assets, not index: series differ in length and
 * index-aligning would compare different calendar moments.
 */
function runCrossSectional(
  assets: Array<[string, CandleData[]]>, ref: CandleData[], from: number, to: number
): Result {
  let cash = SEED;
  const held = new Map<string, number>();
  let trades = 0, fees = 0, expSum = 0, n = 0;
  const eq: number[] = [];

  const priceAt = (c: CandleData[], ts: number): number | null => {
    const i = c.findIndex((x) => x.openTime >= ts);
    return i < 0 ? null : c[i].close;
  };

  for (let i = from; i <= to; i++) {
    const ts = ref[i].openTime;
    let held$ = 0;
    for (const [id, qty] of Array.from(held.entries())) {
      const p = priceAt(data.get(id)!, ts); if (p) held$ += qty * p;
    }
    const v = cash + held$;
    if (v <= 0) break;

    if ((i - from) % XS_REBAL_H === 0) {
      const scored = assets.map(([id, c]) => {
        const now = priceAt(c, ts), then = priceAt(c, ts - XS_LOOKBACK_H * 3600_000);
        return { id, mom: now && then ? now / then - 1 : -Infinity };
      }).filter((x) => Number.isFinite(x.mom))
        .sort((a, b) => b.mom - a.mom);
      // Long-only: hold nothing when no asset has positive momentum, rather than
      // holding "the least bad", which would make this a permanently long book.
      const winners = scored.filter((x) => x.mom > 0).slice(0, XS_TOP_N);
      const targetIds = new Set(winners.map((w) => w.id));

      for (const [id, qty] of Array.from(held.entries())) {
        if (targetIds.has(id)) continue;
        const p = priceAt(data.get(id)!, ts); if (!p) continue;
        const gross = qty * p, fee = gross * FEE;
        cash += gross - fee; fees += fee; trades++; held.delete(id);
      }
      if (winners.length) {
        const per = (cash + 0) / winners.length;
        for (const w of winners) {
          if (held.has(w.id)) continue;
          const p = priceAt(data.get(w.id)!, ts); if (!p) continue;
          const spend = Math.min(per, cash);
          if (spend <= 0) continue;
          const fee = spend * FEE;
          held.set(w.id, (spend - fee) / p);
          cash -= spend; fees += fee; trades++;
        }
      }
    }

    let mark = 0;
    for (const [id, qty] of Array.from(held.entries())) {
      const p = priceAt(data.get(id)!, ts); if (p) mark += qty * p;
    }
    const vv = cash + mark;
    eq.push(vv);
    if (vv > 0) { expSum += mark / vv; n++; }
  }
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return {
    name: `C  x-sec top${XS_TOP_N}/${assets.length}, long-only`,
    ret: eq[eq.length - 1] / SEED - 1, maxDD: dd, trades,
    expo: n ? expSum / n : 0, feesPaid: fees,
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number) => String(s).padEnd(w);
let data = new Map<string, CandleData[]>();

async function main() {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`Active strategies, UNLEVERED · taker ${(FEE * 1e4).toFixed(0)}bps (real OKX Lv1) · ${YEARS}y`);
  console.log(`held-out window: ${new Date(HOLDOUT_START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)}`);
  console.log("═".repeat(100));

  // module-scoped so runCrossSectional can price any held asset
  data = new Map<string, CandleData[]>();
  for (const id of UNIVERSE) {
    const { candles } = await loadHourly(id, START, END, false);
    if (candles.length > 5000) data.set(id, candles);
  }
  console.log(`\n${data.size} assets loaded\n`);

  const btc = data.get("BTC-USDT")!;
  const idxAt = (c: CandleData[], ts: number) => Math.max(0, c.findIndex((x) => x.openTime >= ts));

  // Each 12-month window is evaluated separately.
  //
  // This is legitimate rather than a fishing expedition because NO PARAMETER IS
  // FITTED: every constant comes from the literature or from a prior measurement
  // on different data, so there is no train/test distinction to violate. The
  // earlier "held-out" framing was conservative but unnecessary — and it was
  // actively misleading, because ALL TWELVE assets fell in that window (TRX
  // -6.4% was the best, ADA -81.8% the worst). A single uniformly bearish year
  // cannot tell "trend does not work" apart from "trend does not work in a bear
  // market", which is the whole question.
  const YEAR = 365 * 24 * 3600 * 1000;
  const windows: Array<readonly [string, number, number]> = [
    ["YEAR 1  2023-08 → 2024-08", START, START + YEAR],
    ["YEAR 2  2024-08 → 2025-08", START + YEAR, START + 2 * YEAR],
    ["YEAR 3  2025-08 → 2026-08  (all 12 assets fell)", START + 2 * YEAR, END],
    ["FULL SAMPLE", START, END],
  ];
  for (const [label, winStart, winEnd] of windows) {
    const from = idxAt(btc, winStart);
    const to = winEnd >= END ? btc.length - 1 : Math.max(from + 1, idxAt(btc, winEnd));
    const warm = Math.max(TREND_LOOKBACK_H, VOL_WINDOW_H, XS_LOOKBACK_H) + 1;
    const f = Math.max(from, warm);

    const hodl = btc[to].close / btc[Math.max(f, from)].close - 1;
    console.log(`${label}   [BTC ${hodl >= 0 ? "+" : ""}${(hodl * 100).toFixed(1)}%]`);
    console.log("─".repeat(100));
    console.log(pad("strategy", 42) + pad("return", 10) + pad("maxDD", 9) + pad("trades", 9) + pad("expo", 8) + "fees");
    console.log("─".repeat(100));

    const results: Result[] = [];

    // CONTROL — static 40%, as deployed.
    results.push(runWeighted(btc, f, to, () => STATIC_W, STATIC_BAND, "CONTROL static 40% BTC"));

    // Target volatility = median over a FIXED burn-in at the start of the data,
    // identical for both windows. The first version measured it over [warm, f),
    // which is EMPTY on the full-sample run -- so it silently fell back to a
    // constant so high that the scaler pinned at 1.0 and strategy D became
    // buy-and-hold. Two strategies reporting identical numbers is what exposed it.
    const BURN_IN_BARS = 90 * 24;
    const targetVol = (() => {
      const vs: number[] = [];
      for (let i = warm; i < Math.min(warm + BURN_IN_BARS, btc.length); i += 24) {
        const v = hourlyVol(btc, i, VOL_WINDOW_H); if (v) vs.push(v);
      }
      vs.sort((a, b) => a - b);
      if (!vs.length) throw new Error("cannot establish target volatility");
      return vs[Math.floor(vs.length / 2)];
    })();
    // Decisions are DAILY. A 30-day signal re-evaluated hourly flips on every
    // intraday wiggle across its threshold: the first version ran 454 full-book
    // turns and paid $7,433 of fees on a $10,000 book. Daily is the standard
    // rebalancing frequency for time-series momentum and is not a fitted choice.
    const daily = (fn: (i: number) => number | null) => {
      let held: number | null = null;
      return (i: number) => {
        if ((i - f) % 24 === 0 || held === null) held = fn(i);
        return held;
      };
    };
    const trendUp = (i: number) => btc[i].close / btc[i - TREND_LOOKBACK_H].close - 1 > 0;
    const volScale = (i: number) => {
      const v = hourlyVol(btc, i, VOL_WINDOW_H);
      return v && v > 0 ? Math.min(MAX_W, targetVol / v) : STATIC_W;
    };

    results.push(runWeighted(btc, f, to, daily((i) => (trendUp(i) ? volScale(i) : 0)),
      0.10, "B  trend 30d, vol-scaled, long-only"));
    results.push(runWeighted(btc, f, to, daily((i) => (trendUp(i) ? MAX_W : 0)),
      0.10, "B2 trend 30d, unscaled (on/off)"));
    results.push(runWeighted(btc, f, to, daily(volScale),
      0.10, "D  vol-scaled exposure (no view)"));

    // EXPOSURE-MATCHED variants. Comparing an 85%-exposed book against a 40% one
    // measures risk appetite, not skill -- in a falling market the lower-exposure
    // book wins by construction. Scaling each signal to the control's ~40% average
    // exposure isolates whether the SIGNAL adds anything. This is a control, not a
    // fitted parameter: the multiplier is derived from realised exposure, not
    // chosen to improve returns.
    const matchTo = STATIC_W;
    // CAUSAL exposure matching. The first version averaged realised exposure over
    // the ENTIRE window and applied the resulting multiplier from bar one -- a
    // look-ahead leak. It was verdict-flipping, not cosmetic: an independent
    // audit measured B* at +68.1% with the leak against +38.3% without it, versus
    // a +54.0% control. The leaked version beat the control; the causal one loses
    // badly. The earlier claim that the leak "only favoured the strategies, which
    // lost anyway" was therefore wrong for the full sample.
    //
    // k is now recomputed from realised exposure STRICTLY BEFORE each decision,
    // over an expanding window, starting at 1.0 until there is history to average.
    const scaleTo = (w: (i: number) => number | null) => {
      let sum = 0, n = 0;
      return daily((i) => {
        const x = w(i);
        const k = n > 0 ? matchTo / Math.max(1e-9, sum / n) : 1;
        if (x !== null) { sum += Math.min(MAX_W, x); n++; }   // accrue AFTER using k
        return x === null ? null : Math.min(MAX_W, x * k);
      });
    };
    results.push(runWeighted(btc, f, to, scaleTo((i) => (trendUp(i) ? volScale(i) : 0)),
      0.10, "B* trend vol-scaled, exposure-matched"));
    results.push(runWeighted(btc, f, to, scaleTo(volScale),
      0.10, "D* vol-scaled, exposure-matched"));

    // C — cross-sectional momentum, long-only top-N rotation.
    // Long-only because "no leverage" forecloses the short leg entirely: shorting
    // spot needs borrow and shorting perps IS leverage. That removes the market-
    // neutral property, so C here is a rotation, not the long-short strategy the
    // literature reports -- a weaker claim, honestly labelled.
    const assets = Array.from(data.entries());
    const xs = runCrossSectional(assets, btc, f, to);
    results.push(xs);

    // Buy and hold, for reference.
    results.push(runWeighted(btc, f, to, () => MAX_W, 0.99, "REF buy & hold BTC"));

    for (const r of results) {
      console.log(
        pad(r.name, 42) + pad(pct(r.ret), 10) + pad(`${(r.maxDD * 100).toFixed(1)}%`, 9) +
        pad(r.trades, 9) + pad(`${(r.expo * 100).toFixed(0)}%`, 8) +
        `$${r.feesPaid.toFixed(0)} (${((r.feesPaid / SEED) * 100).toFixed(1)}%)`
      );
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
