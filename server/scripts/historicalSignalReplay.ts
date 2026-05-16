/**
 * Historical Signal Replay
 *
 * Compares the baseline signal generator against an enhanced version that
 * incorporates external market signals:
 *   1. Perpetual funding rate (Bybit)        — crowded-long / smart-money-short detection
 *   2. Fear & Greed Index (alternative.me)   — sentiment extremes
 *   3. US 10Y Treasury yield velocity        — risk-off detection via rate of change
 *   4. Spot ETF netflow 7D SMA (SosoValue)   — institutional flow momentum (best-effort)
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
import { DEFAULT_STRATEGY_PARAMS } from "../../shared/tradingTypes";
import type { StrategyParameters } from "../../shared/tradingTypes";
import * as fs from "fs";

// ─── CLI Config ───────────────────────────────────────────────────────
const argDays  = process.argv.find(a => a.startsWith("--days="));
const argPrice = process.argv.find(a => a.startsWith("--price="));
const WINDOW_DAYS     = argDays  ? parseInt(argDays.slice(7))   : 90;
const HIGHLIGHT_PRICE = argPrice ? parseFloat(argPrice.slice(8)) : 82000;

const HIGHLIGHT_RANGE = 0.05;   // ±5% around highlight price for detail table
const DROP_THRESHOLD  = -0.02;  // -2% in 24h = a "drop" for precision/recall
const DAY_MS          = 24 * 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────
interface CandleRow {
  open: number; high: number; low: number;
  close: number; volume: number; openTime: number;
}

interface FundingRecord {
  ts:   number;  // ms — timestamp of the 8h settlement
  rate: number;  // e.g. 0.0001 = 0.01% per 8h period
}

interface YieldRecord {
  yield10y: number;  // e.g. 4.54 = 4.54%
  velocity: number;  // daily change in percentage points, e.g. 0.12 = 12bps
}

interface ExternalPoint {
  fundingRate:          number | null;
  fundingNegDivergence: boolean;       // rate flipped negative after sustained positive
  fearGreed:            number | null; // 0-100
  yieldVelocity:        number | null; // ppt/day, positive = yields rising
  etfNetflow7dSma:      number | null; // USD millions/day, negative = net outflows
}

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
  ext:          ExternalPoint;
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
async function fetchAllCandles(days: number): Promise<CandleRow[]> {
  console.log(`Fetching ${days} days of 1h candles from Kraken (720/page)...`);
  const pagesNeeded = Math.ceil(days / 30);
  const all: CandleRow[] = [];
  let nextSince = Date.now() - days * DAY_MS;

  for (let page = 0; page < pagesNeeded; page++) {
    const raw = await fetchCandlesFrom("1h", nextSince, 720);
    if (raw.length === 0) break;
    all.push(...raw.map(c => ({
      open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, openTime: c.openTime,
    })));
    nextSince = raw[raw.length - 1].openTime + 1;
    const last = new Date(raw[raw.length - 1].openTime).toISOString().slice(0, 13);
    console.log(`  Page ${page + 1}: ${raw.length} candles → ${last}`);
    if (page < pagesNeeded - 1) await sleep(800); // avoid rate limiting
  }

  // Deduplicate and sort ascending
  const seen = new Set<number>();
  const deduped = all
    .filter(c => { if (seen.has(c.openTime)) return false; seen.add(c.openTime); return true; })
    .sort((a, b) => a.openTime - b.openTime);

  const from = new Date(deduped[0].openTime).toISOString().slice(0, 10);
  const to   = new Date(deduped[deduped.length - 1].openTime).toISOString().slice(0, 10);
  console.log(`  Total: ${deduped.length} candles (${from} → ${to})`);
  return deduped;
}

// ─── Bybit Funding Rate ───────────────────────────────────────────────
async function fetchFundingRates(days: number): Promise<FundingRecord[]> {
  console.log("Fetching perpetual funding rates from Bybit...");
  const now      = Date.now();
  const midpoint = now - Math.floor(days / 2) * DAY_MS;
  const start    = now - days * DAY_MS;
  const records: FundingRecord[] = [];

  try {
    // Split into two calls to stay within the 200-record page limit
    // 90 days × 3 records/day = 270 records → 2 pages of ≤200 each
    const calls = [
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200&startTime=${start}&endTime=${midpoint}`,
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200&startTime=${midpoint}&endTime=${now}`,
    ];

    for (const url of calls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Bybit ${res.status}`);
      const data = await res.json() as {
        retCode: number;
        result: { list: Array<{ fundingRate: string; fundingRateTimestamp: string }> };
      };
      if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}`);
      for (const item of data.result.list) {
        records.push({
          ts:   parseInt(item.fundingRateTimestamp),
          rate: parseFloat(item.fundingRate),
        });
      }
    }

    records.sort((a, b) => a.ts - b.ts);
    console.log(`  Got ${records.length} funding records (every 8h)`);
    return records;
  } catch (e) {
    console.warn(`  ⚠ Funding rate fetch failed: ${e}. Continuing without.`);
    return [];
  }
}

// ─── Fear & Greed (alternative.me) ───────────────────────────────────
async function fetchFearGreed(days: number): Promise<Map<string, number>> {
  console.log("Fetching Fear & Greed index from alternative.me...");
  const result = new Map<string, number>();
  try {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${days + 5}`);
    if (!res.ok) throw new Error(`alternative.me ${res.status}`);
    const data = await res.json() as {
      data: Array<{ value: string; timestamp: string }>;
    };
    for (const item of data.data) {
      const date = new Date(parseInt(item.timestamp) * 1000).toISOString().slice(0, 10);
      result.set(date, parseInt(item.value));
    }
    console.log(`  Got ${result.size} daily Fear & Greed records`);
  } catch (e) {
    console.warn(`  ⚠ Fear & Greed fetch failed: ${e}. Continuing without.`);
  }
  return result;
}

// ─── US 10Y Yield (Yahoo Finance direct) ─────────────────────────────
async function fetchYield10y(): Promise<Map<string, YieldRecord>> {
  console.log("Fetching US 10Y Treasury yield from Yahoo Finance...");
  const result = new Map<string, YieldRecord>();
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=6mo",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-backtest/1.0)" } }
    );
    if (!res.ok) throw new Error(`Yahoo US10Y ${res.status}`);
    const data = await res.json() as {
      chart: {
        result?: Array<{
          timestamp: number[];
          indicators: { quote: Array<{ close: (number | null)[] }> };
        }>;
      };
    };
    const chart = data.chart.result?.[0];
    if (!chart) throw new Error("No chart result");
    const { timestamp, indicators } = chart;
    const closes = indicators.quote[0]?.close ?? [];

    for (let i = 0; i < timestamp.length; i++) {
      const yv = closes[i];
      if (!yv || isNaN(yv)) continue;
      const date  = new Date(timestamp[i] * 1000).toISOString().slice(0, 10);
      const prev  = i > 0 ? (closes[i - 1] ?? yv) : yv;
      result.set(date, { yield10y: yv, velocity: yv - prev });
    }
    console.log(`  Got ${result.size} daily yield records`);
  } catch (e) {
    console.warn(`  ⚠ US10Y yield fetch failed: ${e}. Continuing without.`);
  }
  return result;
}

// ─── Spot ETF Netflow (SosoValue, best-effort) ────────────────────────
async function fetchEtfNetflow(): Promise<Map<string, number>> {
  console.log("Fetching BTC spot ETF netflow from SosoValue (best-effort)...");
  const result = new Map<string, number>();

  // Try several known/guessed SosoValue endpoints — the API path changes without notice.
  // If all fail, ETF signal is simply absent from this run.
  const endpoints = [
    "https://sosovalue.com/api/en-us/bitcoin-etf/net-flow",
    "https://sosovalue.com/api/en-us/bitcoin-spot-etf/net-flow",
    "https://sosovalue.xyz/api/fund/bitcoin-etf-net-flow-all-data",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const raw = await res.json() as unknown;
      // Normalise — SosoValue response shape varies across API versions
      const arr: unknown[] = Array.isArray(raw) ? raw
        : Array.isArray((raw as Record<string, unknown>)?.data)   ? (raw as Record<string, unknown[]>).data
        : Array.isArray((raw as Record<string, unknown>)?.result) ? (raw as Record<string, unknown[]>).result
        : [];
      if (arr.length === 0) continue;

      for (const item of arr) {
        const obj  = item as Record<string, unknown>;
        const date = String(obj.date ?? obj.day ?? obj.time ?? "").slice(0, 10);
        const flow = obj.flow ?? obj.netFlow ?? obj.net_flow ?? obj.value;
        if (date.length === 10 && flow !== undefined) {
          result.set(date, parseFloat(String(flow)));
        }
      }
      if (result.size > 0) {
        console.log(`  Got ${result.size} daily ETF netflow records from ${url}`);
        break;
      }
    } catch (_) { /* try next */ }
  }

  if (result.size === 0) {
    console.warn("  ⚠ ETF netflow unavailable from all tried endpoints. Continuing without.");
  }
  return result;
}

