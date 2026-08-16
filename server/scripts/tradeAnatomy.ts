/**
 * Trade-level anatomy of the deployed engine — and whether EXIT policy moves it.
 *
 * ── Why this angle is different from everything already tried ─────────
 * Twelve method families have now failed to predict DIRECTION. But expectancy is
 *
 *     E = winRate × avgWin − lossRate × avgLoss
 *
 * and every previous attempt tried to raise the first term. The second and third
 * are set by EXIT policy, which has never been tested: the engine currently exits
 * only when the signal reverses — no stop, no target, no time limit. Trend
 * followers run 35–40% win rates profitably purely through payoff asymmetry.
 * Raising avgWin/avgLoss requires no forecasting ability at all, which is exactly
 * why it is worth testing after direction has been ruled out.
 *
 * Part 1 measures the current book: win rate, payoff ratio, expectancy, and what
 * share of gross P&L is eaten by fees.
 * Part 2 overlays exit rules on the SAME entry signals, so any difference is
 * attributable to exit policy alone.
 *
 * Usage:
 *   pnpm tsx server/scripts/tradeAnatomy.ts
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
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,DOGE-USDT,ACE-USDT,ROBO-USDT,HYPE-USDT,WLD-USDT,BNB-USDT").split(",");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const P: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

/** One FIFO lot: units bought at a price, carrying its share of entry fee. */
interface Lot { units: number; px: number; fee: number; bar: number }
interface RoundTrip { pnl: number; pct: number; bars: number; fees: number }

interface ExitRule {
  name: string;
  /** Return true to force-close the lot at this bar. */
  hit(lot: Lot, px: number, bar: number, peak: number): boolean;
}

const RULES: ExitRule[] = [
  { name: "none (current)", hit: () => false },
  { name: "stop -5%", hit: (l, px) => px / l.px - 1 <= -0.05 },
  { name: "stop -10%", hit: (l, px) => px / l.px - 1 <= -0.10 },
  { name: "target +10%", hit: (l, px) => px / l.px - 1 >= 0.10 },
  { name: "trail 8%", hit: (l, px, _b, peak) => peak > l.px && px / peak - 1 <= -0.08 },
  { name: "trail 15%", hit: (l, px, _b, peak) => peak > l.px && px / peak - 1 <= -0.15 },
  { name: "stop -10% + trail 15%", hit: (l, px, _b, peak) => px / l.px - 1 <= -0.10 || (peak > l.px && px / peak - 1 <= -0.15) },
  { name: "time stop 336h", hit: (l, _px, bar) => bar - l.bar >= 336 },
];

