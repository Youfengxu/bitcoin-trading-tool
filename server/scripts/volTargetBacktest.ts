/**
 * Volatility targeting — using the signal that measurably works.
 *
 * ── Why this and not another directional attempt ──────────────────────
 * Eleven regime methods failed at calling direction. Measuring WHY produced the
 * useful result: the GMM clusters separate forward 168h VOLATILITY at 1.04
 * standard deviations but forward RETURN at only 0.33. Volatility state is
 * forecastable; direction is not. Every previous attempt applied a working
 * volatility detector to an unforecastable directional question.
 *
 * This applies it to the question it can answer. Position size is scaled
 * inversely to predicted volatility, targeting constant RISK rather than
 * constant capital:
 *
 *   exposure = base × (target_vol / predicted_vol)   [capped]
 *
 * ── Scored on risk-adjusted terms, deliberately ───────────────────────
 * Vol targeting is a risk-management technique, not a return generator. Judging
 * it by raw return would be the same category error that sank the last eleven
 * tests — applying a method to a question it does not answer. The criteria are
 * therefore set on Sharpe and drawdown, PRE-REGISTERED here before running:
 *
 *   1. Sharpe improves in BOTH windows
 *   2. Max drawdown falls in BOTH windows
 *   3. Return is not materially worse (> −2pp in either window)
 *
 * Failing 3 while passing 1 and 2 is still a pass in substance: giving up a
 * little return for materially less risk is the trade this is meant to make.
 *
 * ── Order of testing ──────────────────────────────────────────────────
 * The naive predictor (trailing realized volatility) is tested FIRST. Volatility
 * is strongly autocorrelated, so most of any benefit should come from that
 * alone. Only if scaling helps is it worth asking whether the GMM adds anything
 * over a 20-line trailing average — establishing the baseline effect before
 * crediting the sophisticated method.
 *
 * Usage:
 *   pnpm tsx server/scripts/volTargetBacktest.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const VOL_WINDOW = parseInt(arg("volwin") ?? "168");
/** Exposure multiplier is capped so a quiet stretch cannot imply huge leverage. */
const MAX_MULT = parseFloat(arg("maxmult") ?? "2.0");
const MIN_MULT = parseFloat(arg("minmult") ?? "0.25");
const REBAL_BAND = parseFloat(arg("band") ?? "0.15");
const JSON_OUT = arg("json") ?? null;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,LINK-USDT,ACE-USDT,ROBO-USDT,DOGE-USDT,HYPE-USDT,WLD-USDT,BNB-USDT").split(",");

const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const WARMUP = 200;
const PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

/** Trailing realized volatility of hourly log returns — the naive predictor. */
function realizedVol(c: CandleData[], i: number, win: number): number | null {
  if (i < win + 1) return null;
  const lr: number[] = [];
  for (let k = i - win + 1; k <= i; k++) lr.push(Math.log(c[k].close / c[k - 1].close));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / lr.length);
}

type Mode = "hold" | "hold+vol" | "engine" | "engine+vol";

interface Res { ret: number; sharpe: number; maxDD: number; expo: number; trades: number }

