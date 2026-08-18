/**
 * What does the deployed engine do in a BULL RUN — and does it get worse as the
 * bull gets stronger?
 *
 * Every bull reading quoted so far comes from one modest window (Mar–May 2026,
 * hold +7.2%). That is a weak bull, and a mean-reverting engine that sells into
 * strength should degrade as the trend steepens. Quoting a single mild episode
 * as if it characterised bull behaviour would understate the risk in exactly the
 * scenario the owner most needs sized.
 *
 * This pulls multi-year hourly history, slides a 90-day window across it, buckets
 * each window by how strong the bull was, and reports engine vs hold in each
 * bucket. The output is a dose-response curve: if the shortfall widens with bull
 * strength, that is the number that matters, not the average.
 *
 * Windows overlap (90-day window, 30-day step), so bucket counts are NOT
 * independent observations and no significance should be read into them. They
 * describe the shape of the relationship, which is the question being asked.
 *
 * Usage:
 *   pnpm tsx server/scripts/bullRunBehaviour.ts
 *   pnpm tsx server/scripts/bullRunBehaviour.ts --years=3 --pairs=BTC-USDT,ETH-USDT
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import { loadHourly } from "./lib/historyCache";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const YEARS = parseFloat(arg("years") ?? "3");
const SEED = 10000;
const WARMUP = 200;
const WIN_MS = 90 * 24 * 3600 * 1000;   // 90-day episode
const STEP_MS = 30 * 24 * 3600 * 1000;  // slide a month at a time
/** Pinned so reruns are comparable — the live-clock defect from earlier. */
const END = Date.parse("2026-08-16T00:00:00Z");
const START = END - YEARS * 365 * 24 * 3600 * 1000;
/** Matched to the engine's realised average exposure so the comparison is like-for-like. */
const STATIC_W = parseFloat(arg("w") ?? "0.40");
const PAIRS = (arg("pairs") ?? "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,DOGE-USDT").split(",");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

interface Sig { signal: "buy" | "sell" | "hold"; confidence: number }

function runEngine(c: CandleData[], sigs: Sig[], from: number, to: number) {
  let cash = SEED, u = 0, trades = 0, expSum = 0, n = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const s = sigs[i];
    if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
    if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
      const f = convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence);
      if (s.signal === "buy" && cash > 0) {
        const usd = cash * f;
        if (usd >= MIN_TRADE_NOTIONAL_USD) { const fee = usd * FEE; u += (usd - fee) / px; cash -= usd; trades++; }
      } else if (s.signal === "sell" && u > 0) {
        const sz = u * f, g = sz * px;
        if (g >= MIN_TRADE_NOTIONAL_USD) { const fee = g * FEE; u -= sz; cash += g - fee; trades++; }
      }
    }
    const v = cash + u * px;
    eq.push(v);
    if (v > 0) { expSum += (u * px) / v; n++; }
  }
  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd, expo: n ? expSum / n : 0, trades };
}

/**
 * Static allocation control: hold a constant `w` fraction in the asset, the rest
 * in cash, rebalanced when drift exceeds `band`.
 *
 * This is the null hypothesis the engine has never been tested against. If the
 * engine's behaviour is fully explained by its ~40% average exposure, a static
 * 40% book reproduces it with no signals, no optimiser and far fewer fees — and
 * the engine's entire apparatus would be earning nothing.
 */
function runStatic(c: CandleData[], from: number, to: number, w: number, band = 0.10) {
  let cash = SEED, u = 0, trades = 0;
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close, v = cash + u * px;
    if (v <= 0) break;
    const cur = (u * px) / v;
    if (Math.abs(w - cur) > band) {
      const tu = (w * v) / px, d = tu - u;
      cash -= d * px + Math.abs(d) * px * FEE;
      u = tu; trades++;
    }
    eq.push(cash + u * px);
  }
  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd, trades };
}

function holdStats(c: CandleData[], from: number, to: number) {
  const eq = c.slice(from, to + 1).map((x) => (SEED / c[from].close) * x.close);
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: c[to].close / c[from].close - 1, maxDD: dd };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

interface Ep { id: string; hold: number; eng: number; stat: number; holdDD: number; engDD: number; statDD: number; expo: number; trades: number; statTrades: number; t0: number }

