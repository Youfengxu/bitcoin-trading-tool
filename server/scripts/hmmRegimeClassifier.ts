/**
 * Hidden Markov Model regime classifier — Tier 1 step 2.
 *
 * The GMM diagnostic established that the feature space separates: out-of-sample
 * forward-168h return spread of +9.08% raw, strengthening to +15.39% once
 * persistence is imposed. Signal that STRENGTHENS under smoothing is a
 * persistent state observed through per-bar noise — which is the thing an HMM
 * models directly, via a transition matrix that makes staying put more likely
 * than switching.
 *
 * ── What this adds over the GMM ───────────────────────────────────────
 * A GMM asks "which cluster does this bar resemble?". An HMM asks "which state
 * is the market IN, given everything seen so far and the fact that states
 * persist?". The transition matrix is learned, not imposed, so the stickiness
 * that had to be hand-tuned in the diagnostic (confirm-N-bars) comes out of the
 * data instead.
 *
 * ── Filtering, not smoothing ──────────────────────────────────────────
 * State probabilities are computed by FORWARD FILTERING only: the estimate at
 * bar i uses bars 0..i and never looks ahead. The Baum-Welch smoothed estimate
 * (which uses the whole sequence) would be far more accurate and completely
 * unusable in production — it is the classic way an HMM backtest fools its
 * author. Everything reported here is what would have been knowable at the time.
 *
 * ── Scoring ───────────────────────────────────────────────────────────
 * Against the criteria pre-registered in docs/regime-classifier-proposal.md:
 *   accuracy      >= +8pp over the 47.2% base rate
 *   prize         >= 30% of the +29.35% oracle switching return
 *   correlation   accuracy must track return across configurations
 *   both windows  positive in bull AND bear
 *
 * Usage:
 *   pnpm tsx server/scripts/hmmRegimeClassifier.ts
 *   pnpm tsx server/scripts/hmmRegimeClassifier.ts --states=3
 */

import { computeAllMetrics, sma, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const STATES = (arg("states") ?? "2,3,4").split(",").map(Number);
const HORIZON = parseInt(arg("horizon") ?? "168");
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const TRAIN_FRAC = parseFloat(arg("train") ?? "0.7");
const JSON_OUT = arg("json") ?? null;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,LINK-USDT,ACE-USDT,ROBO-USDT,DOGE-USDT,HYPE-USDT").split(",");

const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const WARMUP = 200;
const PACE_MS = 400;
const BASE_RATE = 0.472;   // measured in regimeClassifierScore
const ORACLE_PRIZE = 0.2935;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

function atrPct(c: CandleData[], i: number, period: number): number {
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const cur = c[k], prev = c[k - 1];
    s += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return s / period / c[i].close;
}

/** Same five state features the GMM diagnostic validated. */
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
  const f = [ret24, vol, aF / aS, volR, dist];
  return f.every(Number.isFinite) ? f : null;
}

// ─── Gaussian HMM, diagonal covariance ────────────────────────────────
interface HMM { pi: number[]; A: number[][]; mu: number[][]; var: number[][]; k: number; d: number }

function logGauss(x: number[], mu: number[], v: number[]): number {
  let s = 0;
  for (let f = 0; f < x.length; f++) s += -0.5 * (Math.log(2 * Math.PI * v[f]) + (x[f] - mu[f]) ** 2 / v[f]);
  return s;
}
const logSumExp = (a: number[]) => {
  const m = Math.max(...a);
  return m + Math.log(a.reduce((s, x) => s + Math.exp(x - m), 0));
};

/**
 * Baum-Welch on a set of independent sequences (one per asset). Training uses
 * the smoothed posterior, which is correct — the constraint is that INFERENCE
 * later must be forward-only.
 */