// ─── External Data Alignment ──────────────────────────────────────────
function getExternalAt(
  ts: number,
  funding:   FundingRecord[],
  fearGreed: Map<string, number>,
  yields:    Map<string, YieldRecord>,
  etf:       Map<string, number>,
): ExternalPoint {
  const date = new Date(ts).toISOString().slice(0, 10);

  // Funding: most recent record at or before ts (forward-fill from 8h settlements)
  let fundingRate: number | null = null;
  for (const r of funding) {
    if (r.ts <= ts) fundingRate = r.rate;
    else break;
  }

  // Negative divergence: rate is now < -0.02%/8h after being positive in the prior 8h window
  let fundingNegDivergence = false;
  if (fundingRate !== null && fundingRate < -0.0002) {
    let prevRate: number | null = null;
    for (const r of funding) {
      if (r.ts < ts - 8 * 3600000) prevRate = r.rate;
      else break;
    }
    if (prevRate !== null && prevRate > 0) fundingNegDivergence = true;
  }

  // Fear & Greed: look up by date (daily)
  const fearGreedVal = fearGreed.get(date) ?? null;

  // Yield velocity: look up by date (daily)
  const yieldRec = yields.get(date) ?? null;
  const yieldVelocity = yieldRec?.velocity ?? null;

  // ETF netflow 7D SMA: average of the last 7 available daily values
  let etfNetflow7dSma: number | null = null;
  if (etf.size > 0) {
    const window: number[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(ts - d * DAY_MS).toISOString().slice(0, 10);
      const v = etf.get(day);
      if (v !== undefined) window.push(v);
    }
    if (window.length >= 3) {
      etfNetflow7dSma = window.reduce((a, b) => a + b, 0) / window.length;
    }
  }

  return { fundingRate, fundingNegDivergence, fearGreed: fearGreedVal, yieldVelocity, etfNetflow7dSma };
}

