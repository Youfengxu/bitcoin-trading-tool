/**
 * Validation of the drawdown-scaling weight rule.
 *
 *     w(t) = base x max(floor, price(t) / runningPeak(t))
 *
 * It improved Sharpe in 11 of 12 assets at lower cost than a constant weight.
 * This decides whether that survives the protocol that killed the exit-policy
 * work, and it is written to FAIL the rule if the rule is noise.
 *
 * ── Pre-registered criteria (all four required) ───────────────────────
 *
 *   1. PLATEAU, NOT SPIKE. The top-quartile region of the (floor x peak-window)
 *      grid spans >= 25% of cells. A lone good cell ringed by bad ones is a fit.
 *
 *   2. TRAIN RANK PREDICTS TEST RANK. Spearman rho > 0 between each parameter
 *      pair's train and test Sharpe. This is the criterion that killed exit-policy
 *      tuning, where rho was -0.339: historically-best parameters did WORSE than
 *      average next fold. If picking a good parameter on history says nothing
 *      about its future, the grid is a lottery however good its best cell looks.
 *
 *   3. FIXED PARAMETER BEATS CONSTANT WEIGHT OUT OF SAMPLE. Not the best cell --
 *      a single parameter chosen once, scored on held-out folds, against the
 *      control. Selection is not available in live trading.
 *
 *   4. BREADTH. Improves Sharpe in >= 8 of 12 assets on held-out folds.
 *
 * ── Why the control is inside the grid ────────────────────────────────
 * floor = 1.0 makes w = base identically, i.e. the constant-weight control. It
 * is one cell of the same sweep, scored by the same code on the same bars, so
 * the comparison cannot drift.
 *
 * ── Sharpe, deliberately ──────────────────────────────────────────────
 * Sharpe is scale-invariant, so rules running different average exposures are
 * comparable without exposure-matching -- which is what leaked look-ahead into
 * the earlier active-strategy run. The base weight is held at 0.40 throughout
 * and cannot affect Sharpe; only floor and peak-window can.
 */

import { loadHourly } from "./lib/historyCache";
import type { CandleData } from "../engine/technicalAnalysis";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const SEED = 10000, BAND = 0.10, BASE = 0.40, MIN_NOTIONAL = 300;
const END = Date.parse("2026-08-16T00:00:00Z");
const YEAR = 365 * 24 * 3600 * 1000;
const START = END - 3 * YEAR;
const FOLD_H = 120 * 24;          // 120-day folds
const MIN_TRAIN_H = 300 * 24;     // at least 300 days before the first test fold

const FLOORS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1.0];
/** Running peak measured from inception, or over a trailing window. */
const PEAK_WINDOWS_H = [0, 90 * 24, 180 * 24, 365 * 24]; // 0 = since inception

const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,XRP-USDT,DOGE-USDT,ADA-USDT,LINK-USDT,AVAX-USDT,LTC-USDT,DOT-USDT,TRX-USDT").split(",");

/** Sharpe of the rule over [from,to]. Peak is causal: only bars <= i are used. */
function sharpeOf(c: CandleData[], from: number, to: number, floor: number, peakW: number): number {
  let cash = SEED, u = 0;
  const eq: number[] = [];
  let peak = 0, held = BASE;
  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    if (peakW === 0) peak = Math.max(peak, px);
    else {
      peak = 0;
      for (let k = Math.max(from, i - peakW + 1); k <= i; k++) peak = Math.max(peak, c[k].close);
    }
    const v = cash + u * px;
    if (v <= 0) break;
    if ((i - from) % 24 === 0) held = BASE * Math.max(floor, peak > 0 ? px / peak : 1);
    const t = Math.max(0, Math.min(1, held));
    if (Math.abs(t - (u * px) / v) > BAND) {
      const d = (t * v) / px - u, no = Math.abs(d) * px;
      if (no >= MIN_NOTIONAL) { cash -= d * px + no * FEE; u += d; }
    }
    eq.push(cash + u * px);
  }
  if (eq.length < 100) return NaN;
  const r: number[] = [];
  for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length);
  return sd > 0 ? (m / sd) * Math.sqrt(24 * 365) : 0;
}

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
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

const cells = FLOORS.flatMap((f) => PEAK_WINDOWS_H.map((p) => ({ f, p })));
const CONTROL = cells.findIndex((c) => c.f === 1.0 && c.p === 0);
/** Fixed parameter for criterion 3, chosen ONCE before any fold is scored. */
const FIXED = { f: 0.3, p: 0 };

