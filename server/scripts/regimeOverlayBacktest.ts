/**
 * Regime Overlay — the minimal version, and the one never actually tested.
 *
 * ── What the evidence says to fix ─────────────────────────────────────
 * Across 10 assets the deployed engine produces +3.30% mean alpha in bear
 * windows and −6.03% in bull ones. It is a defensive tilt: it sells into
 * strength, which protects in a decline and costs in a rally. One defect,
 * measured, consistent, and regime-specific.
 *
 * ── Why this differs from the overhaul that failed ────────────────────
 * The earlier attempt replaced the whole exposure mapping — three per-regime
 * conviction curves, target rebalancing, shorting — and lost 16–25% alpha while
 * trading 450–640 times per window. Too many moving parts against a thin edge.
 *
 * This changes exactly ONE thing: in a confirmed uptrend, stop trading and hold.
 * Everywhere else the engine runs completely unmodified. One binary decision,
 * one degree of freedom, aimed squarely at the single measured defect.
 *
 *   confirmed uptrend   →  hold UPTREND_EXPOSURE, engine OFF
 *   anything else       →  engine ON, exactly as deployed
 *
 * "Confirmed" needs ADX, DI direction and the 200-bar SMA to agree, the same
 * classifier as before — it fired on 15–30% of bars, so it discriminates rather
 * than flapping.
 *
 * ── The bar it must clear ─────────────────────────────────────────────
 * Beating the engine in bull windows is not enough: holding more in a rising
 * market is trivially better. It must ALSO not damage the bear windows, which
 * is where the engine's only demonstrated value lives. Both columns are scored,
 * and the summary counts assets improved in bull WITHOUT being made worse in
 * bear.
 *
 * Usage:
 *   pnpm tsx server/scripts/regimeOverlayBacktest.ts
 *   pnpm tsx server/scripts/regimeOverlayBacktest.ts --uptrend-expo=0.8
 */

import { computeAllMetrics, type CandleData, type AllMetrics } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";

/**
 * OKX rate-limits and replies 429 rather than degrading. Fetching six months of
 * hourly history paginates ~43 requests per asset, so a multi-asset loop with no
 * spacing trips the limit and silently drops assets — a run of this script
 * returned 5 pairs and omitted BTC entirely, which looks like "insufficient
 * history" and is not. Space the per-asset fetches out.
 */
const PACE_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
import {
  getCandleLimit, convictionScaledFraction, MIN_TRADE_NOTIONAL_USD, type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const UPTREND_EXPO = parseFloat(arg("uptrend-expo") ?? "0.9");
const ADX_TREND = parseFloat(arg("adx") ?? "25");
const REBAL_BAND = parseFloat(arg("band") ?? "0.15");
const JSON_OUT = arg("json") ?? null;

const SEED = 10000;
const HISTORY_START = Date.parse("2026-02-15T00:00:00Z");
const LIVE_START = Date.parse("2026-05-15T00:00:00Z");
const WINDOW_END = Date.parse("2026-08-16T00:00:00Z");
const MIN_BARS = 1500;
const ANCHOR = "BTC-USDT";
const PEG_RANGE_PCT = 0.05;

const LIVE_PARAMS: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282, rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0, macdSellThreshold: 0, bbBuyDeviation: 0, bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797, zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083, emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129, minConfidence: 0.45,
};

/** Confirmed uptrend: strength, direction and long-MA position must all agree. */
function isUptrend(m: AllMetrics): boolean {
  return m.adx !== null && m.adxPlus !== null && m.adxMinus !== null && m.sma200 !== null
    && m.adx > ADX_TREND && m.adxPlus > m.adxMinus && m.price > m.sma200;
}

interface Res {
  ret: number; expo: number; blend: number; alpha: number;
  trades: number; maxDD: number; pctUptrend: number;
}

