/**
 * GMM Regime Diagnostic — is the feature space separable at all?
 *
 * Step 1 of the Tier 1 plan in docs/regime-classifier-proposal.md, and
 * deliberately the cheapest one. If market states do not form distinguishable
 * clusters, a Hidden Markov Model has nothing to find either and the whole line
 * closes for half a day's work rather than a week's.
 *
 * ── Three tests, in increasing order of what matters ──────────────────
 *
 *   1. STRUCTURE    does a k-component mixture fit better than a single
 *                   Gaussian? Reported as BIC improvement, which penalises the
 *                   extra parameters so "more components fit better" cannot
 *                   trivially win.
 *
 *   2. PERSISTENCE  do cluster assignments stay put? A regime that changes every
 *                   few bars is not a regime, it is noise with a label. Measured
 *                   as mean run length. With a 72h latency budget the useful
 *                   floor is roughly a day; anything under a few bars is fatal.
 *
 *   3. PREDICTIVENESS  do the clusters differ in FORWARD 168h return? This is
 *                   the only test that matters economically. A GMM can always
 *                   partition a cloud of points; the question is whether the
 *                   partition says anything about what happens next.
 *
 * Test 3 is measured strictly out-of-sample: the mixture is fitted on the first
 * 70% of bars and clusters are assigned on the remaining 30%. Fitting and
 * scoring on the same data is the defect that made walkForwardOptimize report
 * 93% over six weeks against a true −1.6%, and it would be far easier to commit
 * here, where the model has real parameters.
 *
 * Usage:
 *   pnpm tsx server/scripts/gmmRegimeDiagnostic.ts
 *   pnpm tsx server/scripts/gmmRegimeDiagnostic.ts --k=3 --pairs=BTC-USDT,ETH-USDT
 */

import { sma, type CandleData } from "../engine/technicalAnalysis";
import * as okx from "../engine/okxClient";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const KS = (arg("k") ?? "2,3,4").split(",").map((x) => parseInt(x));
const HORIZON = parseInt(arg("horizon") ?? "168");
const TRAIN_FRAC = parseFloat(arg("train") ?? "0.7");
const JSON_OUT = arg("json") ?? null;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,LINK-USDT,ACE-USDT,ROBO-USDT,DOGE-USDT,HYPE-USDT,WLD-USDT,BNB-USDT").split(",");

const H0 = Date.parse("2026-02-15T00:00:00Z");
const WARMUP = 200;
const PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Features ─────────────────────────────────────────────────────────
/**
 * All backward-looking at bar i. Chosen to describe the STATE of the market
 * (how fast, how volatile, where relative to trend) rather than to predict
 * direction — the clustering should discover direction, not be told it.
 */
const FEATURE_NAMES = ["ret24h", "realVol168", "atrFast/Slow", "volRatio", "distSMA200/ATR"];

function atrPct(c: CandleData[], i: number, period: number): number {
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const cur = c[k], prev = c[k - 1];
    s += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return s / period / c[i].close;
}

function features(c: CandleData[], i: number): number[] | null {
  if (i < WARMUP) return null;
  const ret24 = Math.log(c[i].close / c[i - 24].close);
  const lr: number[] = [];
  for (let k = i - 167; k <= i; k++) lr.push(Math.log(c[k].close / c[k - 1].close));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  const vol = Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / lr.length);
  const aF = atrPct(c, i, 14), aS = atrPct(c, i, 50);
  const volAvg = c.slice(i - 167, i + 1).reduce((a, b) => a + b.volume, 0) / 168;
  const volR = volAvg > 0 ? c[i].volume / volAvg : 1;
  const s200 = sma(c.slice(i - 249, i + 1).map((x) => x.close), 200);
  if (s200 === null || aS === 0 || aF === 0) return null;
  const dist = (c[i].close - s200) / s200 / aF;
  if (![ret24, vol, aF / aS, volR, dist].every(Number.isFinite)) return null;
  return [ret24, vol, aF / aS, volR, dist];
}

// ─── Gaussian Mixture, diagonal covariance ────────────────────────────
/**
 * Diagonal covariance rather than full: with 5 features a full covariance
 * matrix needs 15 parameters per component and destabilises on this sample
 * size. Diagonal needs 5 and is the standard choice when components are
 * expected to differ mainly in location and scale.
 */
