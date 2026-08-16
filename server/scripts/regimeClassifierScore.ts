/**
 * Regime Classifiers — built and scored against a known payoff curve.
 *
 * ── The target, from regimeSwitchBound ────────────────────────────────
 * Switching between "hold" and "the engine" is worth +24.7% mean return with a
 * perfect regime call, against ~0% for every blended weight. The edge survives
 * 24h of staleness undiminished and 72h at +15.8%, so a classifier does not need
 * to be fast. It needs to be RIGHT about the direction of the coming week.
 *
 * The deployed ADX/DI/SMA200 rule returns −1.98%. That is not a speed failure;
 * this script measures whether it is an accuracy failure and whether anything
 * available does better.
 *
 * ── What is scored ────────────────────────────────────────────────────
 * Each classifier is a pure function of PAST bars — no lookahead anywhere. Two
 * numbers are reported for each, because they answer different questions:
 *
 *   accuracy   agreement with the oracle label (did price rise over the next
 *              168 bars), measured against the BASE RATE. A classifier that
 *              always says "bull" scores the base rate for free, so only the
 *              margin over it is skill.
 *
 *   return     the same classifier driving the actual switch, fees included.
 *              This is the number that matters; accuracy is diagnostic.
 *
 * The pairing is the point: it shows how much accuracy is needed before the
 * switch pays, which no single classifier's result would reveal.
 *
 * Usage:
 *   pnpm tsx server/scripts/regimeClassifierScore.ts
 */

