/**
 * Historical External Signal Data
 *
 * Fetches and aligns the external market data streams that
 * engine/externalModifiers.ts consumes, for any historical window:
 *
 *   1. Perpetual funding rate (Bybit)        — crowded-long / smart-money-short
 *   2. Fear & Greed Index (alternative.me)   — sentiment extremes
 *   3. US 10Y Treasury yield velocity        — risk-off detection
 *   4. Spot ETF netflow 7D SMA (SosoValue)   — institutional flow (best-effort)
 *   5. IBIT 7D signed-flow proxy (Yahoo Fin) — ETF demand proxy
 *
 * Shared by server/scripts/historicalSignalReplay.ts (signal-level precision study)
 * and server/scripts/strategyBacktest.ts (portfolio-level equity backtest) so both
 * see identical external context.
 *
 * Every fetcher fails soft: an unreachable feed yields an empty map and the
 * corresponding modifier simply never fires, matching production behaviour in
 * heartbeatHandler.fetchExternalSignals().
 */

import type { ExternalSignals } from "../engine/externalModifiers";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FundingRecord {
  /** ms — timestamp of the 8h settlement */
  ts: number;
  /** e.g. 0.0001 = 0.01% per 8h period */
  rate: number;
}

export interface YieldRecord {
  /** e.g. 4.54 = 4.54% */
  yield10y: number;
  /** daily change in percentage points, e.g. 0.12 = 12bps */
  velocity: number;
}

/** All external streams for a window, ready for getExternalAt(). */
export interface ExternalHistory {
  funding: FundingRecord[];
  fearGreed: Map<string, number>;
  yields: Map<string, YieldRecord>;
  etfFlows: Map<string, number>;
  ibitFlows: Map<string, number>;
}

// ─── Bybit Funding Rate ───────────────────────────────────────────────
export async function fetchFundingRates(days: number): Promise<FundingRecord[]> {
  const now = Date.now();
  const midpoint = now - Math.floor(days / 2) * DAY_MS;
  const start = now - days * DAY_MS;
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
      const data = (await res.json()) as {
        retCode: number;
        result: { list: Array<{ fundingRate: string; fundingRateTimestamp: string }> };
      };
      if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode}`);
      for (const item of data.result.list) {
        records.push({
          ts: parseInt(item.fundingRateTimestamp),
          rate: parseFloat(item.fundingRate),
        });
      }
    }

    records.sort((a, b) => a.ts - b.ts);
    return records;
  } catch (e) {
    console.warn(`  ⚠ Funding rate fetch failed: ${e}. Continuing without.`);
    return [];
  }
}

// ─── Fear & Greed (alternative.me) ───────────────────────────────────
export async function fetchFearGreed(days: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${days + 5}`);
    if (!res.ok) throw new Error(`alternative.me ${res.status}`);
    const data = (await res.json()) as { data: Array<{ value: string; timestamp: string }> };
    for (const item of data.data) {
      const date = new Date(parseInt(item.timestamp) * 1000).toISOString().slice(0, 10);
      result.set(date, parseInt(item.value));
    }
  } catch (e) {
    console.warn(`  ⚠ Fear & Greed fetch failed: ${e}. Continuing without.`);
  }
  return result;
}

// ─── US 10Y Yield (Yahoo Finance direct) ─────────────────────────────
export async function fetchYield10y(): Promise<Map<string, YieldRecord>> {
  const result = new Map<string, YieldRecord>();
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=6mo",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-backtest/1.0)" } }
    );
    if (!res.ok) throw new Error(`Yahoo US10Y ${res.status}`);
    const data = (await res.json()) as {
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
      const date = new Date(timestamp[i] * 1000).toISOString().slice(0, 10);
      const prev = i > 0 ? closes[i - 1] ?? yv : yv;
      result.set(date, { yield10y: yv, velocity: yv - prev });
    }
  } catch (e) {
    console.warn(`  ⚠ US10Y yield fetch failed: ${e}. Continuing without.`);
  }
  return result;
}

// ─── Spot ETF Netflow (SosoValue, best-effort) ────────────────────────
export async function fetchEtfNetflow(): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  // Try several known/guessed SosoValue endpoints — the API path changes without notice.
  // If all fail, ETF signal is simply absent; the IBIT volume proxy covers it.
  const endpoints = [
    "https://sosovalue.com/api/en-us/bitcoin-etf/net-flow",
    "https://sosovalue.com/api/en-us/bitcoin-spot-etf/net-flow",
    "https://sosovalue.xyz/api/fund/bitcoin-etf-net-flow-all-data",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown;
      const arr: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as Record<string, unknown>)?.data)
        ? (raw as Record<string, unknown[]>).data
        : Array.isArray((raw as Record<string, unknown>)?.result)
        ? (raw as Record<string, unknown[]>).result
        : [];
      if (arr.length === 0) continue;

      for (const item of arr) {
        const obj = item as Record<string, unknown>;
        const date = String(obj.date ?? obj.day ?? obj.time ?? "").slice(0, 10);
        const flow = obj.flow ?? obj.netFlow ?? obj.net_flow ?? obj.value;
        if (date.length === 10 && flow !== undefined) {
          result.set(date, parseFloat(String(flow)));
        }
      }
      if (result.size > 0) break;
    } catch {
      /* try next endpoint */
    }
  }

  return result;
}

// ─── IBIT Signed-Flow Proxy ───────────────────────────────────────────
/**
 * Computes the IBIT 7-day rolling signed-flow proxy for each trading date.
 *
 * signed_flow_day = sign(IBIT daily return) × IBIT dollar volume ($M)
 * ibitFlow7d[date] = sum of signed_flow over the 7 trading days up to and including date
 *
 * Positive = net institutional demand; negative = net selling. Direction tracks
 * Farside-reported flows; magnitude is ~5× larger because full dollar volume
 * (not just net creation/redemption) is used.
 */