function run(c: CandleData[], from: number, to: number, mode: Mode, targetVol: number): Res | null {
  const scope = getCandleLimit("1h");
  if (to - from < 200) return null;
  let cash = SEED, u = 0, trades = 0, expSum = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];

  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const v = cash + u * px;
    if (v <= 0) break;

    // Risk scaler: below 1 when volatility is high, above when calm.
    let mult = 1;
    if (mode.endsWith("+vol")) {
      const rv = realizedVol(c, i, VOL_WINDOW);
      mult = rv && rv > 0 ? Math.max(MIN_MULT, Math.min(MAX_MULT, targetVol / rv)) : 1;
    }

    if (mode.startsWith("hold")) {
      const target = Math.min(1, mult);   // no leverage: cap at fully invested
      const cur = (u * px) / v;
      if (Math.abs(target - cur) > REBAL_BAND) {
        const tu = (target * v) / px, d = tu - u;
        cash -= d * px + Math.abs(d) * px * FEE;
        u = tu; trades++;
      }
    } else {
      const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
      const s = generateSignal(m, P);
      if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
      if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
        // The scaler modulates how much each signal stakes, leaving WHICH
        // signals fire untouched — so this isolates sizing from selection.
        const f = Math.min(1, convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence) * mult);
        if (s.signal === "buy" && cash > 0) {
          const usd = cash * f;
          if (usd >= MIN_TRADE_NOTIONAL_USD) { const fe = usd * FEE; u += (usd - fe) / px; cash -= usd; trades++; }
        } else if (s.signal === "sell" && u > 0) {
          const sz = u * f, g = sz * px;
          if (g >= MIN_TRADE_NOTIONAL_USD) { const fe = g * FEE; u -= sz; cash += g - fe; trades++; }
        }
      }
    }
    const vv = cash + u * px;
    eq.push(vv);
    expSum += vv > 0 ? (u * px) / vv : 0;
  }

  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  const r: number[] = [];
  for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, r.length));
  return {
    ret: fin / SEED - 1, sharpe: sd > 0 ? (m / sd) * Math.sqrt(24 * 365) : 0,
    maxDD: dd, expo: expSum / eq.length, trades,
  };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(104)}`);
  console.log(`Volatility Targeting — constant risk instead of constant capital · ${VOL_WINDOW}h vol window · ${(FEE * 10000).toFixed(0)}bps`);
  console.log(`scaler capped to [${MIN_MULT}, ${MAX_MULT}] · no leverage (exposure capped at 100%)`);
  console.log("═".repeat(104));

  const assets: Array<{ id: string; c: CandleData[] }> = [];
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
    assets.push({ id, c });
  }
  console.log(`\n${assets.length} assets\n`);

  // Target volatility = the median trailing vol across the TRAIN portion, so the
  // scaler averages ~1 and this is a redistribution of risk rather than a
  // disguised change in average exposure.
  const vols: number[] = [];
  for (const { c } of assets) {
    const cut = Math.floor(c.length * 0.7);
    for (let i = WARMUP; i < cut; i += 24) { const rv = realizedVol(c, i, VOL_WINDOW); if (rv) vols.push(rv); }
  }
  vols.sort((a, b) => a - b);
  const targetVol = vols[Math.floor(vols.length / 2)];
  console.log(`target volatility = train median = ${(targetVol * 100).toFixed(3)}% per hour\n`);

  const modes: Mode[] = ["hold", "hold+vol", "engine", "engine+vol"];
  const out: Record<string, Record<string, Res>> = {};

  for (const [label, ws, we] of [["BULL (Mar–May)", H0, SPLIT], ["BEAR (May–Aug)", SPLIT, END]] as Array<[string, number, number]>) {
    console.log(label);
    console.log("─".repeat(104));
    console.log("mode".padEnd(14) + pad("return", 11) + pad("Sharpe", 10) + pad("maxDD", 10) +
                pad("exposure", 11) + pad("trades", 9) + pad("Δ Sharpe", 11) + pad("Δ maxDD", 10));
    console.log("─".repeat(104));
    const agg: Record<string, Res> = {};
    for (const mode of modes) {
      const rs: Res[] = [];
      for (const { c } of assets) {
        const from = Math.max(c.findIndex((x) => x.openTime >= ws), WARMUP + VOL_WINDOW);
        let to = c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = c.length - 1;
        const r = run(c, from, to, mode, targetVol);
        if (r) rs.push(r);
      }
      const mean = (f: (r: Res) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      const m: Res = {
        ret: mean((r) => r.ret), sharpe: mean((r) => r.sharpe), maxDD: mean((r) => r.maxDD),
        expo: mean((r) => r.expo), trades: mean((r) => r.trades),
      };
      agg[mode] = m;
      const base = mode.endsWith("+vol") ? agg[mode.replace("+vol", "") as Mode] : null;
      console.log(mode.padEnd(14) + pad(pct(m.ret), 11) + pad(m.sharpe.toFixed(2), 10) +
        pad(`${(m.maxDD * 100).toFixed(1)}%`, 10) + pad(`${(m.expo * 100).toFixed(0)}%`, 11) +
        pad(m.trades.toFixed(0), 9) +
        pad(base ? (m.sharpe - base.sharpe >= 0 ? "+" : "") + (m.sharpe - base.sharpe).toFixed(2) : "—", 11) +
        pad(base ? `${((m.maxDD - base.maxDD) * 100).toFixed(1)}pp` : "—", 10));
    }
    out[label] = agg;
    console.log("");
  }

  const [bull, bear] = Object.values(out);
  const check = (a: Res, b: Res) => ({ sharpe: b.sharpe > a.sharpe, dd: b.maxDD < a.maxDD, ret: b.ret - a.ret > -0.02 });
  const hb = check(bull.hold, bull["hold+vol"]), hr = check(bear.hold, bear["hold+vol"]);
  const eb = check(bull.engine, bull["engine+vol"]), er = check(bear.engine, bear["engine+vol"]);

  console.log("═".repeat(104));
  console.log("PRE-REGISTERED CRITERIA (Sharpe up and drawdown down in BOTH windows; return not materially worse)");
  console.log(`  hold + vol targeting    Sharpe ${hb.sharpe && hr.sharpe ? "PASS" : "FAIL"}   drawdown ${hb.dd && hr.dd ? "PASS" : "FAIL"}   return ${hb.ret && hr.ret ? "PASS" : "FAIL"}`);
  console.log(`  engine + vol targeting  Sharpe ${eb.sharpe && er.sharpe ? "PASS" : "FAIL"}   drawdown ${eb.dd && er.dd ? "PASS" : "FAIL"}   return ${eb.ret && er.ret ? "PASS" : "FAIL"}`);
  console.log("═".repeat(104) + "\n");

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
