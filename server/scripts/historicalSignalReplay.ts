/**
 * Historical Signal Replay
 *
 * Compares the baseline signal generator against an enhanced version that
 * incorporates external market signals:
 *   1. Perpetual funding rate (Bybit)        — crowded-long / smart-money-short detection
 *   2. Fear & Greed Index (alternative.me)   — sentiment extremes
 *   3. US 10Y Treasury yield velocity        — risk-off detection via rate of change
 *   4. Spot ETF netflow 7D SMA (SosoValue)   — institutional flow momentum (best-effort)
 *   5. IBIT 7D/14D volume ratio (Yahoo Fin.) — ETF demand proxy when SosoValue unavailable
 *      Declining IBIT dollar volume near BTC highs = institutional demand drying up
 *
 * For each hourly bar it:
 *   a) Runs the existing indicator pipeline (RSI, MACD, BB, EMA, Z-score, CUSUM, Hurst, ADX)
 *   b) Generates a baseline signal
 *   c) Applies external modifier multipliers to the raw buy/sell scores
 *   d) Re-evaluates the signal with modified scores
 *   e) Records both and computes 24h outcome
 *
 * Usage:
 *   pnpm tsx server/scripts/historicalSignalReplay.ts [--days=90] [--price=82000]
 *
 * Output:
 *   - Data availability report (which feeds were reachable)
 *   - 90-day precision / recall table for sell signals
 *   - Signal table for the ±5% window around --price
 *   - Modifier flip analysis (hold→sell, buy→hold, buy→sell counts)
 *   - Full row-level JSON saved to replay-results.json
 *
 * OVERFITTING CAVEAT:
 *   The modifier thresholds below were not tuned on historical data — they are
 *   first-principles values (e.g., >0.10%/8h funding = overcrowded longs). If
 *   you tune them on the same 90-day window you then evaluate on, precision
 *   will be inflated. For a valid evaluation, hold out a separate test period.
 */

import { computeAllMetrics } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import { fetchCandlesFrom } from "../engine/marketData";
import { applyExternalModifiers, signalFromScores } from "../engine/externalModifiers";
import type { ExternalSignals } from "../engine/externalModifiers";
import { fetchExternalHistory, availabilityReport, getExternalAt } from "./externalHistory";
import { DEFAULT_STRATEGY_PARAMS } from "../../shared/tradingTypes";
import type { StrategyParameters } from "../../shared/tradingTypes";
import * as fs from "fs";

// ─── CLI Config ───────────────────────────────────────────────────────
const argDays    = process.argv.find(a => a.startsWith("--days="));
const argPrice   = process.argv.find(a => a.startsWith("--price="));
const argMinConf = process.argv.find(a => a.startsWith("--min-confidence="));
const DISABLE_IBIT = process.argv.includes("--no-ibit");
/**
 * --ibit-strict: re-applies the IBIT modifier with much tighter thresholds
 * than the previously-disabled production version. Used to test whether a
 * stricter IBIT rule (fewer fires, higher signal) beats the IBIT-off baseline.
 *   Strict thresholds (vs. original in parens):
 *     >$8000M  → strong inflow buy×1.20  sell×0.88  (was >$4000M)
 *     >$3000M  → moderate inflow buy×1.12          (was >$1500M)
 *     <-$3000M → moderate outflow sell×1.10        (was <-$800M)
 *     <-$8000M → heavy outflow sell×1.20 buy×0.90  (was <-$2000M)
 */
const IBIT_STRICT = process.argv.includes("--ibit-strict");
const WINDOW_DAYS      = argDays    ? parseInt(argDays.slice(7))   : 90;
const HIGHLIGHT_PRICE  = argPrice   ? parseFloat(argPrice.slice(8)) : 82000;
const MIN_CONF_OVERRIDE = argMinConf ? parseFloat(argMinConf.slice("--min-confidence=".length)) : null;

const HIGHLIGHT_RANGE = 0.05;   // ±5% around highlight price for detail table
const DROP_THRESHOLD  = -0.02;  // -2% in 24h = a "drop" for precision/recall
const DAY_MS          = 24 * 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────
interface CandleRow {
  open: number; high: number; low: number;
  close: number; volume: number; openTime: number;
}

// FundingRecord / YieldRecord and every external fetcher now live in
// ./externalHistory, shared with strategyBacktest.ts.
// ExternalPoint is now ExternalSignals from the shared engine module.
// The replay script uses the same type so backtest results are directly comparable
// to what the production heartbeat computes.

