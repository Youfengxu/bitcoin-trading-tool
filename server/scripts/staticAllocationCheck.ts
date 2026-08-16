/**
 * BTC-only verification before switching the live strategy to a static weight.
 *
 * The engine-vs-static comparison that motivated this switch averaged 5 assets.
 * The deployed book trades ONE instrument (OKX_INST_ID, default BTC-USDT), and an
 * average across SOL and DOGE is not evidence about BTC. This re-runs the same
 * episode study on the single traded instrument.
 *
 * It also reports the weight/band sensitivity — NOT to pick the best cell. The
 * walk-forward study measured Spearman rho = -0.339 between train-optimal and
 * test-optimal exit parameters, i.e. chasing a historical optimum was worse than
 * choosing blindly. The same trap applies here. The weight is a RISK APPETITE
 * decision for the owner, and 40% is defensible for one specific reason: it is
 * what the engine's realised exposure already was, so adopting it changes cost
 * and complexity without changing the risk profile. The grid is printed so that
 * choice is informed, not optimised.
 *
 * Usage:
 *   pnpm tsx server/scripts/staticAllocationCheck.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import { loadHourly } from "./lib/historyCache";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const INST = arg("inst") ?? process.env.OKX_INST_ID ?? "BTC-USDT";
const YEARS = parseFloat(arg("years") ?? "3");
const SEED = 10000;
const WARMUP = 200;
const WIN_MS = 90 * 24 * 3600 * 1000;
const STEP_MS = 30 * 24 * 3600 * 1000;
const END = Date.parse("2026-08-16T00:00:00Z");
const START = END - YEARS * 365 * 24 * 3600 * 1000;

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

interface Sig { signal: "buy" | "sell" | "hold"; confidence: number }
interface Perf { ret: number; maxDD: number; trades: number; expo: number }

function stats(eq: number[], trades: number, expSum: number, n: number): Perf {
  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd, trades, expo: n ? expSum / n : 0 };
}

function runEngine(c: CandleData[], sigs: Sig[], from: number, to: number): Perf {
  let cash = SEED, u = 0, trades = 0, expSum = 0, n = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close, s = sigs[i];
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
  return stats(eq, trades, expSum, n);
}

function runStatic(c: CandleData[], from: number, to: number, w: number, band: number): Perf {
  let cash = SEED, u = 0, trades = 0, expSum = 0, n = 0;
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close, v = cash + u * px;
    if (v <= 0) break;
    if (Math.abs(w - (u * px) / v) > band) {
      const tu = (w * v) / px, d = tu - u;
      const notional = Math.abs(d) * px;
      // Same dust floor the live venue enforces, so trade counts are comparable.
      if (notional >= MIN_TRADE_NOTIONAL_USD) { cash -= d * px + notional * FEE; u = tu; trades++; }
    }
    const vv = cash + u * px;
    eq.push(vv);
    if (vv > 0) { expSum += (u * px) / vv; n++; }
  }
  return stats(eq, trades, expSum, n);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`Static-allocation check — ${INST} ONLY · ${YEARS}y · 90-day episodes stepped 30d · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(92));

  const { candles: c, gaps } = await loadHourly(INST, START, END);
  if (c.length < WARMUP + 2200) { console.log("insufficient history"); return; }
  if (gaps.length) console.log(`  ⚠ ${gaps.reduce((a, g) => a + g.bars, 0)} missing bars`);

  const scope = getCandleLimit("1h");
  const sigs: Sig[] = new Array(c.length).fill(null).map(() => ({ signal: "hold" as const, confidence: 0 }));
  for (let i = WARMUP; i < c.length; i++) {
    const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    const s = generateSignal(m, P);
    sigs[i] = { signal: s.signal, confidence: s.confidence };
  }

  const eps: Array<{ hold: number; eng: Perf; t0: number }> = [];
  const spans: Array<[number, number]> = [];
  for (let t0 = START; t0 + WIN_MS <= END; t0 += STEP_MS) {
    const from = c.findIndex((x) => x.openTime >= t0);
    const to = c.findIndex((x) => x.openTime >= t0 + WIN_MS);
    if (from < WARMUP || to <= from) continue;
    spans.push([from, to]);
    eps.push({ hold: c[to].close / c[from].close - 1, eng: runEngine(c, sigs, from, to), t0: c[from].openTime });
  }
  console.log(`\n${eps.length} episodes\n`);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const engRet = mean(eps.map((e) => e.eng.ret));
  const engDD = mean(eps.map((e) => e.eng.maxDD));
  const engTr = mean(eps.map((e) => e.eng.trades));
  const engEx = mean(eps.map((e) => e.eng.expo));

  console.log("─".repeat(92));
  console.log("strategy".padEnd(26) + pad("mean ret", 11) + pad("mean DD", 10) + pad("trades", 9) +
              pad("exposure", 10) + pad("beats engine", 14));
  console.log("─".repeat(92));
  console.log("ENGINE (current)".padEnd(26) + pad(pct(engRet), 11) + pad(`${(engDD * 100).toFixed(1)}%`, 10) +
              pad(engTr.toFixed(0), 9) + pad(`${(engEx * 100).toFixed(0)}%`, 10) + pad("—", 14));

  for (const band of [0.05, 0.10, 0.15]) {
    for (const w of [0.30, 0.40, 0.50]) {
      const rs = spans.map(([f, t]) => runStatic(c, f, t, w, band));
      const wins = rs.filter((r, i) => r.ret > eps[i].eng.ret).length;
      const tag = `static ${(w * 100).toFixed(0)}% band ${(band * 100).toFixed(0)}%`;
      console.log(tag.padEnd(26) + pad(pct(mean(rs.map((r) => r.ret))), 11) +
        pad(`${(mean(rs.map((r) => r.maxDD)) * 100).toFixed(1)}%`, 10) +
        pad(mean(rs.map((r) => r.trades)).toFixed(0), 9) +
        pad(`${(mean(rs.map((r) => r.expo)) * 100).toFixed(0)}%`, 10) +
        pad(`${wins}/${rs.length} (${((wins / rs.length) * 100).toFixed(0)}%)`, 14));
    }
  }
  console.log("─".repeat(92));

  // Bull/bear split at the chosen configuration, so the tradeoff is explicit.
  const W = 0.40, B = 0.10;
  const chosen = spans.map(([f, t]) => runStatic(c, f, t, W, B));
  const bulls = eps.map((e, i) => ({ e, s: chosen[i] })).filter((x) => x.e.hold > 0.25);
  const bears = eps.map((e, i) => ({ e, s: chosen[i] })).filter((x) => x.e.hold < -0.20);
  console.log(`\nchosen configuration: static ${(W * 100).toFixed(0)}%, ${(B * 100).toFixed(0)}% band`);
  if (bulls.length) console.log(`  bulls (hold >+25%, n=${bulls.length})   engine ${pct(mean(bulls.map((x) => x.e.eng.ret)))}   static ${pct(mean(bulls.map((x) => x.s.ret)))}`);
  if (bears.length) console.log(`  bears (hold <-20%, n=${bears.length})   engine ${pct(mean(bears.map((x) => x.e.eng.ret)))}   static ${pct(mean(bears.map((x) => x.s.ret)))}`);
  console.log("═".repeat(92) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
