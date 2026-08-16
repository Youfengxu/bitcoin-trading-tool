/**
 * Does GMM-FORECAST volatility beat TRAILING volatility as the risk scaler?
 *
 * The 1.04sd separation that motivated this whole line was measured on FORWARD
 * volatility conditioned on cluster. The first backtest used trailing realized
 * vol — the naive proxy — and got consistent drawdown reduction. This asks the
 * question that sequencing set up: does the sophisticated predictor earn its
 * complexity over the 20-line average?
 *
 * Both scalers are fed into an IDENTICAL sizing rule, so the only thing that
 * varies is the volatility forecast. Two things are measured:
 *
 *   1. FORECAST QUALITY — correlation of each predictor with realized forward
 *      volatility, out-of-sample. This is the honest test of the predictor
 *      itself, independent of any trading rule wrapped around it.
 *   2. ECONOMIC RESULT — drawdown and Sharpe through the same book.
 *
 * Measuring (1) separately matters: if the GMM forecasts better but trades no
 * better, that locates the failure in the sizing rule rather than the signal,
 * which is a different and more useful conclusion than a single blended number.
 *
 * Cluster→forward-vol mapping is learned on TRAIN ONLY and applied unchanged to
 * test bars. Learning it on the full sample would leak the answer, which is the
 * defect that made walkForwardOptimize report 93% against a true −1.6%.
 *
 * Usage:
 *   pnpm tsx server/scripts/volForecastCompare.ts
 */

import { sma, type CandleData } from "../engine/technicalAnalysis";
import * as okx from "../engine/okxClient";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const K = parseInt(arg("k") ?? "4");
const VOL_WINDOW = 168;
const HORIZON = 168;
const WARMUP = 200;
const MAX_MULT = 2.0, MIN_MULT = 0.25, BAND = 0.15;
const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT_TS = Date.parse("2026-05-15T00:00:00Z");
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,DOGE-USDT,ACE-USDT,ROBO-USDT,HYPE-USDT,WLD-USDT,BNB-USDT").split(",");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function atr(c: CandleData[], i: number, p: number) {
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) {
    const a = c[k], b = c[k - 1];
    s += Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close));
  }
  return s / p / c[i].close;
}
function vol(c: CandleData[], from: number, to: number) {
  const lr: number[] = [];
  for (let k = from; k <= to; k++) lr.push(Math.log(c[k].close / c[k - 1].close));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / lr.length);
}
/** Same five features as the GMM diagnostic that produced the 1.04sd result. */
function feat(c: CandleData[], i: number): number[] | null {
  if (i < WARMUP) return null;
  const r24 = Math.log(c[i].close / c[i - 24].close);
  const v = vol(c, i - VOL_WINDOW + 1, i);
  const aF = atr(c, i, 14), aS = atr(c, i, 50);
  const va = c.slice(i - 167, i + 1).reduce((a, b) => a + b.volume, 0) / 168;
  const s2 = sma(c.slice(i - 249, i + 1).map((x) => x.close), 200);
  if (s2 === null || aS === 0 || aF === 0) return null;
  const f = [r24, v, aF / aS, va > 0 ? c[i].volume / va : 1, (c[i].close - s2) / s2 / aF];
  return f.every(Number.isFinite) ? f : null;
}