async function main() {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`Bull-run behaviour · ${YEARS}y history · 90-day episodes stepped 30 days · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(100));

  const eps: Ep[] = [];
  for (const id of PAIRS) {
    const { candles: c, gaps } = await loadHourly(id, START, END);
    if (c.length < WARMUP + 2200) { console.log(`  ${id.padEnd(10)} insufficient history — EXCLUDED`); continue; }
    if (gaps.length) console.log(`  ${id.padEnd(10)} note: ${gaps.reduce((a, g) => a + g.bars, 0)} missing bars`);

    const scope = getCandleLimit("1h");
    const sigs: Sig[] = new Array(c.length).fill(null).map(() => ({ signal: "hold" as const, confidence: 0 }));
    for (let i = WARMUP; i < c.length; i++) {
      const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
      const s = generateSignal(m, P);
      sigs[i] = { signal: s.signal, confidence: s.confidence };
    }
    // Episode boundaries are anchored to ABSOLUTE timestamps, not array indices.
    // Index-based anchoring made bucket counts drift between runs (parabolic 8 vs
    // 6) because the fetch's first bar can land a few candles apart each time.
    for (let t0 = START; t0 + WIN_MS <= END; t0 += STEP_MS) {
      const from = c.findIndex((x) => x.openTime >= t0);
      const to = c.findIndex((x) => x.openTime >= t0 + WIN_MS);
      if (from < WARMUP || to <= from) continue;
      const h = holdStats(c, from, to);
      const e = runEngine(c, sigs, from, to);
      const st = runStatic(c, from, to, STATIC_W);
      eps.push({ id, hold: h.ret, eng: e.ret, stat: st.ret, holdDD: h.maxDD, engDD: e.maxDD,
                 statDD: st.maxDD, expo: e.expo, trades: e.trades, statTrades: st.trades, t0: c[from].openTime });
    }
  }

  if (!eps.length) { console.log("\nno episodes\n"); return; }

  const BUCKETS: Array<[string, number, number]> = [
    ["bear      < -20%", -Infinity, -0.20],
    ["soft bear -20..0%", -0.20, 0],
    ["mild bull   0..25%", 0, 0.25],
    ["good bull  25..50%", 0.25, 0.50],
    ["strong    50..100%", 0.50, 1.00],
    ["parabolic   >100%", 1.00, Infinity],
  ];

  console.log(`\n${eps.length} episodes across ${new Set(eps.map((e) => e.id)).size} assets\n`);
  console.log("─".repeat(100));
  console.log("regime bucket".padEnd(20) + pad("n", 5) + pad("hold", 10) + pad("engine", 10) +
              pad(`static ${(STATIC_W * 100).toFixed(0)}%`, 11) + pad("eng-stat", 10) +
              pad("hold DD", 9) + pad("eng DD", 8) + pad("stat DD", 9));
  console.log("─".repeat(100));
  for (const [label, lo, hi] of BUCKETS) {
    const g = eps.filter((e) => e.hold >= lo && e.hold < hi);
    if (!g.length) continue;
    const m = (f: (e: Ep) => number) => g.reduce((a, e) => a + f(e), 0) / g.length;
    const h = m((e) => e.hold), en = m((e) => e.eng), st = m((e) => e.stat);
    console.log(label.padEnd(20) + pad(g.length, 5) + pad(pct(h), 10) + pad(pct(en), 10) +
      pad(pct(st), 11) + pad(pct(en - st), 10) +
      pad(`${(m((e) => e.holdDD) * 100).toFixed(1)}%`, 9) +
      pad(`${(m((e) => e.engDD) * 100).toFixed(1)}%`, 8) +
      pad(`${(m((e) => e.statDD) * 100).toFixed(1)}%`, 9));
  }
  console.log("─".repeat(100));

  const bulls = eps.filter((e) => e.hold > 0);
  const beats = bulls.filter((e) => e.eng > e.hold).length;
  console.log(`\nIn bull episodes the engine beat hold in ${beats}/${bulls.length} (${((beats / bulls.length) * 100).toFixed(0)}%)`);

  const beatStat = eps.filter((e) => e.eng > e.stat).length;
  const mAll = (f: (e: Ep) => number) => eps.reduce((a, e) => a + f(e), 0) / eps.length;
  console.log(`\nEngine vs static ${(STATIC_W * 100).toFixed(0)}%, all ${eps.length} episodes:`);
  console.log(`  engine beat static in ${beatStat}/${eps.length} (${((beatStat / eps.length) * 100).toFixed(0)}%)`);
  console.log(`  mean return   engine ${pct(mAll((e) => e.eng))}   static ${pct(mAll((e) => e.stat))}`);
  console.log(`  mean maxDD    engine ${(mAll((e) => e.engDD) * 100).toFixed(1)}%     static ${(mAll((e) => e.statDD) * 100).toFixed(1)}%`);
  console.log(`  mean trades   engine ${mAll((e) => e.trades).toFixed(0)}       static ${mAll((e) => e.statTrades).toFixed(0)}`);

  const worst = [...eps].sort((a, b) => (a.eng - a.hold) - (b.eng - b.hold)).slice(0, 6);
  console.log(`\nworst shortfalls:`);
  console.log("  asset      start         hold      engine        gap    expo");
  for (const e of worst) {
    console.log(`  ${e.id.padEnd(10)} ${new Date(e.t0).toISOString().slice(0, 10)}  ` +
      `${pad(pct(e.hold), 9)}  ${pad(pct(e.eng), 9)}  ${pad(pct(e.eng - e.hold), 9)}  ${pad(`${(e.expo * 100).toFixed(0)}%`, 5)}`);
  }

  // Is the shortfall proportional to bull strength? Slope of gap on hold return.
  const bx = bulls.map((e) => e.hold), by = bulls.map((e) => e.eng - e.hold);
  const mx = bx.reduce((a, b) => a + b, 0) / bx.length, my = by.reduce((a, b) => a + b, 0) / by.length;
  let num = 0, den = 0;
  for (let i = 0; i < bx.length; i++) { num += (bx[i] - mx) * (by[i] - my); den += (bx[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : 0;
  // CAUTION: for a book holding a constant fraction beta of the asset, regressing
  // (engine - hold) on hold has slope identically beta-1. At ~40% exposure that is
  // ~-0.6 with NO information content about the strategy. This is an identity, not
  // a finding, and was previously reported as though it were the latter.
  console.log(`\nshortfall vs bull strength: slope = ${slope.toFixed(2)}`);
  console.log(`  (identity: slope == beta-1 for a constant-beta book; at ${"~40%"} exposure this is mechanical)`);
  console.log(`  ⇒ every +10pp of bull costs roughly ${(slope * 10).toFixed(1)}pp of relative underperformance`);
  console.log("═".repeat(100) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