interface ReplayRow {
  ts:           number;
  isoTime:      string;
  price:        number;
  // Baseline
  baseSignal:   "buy" | "sell" | "hold";
  baseConf:     number;
  baseRawBuy:   number;
  baseRawSell:  number;
  // External
  ext:          ExternalSignals;
  modifiers:    string[];
  // Enhanced
  enhSignal:    "buy" | "sell" | "hold";
  enhBuy:       number;
  enhSell:      number;
  enhConf:      number;
  // Outcome
  next24hRet:   number | null;
}

// ─── Candle Fetching ──────────────────────────────────────────────────
/**
 * Fetch historical 1h OHLCV candles for the replay window.
 *
 * Kraken's OHLC endpoint silently ignores `since` values older than ~30 days
 * and returns its most recent 720 candles regardless.  Yahoo Finance supports
 * arbitrary ranges (range=3mo → ~2160 1h bars) and is used as the primary
 * source for windows longer than 30 days.  Kraken is the fallback for shorter
 * windows or when Yahoo Finance is unreachable.
 */
async function fetchAllCandles(days: number): Promise<CandleRow[]> {
  // ── Yahoo Finance (primary for >30d windows) ───────────────────────
  if (days > 30) {
    console.log(`Fetching ${days} days of 1h candles from Yahoo Finance...`);
    try {
      const rangeParam = days <= 60 ? "2mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : "1y";
      const res = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1h&range=${rangeParam}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-backtest/1.0)" } }
      );
      if (!res.ok) throw new Error(`Yahoo Finance BTC-USD ${res.status}`);
      const data = await res.json() as {
        chart: {
          result?: Array<{
            timestamp: number[];
            indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }> };
          }>;
        };
      };
      const chart = data.chart.result?.[0];
      if (!chart) throw new Error("No chart result from Yahoo Finance");
      const { timestamp, indicators } = chart;
      const q = indicators.quote[0];
      const candles: CandleRow[] = [];
      for (let i = 0; i < timestamp.length; i++) {
        const c = q.close[i], o = q.open[i], h = q.high[i], l = q.low[i], v = q.volume[i];
        if (!c || !o || !h || !l) continue; // skip null/gap bars
        candles.push({ openTime: timestamp[i] * 1000, open: o, high: h, low: l, close: c, volume: v ?? 0 });
      }
      // Trim to requested window
      const cutoff = Date.now() - days * DAY_MS;
      const trimmed = candles.filter(c => c.openTime >= cutoff).sort((a, b) => a.openTime - b.openTime);
      const from = new Date(trimmed[0].openTime).toISOString().slice(0, 10);
      const to   = new Date(trimmed[trimmed.length - 1].openTime).toISOString().slice(0, 10);
      console.log(`  Got ${trimmed.length} candles (${from} → ${to})`);
      return trimmed;
    } catch (e) {
      console.warn(`  ⚠ Yahoo Finance failed: ${e}. Falling back to Kraken (30-day cap applies).`);
    }
  }

  // ── Kraken fallback (≤30 days reliable) ───────────────────────────
  console.log(`Fetching candles from Kraken (720-candle cap, ~30 days max)...`);
  const raw = await fetchCandlesFrom("1h", Date.now() - days * DAY_MS, 720);
  const candles = raw.map(c => ({
    open: c.open, high: c.high, low: c.low,
    close: c.close, volume: c.volume, openTime: c.openTime,
  })).sort((a, b) => a.openTime - b.openTime);
  const from = new Date(candles[0].openTime).toISOString().slice(0, 10);
  const to   = new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10);
  console.log(`  Got ${candles.length} candles (${from} → ${to})`);
  return candles;
}

// ─── External data fetching + alignment ───────────────────────────────
// Bybit funding, Fear & Greed, US10Y yield, SosoValue ETF netflow and the IBIT
// signed-flow proxy all live in ./externalHistory so that this script and
// strategyBacktest.ts see byte-identical external context.


// ─── Formatting Helpers ───────────────────────────────────────────────
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function isoUtc(ts: number) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function pct(n: number, digits = 2) { return `${(n * 100).toFixed(digits)}%`; }