async function main() {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`Drawdown-scaling validation · ${cells.length} cells · base ${BASE} · ${(FEE * 1e4).toFixed(0)}bps`);
  console.log(`control = floor 1.0 (constant weight), inside the grid`);
  console.log("═".repeat(92));

  const data: Array<[string, CandleData[]]> = [];
  for (const id of PAIRS) {
    const { candles } = await loadHourly(id, START, END, false);
    if (candles.length > 5000) data.push([id.replace("-USDT", ""), candles]);
  }

  // ── 1. Full-sample grid, pooled across assets ──────────────────────
  const pooled = cells.map(({ f, p }) => {
    const vals = data.map(([, c]) => sharpeOf(c, 0, c.length - 1, f, p)).filter(Number.isFinite);
    return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  });
  const sorted = [...pooled].sort((a, b) => b - a);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const topCells = pooled.filter((x) => x >= q1).length;

  console.log(`\nmean Sharpe across ${data.length} assets, by floor x peak-window\n`);
  console.log("floor   " + PEAK_WINDOWS_H.map((p) => (p === 0 ? "inception" : `${p / 24}d`).padStart(11)).join(""));
  console.log("─".repeat(92));
  for (const f of FLOORS) {
    let row = String(f === 1.0 ? "1.0*" : f).padEnd(8);
    for (const p of PEAK_WINDOWS_H) {
      const v = pooled[cells.findIndex((c) => c.f === f && c.p === p)];
      row += v.toFixed(3).padStart(11);
    }
    console.log(row);
  }
  console.log(`\n* floor 1.0 = constant weight = the control (Sharpe ${pooled[CONTROL].toFixed(3)})`);
  console.log(`top-quartile cells: ${topCells}/${cells.length}`);

  // ── 2 & 3. Walk-forward ────────────────────────────────────────────
  const rhos: number[] = [];
  let selWins = 0, fixWins = 0, folds = 0;
  const perAssetFixed: Array<{ id: string; fixed: number; ctrl: number }> = [];

  for (const [id, c] of data) {
    let aFix = 0, aCtl = 0, aN = 0;
    for (let ts = MIN_TRAIN_H; ts + FOLD_H <= c.length; ts += FOLD_H) {
      const tr = cells.map(({ f, p }) => sharpeOf(c, 0, ts - 1, f, p));
      const te = cells.map(({ f, p }) => sharpeOf(c, ts, ts + FOLD_H - 1, f, p));
      const ok = tr.map((x, i) => Number.isFinite(x) && Number.isFinite(te[i]));
      const trF = tr.filter((_, i) => ok[i]), teF = te.filter((_, i) => ok[i]);
      if (trF.length < 5) continue;
      rhos.push(spearman(trF, teF));

      let bi = 0;
      for (let i = 1; i < tr.length; i++) if (Number.isFinite(tr[i]) && tr[i] > tr[bi]) bi = i;
      const fixedI = cells.findIndex((x) => x.f === FIXED.f && x.p === FIXED.p);
      if (Number.isFinite(te[bi]) && Number.isFinite(te[CONTROL]) && te[bi] > te[CONTROL]) selWins++;
      if (Number.isFinite(te[fixedI]) && Number.isFinite(te[CONTROL])) {
        if (te[fixedI] > te[CONTROL]) fixWins++;
        aFix += te[fixedI]; aCtl += te[CONTROL]; aN++;
      }
      folds++;
    }
    if (aN) perAssetFixed.push({ id, fixed: aFix / aN, ctrl: aCtl / aN });
  }

  const meanRho = rhos.reduce((a, b) => a + b, 0) / Math.max(1, rhos.length);
  const breadth = perAssetFixed.filter((x) => x.fixed > x.ctrl).length;

  console.log(`\n${"─".repeat(92)}`);
  console.log(`Walk-forward: ${folds} folds across ${data.length} assets (${FOLD_H / 24}-day folds)`);
  console.log("─".repeat(92));
  console.log(`  train rank vs test rank      mean Spearman rho = ${meanRho >= 0 ? "+" : ""}${meanRho.toFixed(3)}`);
  console.log(`  SELECTED best-on-train beats control   ${selWins}/${folds} folds (${((selWins / folds) * 100).toFixed(0)}%)`);
  console.log(`  FIXED floor ${FIXED.f} beats control        ${fixWins}/${folds} folds (${((fixWins / folds) * 100).toFixed(0)}%)`);
  console.log(`\n  per-asset mean held-out Sharpe, fixed floor ${FIXED.f} vs constant weight:`);
  for (const a of perAssetFixed) {
    const d = a.fixed - a.ctrl;
    console.log(`    ${a.id.padEnd(7)} ${a.fixed.toFixed(3).padStart(7)} vs ${a.ctrl.toFixed(3).padStart(7)}   ${(d >= 0 ? "+" : "") + d.toFixed(3)}`);
  }

  console.log(`\n${"═".repeat(92)}`);
  console.log("PRE-REGISTERED CRITERIA");
  console.log(`  1. plateau (top quartile >= 25% of grid)     ${topCells >= cells.length * 0.25 ? "PASS" : "FAIL"}  (${topCells}/${cells.length})`);
  console.log(`  2. train rank predicts test rank (rho > 0)   ${meanRho > 0 ? "PASS" : "FAIL"}  (rho ${meanRho.toFixed(3)})`);
  console.log(`  3. FIXED param beats control out-of-sample   ${fixWins / folds > 0.5 ? "PASS" : "FAIL"}  (${((fixWins / folds) * 100).toFixed(0)}% of folds)`);
  console.log(`  4. breadth >= 8/12 assets                    ${breadth >= 8 ? "PASS" : "FAIL"}  (${breadth}/${perAssetFixed.length})`);
  console.log("═".repeat(92) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