function run(candles: CandleData[], from: number, to: number, overlay: boolean): Res | null {
  const scope = getCandleLimit("1h");
  if (to - from < 200) return null;

  let cash = SEED, units = 0, trades = 0, expSum = 0, upBars = 0;
  const buffer: ("buy" | "sell")[] = [];
  const eq: number[] = [];

  for (let i = from; i <= to; i++) {
    const px = candles[i].close;
    const window = candles.slice(Math.max(0, i - scope + 1), i + 1);
    const m = computeAllMetrics(window, LIVE_PARAMS.zScoreTrendThreshold, LIVE_PARAMS.zScoreBlipThreshold);
    const value = cash + units * px;
    if (value <= 0) break;

    const uptrend = isUptrend(m);
    if (uptrend) upBars++;

    if (overlay && uptrend) {
      // Step aside: hold a fixed exposure and let the trend run. The engine's
      // sell-into-strength behaviour is exactly what costs money here.
      const cur = (units * px) / value;
      if (Math.abs(UPTREND_EXPO - cur) > REBAL_BAND) {
        const targetUnits = (UPTREND_EXPO * value) / px;
        const delta = targetUnits - units;
        cash -= delta * px + Math.abs(delta) * px * FEE;
        units = targetUnits;
        trades++;
      }
    } else {
      // Engine, byte-for-byte as deployed.
      const sig = generateSignal(m, LIVE_PARAMS);
      if (sig.signal !== "hold") { buffer.push(sig.signal); if (buffer.length > 2) buffer.shift(); }
      const confirmed = sig.signal !== "hold" && buffer.length === 2 && buffer[0] === buffer[1];
      if (confirmed) {
        const frac = convictionScaledFraction(LIVE_PARAMS.maxPositionPct, sig.confidence, LIVE_PARAMS.minConfidence);
        if (sig.signal === "buy" && cash > 0) {
          const usd = cash * frac;
          if (usd >= MIN_TRADE_NOTIONAL_USD) {
            const fee = usd * FEE; units += (usd - fee) / px; cash -= usd; trades++;
          }
        } else if (sig.signal === "sell" && units > 0) {
          const sz = units * frac, gross = sz * px;
          if (gross >= MIN_TRADE_NOTIONAL_USD) {
            const fee = gross * FEE; units -= sz; cash += gross - fee; trades++;
          }
        }
      }
    }

    const v = cash + units * px;
    eq.push(v);
    expSum += v > 0 ? (units * px) / v : 0;
  }

  const final = eq[eq.length - 1];
  let peak = eq[0], maxDD = 0;
  for (const v of eq) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
  const p0 = candles[from].close, p1 = candles[to].close;
  const expo = expSum / eq.length;
  const blend = (SEED * expo * (p1 / p0) + SEED * (1 - expo)) / SEED - 1;
  return {
    ret: final / SEED - 1, expo, blend, alpha: final / SEED - 1 - blend,
    trades, maxDD, pctUptrend: upBars / eq.length,
  };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(106)}`);
  console.log(`Regime Overlay — hold ${(UPTREND_EXPO * 100).toFixed(0)}% in confirmed uptrends (ADX>${ADX_TREND}, +DI>−DI, price>SMA200),`);
  console.log(`engine unchanged everywhere else · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("═".repeat(106));

  const tickers = await okx.publicGet<{ instId: string; volCcy24h: string }>("/api/v5/market/tickers?instType=SPOT");
  const ranked = tickers.filter((t) => t.instId.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0")).map((t) => t.instId);
  const candidates = [ANCHOR, ...ranked.filter((p) => p !== ANCHOR)].slice(0, TOP_N * 3);

  const sel: Array<{ instId: string; candles: CandleData[] }> = [];
  for (const instId of candidates) {
    if (sel.length >= TOP_N) break;
    let c: CandleData[] | null = null;
    for (let a = 0; a < 3 && !c; a++) {
      try {
        const raw = await okx.fetchCandlesFrom("1h", HISTORY_START, 5000, instId);
        c = raw.map((x) => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, openTime: x.openTime }));
      } catch { await pause(1200 * (a + 1)); }
    }
    await pause(PACE_MS);
    if (!c || c.length < MIN_BARS) continue;
    const hi = Math.max(...c.map((x) => x.high)), lo = Math.min(...c.map((x) => x.low));
    if ((hi - lo) / ((hi + lo) / 2) < PEG_RANGE_PCT) continue;
    sel.push({ instId, candles: c });
  }
  console.log(`\n${sel.length} pairs: ${sel.map((s) => s.instId).join(", ")}`);

  const out: Record<string, Array<{ instId: string; base: Res; ovl: Res }>> = {};
  for (const [label, ws, we] of [
    ["HELD-OUT (Mar–May, bull — where the engine loses)", HISTORY_START, LIVE_START],
    ["LIVE (May–Aug, bear — where the engine's value is)", LIVE_START, WINDOW_END],
  ] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(106));
    console.log("pair".padEnd(12) + pad("%uptrend", 10) + pad("engine α", 11) + pad("overlay α", 12) +
                pad("Δ alpha", 10) + pad("engine ret", 12) + pad("overlay ret", 13) +
                pad("eng trades", 12) + pad("ovl trades", 12));
    console.log("─".repeat(106));
    const rows: Array<{ instId: string; base: Res; ovl: Res }> = [];
    for (const { instId, candles } of sel) {
      const from = Math.max(candles.findIndex((c) => c.openTime >= ws), getCandleLimit("1h"));
      let to = candles.findIndex((c) => c.openTime >= we);
      if (to < 0) to = candles.length - 1;
      const base = run(candles, from, to, false), ovl = run(candles, from, to, true);
      if (!base || !ovl) continue;
      rows.push({ instId, base, ovl });
      console.log(instId.padEnd(12) + pad(`${(ovl.pctUptrend * 100).toFixed(0)}%`, 10) +
        pad(pct(base.alpha), 11) + pad(pct(ovl.alpha), 12) + pad(pct(ovl.alpha - base.alpha), 10) +
        pad(pct(base.ret), 12) + pad(pct(ovl.ret), 13) + pad(base.trades, 12) + pad(ovl.trades, 12));
    }
    console.log("─".repeat(106));
    const improved = rows.filter((r) => r.ovl.alpha > r.base.alpha).length;
    const mb = rows.reduce((a, r) => a + r.base.alpha, 0) / rows.length;
    const mo = rows.reduce((a, r) => a + r.ovl.alpha, 0) / rows.length;
    console.log(`  improved ${improved}/${rows.length}   mean alpha: engine ${pct(mb)} → overlay ${pct(mo)}   (Δ ${pct(mo - mb)})`);
    out[label] = rows;
  }

  const [bull, bear] = Object.values(out);
  const helped = bull.filter((b) => {
    const r = bear.find((x) => x.instId === b.instId);
    return r && b.ovl.alpha > b.base.alpha && r.ovl.alpha >= r.base.alpha - 0.005;
  });
  console.log(`\n${"═".repeat(106)}`);
  console.log(`Better in bull WITHOUT damaging bear (within 0.5pp): ${helped.length}/${bull.length}` +
              (helped.length ? ` — ${helped.map((r) => r.instId).join(", ")}` : ""));
  console.log("Beating the engine in a rally is trivial — holding more does it. Not harming the");
  console.log("bear window is the real test, because that is the engine's only demonstrated value.");
  console.log("═".repeat(106) + "\n");
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