interface GMM { w: number[]; mu: number[][]; var: number[][]; k: number; d: number }

function fitGMM(X: number[][], k: number, iters = 120): GMM {
  const n = X.length, d = X[0].length;
  // k-means++-ish seeding: spread initial means across the data deterministically.
  const mu: number[][] = [];
  for (let j = 0; j < k; j++) mu.push([...X[Math.floor((j + 0.5) * n / k)]]);
  const varr: number[][] = Array.from({ length: k }, () => {
    const v: number[] = [];
    for (let f = 0; f < d; f++) {
      const col = X.map((x) => x[f]);
      const m = col.reduce((a, b) => a + b, 0) / n;
      v.push(Math.max(1e-6, col.reduce((s, x) => s + (x - m) ** 2, 0) / n));
    }
    return v;
  });
  const w = new Array(k).fill(1 / k);
  const resp: number[][] = Array.from({ length: n }, () => new Array(k).fill(0));

  const logpdf = (x: number[], j: number) => {
    let s = 0;
    for (let f = 0; f < d; f++) s += -0.5 * (Math.log(2 * Math.PI * varr[j][f]) + (x[f] - mu[j][f]) ** 2 / varr[j][f]);
    return s;
  };

  for (let it = 0; it < iters; it++) {
    // E-step, in log space for numerical stability.
    for (let i = 0; i < n; i++) {
      const lp = new Array(k);
      for (let j = 0; j < k; j++) lp[j] = Math.log(Math.max(1e-300, w[j])) + logpdf(X[i], j);
      const mx = Math.max(...lp);
      let sum = 0;
      for (let j = 0; j < k; j++) { resp[i][j] = Math.exp(lp[j] - mx); sum += resp[i][j]; }
      for (let j = 0; j < k; j++) resp[i][j] /= sum;
    }
    // M-step
    for (let j = 0; j < k; j++) {
      let nj = 0;
      for (let i = 0; i < n; i++) nj += resp[i][j];
      nj = Math.max(1e-8, nj);
      w[j] = nj / n;
      for (let f = 0; f < d; f++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += resp[i][j] * X[i][f];
        mu[j][f] = s / nj;
      }
      for (let f = 0; f < d; f++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += resp[i][j] * (X[i][f] - mu[j][f]) ** 2;
        varr[j][f] = Math.max(1e-6, s / nj);
      }
    }
  }
  return { w, mu, var: varr, k, d };
}

function logLik(X: number[][], g: GMM): number {
  let ll = 0;
  for (const x of X) {
    const lp: number[] = [];
    for (let j = 0; j < g.k; j++) {
      let s = Math.log(Math.max(1e-300, g.w[j]));
      for (let f = 0; f < g.d; f++) s += -0.5 * (Math.log(2 * Math.PI * g.var[j][f]) + (x[f] - g.mu[j][f]) ** 2 / g.var[j][f]);
      lp.push(s);
    }
    const mx = Math.max(...lp);
    ll += mx + Math.log(lp.reduce((a, b) => a + Math.exp(b - mx), 0));
  }
  return ll;
}

