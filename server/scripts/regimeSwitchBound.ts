/**
 * Regime Switching — the upper bound, and how fast a classifier must be.
 *
 * ── Why this is the right question ────────────────────────────────────
 * The core/satellite frontier showed the two sleeves are near-perfect mirror
 * images: blending them at any weight yields a flat ~0% mean return, because
 * what one gains the other gives back. But that is an argument FOR switching
 * rather than against it. A blend earns the AVERAGE of the two sleeves; a switch
 * earns whichever is right for the regime.
 *
 * From the frontier, the prize is roughly:
 *   hold in bull   +6.87%     engine in bear   +2.38%
 * against ~0% for every blended weight. Worth chasing — IF the regime can be
 * called in time.
 *
 * ── The experiment ────────────────────────────────────────────────────
 * Rather than invent another classifier and report whether it worked, this
 * measures the ceiling and the decay:
 *
 *   ORACLE with lag L   the regime label is derived from what the price
 *                       actually did over the next HORIZON bars, then delayed
 *                       by L bars before being acted on.
 *
 *   L = 0     perfect foresight — the theoretical maximum for ANY classifier
 *   L > 0     the same perfect labels, but stale, which is what every real
 *             classifier produces: it is right about the past
 *
 * If the prize survives only at L = 0, no classifier can capture it and this
 * direction is closed. If it survives to L = 24 or 72 bars, a classifier has
 * room to be slow and still pay, and building one is worthwhile.
 *
 * The deployed ADX/DI/SMA200 classifier is scored alongside for reference — it
 * fires on 15-30% of bars and made bull windows WORSE in the overlay test.
 *
 * Usage:
 *   pnpm tsx server/scripts/regimeSwitchBound.ts
 */

import { computeAllMetrics, type CandleData, type AllMetrics } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
/** Bars of future used to LABEL the regime. 168 = one week at 1h. */
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

/** True where the next HORIZON bars rose — the label a perfect classifier would emit. */
function oracleLabels(c: CandleData[]): boolean[] {
  return c.map((_, i) => {
    const j = Math.min(c.length - 1, i + HORIZON);
    return c[j].close > c[i].close;
  });
}

function isUptrendADX(m: AllMetrics): boolean {
  return m.adx !== null && m.adxPlus !== null && m.adxMinus !== null && m.sma200 !== null
    && m.adx > 25 && m.adxPlus > m.adxMinus && m.price > m.sma200;
}

/**
 * Runs the switch: when `bullish[i]` the book is HELD at full exposure, otherwise
 * the engine trades it. Both branches share one book, so a switch is a real
 * rebalance and pays real fees.
 */
function runSwitch(c: CandleData[], from: number, to: number, bullish: boolean[]) {
  const scope = getCandleLimit("1h");
  let cash = SEED, u = 0, trades = 0;
  const buf: ("buy" | "sell")[] = [];
  const eq: number[] = [];

  for (let i = from; i <= to; i++) {
    const px = c[i].close;
    const m = computeAllMetrics(c.slice(Math.max(0, i - scope + 1), i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold);
    const v = cash + u * px;
    if (v <= 0) break;

    if (bullish[i]) {
      const cur = (u * px) / v;
      if (cur < 0.95) { // move to fully held
        const tu = v / px, d = tu - u;
        cash -= d * px + Math.abs(d) * px * FEE;
        u = tu; trades++;
      }
    } else {
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
  console.log(`\n${"═".repeat(94)}`);
  console.log(`Regime Switch — oracle upper bound and decay with lag · horizon ${HORIZON} bars · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(94));

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

  const LAGS = [0, 6, 12, 24, 48, 72, 168];
  const out: any[] = [];
  console.log("classifier".padEnd(22) + pad("BULL ret", 11) + pad("BEAR ret", 11) +
              pad("mean ret", 11) + pad("worst DD", 11) + pad("trades", 9));
  console.log("─".repeat(94));

  for (const lag of LAGS) {
    const acc: Record<string, number[]> = { bull: [], bear: [], dd: [], tr: [] };
    for (const [lab, ws, we] of [["bull", H0, SPLIT], ["bear", SPLIT, END]] as Array<[string, number, number]>) {
      for (const { id, c } of sel) {
        const from = Math.max(c.findIndex((x) => x.openTime >= ws), getCandleLimit("1h"));
        let to = c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = c.length - 1;
        if (to - from < 200) continue;
        const raw = oracleLabels(c);
        // Delay the perfect label: act on what was true `lag` bars ago.
        const lagged = raw.map((_, i) => raw[Math.max(0, i - lag)]);
        const r = runSwitch(c, from, to, lagged);
        acc[lab].push(r.ret); acc.dd.push(r.maxDD); acc.tr.push(r.trades);
      }
    }
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const row = { lag, bull: mean(acc.bull), bear: mean(acc.bear), dd: Math.max(...acc.dd), tr: mean(acc.tr) };
    out.push(row);
    const name = lag === 0 ? "ORACLE (perfect)" : `oracle lag ${lag}h`;
    console.log(name.padEnd(22) + pad(pct(row.bull), 11) + pad(pct(row.bear), 11) +
      pad(pct((row.bull + row.bear) / 2), 11) + pad(`${(row.dd * 100).toFixed(1)}%`, 11) + pad(row.tr.toFixed(0), 9));
  }

  // Reference: the classifier actually available today.
  {
    const acc: Record<string, number[]> = { bull: [], bear: [], dd: [], tr: [] };
    for (const [lab, ws, we] of [["bull", H0, SPLIT], ["bear", SPLIT, END]] as Array<[string, number, number]>) {
      for (const { id, c } of sel) {
        const from = Math.max(c.findIndex((x) => x.openTime >= ws), getCandleLimit("1h"));
        let to = c.findIndex((x) => x.openTime >= we);
        if (to < 0) to = c.length - 1;
        if (to - from < 200) continue;
        const scope = getCandleLimit("1h");
        const flags = c.map((_, i) =>
          i < scope ? false : isUptrendADX(computeAllMetrics(c.slice(i - scope + 1, i + 1), P.zScoreTrendThreshold, P.zScoreBlipThreshold)));
        const r = runSwitch(c, from, to, flags);
        acc[lab].push(r.ret); acc.dd.push(r.maxDD); acc.tr.push(r.trades);
      }
    }
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const row = { lag: "ADX/DI/SMA200", bull: mean(acc.bull), bear: mean(acc.bear), dd: Math.max(...acc.dd), tr: mean(acc.tr) };
    out.push(row);
    console.log("─".repeat(94));
    console.log("ADX/DI/SMA200 (real)".padEnd(22) + pad(pct(row.bull), 11) + pad(pct(row.bear), 11) +
      pad(pct((row.bull + row.bear) / 2), 11) + pad(`${(row.dd * 100).toFixed(1)}%`, 11) + pad(row.tr.toFixed(0), 9));
  }

  console.log("─".repeat(94));
  console.log("\nRead the DECAY, not the top row. A perfect classifier is not available; the");
  console.log("question is how much staleness the edge tolerates. If it is gone by lag 24h,");
  console.log("no achievable classifier captures it and this direction is closed.");
  console.log(`${"═".repeat(94)}\n`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
