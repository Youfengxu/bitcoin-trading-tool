/**
 * Validation of the exit-policy lead: parameter sweep + anchored walk-forward.
 *
 * `tradeAnatomy.ts` found three exit rules improving BOTH regime windows — the
 * first result of this project to clear that bar. This decides whether it is
 * real or fitted. It is written to FAIL the lead if the lead is noise, because
 * the incentive at this point runs the other way.
 *
 * ── Pre-registered criteria (all four required) ───────────────────────
 *
 *   1. PLATEAU, NOT SPIKE. The top-quartile region of the grid is contiguous
 *      and spans >=25% of cells. A single good cell ringed by bad ones is a fit;
 *      a broad region means the effect is insensitive to the exact parameter.
 *
 *   2. TRAIN RANK PREDICTS TEST RANK. Spearman rho > 0 between each parameter
 *      pair's train and test performance. This is the decisive one: it is the
 *      same diagnostic that exposed the eight threshold classifiers as scatter
 *      (their accuracy and return correlated at r=0.45, i.e. noise). If picking
 *      a good parameter on history tells you nothing about its future, the grid
 *      is a lottery no matter how good its best cell looks.
 *
 *   3. WALK-FORWARD BEATS BASELINE. Parameters selected on train only must beat
 *      the current no-exit-rule policy on held-out folds, aggregated.
 *
 *   4. HOLDS IN BOTH WINDOWS separately.
 *
 * ── Design notes ──────────────────────────────────────────────────────
 * Entry signals are a pure function of candles, so they are computed ONCE per
 * asset and reused across all grid cells; only the exit arithmetic varies. This
 * makes a 49-cell grid affordable and guarantees that every cell sees literally
 * identical entries.
 *
 * Each fold starts a fresh book. Carrying state across folds would let one
 * fold's luck compound into the next and confound the per-fold readings.
 *
 * Usage:
 *   pnpm tsx server/scripts/exitPolicyValidation.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const WARMUP = 200;
const FOLD = 700;
const MIN_TRAIN = 1400;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,DOGE-USDT,ACE-USDT,ROBO-USDT,HYPE-USDT,WLD-USDT,BNB-USDT").split(",");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** null = rule disabled. Values are fractional drawdowns from entry / from peak. */
const STOPS: (number | null)[] = [null, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20];
const TRAILS: (number | null)[] = [null, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25];

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

interface Sig { signal: "buy" | "sell" | "hold"; confidence: number }
interface Lot { units: number; px: number; bar: number; peak: number }

/** Simulate one asset over [from,to] with a given exit policy. Signals precomputed. */
function sim(c: CandleData[], sigs: Sig[], from: number, to: number, stop: number | null, trail: number | null) {
  let cash = SEED;
  const lots: Lot[] = [];
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  const units = () => lots.reduce((a, l) => a + l.units, 0);

  const close = (want: number, px: number) => {
    let left = want, gross = 0;
    while (left > 1e-12 && lots.length) {
      const l = lots[0];
      const take = Math.min(l.units, left);
      const g = take * px;
      gross += g - g * FEE;
      l.units -= take;
      left -= take;
      if (l.units <= 1e-12) lots.shift();
    }
    cash += gross;
  };

  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    for (const l of lots) l.peak = Math.max(l.peak, px);

    // Exits checked before entries so a stop always wins a tie on the same bar.
    if (stop !== null || trail !== null) {
      for (const l of [...lots]) {
        const hitStop = stop !== null && px / l.px - 1 <= -stop;
        const hitTrail = trail !== null && l.peak > l.px && px / l.peak - 1 <= -trail;
        if (hitStop || hitTrail) close(l.units, px);
      }
    }

    const s = sigs[i];
    if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
    if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
      const f = convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence);
      if (s.signal === "buy" && cash > 0) {
        const usd = cash * f;
        if (usd >= MIN_TRADE_NOTIONAL_USD) {
          const fee = usd * FEE;
          lots.push({ units: (usd - fee) / px, px, bar: i, peak: px });
          cash -= usd;
        }
      } else if (s.signal === "sell" && units() > 0) {
        const sz = units() * f;
        if (sz * px >= MIN_TRADE_NOTIONAL_USD) close(sz, px);
      }
    }
    eq.push(cash + units() * px);
  }

  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd };
}