function fitHMM(seqs: number[][][], k: number, iters = 40): HMM {
  const d = seqs[0][0].length;
  const all = seqs.flat();
  const mu: number[][] = [], varr: number[][] = [];
  for (let j = 0; j < k; j++) mu.push([...all[Math.floor((j + 0.5) * all.length / k)]]);
  for (let j = 0; j < k; j++) {
    const v: number[] = [];
    for (let f = 0; f < d; f++) {
      const col = all.map((x) => x[f]);
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      v.push(Math.max(1e-4, col.reduce((s, x) => s + (x - m) ** 2, 0) / col.length));
    }
    varr.push(v);
  }
  let pi = new Array(k).fill(1 / k);
  // Initialise strongly self-transitioning: regimes are persistent by assumption,
  // and a uniform start collapses to a memoryless mixture.
  let A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 0.95 : 0.05 / (k - 1))));

  for (let it = 0; it < iters; it++) {
    const accPi = new Array(k).fill(0);
    const accA = Array.from({ length: k }, () => new Array(k).fill(0));
    const accN = new Array(k).fill(0);
    const accX = Array.from({ length: k }, () => new Array(d).fill(0));
    const accX2 = Array.from({ length: k }, () => new Array(d).fill(0));

    for (const X of seqs) {
      const T = X.length;
      const B = X.map((x) => Array.from({ length: k }, (_, j) => logGauss(x, mu[j], varr[j])));
      // forward
      const al = Array.from({ length: T }, () => new Array(k).fill(-Infinity));
      for (let j = 0; j < k; j++) al[0][j] = Math.log(pi[j]) + B[0][j];
      for (let t = 1; t < T; t++)
        for (let j = 0; j < k; j++)
          al[t][j] = logSumExp(Array.from({ length: k }, (_, i2) => al[t - 1][i2] + Math.log(A[i2][j]))) + B[t][j];
      // backward
      const be = Array.from({ length: T }, () => new Array(k).fill(-Infinity));
      for (let j = 0; j < k; j++) be[T - 1][j] = 0;
      for (let t = T - 2; t >= 0; t--)
        for (let i2 = 0; i2 < k; i2++)
          be[t][i2] = logSumExp(Array.from({ length: k }, (_, j) => Math.log(A[i2][j]) + B[t + 1][j] + be[t + 1][j]));

      const ll = logSumExp(al[T - 1]);
      for (let t = 0; t < T; t++) {
        for (let j = 0; j < k; j++) {
          const g = Math.exp(al[t][j] + be[t][j] - ll);
          accN[j] += g;
          if (t === 0) accPi[j] += g;
          for (let f = 0; f < d; f++) { accX[j][f] += g * X[t][f]; accX2[j][f] += g * X[t][f] ** 2; }
        }
        if (t < T - 1)
          for (let i2 = 0; i2 < k; i2++)
            for (let j = 0; j < k; j++)
              accA[i2][j] += Math.exp(al[t][i2] + Math.log(A[i2][j]) + B[t + 1][j] + be[t + 1][j] - ll);
      }
    }
    const piSum = accPi.reduce((a, b) => a + b, 0) || 1;
    pi = accPi.map((x) => Math.max(1e-8, x / piSum));
    A = accA.map((row) => { const s = row.reduce((a, b) => a + b, 0) || 1; return row.map((x) => Math.max(1e-8, x / s)); });
    for (let j = 0; j < k; j++) {
      const n = Math.max(1e-8, accN[j]);
      for (let f = 0; f < d; f++) {
        mu[j][f] = accX[j][f] / n;
        varr[j][f] = Math.max(1e-4, accX2[j][f] / n - mu[j][f] ** 2);
      }
    }
  }
  return { pi, A, mu, var: varr, k, d };
}

/**
 * FORWARD-ONLY state probabilities. p[t] uses observations 0..t and nothing
 * later — the only inference mode that could run live.
 */
function filter(X: number[][], h: HMM): number[][] {
  const T = X.length, out: number[][] = [];
  let al = Array.from({ length: h.k }, (_, j) => Math.log(h.pi[j]) + logGauss(X[0], h.mu[j], h.var[j]));
  const norm = (a: number[]) => { const z = logSumExp(a); return a.map((x) => Math.exp(x - z)); };
  out.push(norm(al));
  for (let t = 1; t < T; t++) {
    const nx = new Array(h.k).fill(-Infinity);
    for (let j = 0; j < h.k; j++)
      nx[j] = logSumExp(Array.from({ length: h.k }, (_, i2) => al[i2] + Math.log(h.A[i2][j]))) + logGauss(X[t], h.mu[j], h.var[j]);
    al = nx;
    out.push(norm(al));
  }
  return out;
}