interface Gmm { w: number[]; mu: number[][]; vr: number[][]; k: number; d: number }
function fitGmm(X: number[][], k: number, iters = 100): Gmm {
  const n = X.length, d = X[0].length;
  const mu: number[][] = [];
  for (let j = 0; j < k; j++) mu.push([...X[Math.floor((j + 0.5) * n / k)]]);
  const vr = Array.from({ length: k }, () => {
    const v: number[] = [];
    for (let f = 0; f < d; f++) {
      const col = X.map((x) => x[f]);
      const m = col.reduce((a, b) => a + b, 0) / n;
      v.push(Math.max(1e-6, col.reduce((s, x) => s + (x - m) ** 2, 0) / n));
    }
    return v;
  });
  const w = new Array(k).fill(1 / k);
  const R = Array.from({ length: n }, () => new Array(k).fill(0));
  const lp = (x: number[], j: number) => {
    let s = 0;
    for (let f = 0; f < d; f++) s += -0.5 * (Math.log(2 * Math.PI * vr[j][f]) + (x[f] - mu[j][f]) ** 2 / vr[j][f]);
    return s;
  };
  for (let t = 0; t < iters; t++) {
    for (let i = 0; i < n; i++) {
      const a = new Array(k);
      for (let j = 0; j < k; j++) a[j] = Math.log(Math.max(1e-300, w[j])) + lp(X[i], j);
      const mx = Math.max(...a);
      let s = 0;
      for (let j = 0; j < k; j++) { R[i][j] = Math.exp(a[j] - mx); s += R[i][j]; }
      for (let j = 0; j < k; j++) R[i][j] /= s;
    }
    for (let j = 0; j < k; j++) {
      let nj = 0;
      for (let i = 0; i < n; i++) nj += R[i][j];
      nj = Math.max(1e-8, nj);
      w[j] = nj / n;
      for (let f = 0; f < d; f++) { let s = 0; for (let i = 0; i < n; i++) s += R[i][j] * X[i][f]; mu[j][f] = s / nj; }
      for (let f = 0; f < d; f++) { let s = 0; for (let i = 0; i < n; i++) s += R[i][j] * (X[i][f] - mu[j][f]) ** 2; vr[j][f] = Math.max(1e-6, s / nj); }
    }
  }
  return { w, mu, vr, k, d };
}
function classify(x: number[], g: Gmm): number {
  let b = 0, bl = -Infinity;
  for (let j = 0; j < g.k; j++) {
    let s = Math.log(Math.max(1e-300, g.w[j]));
    for (let f = 0; f < g.d; f++) s += -0.5 * (Math.log(2 * Math.PI * g.vr[j][f]) + (x[f] - g.mu[j][f]) ** 2 / g.vr[j][f]);
    if (s > bl) { bl = s; b = j; }
  }
  return b;
}
function corr(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; num += u * v; da += u * u; dbb += v * v; }
  return da > 0 && dbb > 0 ? num / Math.sqrt(da * dbb) : 0;
}

