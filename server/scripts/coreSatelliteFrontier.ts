/**
 * Core / Satellite Frontier — how much bull-market drag buys how much bear protection.
 *
 * ── Why this and not another signal ───────────────────────────────────
 * Eight experiments failed to improve on the deployed engine, and the pattern
 * was consistent: added machinery subtracts. What survived every test is a pair
 * of facts, each measured across ten assets and two regimes:
 *
 *   a STATIC allocation beats the engine in bull windows (engine −5.23% alpha)
 *   the ENGINE beats a static allocation in bear windows (+4.40% alpha), and
 *     beats a naive SMA200 trend rule 9/10 there
 *
 * Neither dominates. That is not a signal problem, it is an allocation problem,
 * and it has a knowable trade-off rather than a right answer:
 *
 *   core       a static holding, never traded — captures trends
 *   satellite  the engine, unchanged — adds defensive tilt
 *
 * ── Why the equity curves are blended, not the returns ────────────────
 * Combined RETURN is linear in the weight, so it could be computed on paper.
 * Combined DRAWDOWN is not: it depends on when each sleeve loses, and the whole
 * point of holding both is that they lose at different times. So both sleeves
 * are simulated bar by bar and their equity curves blended before any risk
 * measure is taken.
 *
 * Usage:
 *   pnpm tsx server/scripts/coreSatelliteFrontier.ts
 *   pnpm tsx server/scripts/coreSatelliteFrontier.ts --top=10 --json=out.json
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const JSON_OUT = arg("json") ?? null;

const SEED = 10000;
const H0 = Date.parse("2026-02-15T00:00:00Z");
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const END = Date.parse("2026-08-16T00:00:00Z");
const MIN_BARS = 1500;
const ANCHOR = "BTC-USDT";
const PEG = 0.05;
const PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

/** Equity curve of the engine sleeve, run exactly as deployed. */
function engineCurve(c: CandleData[], from: number, to: number): number[] {
  const scope = getCandleLimit("1h");
  let cash = SEED, u = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    const s = generateSignal(m, P);
    if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
    if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
      const f = convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence);
      if (s.signal === "buy" && cash > 0) {
        const usd = cash * f;
        if (usd >= MIN_TRADE_NOTIONAL_USD) { const fe = usd * FEE; u += (usd - fe) / px; cash -= usd; }
      } else if (s.signal === "sell" && u > 0) {
        const sz = u * f, g = sz * px;
        if (g >= MIN_TRADE_NOTIONAL_USD) { const fe = g * FEE; u -= sz; cash += g - fe; }
      }
    }
    eq.push(cash + u * px);
  }
  return eq;
}

/** Equity curve of the core sleeve: buy once at the open, never trade again. */
function coreCurve(c: CandleData[], from: number, to: number): number[] {
  const units = (SEED * (1 - FEE)) / c[from].close;
  const eq: number[] = [];
  for (let i = from; i <= to; i++) eq.push(units * c[i].close);
  return eq;
}

function stats(eq: number[]) {
  const final = eq[eq.length - 1];
  let peak = eq[0], dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  const r: number[] = [];
  for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, r.length));
  return { ret: final / SEED - 1, maxDD: dd, sharpe: sd > 0 ? (m / sd) * Math.sqrt(24 * 365) : 0 };
}