function runSwitch(c: CandleData[], from: number, to: number, bullish: boolean[]) {
  const scope = getCandleLimit("1h");
  let cash = SEED, u = 0, trades = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close, v = cash + u * px;
    if (v <= 0) break;
    if (bullish[i]) {
      if ((u * px) / v < 0.95) { const tu = v / px, dd = tu - u; cash -= dd * px + Math.abs(dd) * px * FEE; u = tu; trades++; }
    } else {
      const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
      const s = generateSignal(m, P);
      if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
      if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
        const f = convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence);
        if (s.signal === "buy" && cash > 0) {
          const usd = cash * f;
          if (usd >= MIN_TRADE_NOTIONAL_USD) { const fe = usd * FEE; u += (usd - fe) / px; cash -= usd; trades++; }
        } else if (s.signal === "sell" && u > 0) {
          const sz = u * f, g = sz * px;
          if (g >= MIN_TRADE_NOTIONAL_USD) { const fe = g * FEE; u -= sz; cash += g - fe; trades++; }
        }
      }
    }
    eq.push(cash + u * px);
  }
  const fin = eq[eq.length - 1];
  return { ret: fin / SEED - 1, trades };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(98)}`);
  console.log(`HMM Regime Classifier — forward filtering only · ${HORIZON}h horizon · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(98));

  const assets: Array<{ id: string; c: CandleData[]; X: number[][]; idx: number[] }> = [];
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
    const X: number[][] = [], idx: number[] = [];
    for (let i = WARMUP; i < c.length; i++) { const f = features(c, i); if (f) { X.push(f); idx.push(i); } }
    assets.push({ id, c, X, idx });
  }
  console.log(`\n${assets.length} assets\n`);

  // Standardise on the training portion of each sequence only.
  const cut = Math.floor(assets[0].X.length * TRAIN_FRAC);
  const d = assets[0].X[0].length;
  const mu0: number[] = [], sd0: number[] = [];
  const trainPool = assets.flatMap((a) => a.X.slice(0, Math.floor(a.X.length * TRAIN_FRAC)));
  for (let f = 0; f < d; f++) {
    const col = trainPool.map((x) => x[f]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    mu0.push(m); sd0.push(Math.sqrt(col.reduce((s, x) => s + (x - m) ** 2, 0) / col.length) || 1);
  }
  const std = (X: number[][]) => X.map((x) => x.map((v, f) => (v - mu0[f]) / sd0[f]));

  console.log("states".padEnd(8) + pad("accuracy", 10) + pad("vs base", 10) + pad("%bull", 8) +
              pad("BULL ret", 11) + pad("BEAR ret", 11) + pad("mean ret", 11) +
              pad("% of prize", 12) + pad("trades", 8));
  console.log("─".repeat(98));

  const results: any[] = [];
  for (const k of STATES) {
    const trainSeqs = assets.map((a) => std(a.X.slice(0, Math.floor(a.X.length * TRAIN_FRAC))));
    const h = fitHMM(trainSeqs, k);

    // Which states are "bullish"? Decided on TRAIN data only: a state is bullish
    // if bars filtered into it were followed by a rise more often than the base
    // rate. Using test data here would be the whole experiment leaking.
    const stateUp = new Array(k).fill(0), stateN = new Array(k).fill(0);
    for (const a of assets) {
      const nTr = Math.floor(a.X.length * TRAIN_FRAC);
      const pr = filter(std(a.X.slice(0, nTr)), h);
      for (let t = 0; t < pr.length; t++) {
        const i = a.idx[t];
        if (i + HORIZON >= a.c.length) continue;
        const up = a.c[i + HORIZON].close > a.c[i].close ? 1 : 0;
        const s = pr[t].indexOf(Math.max(...pr[t]));
        stateN[s]++; stateUp[s] += up;
      }
    }
    const bullState = stateUp.map((u, j) => (stateN[j] > 50 ? u / stateN[j] : 0) > BASE_RATE);

    let hits = 0, n = 0, bull = 0;
    const rets: Record<string, number[]> = { bull: [], bear: [] };
    const trs: number[] = [];
    for (const a of assets) {
      const pr = filter(std(a.X), h);          // forward-only over the whole series
      const flags = new Array(a.c.length).fill(false);
      for (let t = 0; t < pr.length; t++) flags[a.idx[t]] = bullState[pr[t].indexOf(Math.max(...pr[t]))];

      const nTr = Math.floor(a.X.length * TRAIN_FRAC);
      for (let t = nTr; t < pr.length; t++) {           // accuracy scored out-of-sample only
        const i = a.idx[t];
        if (i + HORIZON >= a.c.length) continue;
        const up = a.c[i + HORIZON].close > a.c[i].close;
        n++; if (flags[i] === up) hits++; if (flags[i]) bull++;
      }
      for (const [lab, ws, we] of [["bull", H0, SPLIT], ["bear", SPLIT, END]] as Array<[string, number, number]>) {
        const from = Math.max(a.c.findIndex((x) => x.openTime >= ws), getCandleLimit("1h"));
        let to = a.c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = a.c.length - 1;
        if (to - from < 200) continue;
        const r = runSwitch(a.c, from, to, flags);
        rets[lab].push(r.ret); trs.push(r.trades);
      }
    }
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
    const acc = hits / Math.max(1, n);
    const meanRet = (mean(rets.bull) + mean(rets.bear)) / 2;
    const row = {
      k, acc, edge: acc - BASE_RATE, pctBull: bull / Math.max(1, n),
      bull: mean(rets.bull), bear: mean(rets.bear), meanRet,
      prize: meanRet / ORACLE_PRIZE, trades: mean(trs),
      selfTrans: h.A.map((r, i2) => r[i2]),
    };
    results.push(row);
    console.log(String(k).padEnd(8) + pad(`${(acc * 100).toFixed(1)}%`, 10) +
      pad(`${row.edge >= 0 ? "+" : ""}${(row.edge * 100).toFixed(1)}pp`, 10) +
      pad(`${(row.pctBull * 100).toFixed(0)}%`, 8) +
      pad(pct(row.bull), 11) + pad(pct(row.bear), 11) + pad(pct(meanRet), 11) +
      pad(`${(row.prize * 100).toFixed(0)}%`, 12) + pad(row.trades.toFixed(0), 8));
  }
  console.log("─".repeat(98));
  for (const r of results) {
    console.log(`  k=${r.k} self-transition probabilities: ${r.selfTrans.map((x: number) => x.toFixed(3)).join(", ")}` +
                `  (implied mean run ${(1 / (1 - Math.max(...r.selfTrans))).toFixed(0)} bars)`);
  }

  const best = results.reduce((a, b) => (b.meanRet > a.meanRet ? b : a));
  const accs = results.map((r) => r.acc), rr = results.map((r) => r.meanRet);
  const ma = accs.reduce((a, b) => a + b, 0) / accs.length, mr = rr.reduce((a, b) => a + b, 0) / rr.length;
  const num = accs.reduce((s, a, i) => s + (a - ma) * (rr[i] - mr), 0);
  const den = Math.sqrt(accs.reduce((s, a) => s + (a - ma) ** 2, 0) * rr.reduce((s, x) => s + (x - mr) ** 2, 0));
  const corr = den > 0 ? num / den : 0;

  console.log(`\n${"═".repeat(98)}`);
  console.log("SCORED AGAINST THE PRE-REGISTERED CRITERIA");
  console.log(`  accuracy >= +8pp over base    ${best.edge >= 0.08 ? "PASS" : "FAIL"}  (best ${best.edge >= 0 ? "+" : ""}${(best.edge * 100).toFixed(1)}pp)`);
  console.log(`  >= 30% of oracle prize        ${best.prize >= 0.30 ? "PASS" : "FAIL"}  (best ${(best.prize * 100).toFixed(0)}%)`);
  console.log(`  accuracy tracks return        ${corr > 0.7 ? "PASS" : "FAIL"}  (r = ${corr.toFixed(2)} across ${results.length} configs)`);
  console.log(`  positive in BOTH windows      ${best.bull > 0 && best.bear > 0 ? "PASS" : "FAIL"}  (bull ${pct(best.bull)}, bear ${pct(best.bear)})`);
  console.log(`${"═".repeat(98)}\n`);

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
