/**
 * Does the static-allocation result hold across the major cryptocurrencies, or
 * is it a BTC artefact?
 *
 * Runs three strategies continuously over the same 3-year window on every major
 * with full history: the deployed engine, a static 40% weight, and buy-and-hold.
 * Continuous rather than chopped into 90-day episodes, so the numbers are what a
 * book actually holding these would have experienced.
 *
 * ── The caveat that governs how much this proves ──────────────────────
 * Hourly crypto returns across majors correlate at ~0.449, so the effective
 * independent sample is N/(1+(N-1)p) ≈ 2.2 assets no matter how many are added.
 * Ten majors agreeing is therefore NOT ten confirmations — it is closer to two,
 * and largely a statement that they all rose and fell together. What it CAN
 * rule out is the result being specific to BTC's particular path. Consistency of
 * DIRECTION across assets is meaningful here; the magnitude of the average is
 * not, and no significance should be read into it.
 *
 * Usage:
 *   pnpm tsx server/scripts/majorsStaticCompare.ts
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import { loadHourly } from "./lib/historyCache";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const W = parseFloat(arg("w") ?? "0.40");
const BAND = parseFloat(arg("band") ?? "0.10");
const YEARS = parseFloat(arg("years") ?? "3");
const SEED = 10000;
const WARMUP = 200;
const END = Date.parse("2026-08-16T00:00:00Z");
const START = END - YEARS * 365 * 24 * 3600 * 1000;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,XRP-USDT,DOGE-USDT,ADA-USDT,LINK-USDT,AVAX-USDT,TRX-USDT,LTC-USDT,DOT-USDT").split(",");

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

interface Perf { ret: number; maxDD: number; trades: number; expo: number; sells?: number; buys?: number }

function finish(eq: number[], trades: number, expSum: number, n: number): Perf {
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: eq[eq.length - 1] / SEED - 1, maxDD: dd, trades, expo: n ? expSum / n : 0 };
}

function runEngine(c: CandleData[], from: number): Perf {
  const scope = getCandleLimit("1h");
  let cash = SEED, u = 0, trades = 0, expSum = 0, n = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];
  for (let i = from; i < c.length; i++) {
    const px = c[i].close;
    const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    const s = generateSignal(m, P);
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
  return finish(eq, trades, expSum, n);
}

function runStatic(c: CandleData[], from: number): Perf {
  let cash = SEED * (1 - W), u = (SEED * W) / c[from].close;
  let trades = 0, sells = 0, buys = 0, expSum = 0, n = 0;
  const eq: number[] = [];
  for (let i = from; i < c.length; i++) {
    const px = c[i].close;
    const total = cash + u * px;
    if (total <= 0) break;
    if (Math.abs(W - (u * px) / total) > BAND) {
      const d = (W * total) / px - u;
      const notional = Math.abs(d) * px;
      if (notional >= MIN_TRADE_NOTIONAL_USD) {
        cash -= d * px + notional * FEE;
        u += d; trades++;
        if (d < 0) sells++; else buys++;
      }
    }
    const v = cash + u * px;
    eq.push(v);
    if (v > 0) { expSum += (u * px) / v; n++; }
  }
  return { ...finish(eq, trades, expSum, n), sells, buys };
}

function runHold(c: CandleData[], from: number): Perf {
  const eq = c.slice(from).map((x) => (SEED / c[from].close) * x.close);
  return finish(eq, 1, eq.length, eq.length);
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(104)}`);
  console.log(`Majors: engine vs static ${(W * 100).toFixed(0)}% vs hold · ${YEARS}y continuous · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(110));

  const rows: Array<{ id: string; eng: Perf; st: Perf; hold: Perf }> = [];
  for (const id of PAIRS) {
    const { candles: c } = await loadHourly(id, START, END);
    if (c.length < WARMUP + 4000) { console.log(`  ${id.padEnd(10)} skipped — only ${c.length} bars`); continue; }
    rows.push({ id, eng: runEngine(c, WARMUP), st: runStatic(c, WARMUP), hold: runHold(c, WARMUP) });
  }

  console.log(`\n${rows.length} assets with full history\n`);
  console.log("asset".padEnd(11) + pad("hold", 10) + pad("engine", 10) + pad("static", 10) +
              pad("st − eng", 11) + pad("eng DD", 9) + pad("st DD", 8) + pad("hold DD", 9) +
              pad("eng trd", 10) + pad("st trd", 14));
  console.log("─".repeat(110));
  for (const r of rows) {
    console.log(r.id.replace("-USDT", "").padEnd(11) +
      pad(pct(r.hold.ret), 10) + pad(pct(r.eng.ret), 10) + pad(pct(r.st.ret), 10) +
      pad(pct(r.st.ret - r.eng.ret), 11) +
      pad(`${(r.eng.maxDD * 100).toFixed(0)}%`, 9) + pad(`${(r.st.maxDD * 100).toFixed(0)}%`, 8) +
      pad(`${(r.hold.maxDD * 100).toFixed(0)}%`, 9) +
      pad(r.eng.trades, 10) + pad(`${r.st.trades} (${r.st.sells}s/${r.st.buys}b)`, 14));
  }
  console.log("─".repeat(110));
  const m = (f: (r: typeof rows[0]) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  console.log("MEAN".padEnd(11) + pad(pct(m((r) => r.hold.ret)), 10) + pad(pct(m((r) => r.eng.ret)), 10) +
    pad(pct(m((r) => r.st.ret)), 10) + pad(pct(m((r) => r.st.ret - r.eng.ret)), 11) +
    pad(`${(m((r) => r.eng.maxDD) * 100).toFixed(0)}%`, 9) + pad(`${(m((r) => r.st.maxDD) * 100).toFixed(0)}%`, 8) +
    pad(`${(m((r) => r.hold.maxDD) * 100).toFixed(0)}%`, 9) +
    pad(m((r) => r.eng.trades).toFixed(0), 10) + pad(m((r) => r.st.trades).toFixed(0), 14));

  const stBeatsEng = rows.filter((r) => r.st.ret > r.eng.ret).length;
  const stDDBetter = rows.filter((r) => r.st.maxDD < r.eng.maxDD).length;
  const holdBeatsSt = rows.filter((r) => r.hold.ret > r.st.ret).length;
  console.log(`\nstatic beats engine on return    ${stBeatsEng}/${rows.length}`);
  console.log(`static beats engine on drawdown  ${stDDBetter}/${rows.length}`);
  console.log(`hold beats static on return      ${holdBeatsSt}/${rows.length}   (the cost of holding ${(W * 100).toFixed(0)}% instead of 100%)`);
  console.log(`\nNOTE: majors correlate ~0.449 hourly, so the effective independent sample is ~2.2`);
  console.log(`assets, not ${rows.length}. Consistency of direction is the signal here; the mean is not evidence.`);
  console.log("═".repeat(110) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