/** Blends two sleeves at weight w in the CORE, then measures. Order matters. */
function blend(core: number[], eng: number[], w: number) {
  const n = Math.min(core.length, eng.length);
  const eq: number[] = [];
  for (let i = 0; i < n; i++) eq.push(w * core[i] + (1 - w) * eng[i]);
  return stats(eq);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(96)}`);
  console.log(`Core / Satellite Frontier — static holding vs the engine, ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(96));

  const t = await okx.publicGet<{ instId: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SPOT");
  const rank = t.filter((x) => x.instId.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0")).map((x) => x.instId);
  const cands = [ANCHOR, ...rank.filter((p) => p !== ANCHOR)].slice(0, TOP_N * 3);

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
  console.log(`\n${sel.length} pairs: ${sel.map((s) => s.id).join(", ")}`);

  // Simulate both sleeves once per asset per window; the frontier is then just
  // re-blending the stored curves, which is why the sweep is cheap.
  const curves: Record<string, Record<string, { core: number[]; eng: number[] }>> = {};
  for (const [lab, ws, we] of [["bull", H0, SPLIT], ["bear", SPLIT, END]] as Array<[string, number, number]>) {
    curves[lab] = {};
    for (const { id, c } of sel) {
      const from = Math.max(c.findIndex((x) => x.openTime >= ws), getCandleLimit("1h"));
      let to = c.findIndex((x) => x.openTime >= we);
      if (to < 0) to = c.length - 1;
      if (to - from < 200) continue;
      curves[lab][id] = { core: coreCurve(c, from, to), eng: engineCurve(c, from, to) };
    }
  }

  const weights = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const rows: any[] = [];
  console.log(`\n${"core%".padEnd(7)}${pad("BULL ret", 10)}${pad("BULL DD", 10)}${pad("BEAR ret", 10)}${pad("BEAR DD", 10)}` +
              `${pad("mean ret", 10)}${pad("worst DD", 10)}${pad("mean Sharpe", 13)}`);
  console.log("─".repeat(96));
  for (const w of weights) {
    const agg: Record<string, { ret: number[]; dd: number[]; sh: number[] }> = {
      bull: { ret: [], dd: [], sh: [] }, bear: { ret: [], dd: [], sh: [] },
    };
    for (const lab of ["bull", "bear"]) {
      for (const id of Object.keys(curves[lab])) {
        const s = blend(curves[lab][id].core, curves[lab][id].eng, w);
        agg[lab].ret.push(s.ret); agg[lab].dd.push(s.maxDD); agg[lab].sh.push(s.sharpe);
      }
    }
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const row = {
      core: w,
      bullRet: mean(agg.bull.ret), bullDD: mean(agg.bull.dd),
      bearRet: mean(agg.bear.ret), bearDD: mean(agg.bear.dd),
      meanRet: (mean(agg.bull.ret) + mean(agg.bear.ret)) / 2,
      worstDD: Math.max(...agg.bull.dd, ...agg.bear.dd),
      sharpe: (mean(agg.bull.sh) + mean(agg.bear.sh)) / 2,
    };
    rows.push(row);
    const tag = w === 0 ? "  ← engine only" : w === 1 ? "  ← hold only" : "";
    console.log(
      `${(w * 100).toFixed(0) + "%"}`.padEnd(7) +
      pad(pct(row.bullRet), 10) + pad(`${(row.bullDD * 100).toFixed(1)}%`, 10) +
      pad(pct(row.bearRet), 10) + pad(`${(row.bearDD * 100).toFixed(1)}%`, 10) +
      pad(pct(row.meanRet), 10) + pad(`${(row.worstDD * 100).toFixed(1)}%`, 10) +
      pad(row.sharpe.toFixed(2), 13) + tag
    );
  }
  console.log("─".repeat(96));

  const bestRet = rows.reduce((a, b) => (b.meanRet > a.meanRet ? b : a));
  const bestSharpe = rows.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
  console.log(`\nBest mean return : ${(bestRet.core * 100).toFixed(0)}% core  (${pct(bestRet.meanRet)}, worst DD ${(bestRet.worstDD * 100).toFixed(1)}%)`);
  console.log(`Best mean Sharpe : ${(bestSharpe.core * 100).toFixed(0)}% core  (${bestSharpe.sharpe.toFixed(2)}, worst DD ${(bestSharpe.worstDD * 100).toFixed(1)}%)`);
  console.log(`\nThis is a trade-off to choose, not an optimum to find: more core earns more in`);
  console.log(`rallies and gives back more in declines. Two regimes and ten correlated assets`);
  console.log(`is a thin basis for picking a precise weight — read the shape, not the argmax.`);
  console.log(`${"═".repeat(96)}\n`);

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