function run(c: CandleData[], from: number, to: number, rule: ExitRule) {
  const scope = getCandleLimit("1h");
  let cash = SEED, trades = 0, feesPaid = 0;
  const lots: Lot[] = [];
  const trips: RoundTrip[] = [];
  const peaks = new Map<Lot, number>();
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];

  const units = () => lots.reduce((a, l) => a + l.units, 0);

  /** Close `want` units FIFO, booking each lot's realised round trip. */
  const sell = (want: number, px: number, bar: number) => {
    let left = want, gross = 0;
    while (left > 1e-12 && lots.length) {
      const l = lots[0];
      const take = Math.min(l.units, left);
      const g = take * px, fee = g * FEE;
      const entryCost = take * l.px + l.fee * (take / l.units);
      gross += g - fee;
      feesPaid += fee;
      trips.push({
        pnl: g - fee - entryCost,
        pct: (g - fee) / entryCost - 1,
        bars: bar - l.bar,
        fees: fee + l.fee * (take / l.units),
      });
      l.fee *= 1 - take / l.units;
      l.units -= take;
      left -= take;
      if (l.units <= 1e-12) { peaks.delete(l); lots.shift(); }
    }
    cash += gross;
    trades++;
  };

  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    for (const l of lots) peaks.set(l, Math.max(peaks.get(l) ?? l.px, px));

    // Exit rule is checked BEFORE the signal, so a stop always wins a tie.
    for (const l of [...lots]) {
      if (rule.hit(l, px, i, peaks.get(l) ?? l.px)) sell(l.units, px, i);
    }

    const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    const s = generateSignal(m, P);
    if (s.signal !== "hold") { buf.push(s.signal); if (buf.length > 2) buf.shift(); }
    if (s.signal !== "hold" && buf.length === 2 && buf[0] === buf[1]) {
      const f = convictionScaledFraction(P.maxPositionPct, s.confidence, P.minConfidence);
      if (s.signal === "buy" && cash > 0) {
        const usd = cash * f;
        if (usd >= MIN_TRADE_NOTIONAL_USD) {
          const fee = usd * FEE;
          const u = (usd - fee) / px;
          const lot: Lot = { units: u, px, fee, bar: i };
          lots.push(lot); peaks.set(lot, px);
          cash -= usd; feesPaid += fee; trades++;
        }
      } else if (s.signal === "sell" && units() > 0) {
        const sz = units() * f;
        if (sz * px >= MIN_TRADE_NOTIONAL_USD) sell(sz, px, i);
      }
    }
    eq.push(cash + units() * px);
  }

  const fin = eq[eq.length - 1];
  let pk = eq[0], dd = 0;
  for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk); }
  return { ret: fin / SEED - 1, maxDD: dd, trips, trades, feesPaid };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
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

  console.log(`\n${"═".repeat(100)}`);
  console.log(`Trade anatomy — ${assets.length} assets · ${(FEE * 10000).toFixed(0)}bps · entries identical, only exit policy varies`);
  console.log("═".repeat(100));

  for (const [label, ws, we] of [["BULL (Mar–May)", H0, SPLIT], ["BEAR (May–Aug)", SPLIT, END]] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(100));
    console.log("exit rule".padEnd(22) + pad("return", 10) + pad("maxDD", 9) + pad("win%", 8) +
                pad("avg win", 10) + pad("avg loss", 10) + pad("payoff", 9) + pad("expect", 9) + pad("trips", 7));
    console.log("─".repeat(100));

    for (const rule of RULES) {
      let ret = 0, dd = 0, nA = 0;
      const all: RoundTrip[] = [];
      for (const { c } of assets) {
        const from = Math.max(c.findIndex((x) => x.openTime >= ws), WARMUP);
        let to = c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = c.length - 1;
        if (to - from < 200) continue;
        const r = run(c, from, to, rule);
        ret += r.ret; dd += r.maxDD; nA++;
        all.push(...r.trips);
      }
      if (!nA || !all.length) continue;
      const wins = all.filter((t) => t.pnl > 0), losses = all.filter((t) => t.pnl <= 0);
      const aw = wins.length ? wins.reduce((a, t) => a + t.pct, 0) / wins.length : 0;
      const al = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pct, 0) / losses.length) : 0;
      const wr = wins.length / all.length;
      console.log(rule.name.padEnd(22) + pad(pct(ret / nA), 10) + pad(`${((dd / nA) * 100).toFixed(1)}%`, 9) +
        pad(`${(wr * 100).toFixed(1)}%`, 8) + pad(pct(aw), 10) + pad(pct(-al), 10) +
        pad(al > 0 ? (aw / al).toFixed(2) : "—", 9) +
        pad(pct(wr * aw - (1 - wr) * al), 9) + pad(all.length, 7));
    }
  }

  // Fee drag on the current configuration only.
  console.log(`\n${"═".repeat(100)}`);
  console.log("FEE DRAG — current exit policy");
  console.log("─".repeat(100));
  for (const [label, ws, we] of [["BULL", H0, SPLIT], ["BEAR", SPLIT, END]] as Array<[string, number, number]>) {
    let fees = 0, gross = 0, n = 0;
    for (const { c } of assets) {
      const from = Math.max(c.findIndex((x) => x.openTime >= ws), WARMUP);
      let to = c.findIndex((x) => x.openTime >= we);
      if (to < 0) to = c.length - 1;
      if (to - from < 200) continue;
      const r = run(c, from, to, RULES[0]);
      fees += r.feesPaid; gross += r.trips.reduce((a, t) => a + t.pnl + t.fees, 0); n++;
    }
    console.log(`${label.padEnd(8)} fees ${pad(`$${(fees / n).toFixed(0)}`, 8)} on a $${SEED} book = ${pad(`${((fees / n / SEED) * 100).toFixed(2)}%`, 7)} of capital   ` +
      `gross realised P&L $${(gross / n).toFixed(0)}`);
  }
  console.log("═".repeat(100) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