import { computeAllMetrics, sma, ema, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const HORIZON = parseInt(arg("horizon") ?? "168");
const JSON_OUT = arg("json") ?? null;
/**
 * Pin the asset list. Selection by live 24h volume shifts between runs, so two
 * scripts run minutes apart can score different samples — which silently made
 * an oracle bound and a classifier table non-comparable.
 */
const PAIRS_ARG = arg("pairs");

const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const MIN_BARS = 1500, ANCHOR = "BTC-USDT", PEG = 0.05, PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

/** Average true range over `period` bars ending at i, as a fraction of price. */
function atrPct(c: CandleData[], i: number, period: number): number | null {
  if (i < period) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const cur = c[k], prev = c[k - 1];
    s += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return s / period / c[i].close;
}

/**
 * Candidate classifiers. Each returns true for "expect the coming week to be up".
 * All read only bars up to and including i.
 */
const CLASSIFIERS: Record<string, (c: CandleData[], i: number) => boolean> = {
  // The rule in production today.
  "adx+di+sma200": (c, i) => {
    const scope = getCandleLimit("1h");
    if (i < scope) return false;
    const m = computeAllMetrics(c.slice(i - scope + 1, i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    return m.adx !== null && m.adxPlus !== null && m.adxMinus !== null && m.sma200 !== null
      && m.adx > 25 && m.adxPlus > m.adxMinus && m.price > m.sma200;
  },
  // Price above its own long average — the simplest possible statement of trend.
  "price>sma200": (c, i) => {
    const s = sma(c.slice(Math.max(0, i - 250), i + 1).map((x) => x.close), 200);
    return s !== null && c[i].close > s;
  },
  // Golden cross. Slower to turn than price>SMA200, so it flaps less.
  "sma50>sma200": (c, i) => {
    const cl = c.slice(Math.max(0, i - 250), i + 1).map((x) => x.close);
    const f = sma(cl, 50), s = sma(cl, 200);
    return f !== null && s !== null && f > s;
  },
  // Momentum over exactly the horizon being predicted.
  "mom 168h": (c, i) => i >= 168 && c[i].close > c[i - 168].close,
  // Momentum over twice the horizon — slower, less noisy.
  "mom 336h": (c, i) => i >= 336 && c[i].close > c[i - 336].close,
  // Trend measured in units of volatility, so a quiet drift and a violent one
  // are not treated the same.
  "trend/ATR>0.5": (c, i) => {
    const s = sma(c.slice(Math.max(0, i - 250), i + 1).map((x) => x.close), 200);
    const a = atrPct(c, i, 14);
    if (s === null || a === null || a === 0) return false;
    return (c[i].close - s) / s / a > 0.5;
  },
  // Fast EMA cross — included as the noisy end of the spectrum.
  "ema12>ema26": (c, i) => {
    const cl = c.slice(Math.max(0, i - 60), i + 1).map((x) => x.close);
    const f = ema(cl, 12), s = ema(cl, 26);
    return f !== null && s !== null && f > s;
  },
  // Majority vote of three uncorrelated-ish slow rules.
  "vote(3 slow)": (c, i) => {
    const cl = c.slice(Math.max(0, i - 350), i + 1).map((x) => x.close);
    const s200 = sma(cl, 200), s50 = sma(cl, 50);
    const v1 = s200 !== null && c[i].close > s200;
    const v2 = s50 !== null && s200 !== null && s50 > s200;
    const v3 = i >= 336 && c[i].close > c[i - 336].close;
    return [v1, v2, v3].filter(Boolean).length >= 2;
  },
};

function oracle(c: CandleData[]): boolean[] {
  return c.map((_, i) => c[Math.min(c.length - 1, i + HORIZON)].close > c[i].close);
}

function runSwitch(c: CandleData[], from: number, to: number, bullish: boolean[]) {
  const scope = getCandleLimit("1h");
  let cash = SEED, u = 0, trades = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const v = cash + u * px;
    if (v <= 0) break;
    if (bullish[i]) {
      if ((u * px) / v < 0.95) { const tu = v / px, d = tu - u; cash -= d * px + Math.abs(d) * px * FEE; u = tu; trades++; }
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
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd, trades };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`Regime Classifiers — accuracy vs economic payoff · ${HORIZON}h horizon · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(100));

  const t = await okx.publicGet<{ instId: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SPOT");
  const rank = t.filter((x) => x.instId.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0")).map((x) => x.instId);
  const cands = PAIRS_ARG
    ? PAIRS_ARG.split(",").map((x) => x.trim())
    : [ANCHOR, ...rank.filter((p) => p !== ANCHOR)].slice(0, TOP_N * 3);
  const sel: Array<{ id: string; c: CandleData[] }> = [];
  for (const id of cands) {
    if (sel.length >= TOP_N) break;
    let c: CandleData[] | null = null;
    for (let a = 0; a < 3 && !c; a++) {
      try {
        const r = await okx.fetchCandlesFrom("1h", H0, 5000, id);
        c = r.map((x) => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, openTime: x.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(PACE_MS);
    if (!c || c.length < MIN_BARS) continue;
    const hi = Math.max(...c.map((x) => x.high)), lo = Math.min(...c.map((x) => x.low));
    if ((hi - lo) / ((hi + lo) / 2) < PEG) continue;
    sel.push({ id, c });
  }
  console.log(`\n${sel.length} pairs: ${sel.map((s) => s.id).join(", ")}\n`);

  // Base rate: how often the next week is up at all. A constant "bull" call
  // scores this for free, so it is the line every classifier must clear.
  let baseHits = 0, baseN = 0;
  for (const { c } of sel) {
    const o = oracle(c);
    for (let i = getCandleLimit("1h"); i < c.length - HORIZON; i++) { baseN++; if (o[i]) baseHits++; }
  }
  const baseRate = baseHits / baseN;
  console.log(`Base rate (fraction of bars followed by a higher price ${HORIZON}h later): ${(baseRate * 100).toFixed(1)}%`);
  console.log(`Always-bull therefore scores ${(baseRate * 100).toFixed(1)}% accuracy with no skill at all.\n`);

  console.log("classifier".padEnd(18) + pad("accuracy", 10) + pad("vs base", 10) + pad("%bull", 8) +
              pad("BULL ret", 11) + pad("BEAR ret", 11) + pad("mean ret", 11) + pad("trades", 8));
  console.log("─".repeat(100));

  const out: any[] = [];
  for (const [name, fn] of Object.entries(CLASSIFIERS)) {
    let hits = 0, n = 0, bull = 0;
    const rets: Record<string, number[]> = { bull: [], bear: [] };
    const trs: number[] = [];
    for (const { c } of sel) {
      const o = oracle(c);
      const flags: boolean[] = new Array(c.length).fill(false);
      for (let i = getCandleLimit("1h"); i < c.length; i++) flags[i] = fn(c, i);
      for (let i = getCandleLimit("1h"); i < c.length - HORIZON; i++) {
        n++; if (flags[i] === o[i]) hits++; if (flags[i]) bull++;
      }
      for (const [lab, ws, we] of [["bull", H0, SPLIT], ["bear", SPLIT, END]] as Array<[string, number, number]>) {
        const from = Math.max(c.findIndex((x) => x.openTime >= ws), getCandleLimit("1h"));
        let to = c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = c.length - 1;
        if (to - from < 200) continue;
        const r = runSwitch(c, from, to, flags);
        rets[lab].push(r.ret); trs.push(r.trades);
      }
    }
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
    const acc = hits / n;
    const row = { name, acc, edge: acc - baseRate, pctBull: bull / n, bull: mean(rets.bull), bear: mean(rets.bear), trades: mean(trs) };
    out.push(row);
    console.log(name.padEnd(18) + pad(`${(acc * 100).toFixed(1)}%`, 10) +
      pad(`${row.edge >= 0 ? "+" : ""}${(row.edge * 100).toFixed(1)}pp`, 10) +
      pad(`${(row.pctBull * 100).toFixed(0)}%`, 8) +
      pad(pct(row.bull), 11) + pad(pct(row.bear), 11) +
      pad(pct((row.bull + row.bear) / 2), 11) + pad(row.trades.toFixed(0), 8));
  }
  console.log("─".repeat(100));
  const best = out.reduce((a, b) => ((b.bull + b.bear) > (a.bull + a.bear) ? b : a));
  console.log(`\nBest by economic return: ${best.name}  (mean ${pct((best.bull + best.bear) / 2)}, accuracy ${(best.acc * 100).toFixed(1)}%, ${best.edge >= 0 ? "+" : ""}${(best.edge * 100).toFixed(1)}pp over base)`);
  console.log(`Reference: perfect oracle +24.74%, engine-only ~0%, ADX rule -1.98%.`);
  console.log(`${"═".repeat(100)}\n`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ baseRate, classifiers: out }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