function pad(s: string | number, w: number, right = false) {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w).slice(0, w);
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const hr = "─".repeat(72);
  console.log(`\n${hr}`);
  console.log(`BTC Historical Signal Replay  ·  ${WINDOW_DAYS}-day window`);
  console.log(`Detail view: ±${HIGHLIGHT_RANGE * 100}% of $${HIGHLIGHT_PRICE.toLocaleString()}`);
  console.log(`Drop threshold: next-24h return < ${DROP_THRESHOLD * 100}%`);
  console.log(`${hr}\n`);

  // ── 1. Fetch all external data in parallel ──────────────────────────
  const [candles, external] = await Promise.all([
    fetchAllCandles(WINDOW_DAYS),
    fetchExternalHistory(WINDOW_DAYS),
  ]);

  const feeds = availabilityReport(external);
  const avail = {
    candles:   String(candles.length),
    funding:   feeds.funding,
    fearGreed: feeds.fearGreed,
    yields:    feeds.yields,
    etf:       feeds.etf,
    ibit:      feeds.ibit,
  };
  console.log(`\nData availability:`);
  console.log(`  Candles:               ${avail.candles}`);
  console.log(`  Funding rates:         ${avail.funding}`);
  console.log(`  Fear & Greed:          ${avail.fearGreed}`);
  console.log(`  US10Y yield:           ${avail.yields}`);
  console.log(`  ETF netflow (SosoVal): ${avail.etf}`);
  console.log(`  IBIT signed-flow:      ${avail.ibit}`);

  const params: StrategyParameters = MIN_CONF_OVERRIDE !== null
    ? { ...DEFAULT_STRATEGY_PARAMS, minConfidence: MIN_CONF_OVERRIDE }
    : DEFAULT_STRATEGY_PARAMS;
  if (MIN_CONF_OVERRIDE !== null) console.log(`⚙ minConfidence override → ${MIN_CONF_OVERRIDE}`);
  if (DISABLE_IBIT) console.log(`⚙ IBIT modifier DISABLED (ibitFlow7d → null)`);
  const rows: ReplayRow[] = [];

  // ── 2. Replay bar by bar ────────────────────────────────────────────
  console.log("\nReplaying signals (this takes ~30-60s for 90 days)...");
  const startIdx = Math.min(200, candles.length - 1);

  for (let i = startIdx; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const cur    = candles[i];

    const metrics = computeAllMetrics(window, params.zScoreTrendThreshold, params.zScoreBlipThreshold);
    const base    = generateSignal(metrics, params);

    // Rolling 14-day high (336 1h bars) for the funding divergence context filter
    const highLookback = 336;
    const highStart    = Math.max(0, i - highLookback);
    const rollingHigh14d = candles
      .slice(highStart, i + 1)
      .reduce((mx, c) => Math.max(mx, c.close), 0);

    const extRaw = getExternalAt(cur.openTime, external, cur.close, rollingHigh14d);
    const ext = DISABLE_IBIT ? { ...extRaw, ibitFlow7d: null } : extRaw;

    let { modBuy, modSell, mods } = applyExternalModifiers(base.rawBuyScore, base.rawSellScore, ext);

    // ── Strict IBIT experiment ────────────────────────────────────────
    // Production externalModifiers.ts has IBIT disabled (commit b512790).
    // When --ibit-strict is set, re-apply the IBIT block here with tighter
    // thresholds to test whether a more selective version adds edge.
    if (IBIT_STRICT && ext.ibitFlow7d !== null) {
      const f = ext.ibitFlow7d;
      if (f > 8000) {
        modBuy *= 1.20; modSell *= 0.88;
        mods.push(`IBIT-7d=+${f.toFixed(0)}M[STRICT strong-inflow buy×1.20]`);
      } else if (f > 3000) {
        modBuy *= 1.12;
        mods.push(`IBIT-7d=+${f.toFixed(0)}M[STRICT inflow buy×1.12]`);
      } else if (f < -8000) {
        modSell *= 1.20; modBuy *= 0.90;
        mods.push(`IBIT-7d=${f.toFixed(0)}M[STRICT heavy-outflow sell×1.20]`);
      } else if (f < -3000) {
        modSell *= 1.10;
        mods.push(`IBIT-7d=${f.toFixed(0)}M[STRICT outflow sell×1.10]`);
      }
    }

    const enh = signalFromScores(modBuy, modSell, params.minConfidence);

    // 24h outcome — price 24 candles ahead
    const futureIdx   = Math.min(i + 24, candles.length - 1);
    const next24hRet  = (i + 24 < candles.length)
      ? (candles[futureIdx].close - cur.close) / cur.close
      : null;

    rows.push({
      ts: cur.openTime, isoTime: isoUtc(cur.openTime), price: cur.close,
      baseSignal: base.signal, baseConf: base.confidence,
      baseRawBuy: base.rawBuyScore, baseRawSell: base.rawSellScore,
      ext, modifiers: mods,
      enhSignal: enh.signal, enhBuy: modBuy, enhSell: modSell, enhConf: enh.confidence,
      next24hRet,
    });

    if (i % 200 === 0) process.stdout.write(".");
  }
  console.log(` done — ${rows.length} bars\n`);

  // ── 3. Statistics ───────────────────────────────────────────────────
  const baseSells  = rows.filter(r => r.baseSignal  === "sell");
  const enhSells   = rows.filter(r => r.enhSignal   === "sell");
  const trueDrops  = rows.filter(r => r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD);

  const baseTP = baseSells.filter(r => r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD);
  const enhTP  = enhSells.filter( r => r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD);

  const basePrecision = baseSells.length > 0 ? baseTP.length / baseSells.length : 0;
  const enhPrecision  = enhSells.length  > 0 ? enhTP.length  / enhSells.length  : 0;
  const baseRecall    = trueDrops.length > 0 ? baseTP.length / trueDrops.length : 0;
  const enhRecall     = trueDrops.length > 0 ? enhTP.length  / trueDrops.length : 0;

  console.log(hr);
  console.log(`SELL SIGNAL QUALITY  (drop = next-24h return < ${pct(DROP_THRESHOLD)})`);
  console.log(hr);
  console.log(`                          Baseline    Enhanced`);
  console.log(`Sell signals emitted:     ${pad(baseSells.length, 8, true)}    ${pad(enhSells.length, 8, true)}`);
  console.log(`True positives:           ${pad(baseTP.length, 8, true)}    ${pad(enhTP.length, 8, true)}`);
  console.log(`False positives:          ${pad(baseSells.length - baseTP.length, 8, true)}    ${pad(enhSells.length - enhTP.length, 8, true)}`);
  console.log(`Precision:                ${pad(pct(basePrecision), 8, true)}    ${pad(pct(enhPrecision), 8, true)}`);
  console.log(`Recall (of all drops):    ${pad(pct(baseRecall), 8, true)}    ${pad(pct(enhRecall), 8, true)}`);
  console.log(`Total drops in window:    ${pad(trueDrops.length, 8, true)}`);

  // F1 score
  const baseF1 = (basePrecision + baseRecall) > 0
    ? 2 * basePrecision * baseRecall / (basePrecision + baseRecall) : 0;
  const enhF1  = (enhPrecision + enhRecall) > 0
    ? 2 * enhPrecision * enhRecall / (enhPrecision + enhRecall) : 0;
  console.log(`F1 score:                 ${pad(pct(baseF1), 8, true)}    ${pad(pct(enhF1), 8, true)}`);

  // ── 4. Detail table around highlight price ──────────────────────────
  const lo = HIGHLIGHT_PRICE * (1 - HIGHLIGHT_RANGE);
  const hi = HIGHLIGHT_PRICE * (1 + HIGHLIGHT_RANGE);
  const detail = rows.filter(r => r.price >= lo && r.price <= hi);

  if (detail.length > 0) {
    console.log(`\n${hr}`);
    console.log(`SIGNAL TABLE  ·  $${lo.toLocaleString(undefined, {maximumFractionDigits: 0})} – $${hi.toLocaleString(undefined, {maximumFractionDigits: 0})}  (${detail.length} bars)`);
    console.log(hr);
    const hdr = `${pad("Timestamp", 20)} ${pad("Price", 8)} ${pad("Base", 5)} ${pad("Enh", 9)} ${pad("24h%", 7)} Modifiers`;
    console.log(hdr);
    console.log("─".repeat(hdr.length + 30));

    for (const r of detail) {
      const base = r.baseSignal === "sell" ? "SELL" : r.baseSignal === "buy" ? "BUY " : "hold";
      const enh  = r.enhSignal  === "sell" ? "SELL" : r.enhSignal  === "buy" ? "BUY " : "hold";
      const flip  = r.baseSignal !== r.enhSignal ? " ←" : "  ";
      const ret24 = r.next24hRet !== null ? pct(r.next24hRet) : " N/A  ";
      const correct = r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD ? "✓" : " ";
      const modStr = r.modifiers.join(" · ") || "—";

      console.log(
        `${pad(r.isoTime, 20)} ` +
        `${pad("$" + r.price.toFixed(0), 8)} ` +
        `${pad(base, 5)} ` +
        `${pad(enh + flip, 7)} ` +
        `${correct}${pad(ret24, 7)} ` +
        modStr
      );
    }
  } else {
    console.log(`\n⚠ No bars found in $${lo.toLocaleString()}–$${hi.toLocaleString()} price range in this dataset.`);
    console.log(`  Price range in data: $${Math.min(...rows.map(r => r.price)).toFixed(0)} – $${Math.max(...rows.map(r => r.price)).toFixed(0)}`);
  }

  // ── 5. Modifier flip analysis ───────────────────────────────────────
  const flipped     = rows.filter(r => r.baseSignal !== r.enhSignal);
  const holdToSell  = flipped.filter(r => r.baseSignal === "hold" && r.enhSignal === "sell");
  const buyToHold   = flipped.filter(r => r.baseSignal === "buy"  && r.enhSignal === "hold");
  const buyToSell   = flipped.filter(r => r.baseSignal === "buy"  && r.enhSignal === "sell");

  console.log(`\n${hr}`);
  console.log("MODIFIER FLIP ANALYSIS");
  console.log(hr);
  console.log(`Total flipped bars: ${flipped.length} / ${rows.length} (${pct(flipped.length / rows.length)})`);
  console.log(`  hold → sell : ${holdToSell.length}`);
  console.log(`  buy  → hold : ${buyToHold.length}`);
  console.log(`  buy  → sell : ${buyToSell.length}`);

  if (holdToSell.length > 0) {
    const correctFlips = holdToSell.filter(r => r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD);
    console.log(`\n  hold→sell precision: ${correctFlips.length}/${holdToSell.length} = ${pct(correctFlips.length / holdToSell.length)}`);
    console.log("  First 12 hold→sell flips:");
    holdToSell.slice(0, 12).forEach(r => {
      const ret = r.next24hRet !== null ? pct(r.next24hRet) : "N/A";
      const ok  = r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD ? "✓" : "✗";
      console.log(`    ${ok} ${r.isoTime}  $${r.price.toFixed(0)}  24h:${ret.padStart(8)}  [${r.modifiers.join(", ")}]`);
    });
  }

  if (buyToHold.length > 0) {
    const avoidedLoss = buyToHold.filter(r => r.next24hRet !== null && r.next24hRet < DROP_THRESHOLD);
    console.log(`\n  buy→hold: avoided loss on ${avoidedLoss.length}/${buyToHold.length} flips`);
  }

  // ── 6. Modifier frequency breakdown ────────────────────────────────
  const modCount = new Map<string, number>();
  for (const r of rows) {
    for (const m of r.modifiers) {
      // Group by modifier type (strip values)
      const key = m.replace(/[=+\-\d.]+/g, "N");
      modCount.set(key, (modCount.get(key) ?? 0) + 1);
    }
  }
  if (modCount.size > 0) {
    console.log(`\n${hr}`);
    console.log("MODIFIER ACTIVATION FREQUENCY");
    console.log(hr);
    Array.from(modCount.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${pad(k, 45)} ${pad(v, 5, true)} bars  (${pct(v / rows.length)})`));
  }

  // ── 7. Save full results ────────────────────────────────────────────
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      highlightPrice: HIGHLIGHT_PRICE,
      dropThreshold: DROP_THRESHOLD,
      dataAvailability: avail,
    },
    stats: {
      baseline: {
        sells: baseSells.length, truePositives: baseTP.length,
        precision: basePrecision, recall: baseRecall, f1: baseF1,
      },
      enhanced: {
        sells: enhSells.length, truePositives: enhTP.length,
        precision: enhPrecision, recall: enhRecall, f1: enhF1,
      },
    },
    rows: rows.map(r => ({
      ts: r.ts, time: r.isoTime, price: r.price,
      base: r.baseSignal, enhanced: r.enhSignal,
      baseRawBuy: r.baseRawBuy, baseRawSell: r.baseRawSell,
      enhBuy: r.enhBuy, enhSell: r.enhSell,
      modifiers: r.modifiers,
      ext: r.ext,
      next24hRet: r.next24hRet,
    })),
  };

  const outPath = "./replay-results.json";
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nFull results saved → ${outPath}  (${rows.length} rows, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
  console.log(`\nDone.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