function assign(X: number[][], g: GMM): number[] {
  return X.map((x) => {
    let best = 0, bl = -Infinity;
    for (let j = 0; j < g.k; j++) {
      let s = Math.log(Math.max(1e-300, g.w[j]));
      for (let f = 0; f < g.d; f++) s += -0.5 * (Math.log(2 * Math.PI * g.var[j][f]) + (x[f] - g.mu[j][f]) ** 2 / g.var[j][f]);
      if (s > bl) { bl = s; best = j; }
    }
    return best;
  });
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`GMM Regime Diagnostic — is the feature space separable? · ${HORIZON}h forward horizon`);
  console.log(`features: ${FEATURE_NAMES.join(", ")}`);
  console.log("═".repeat(92));

  // Pool every asset's bars: regimes are assumed to be a market-wide property,
  // and pooling gives the mixture far more to work with than one asset would.
  const rows: number[][] = [], fwd: number[] = [], assetOf: number[] = [];
  let ai = 0;
  for (const id of PAIRS) {
    let c: CandleData[] | null = null;
    for (let a = 0; a < 3 && !c; a++) {
      try {
        const r = await okx.fetchCandlesFrom("1h", H0, 5000, id);
        c = r.map((x) => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, openTime: x.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(PACE_MS);
    if (!c || c.length < 1500) { console.log(`  skipped ${id}`); continue; }
    for (let i = WARMUP; i < c.length - HORIZON; i++) {
      const f = features(c, i);
      if (!f) continue;
      rows.push(f);
      fwd.push(Math.log(c[i + HORIZON].close / c[i].close));
      assetOf.push(ai);
    }
    ai++;
  }
  console.log(`\n${rows.length} pooled bars from ${ai} assets\n`);

  // Standardise on TRAIN statistics only — using full-sample means and standard
  // deviations would leak test-period information into the fit.
  const nTrain = Math.floor(rows.length * TRAIN_FRAC);
  const d = rows[0].length;
  const mu0: number[] = [], sd0: number[] = [];
  for (let f = 0; f < d; f++) {
    const col = rows.slice(0, nTrain).map((x) => x[f]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    mu0.push(m);
    sd0.push(Math.sqrt(col.reduce((s, x) => s + (x - m) ** 2, 0) / col.length) || 1);
  }
  const Z = rows.map((x) => x.map((v, f) => (v - mu0[f]) / sd0[f]));
  const Ztr = Z.slice(0, nTrain), Zte = Z.slice(nTrain);
  const fwdTe = fwd.slice(nTrain);
  console.log(`train ${Ztr.length} bars · test ${Zte.length} bars (out-of-sample)\n`);

  const g1 = fitGMM(Ztr, 1);
  const bic1 = -2 * logLik(Ztr, g1) + (1 * (2 * d) + 0) * Math.log(Ztr.length);

  const results: any[] = [];
  console.log("k".padEnd(4) + pad("BIC vs k=1", 13) + pad("mean run", 11) + pad("clusters", 10) +
              pad("fwd-ret spread", 16) + pad("worst-best", 22));
  console.log("─".repeat(92));

  for (const k of KS) {
    const g = fitGMM(Ztr, k);
    const bic = -2 * logLik(Ztr, g) + (k * (2 * d) + (k - 1)) * Math.log(Ztr.length);
    const lab = assign(Zte, g);

    // Persistence: mean run length of a label, within one asset's stretch.
    let runs = 0, cur = -1;
    for (let i = 0; i < lab.length; i++) {
      if (lab[i] !== cur || (i > 0 && assetOf[nTrain + i] !== assetOf[nTrain + i - 1])) { runs++; cur = lab[i]; }
    }
    const meanRun = lab.length / Math.max(1, runs);

    // Predictiveness: forward return by cluster, out-of-sample.
    const byC: number[][] = Array.from({ length: k }, () => []);
    lab.forEach((l, i) => byC[l].push(fwdTe[i]));
    const means = byC.map((a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0));
    const used = byC.filter((a) => a.length > 20).length;
    const spread = Math.max(...means) - Math.min(...means);
    const detail = byC.map((a, j) => `c${j}:${a.length ? pct(means[j]) : "—"}(${a.length})`).join(" ");

    results.push({ k, bicImprove: bic1 - bic, meanRun, used, spread, means, sizes: byC.map((a) => a.length) });
    console.log(String(k).padEnd(4) + pad((bic1 - bic).toFixed(0), 13) + pad(meanRun.toFixed(1), 11) +
                pad(`${used}/${k}`, 10) + pad(pct(spread), 16) + pad(detail.slice(0, 21), 22));
  }
  console.log("─".repeat(92));

  // ── Persistence-smoothing test ──────────────────────────────────────
  // The persistence criterion above judges the CLUSTERING method, not the
  // feature space: a GMM classifies each bar independently, and adding memory
  // is exactly what an HMM's transition matrix does. So rather than infer the
  // HMM's prospects from a memoryless model's flip rate, impose persistence
  // directly — require N consecutive agreeing bars before switching label — and
  // ask whether the forward-return separation SURVIVES. If it does, an HMM has
  // something to find. If smoothing destroys it, the separation was noise.
  console.log(`\nPersistence-smoothing test (does the signal survive being made sticky?)`);
  console.log("─".repeat(92));
  console.log("k".padEnd(4) + "confirm bars".padEnd(14) + pad("mean run", 11) + pad("fwd-ret spread", 16) + pad("bars kept", 12));
  const smoothOut: any[] = [];
  for (const k of KS) {
    const g = fitGMM(Ztr, k);
    const raw = assign(Zte, g);
    for (const need of [1, 3, 6, 12, 24]) {
      const lab: number[] = [];
      let cur = raw[0], streak = 0;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === cur) streak = 0;
        else { streak++; if (streak >= need) { cur = raw[i]; streak = 0; } }
        lab.push(cur);
      }
      let runs = 0, c2 = -1;
      for (let i = 0; i < lab.length; i++) {
        if (lab[i] !== c2 || (i > 0 && assetOf[nTrain + i] !== assetOf[nTrain + i - 1])) { runs++; c2 = lab[i]; }
      }
      const meanRun = lab.length / Math.max(1, runs);
      const byC: number[][] = Array.from({ length: k }, () => []);
      lab.forEach((l, i) => byC[l].push(fwdTe[i]));
      const means = byC.map((a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0));
      const valid = byC.map((a, j) => ({ n: a.length, m: means[j] })).filter((x) => x.n > 20);
      const spread = valid.length > 1 ? Math.max(...valid.map((v) => v.m)) - Math.min(...valid.map((v) => v.m)) : 0;
      smoothOut.push({ k, need, meanRun, spread });
      if (need === 1 || need === 6 || need === 24) {
        console.log(String(k).padEnd(4) + String(need).padEnd(14) + pad(meanRun.toFixed(1), 11) +
                    pad(pct(spread), 16) + pad(valid.reduce((a, v) => a + v.n, 0), 12));
      }
    }
  }
  const sticky = smoothOut.filter((x) => x.meanRun >= 24);
  const bestSticky = sticky.length ? sticky.reduce((a, b) => (b.spread > a.spread ? b : a)) : null;
  console.log("─".repeat(92));
  if (bestSticky) {
    console.log(`Best config with run length >=24 bars: k=${bestSticky.k}, confirm ${bestSticky.need} bars ` +
                `-> mean run ${bestSticky.meanRun.toFixed(1)}, spread ${pct(bestSticky.spread)}`);
  } else {
    console.log(`No smoothing setting reached a 24-bar mean run.`);
  }

  const best = results.reduce((a, b) => (b.spread > a.spread ? b : a));
  console.log(`\nDetail for k=${best.k}:`);
  best.means.forEach((m: number, j: number) => {
    console.log(`  cluster ${j}: ${pad(best.sizes[j], 6)} bars   mean forward ${HORIZON}h return ${pct(m)}`);
  });

  console.log(`\n${"═".repeat(92)}`);
  console.log("VERDICT");
  const structural = results.some((r) => r.bicImprove > 0);
  const persistent = smoothOut.some((r) => r.meanRun >= 24 && r.spread > 0.02);
  const predictive = best.spread > 0.02;
  console.log(`  structure    ${structural ? "YES" : "NO "}  — a mixture beats a single Gaussian on BIC`);
  console.log(`  persistence  ${persistent ? "YES" : "NO "}  — a >=24-bar-run config that KEEPS a >2% spread ${persistent ? "exists" : "does not exist"}`);
  console.log(`               (raw GMM run length is ${Math.max(...results.map((r) => r.meanRun)).toFixed(1)} bars, but a GMM is memoryless — this tests whether imposed stickiness preserves the signal, which is what an HMM would supply)`);
  console.log(`  predictive   ${predictive ? "YES" : "NO "}  — best out-of-sample forward-return spread ${pct(best.spread)} (need >2%)`);
  console.log(`\n  ${structural && persistent && predictive
    ? "PROCEED to the HMM: clusters exist, persist, and separate forward returns."
    : "STOP or reconsider: the failing test above says an HMM has nothing to find."}`);
  console.log(`${"═".repeat(92)}\n`);

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
