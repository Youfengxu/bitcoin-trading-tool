/**
 * Bayesian Online Changepoint Detection — Tier 1 step 3, and the closing test.
 *
 * Adams & MacKay (2007). Maintains a posterior over RUN LENGTH — how long since
 * the last structural break — updated one observation at a time, never looking
 * ahead. Recent work reports BOCPD substantially outperforming Generalized
 * Likelihood Ratio and Kolmogorov-Smirnov tests on equity index returns, with a
 * hazard rate near λ = 100 performing best.
 *
 * ── Why it is a different test, not a third variant ───────────────────
 * The eight threshold rules and the HMM both answer "which state is this?" using
 * a FIXED lookback. BOCPD answers "when did the current segment start?", and the
 * regime call then uses only data since that break. The lookback adapts to the
 * market rather than being chosen in advance — which is the one structural
 * degree of freedom none of the previous ten attempts had.
 *
 * The literature's standing criticism of BOCPD is detection latency: it must
 * accumulate posterior evidence before declaring a break, so changepoints lag
 * the true structural change. Under a 72h budget that criticism does not apply
 * to us, which is exactly why this method was placed in Tier 1.
 *
 * ── The regime call ───────────────────────────────────────────────────
 *   bullish  =  mean log return since the most likely changepoint > 0
 *
 * No fitted parameters beyond the hazard rate and a weak conjugate prior, so
 * there is very little here to overfit — a useful property this late in a
 * sequence of negative results.
 *
 * Scored against the same pre-registered criteria as the HMM
 * (docs/regime-classifier-proposal.md section 5).
 *
 * Usage:
 *   pnpm tsx server/scripts/bocpdRegimeClassifier.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const HAZARDS = (arg("hazard") ?? "50,100,250,500").split(",").map(Number);
const HORIZON = parseInt(arg("horizon") ?? "168");
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const MAX_RUN = parseInt(arg("maxrun") ?? "800");
const JSON_OUT = arg("json") ?? null;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,LINK-USDT,ACE-USDT,ROBO-USDT,DOGE-USDT,HYPE-USDT").split(",");

const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const WARMUP = 200;
const PACE_MS = 400;
const BASE_RATE = 0.472;
const ORACLE_PRIZE = 0.2935;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

// ─── Student-t predictive for a Normal-Inverse-Gamma prior ────────────
/** Lanczos log-gamma; accurate to ~1e-13 over the range used here. */
function lgamma(z: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function logStudentT(x: number, loc: number, scale: number, df: number): number {
  const z = (x - loc) / scale;
  return lgamma((df + 1) / 2) - lgamma(df / 2)
    - 0.5 * Math.log(df * Math.PI) - Math.log(scale)
    - ((df + 1) / 2) * Math.log(1 + (z * z) / df);
}

/**
 * Returns, for each observation, the MAP run length — the most probable number
 * of bars since the last changepoint, given everything seen up to that point.
 *
 * Conjugate NIG prior, so the predictive is Student-t and the whole recursion
 * stays closed form. Run-length vectors are truncated at MAX_RUN, which is
 * standard and keeps the update O(MAX_RUN) rather than O(t).
 */
function bocpdRunLengths(x: number[], hazardRate: number): number[] {
  const H = 1 / hazardRate;
  // Weak prior: near-zero mean, low confidence, so the data dominates quickly.
  const mu0 = 0, kappa0 = 1, alpha0 = 1, beta0 = 1e-4;

  let R = [1];                       // P(run length = 0) = 1 at t = 0
  let muT = [mu0], kaT = [kappa0], alT = [alpha0], beT = [beta0];
  const out: number[] = [];

  for (let t = 0; t < x.length; t++) {
    const n = R.length;
    const pred = new Array(n);
    for (let i = 0; i < n; i++) {
      const df = 2 * alT[i];
      const scale = Math.sqrt(Math.max(1e-300, (beT[i] * (kaT[i] + 1)) / (alT[i] * kaT[i])));
      pred[i] = Math.exp(logStudentT(x[t], muT[i], scale, df));
    }

    // Growth: the run continues. Changepoint: it resets to zero.
    const growth = new Array(n).fill(0);
    let cp = 0;
    for (let i = 0; i < n; i++) {
      growth[i] = R[i] * pred[i] * (1 - H);
      cp += R[i] * pred[i] * H;
    }
    let Rn = [cp, ...growth];
    const z = Rn.reduce((a, b) => a + b, 0) || 1;
    Rn = Rn.map((v) => v / z);

    // Conjugate updates, with the reset hypothesis prepended.
    const muN = [mu0], kaN = [kappa0], alN = [alpha0], beN = [beta0];
    for (let i = 0; i < n; i++) {
      muN.push((kaT[i] * muT[i] + x[t]) / (kaT[i] + 1));
      kaN.push(kaT[i] + 1);
      alN.push(alT[i] + 0.5);
      beN.push(beT[i] + (kaT[i] * (x[t] - muT[i]) ** 2) / (2 * (kaT[i] + 1)));
    }

    // Truncate the tail; long runs carry negligible mass and cost O(t) forever.
    if (Rn.length > MAX_RUN) {
      Rn = Rn.slice(0, MAX_RUN);
      const z2 = Rn.reduce((a, b) => a + b, 0) || 1;
      Rn = Rn.map((v) => v / z2);
      muN.length = MAX_RUN; kaN.length = MAX_RUN; alN.length = MAX_RUN; beN.length = MAX_RUN;
    }
    R = Rn; muT = muN; kaT = kaN; alT = alN; beT = beN;

    let best = 0, bv = -1;
    for (let i = 0; i < R.length; i++) if (R[i] > bv) { bv = R[i]; best = i; }
    out.push(best);
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
  console.log(`\n${"═".repeat(100)}`);
  console.log(`BOCPD Regime Classifier — adaptive lookback from detected breaks · ${HORIZON}h horizon · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(100));

  const assets: Array<{ id: string; c: CandleData[]; r: number[] }> = [];
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
    const lr: number[] = [];
    for (let i = 1; i < c.length; i++) lr.push(Math.log(c[i].close / c[i - 1].close));
    assets.push({ id, c, r: lr });
  }
  console.log(`\n${assets.length} assets\n`);

  console.log("hazard".padEnd(9) + pad("accuracy", 10) + pad("vs base", 10) + pad("%bull", 8) +
              pad("mean run", 10) + pad("BULL ret", 11) + pad("BEAR ret", 11) +
              pad("mean ret", 11) + pad("% prize", 9) + pad("trades", 8));
  console.log("─".repeat(100));

  const results: any[] = [];
  for (const hz of HAZARDS) {
    let hits = 0, n = 0, bull = 0, runSum = 0, runN = 0;
    const rets: Record<string, number[]> = { bull: [], bear: [] };
    const trs: number[] = [];

    for (const a of assets) {
      const runs = bocpdRunLengths(a.r, hz);
      const flags = new Array(a.c.length).fill(false);
      for (let i = WARMUP; i < a.c.length; i++) {
        const rl = runs[i - 1] ?? 0;             // run length as of this bar
        const start = Math.max(0, i - Math.max(1, rl));
        // Regime call: has the market risen since the detected break?
        flags[i] = a.c[i].close > a.c[start].close;
        runSum += rl; runN++;
      }
      for (let i = WARMUP; i < a.c.length - HORIZON; i++) {
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
      hazard: hz, acc, edge: acc - BASE_RATE, pctBull: bull / Math.max(1, n),
      meanRun: runSum / Math.max(1, runN), bull: mean(rets.bull), bear: mean(rets.bear),
      meanRet, prize: meanRet / ORACLE_PRIZE, trades: mean(trs),
    };
    results.push(row);
    console.log(String(hz).padEnd(9) + pad(`${(acc * 100).toFixed(1)}%`, 10) +
      pad(`${row.edge >= 0 ? "+" : ""}${(row.edge * 100).toFixed(1)}pp`, 10) +
      pad(`${(row.pctBull * 100).toFixed(0)}%`, 8) + pad(row.meanRun.toFixed(0), 10) +
      pad(pct(row.bull), 11) + pad(pct(row.bear), 11) + pad(pct(meanRet), 11) +
      pad(`${(row.prize * 100).toFixed(0)}%`, 9) + pad(row.trades.toFixed(0), 8));
  }
  console.log("─".repeat(100));

  const best = results.reduce((a, b) => (b.meanRet > a.meanRet ? b : a));
  const accs = results.map((r) => r.acc), rr = results.map((r) => r.meanRet);
  const ma = accs.reduce((a, b) => a + b, 0) / accs.length, mr = rr.reduce((a, b) => a + b, 0) / rr.length;
  const num = accs.reduce((s, a, i) => s + (a - ma) * (rr[i] - mr), 0);
  const den = Math.sqrt(accs.reduce((s, a) => s + (a - ma) ** 2, 0) * rr.reduce((s, x) => s + (x - mr) ** 2, 0));
  const corr = den > 0 ? num / den : 0;

  console.log(`\n${"═".repeat(100)}`);
  console.log("SCORED AGAINST THE PRE-REGISTERED CRITERIA");
  console.log(`  accuracy >= +8pp over base    ${best.edge >= 0.08 ? "PASS" : "FAIL"}  (best ${best.edge >= 0 ? "+" : ""}${(best.edge * 100).toFixed(1)}pp)`);
  console.log(`  >= 30% of oracle prize        ${best.prize >= 0.30 ? "PASS" : "FAIL"}  (best ${(best.prize * 100).toFixed(0)}%)`);
  console.log(`  accuracy tracks return        ${corr > 0.7 ? "PASS" : "FAIL"}  (r = ${corr.toFixed(2)} across ${results.length} configs)`);
  console.log(`  positive in BOTH windows      ${best.bull > 0 && best.bear > 0 ? "PASS" : "FAIL"}  (bull ${pct(best.bull)}, bear ${pct(best.bear)})`);
  console.log(`${"═".repeat(100)}\n`);

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