export async function fetchIbitSignedFlowProxy(days: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    // Fetch extra history so the first window has 7 complete prior days
    const rangeParam = days <= 60 ? "2mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : "1y";
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/IBIT?interval=1d&range=${rangeParam}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-backtest/1.0)" } }
    );
    if (!res.ok) throw new Error(`IBIT HTTP ${res.status}`);
    const data = (await res.json()) as {
      chart: {
        result?: Array<{
          timestamp: number[];
          indicators: { quote: Array<{ close: (number | null)[]; volume: (number | null)[] }> };
        }>;
      };
    };
    const chart = data.chart.result?.[0];
    if (!chart) throw new Error("No IBIT chart result");

    const { timestamp, indicators } = chart;
    const q = indicators.quote[0];

    const daily: { date: string; signedFlow: number }[] = [];
    for (let i = 1; i < timestamp.length; i++) {
      const c = q.close[i];
      const cp = q.close[i - 1];
      const v = q.volume[i];
      if (!c || !cp || !v) continue;
      const ret = (c - cp) / cp;
      daily.push({
        date: new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        signedFlow: (Math.sign(ret) * (c * v)) / 1e6, // $M
      });
    }

    for (let i = 6; i < daily.length; i++) {
      const sum7 = daily.slice(i - 6, i + 1).reduce((a, b) => a + b.signedFlow, 0);
      result.set(daily[i].date, sum7);
    }
  } catch (e) {
    console.warn(`  ⚠ IBIT signed-flow fetch failed: ${e}. ETF demand signal will be absent.`);
  }
  return result;
}

// ─── Bulk Fetch ───────────────────────────────────────────────────────
/** Fetches every external stream for a window in parallel. */
export async function fetchExternalHistory(days: number): Promise<ExternalHistory> {
  const [funding, fearGreed, yields, etfFlows, ibitFlows] = await Promise.all([
    fetchFundingRates(days),
    fetchFearGreed(days),
    fetchYield10y(),
    fetchEtfNetflow(),
    fetchIbitSignedFlowProxy(days),
  ]);
  return { funding, fearGreed, yields, etfFlows, ibitFlows };
}

/** One-line-per-feed availability report for script headers. */
export function availabilityReport(h: ExternalHistory): Record<string, string> {
  return {
    funding: h.funding.length > 0 ? `${h.funding.length} records ✓` : "⚠ missing",
    fearGreed: h.fearGreed.size > 0 ? `${h.fearGreed.size} days ✓` : "⚠ missing",
    yields: h.yields.size > 0 ? `${h.yields.size} days ✓` : "⚠ missing",
    etf: h.etfFlows.size > 0 ? `${h.etfFlows.size} days ✓` : "⚠ missing (optional)",
    ibit: h.ibitFlows.size > 0 ? `${h.ibitFlows.size} days ✓ (signed-flow proxy)` : "⚠ missing",
  };
}

// ─── External Data Alignment ──────────────────────────────────────────
/**
 * Aligns external data streams to a specific hourly bar timestamp.
 *
 * @param ts              Bar open time (ms)
 * @param h               All external streams for the window
 * @param currentPrice    Close price of the bar — used for funding divergence near-high filter
 * @param rollingHigh14d  Max close over 14 days — funding divergence only fires within 5% of this
 */
export function getExternalAt(
  ts: number,
  h: ExternalHistory,
  currentPrice: number,
  rollingHigh14d: number
): ExternalSignals {
  const { funding, fearGreed, yields, etfFlows, ibitFlows } = h;
  const date = new Date(ts).toISOString().slice(0, 10);

  // Funding: forward-fill from 8h settlement records
  let fundingRate: number | null = null;
  for (const r of funding) {
    if (r.ts <= ts) fundingRate = r.rate;
    else break;
  }

  // Funding negative divergence: rate flipped below -0.003%/8h after being positive,
  // and price is within 5% of the 14-day rolling high (near resistance).
  let fundingNegDivergence = false;
  if (fundingRate !== null && fundingRate < -0.00003) {
    if (currentPrice >= rollingHigh14d * 0.95) {
      let prevRate: number | null = null;
      for (const r of funding) {
        if (r.ts < ts - 8 * 3600000) prevRate = r.rate;
        else break;
      }
      if (prevRate !== null && prevRate > 0) fundingNegDivergence = true;
    }
  }

  const fearGreedVal = fearGreed.get(date) ?? null;

  const yieldRec = yields.get(date) ?? null;
  const yieldVelocity = yieldRec?.velocity ?? null;

  // ETF netflow 7D SMA (SosoValue — best-effort, usually null)
  let etfNetflow7dSma: number | null = null;
  if (etfFlows.size > 0) {
    const window: number[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(ts - d * DAY_MS).toISOString().slice(0, 10);
      const v = etfFlows.get(day);
      if (v !== undefined) window.push(v);
    }
    if (window.length >= 3) {
      etfNetflow7dSma = window.reduce((a, b) => a + b, 0) / window.length;
    }
  }

  // IBIT signed-flow proxy: forward-fill (weekends/holidays use prior trading day)
  let ibitFlow7d: number | null = null;
  for (let d = 0; d < 5; d++) {
    const day = new Date(ts - d * DAY_MS).toISOString().slice(0, 10);
    const v = ibitFlows.get(day);
    if (v !== undefined) {
      ibitFlow7d = v;
      break;
    }
  }

  return { fundingRate, fundingNegDivergence, fearGreed: fearGreedVal, yieldVelocity, etfNetflow7dSma, ibitFlow7d };
}