/** Hold-with-risk-scaling. `mults[i]` is the exposure multiplier at bar `from+i`. */
function book(c: CandleData[], from: number, to: number, mults: number[] | null) {
  let cash = SEED, u = 0, trades = 0;
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close, v = cash + u * px;
    if (v <= 0) break;
    const target = mults ? Math.min(1, mults[i - from]) : 1;
    const cur = (u * px) / v;
    if (Math.abs(target - cur) > BAND) {
      const tu = (target * v) / px, d = tu - u;
      cash -= d * px + Math.abs(d) * px * FEE;
      u = tu; trades++;
    }
    eq.push(cash + u * px);
  }
  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  const r: number[] = [];
  for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, r.length));
  return { ret: fin / SEED - 1, sharpe: sd > 0 ? (m / sd) * Math.sqrt(24 * 365) : 0, maxDD: dd, trades };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(96)}`);
  console.log(`Volatility forecast: GMM (k=${K}) vs trailing average — same sizing rule, only the predictor varies`);
  console.log("═".repeat(96));

  const assets: Array<{ id: string; c: CandleData[] }> = [];
  for (const id of PAIRS) {
    let c: CandleData[] | null = null;
    for (let a = 0; a < 3 && !c; a++) {
      try {
        const r = await okx.fetchCandlesFrom("1h", H0, 5000, id);
        c = r.map((x) => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, openTime: x.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(400);
    if (c && c.length >= 1500) assets.push({ id, c });
  }
  console.log(`\n${assets.length} assets\n`);

  // ── Fit on pooled TRAIN bars only ───────────────────────────────────
  const trX: number[][] = [], trFwd: number[] = [];
  for (const { c } of assets) {
    const cut = c.findIndex((x) => x.openTime >= SPLIT_TS);
    for (let i = WARMUP; i < cut - HORIZON; i++) {
      const f = feat(c, i);
      if (f) { trX.push(f); trFwd.push(vol(c, i + 1, i + HORIZON)); }
    }
  }
  const d = trX[0].length;
  const mu0: number[] = [], sd0: number[] = [];
  for (let f = 0; f < d; f++) {
    const col = trX.map((x) => x[f]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    mu0.push(m); sd0.push(Math.sqrt(col.reduce((s, x) => s + (x - m) ** 2, 0) / col.length) || 1);
  }
  const z = (x: number[]) => x.map((v, f) => (v - mu0[f]) / sd0[f]);
  const g = fitGmm(trX.map(z), K);

  // Cluster → mean forward vol, learned on train only.
  const sums = new Array(K).fill(0), cnts = new Array(K).fill(0);
  trX.forEach((x, i) => { const j = classify(z(x), g); sums[j] += trFwd[i]; cnts[j]++; });
  const clusterVol = sums.map((s, j) => (cnts[j] > 0 ? s / cnts[j] : NaN));
  const targetVol = [...trFwd].sort((a, b) => a - b)[Math.floor(trFwd.length / 2)];

  console.log("cluster forward-volatility map (learned on train):");
  for (let j = 0; j < K; j++) {
    console.log(`  cluster ${j}  ${pad(cnts[j], 6)} train bars   mean forward 168h vol ${(clusterVol[j] * 100).toFixed(3)}%   ⇒ scaler ${(Math.max(MIN_MULT, Math.min(MAX_MULT, targetVol / clusterVol[j]))).toFixed(2)}`);
  }
  console.log(`\ntarget vol = train median = ${(targetVol * 100).toFixed(3)}%\n`);

  // ── Out-of-sample: forecast quality, then economics ─────────────────
  const pTrail: number[] = [], pGmm: number[] = [], actual: number[] = [];
  const rows: Array<{ id: string; flat: any; tr: any; gm: any }> = [];

  for (const { id, c } of assets) {
    const start = Math.max(c.findIndex((x) => x.openTime >= SPLIT_TS), WARMUP + VOL_WINDOW);
    const end = c.length - 1;
    const mTr: number[] = [], mGm: number[] = [];
    for (let i = start; i <= end; i++) {
      const f = feat(c, i);
      const tv = i >= VOL_WINDOW + 1 ? vol(c, i - VOL_WINDOW + 1, i) : null;
      const gv = f ? clusterVol[classify(z(f), g)] : null;
      mTr.push(tv && tv > 0 ? Math.max(MIN_MULT, Math.min(MAX_MULT, targetVol / tv)) : 1);
      mGm.push(gv && gv > 0 ? Math.max(MIN_MULT, Math.min(MAX_MULT, targetVol / gv)) : 1);
      if (f && tv && gv && i + HORIZON <= end) {
        pTrail.push(tv); pGmm.push(gv); actual.push(vol(c, i + 1, i + HORIZON));
      }
    }
    rows.push({ id, flat: book(c, start, end, null), tr: book(c, start, end, mTr), gm: book(c, start, end, mGm) });
  }

  console.log("─".repeat(96));
  console.log("1. FORECAST QUALITY — correlation with realized forward 168h volatility, out-of-sample");
  console.log("─".repeat(96));
  console.log(`   trailing 168h vol    r = ${corr(pTrail, actual).toFixed(3)}`);
  console.log(`   GMM cluster vol      r = ${corr(pGmm, actual).toFixed(3)}     (${pGmm.length} bars)`);
  console.log("");

  console.log("─".repeat(96));
  console.log("2. ECONOMIC RESULT — held-out window, identical sizing rule");
  console.log("─".repeat(96));
  console.log("asset".padEnd(12) + pad("flat ret", 10) + pad("flat DD", 9) + pad("trail ret", 11) +
              pad("trail DD", 10) + pad("gmm ret", 10) + pad("gmm DD", 9));
  console.log("─".repeat(96));
  for (const r of rows) {
    console.log(r.id.padEnd(12) + pad(pct(r.flat.ret), 10) + pad(`${(r.flat.maxDD * 100).toFixed(1)}%`, 9) +
      pad(pct(r.tr.ret), 11) + pad(`${(r.tr.maxDD * 100).toFixed(1)}%`, 10) +
      pad(pct(r.gm.ret), 10) + pad(`${(r.gm.maxDD * 100).toFixed(1)}%`, 9));
  }
  const avg = (f: (r: any) => number, k: "flat" | "tr" | "gm") => rows.reduce((a, r) => a + f(r[k]), 0) / rows.length;
  console.log("─".repeat(96));
  console.log("MEAN".padEnd(12) + pad(pct(avg((x) => x.ret, "flat")), 10) + pad(`${(avg((x) => x.maxDD, "flat") * 100).toFixed(1)}%`, 9) +
    pad(pct(avg((x) => x.ret, "tr")), 11) + pad(`${(avg((x) => x.maxDD, "tr") * 100).toFixed(1)}%`, 10) +
    pad(pct(avg((x) => x.ret, "gm")), 10) + pad(`${(avg((x) => x.maxDD, "gm") * 100).toFixed(1)}%`, 9));
  console.log("Sharpe".padEnd(12) + pad(avg((x) => x.sharpe, "flat").toFixed(2), 10) + pad("", 9) +
    pad(avg((x) => x.sharpe, "tr").toFixed(2), 11) + pad("", 10) + pad(avg((x) => x.sharpe, "gm").toFixed(2), 10));
  console.log("═".repeat(96) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