// ─── Signal Modifier ──────────────────────────────────────────────────
/**
 * Adjusts raw buy/sell scores based on external market signals.
 *
 * Modifier design principles:
 *   - Modifiers are multiplicative on the raw scores, consistent with how the
 *     existing CUSUM (×1.2) and volume (×1.15) boosts work in the signal generator.
 *   - They amplify a directional lean already present in the indicators; they
 *     cannot manufacture a signal from a perfectly neutral indicator reading.
 *   - Thresholds are first-principles values, not fitted to this dataset.
 */
function applyModifiers(
  rawBuy:  number,
  rawSell: number,
  ext:     ExternalPoint,
): { modBuy: number; modSell: number; mods: string[] } {
  let mBuy  = rawBuy;
  let mSell = rawSell;
  const mods: string[] = [];

  // 1. Funding rate — positive (overcrowded longs): sell bias
  if (ext.fundingRate !== null) {
    if (ext.fundingRate > 0.001) {           // >0.10%/8h — extreme long crowding
      mSell *= 1.25;
      mBuy  *= 0.85;
      mods.push(`fund=+${(ext.fundingRate * 100).toFixed(3)}%/8h[extreme×1.25]`);
    } else if (ext.fundingRate > 0.0005) {   // >0.05%/8h — elevated long bias
      mSell *= 1.10;
      mods.push(`fund=+${(ext.fundingRate * 100).toFixed(3)}%/8h[long×1.10]`);
    }
  }

  // 2. Negative funding divergence — rate flipped negative: smart money building shorts
  if (ext.fundingNegDivergence) {
    mSell *= 1.15;
    mods.push(`fund-flip-neg[smart-short×1.15]`);
  }

  // 3. Fear & Greed — extreme readings
  if (ext.fearGreed !== null) {
    if (ext.fearGreed >= 80) {   // Extreme Greed — historically precedes corrections
      mBuy  *= 0.80;
      mSell *= 1.10;
      mods.push(`F&G=${ext.fearGreed}[greed buy×0.80 sell×1.10]`);
    } else if (ext.fearGreed <= 20) {   // Extreme Fear — better buy zone
      mSell *= 0.85;
      mods.push(`F&G=${ext.fearGreed}[fear sell×0.85]`);
    }
  }

  // 4. Yield velocity — sharp yield spike = capital rotation out of risk assets
  if (ext.yieldVelocity !== null) {
    if (ext.yieldVelocity > 0.15) {     // >15bps/day — significant risk-off
      mSell *= 1.15;
      mBuy  *= 0.90;
      mods.push(`US10Y+${ext.yieldVelocity.toFixed(2)}bps[risk-off×1.15]`);
    } else if (ext.yieldVelocity > 0.08) {  // >8bps/day — moderate risk-off
      mSell *= 1.08;
      mods.push(`US10Y+${ext.yieldVelocity.toFixed(2)}bps[risk-off×1.08]`);
    }
  }

  // 5. ETF netflow 7D SMA — sustained institutional outflows
  if (ext.etfNetflow7dSma !== null) {
    if (ext.etfNetflow7dSma < -300) {    // >$300M/day net outflow — heavy exit
      mSell *= 1.20;
      mods.push(`ETF=${ext.etfNetflow7dSma.toFixed(0)}M/d[inst-exit×1.20]`);
    } else if (ext.etfNetflow7dSma < -100) {   // >$100M/day — moderate exit
      mSell *= 1.10;
      mods.push(`ETF=${ext.etfNetflow7dSma.toFixed(0)}M/d[inst-exit×1.10]`);
    }
  }

  return { modBuy: mBuy, modSell: mSell, mods };
}