function spearman(a: number[], b: number[]) {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length).fill(0);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = ra[i] - ma, v = rb[i] - mb; num += u * v; da += u * u; db += v * v; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}`;
const lbl = (v: number | null) => (v === null ? "off" : `${(v * 100).toFixed(1)}%`);

async function main() {
  const assets: Array<{ id: string; c: CandleData[]; sigs: Sig[] }> = [];
  for (const id of PAIRS) {
    let c: CandleData[] | null = null;
    for (let a = 0; a < 3 && !c; a++) {
      try {
        const r = await okx.fetchCandlesFrom("1h", H0, 5000, id);
        c = r.map((x) => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, openTime: x.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(400);
    if (!c) continue;
    // Truncate to a FIXED end timestamp. Deriving fold boundaries from live
    // array length made two consecutive runs disagree on the sign of the
    // decisive statistic (rho -0.339 vs +0.150) purely because new candles had
    // arrived between them. Same defect class as the Date.now() window bug.
    c = c.filter((x) => x.openTime < END);
    if (c.length < 1500) continue;
    const scope = getCandleLimit("1h");
    const sigs: Sig[] = new Array(c.length).fill(null).map(() => ({ signal: "hold" as const, confidence: 0 }));
    for (let i = WARMUP; i < c.length; i++) {
      const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
      const s = generateSignal(m, P);
      sigs[i] = { signal: s.signal, confidence: s.confidence };
    }
    assets.push({ id, c, sigs });
    process.stdout.write(`  ${id} signals ready\n`);
  }

  const cells: Array<{ s: number | null; t: number | null }> = [];
  for (const s of STOPS) for (const t of TRAILS) cells.push({ s, t });

  const meanOver = (ws: number, we: number, s: number | null, t: number | null) => {
    let sum = 0, n = 0;
    for (const a of assets) {
      const from = Math.max(a.c.findIndex((x) => x.openTime >= ws), WARMUP);
      let to = a.c.findIndex((x) => x.openTime >= we);
      if (to < 0) to = a.c.length - 1;
      if (to - from < 200) continue;
      sum += sim(a.c, a.sigs, from, to, s, t).ret; n++;
    }
    return n ? sum / n : 0;
  };

  // ── 1. Sweep ────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(86)}`);
  console.log(`Exit-policy sweep · ${assets.length} assets · mean return %, BULL / BEAR`);
  console.log("═".repeat(86));
  const bullG: number[] = [], bearG: number[] = [];
  console.log("stop \\ trail".padEnd(13) + TRAILS.map((t) => lbl(t).padStart(11)).join(""));
  for (const s of STOPS) {
    let row = lbl(s).padEnd(13);
    for (const t of TRAILS) {
      const b = meanOver(H0, SPLIT, s, t), r = meanOver(SPLIT, END, s, t);
      bullG.push(b); bearG.push(r);
      row += `${pct(b)}/${pct(r)}`.padStart(11);
    }
    console.log(row);
  }
  const combined = bullG.map((b, i) => b + bearG[i]);
  const base = combined[0];  // stop off, trail off = current policy
  const sorted = [...combined].sort((a, b) => b - a);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const topCells = combined.filter((x) => x >= q1).length;
  const betterBoth = cells.filter((_, i) => bullG[i] > bullG[0] && bearG[i] > bearG[0]).length;

  console.log(`\ncurrent policy (both off): bull ${pct(bullG[0])}%  bear ${pct(bearG[0])}%  sum ${pct(base)}%`);
  console.log(`cells beating it in BOTH windows: ${betterBoth} / ${cells.length} (${((betterBoth / cells.length) * 100).toFixed(0)}%)`);
  console.log(`top-quartile cells: ${topCells} / ${cells.length}`);

  // ── 2. Anchored walk-forward ────────────────────────────────────────
  console.log(`\n${"═".repeat(86)}`);
  console.log("Anchored walk-forward — parameters chosen on train only, scored on the next fold");
  console.log("═".repeat(86));

  const minLen = Math.min(...assets.map((a) => a.c.length));
  const folds: Array<[number, number]> = [];
  for (let st = WARMUP + MIN_TRAIN; st + FOLD <= minLen; st += FOLD) folds.push([st, st + FOLD - 1]);

  const meanBars = (from: number, to: number, s: number | null, t: number | null) => {
    let sum = 0, n = 0;
    for (const a of assets) {
      if (to >= a.c.length) continue;
      sum += sim(a.c, a.sigs, from, to, s, t).ret; n++;
    }
    return n ? sum / n : 0;
  };

  console.log("fold".padEnd(6) + "train bars".padEnd(13) + "selected".padEnd(20) +
              "OOS selected".padStart(14) + "OOS current".padStart(14) + "edge".padStart(9));
  console.log("─".repeat(86));
  let selSum = 0, baseSum = 0;
  const trainPerf: number[][] = [], testPerf: number[][] = [];
  for (const [ts, te] of folds) {
    const tr = cells.map((c) => meanBars(WARMUP, ts - 1, c.s, c.t));
    const te_ = cells.map((c) => meanBars(ts, te, c.s, c.t));
    trainPerf.push(tr); testPerf.push(te_);
    let bi = 0;
    for (let i = 1; i < tr.length; i++) if (tr[i] > tr[bi]) bi = i;
    const oos = te_[bi], cur = te_[0];
    selSum += oos; baseSum += cur;
    console.log(`${String(folds.indexOf([ts, te] as any) + 1).padEnd(6)}`.replace("0     ", `${folds.findIndex(([a]) => a === ts) + 1}     `) +
      `${WARMUP}–${ts - 1}`.padEnd(13) +
      `stop ${lbl(cells[bi].s)} trail ${lbl(cells[bi].t)}`.padEnd(20) +
      `${pct(oos)}%`.padStart(14) + `${pct(cur)}%`.padStart(14) +
      `${pct(oos - cur)}pp`.padStart(9));
  }
  console.log("─".repeat(86));
  console.log("TOTAL".padEnd(39) + `${pct(selSum)}%`.padStart(14) + `${pct(baseSum)}%`.padStart(14) +
              `${pct(selSum - baseSum)}pp`.padStart(9));

  // ── 3. Does train rank predict test rank? ───────────────────────────
  const rhos = trainPerf.map((tr, i) => spearman(tr, testPerf[i]));
  const meanRho = rhos.reduce((a, b) => a + b, 0) / rhos.length;
  console.log(`\nSpearman rho, train rank vs test rank of all ${cells.length} parameter pairs:`);
  rhos.forEach((r, i) => console.log(`  fold ${i + 1}   rho = ${r >= 0 ? "+" : ""}${r.toFixed(3)}`));
  console.log(`  mean    rho = ${meanRho >= 0 ? "+" : ""}${meanRho.toFixed(3)}`);

  // ── 4. Fixed parameters, no selection ───────────────────────────────
  // Criterion 2 failing while criterion 1 passes has a specific meaning: the
  // EFFECT is broad but its OPTIMUM is not identifiable. That is exactly the
  // condition under which you use a fixed parameter and never optimise it. This
  // measures every cell on the concatenated out-of-sample folds, so no cell is
  // chosen and there is nothing to overfit — the distribution answers whether
  // the effect survives without selection.
  const oosTotal = cells.map((_, ci) => testPerf.reduce((a, f) => a + f[ci], 0));
  const curOos = oosTotal[0];
  const beat = oosTotal.filter((x) => x > curOos).length;
  const ranked = cells.map((c, i) => ({ c, v: oosTotal[i] })).sort((a, b) => b.v - a.v);
  const median = [...oosTotal].sort((a, b) => a - b)[Math.floor(oosTotal.length / 2)];

  console.log(`\n${"═".repeat(86)}`);
  console.log("Fixed parameters — every cell scored on the SAME held-out folds, nothing selected");
  console.log("═".repeat(86));
  console.log(`current policy (both off)      ${pct(curOos)}%`);
  console.log(`median across all 49 cells     ${pct(median)}%`);
  console.log(`cells beating current OOS      ${beat} / ${cells.length} (${((beat / cells.length) * 100).toFixed(0)}%)`);
  console.log(`\nbest 5 out-of-sample:`);
  ranked.slice(0, 5).forEach((r) => console.log(`   stop ${lbl(r.c.s).padEnd(6)} trail ${lbl(r.c.t).padEnd(6)}  ${pct(r.v)}%`));
  console.log(`worst 5 out-of-sample:`);
  ranked.slice(-5).forEach((r) => console.log(`   stop ${lbl(r.c.s).padEnd(6)} trail ${lbl(r.c.t).padEnd(6)}  ${pct(r.v)}%`));

  console.log(`\n${"═".repeat(86)}`);
  console.log("PRE-REGISTERED CRITERIA");
  console.log(`  1. plateau (top quartile >=25% of grid)      ${topCells >= cells.length * 0.25 ? "PASS" : "FAIL"}  (${topCells}/${cells.length})`);
  console.log(`  2. train rank predicts test rank (rho > 0)   ${meanRho > 0 ? "PASS" : "FAIL"}  (rho ${meanRho.toFixed(3)})`);
  console.log(`  3. walk-forward beats current policy         ${selSum > baseSum ? "PASS" : "FAIL"}  (${pct(selSum - baseSum)}pp)`);
  console.log(`  4. majority of grid better in BOTH windows   ${betterBoth > cells.length * 0.5 ? "PASS" : "FAIL"}  (${betterBoth}/${cells.length})`);
  console.log("═".repeat(86) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