// ─── Re-evaluate Signal from Raw Scores ──────────────────────────────
function signalFromScores(
  buy: number,
  sell: number,
  minConf: number,
): { signal: "buy" | "sell" | "hold"; confidence: number } {
  if (buy > sell && buy >= minConf) {
    return { signal: "buy", confidence: Math.min(1, buy) };
  } else if (sell > buy && sell >= minConf) {
    return { signal: "sell", confidence: Math.min(1, sell) };
  } else {
    return { signal: "hold", confidence: 1 - Math.max(buy, sell) };
  }
}

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
  const [candles, funding, fearGreed, yields, etfFlows] = await Promise.all([
    fetchAllCandles(WINDOW_DAYS),
    fetchFundingRates(WINDOW_DAYS),
    fetchFearGreed(WINDOW_DAYS),
    fetchYield10y(),
    fetchEtfNetflow(),
  ]);

  const avail = {
    candles:   candles.length,
    funding:   funding.length > 0   ? `${funding.length} records ✓`  : "⚠ missing",
    fearGreed: fearGreed.size > 0   ? `${fearGreed.size} days ✓`     : "⚠ missing",
    yields:    yields.size > 0      ? `${yields.size} days ✓`        : "⚠ missing",
    etf:       etfFlows.size > 0    ? `${etfFlows.size} days ✓`      : "⚠ missing (optional)",
  };
  console.log(`\nData availability:`);
  console.log(`  Candles:       ${avail.candles}`);
  console.log(`  Funding rates: ${avail.funding}`);
  console.log(`  Fear & Greed:  ${avail.fearGreed}`);
  console.log(`  US10Y yield:   ${avail.yields}`);
  console.log(`  ETF netflow:   ${avail.etf}`);

  const params: StrategyParameters = DEFAULT_STRATEGY_PARAMS;
  const rows: ReplayRow[] = [];

  // ── 2. Replay bar by bar ────────────────────────────────────────────
  console.log("\nReplaying signals (this takes ~30-60s for 90 days)...");
  const startIdx = Math.min(200, candles.length - 1);

  for (let i = startIdx; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const cur    = candles[i];

    const metrics = computeAllMetrics(window, params.zScoreTrendThreshold, params.zScoreBlipThreshold);
    const base    = generateSignal(metrics, params);
    const ext     = getExternalAt(cur.openTime, funding, fearGreed, yields, etfFlows);

    const { modBuy, modSell, mods } = applyModifiers(base.rawBuyScore, base.rawSellScore, ext);
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
