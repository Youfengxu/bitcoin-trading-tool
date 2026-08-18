/**
 * Positioning & Flow Collector
 *
 * Records hourly derivatives positioning so a positioning-based signal can be
 * tested properly later. This exists because the data cannot be obtained
 * retroactively — verified 2026-08-16 across every source this project uses:
 *
 *   OKX      720 hourly rows   30 days   `end` param returns 0 rows beyond that
 *   Binance  500 hourly rows   21 days   rejects an old startTime (-1130)
 *   Bybit    200 hourly rows    8 days   (open interest); 500 rows / 21d (L/S)
 *
 * Exchanges simply discard derivatives statistics after roughly a month, which
 * is why paid aggregators exist. The first positioning backtest was therefore
 * forced onto DAILY bars — about 60 per regime window — and was inconclusive as
 * a result. Collecting forward at hourly resolution reaches ~2,000 bars per
 * currency within three months, which is enough to answer the question.
 *
 * ── Self-healing by construction ──────────────────────────────────────
 * Each run re-fetches OKX's entire 720-row window and inserts it, relying on the
 * (ccy, ts) unique constraint to discard what is already stored. Any gap left by
 * downtime, a failed run, or a redeploy is refilled automatically on the next
 * pass, with no cursor or gap-tracking logic to get wrong. It also means the
 * FIRST run backfills 30 days immediately rather than starting from zero.
 *
 * Failure is never fatal: this is a data-gathering side task and must not be
 * able to break signal generation.
 */

import * as okx from "./okxClient";
import * as db from "../db";

/**
 * OKX's statistics endpoints rate-limit aggressively and reply 429 rather than
 * degrading. A scan of 30 currencies without pacing returned five successes and
 * twenty-five 429s — which reads exactly like "these currencies have no data"
 * and is how the first survey wrongly concluded only 8 currencies were covered.
 * Every one of the 30 has full history when requests are paced.
 *
 * So: space out requests, and retry a 429 with backoff rather than treating an
 * empty result as an absence of data.
 */
const REQUEST_SPACING_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function paced<T>(fn: () => Promise<T>, fallback: T, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await fn();
      await sleep(REQUEST_SPACING_MS);
      return out;
    } catch (e) {
      const is429 = e instanceof Error && /429|Too Many Requests/i.test(e.message);
      if (!is429 && i === attempts - 1) break;
      await sleep(800 * (i + 1));
    }
  }
  return fallback;
}

/**
 * Currencies to record. OKX reports these statistics per-currency (aggregated
 * across that currency's contracts), not per-instrument.
 */
export function collectedCurrencies(): string[] {
  // Default list is chosen for REGIME DIVERSITY and low correlation, not for
  // volume. Hourly crypto returns across 20 assets were quoted at 0.449 — a figure
  // never derived in this repo. The 12-major value, derived by
  // scripts/effectiveSample.ts, is 0.663. Treat the 20-asset number as unverified. So the
  // effective independent sample is N/(1+(N-1)p) = 2.1 — and it asymptotes at
  // 1/p = 2.2 however many are added. Extra correlated majors buy almost
  // nothing; assets that move idiosyncratically buy the regime variety that a
  // 30-day window otherwise lacks. UNI, ZEC, WLD and HYPE each reversed
  // direction inside the current window.
  const raw = process.env.POSITIONING_CCYS ??
    "BTC,ETH,SOL,XRP,DOGE,LINK,AVAX,BNB,TRX,UNI,SUI,FIL,BCH,NEAR,ZEC,PEPE,WLD,HYPE,OKB,ETHFI";
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Truncates a timestamp to the start of its hour, so sources align on a key. */
function hourBucket(ts: number): number {
  return Math.floor(ts / 3600_000) * 3600_000;
}

export interface Row {
  ccy: string; ts: number;
  openInterestUsd?: number; volumeUsd?: number; longShortRatio?: number;
  takerBuyUsd?: number; takerSellUsd?: number; fundingRate?: number; price?: number;
}

/**
 * Builds the hourly rows for one currency by joining four independent series on
 * the hour bucket. A series that fails leaves its columns null rather than
 * dropping the row — partial data is still worth recording, and the signal can
 * decide later what it needs.
 */
export async function buildRows(ccy: string): Promise<Row[]> {
  const q = `ccy=${ccy}&period=1H`;
  // Sequential, not Promise.all: firing five requests at once is what trips the
  // rate limiter, and a 429 here silently produces a row with null columns.
  const oi = await paced(() => okx.publicGet<string[]>(`/api/v5/rubik/stat/contracts/open-interest-volume?${q}`), []);
  const ls = await paced(() => okx.publicGet<string[]>(`/api/v5/rubik/stat/contracts/long-short-account-ratio?${q}`), []);
  const tv = await paced(() => okx.publicGet<string[]>(`/api/v5/rubik/stat/taker-volume?${q}&instType=CONTRACTS`), []);
  const [candles, funding] = await Promise.all([
    // 750, not 300: the stats window is 720 hours, and price is what makes an
    // open-interest change readable (OI up + price up is crowding; OI up +
    // price down is new shorts). Under-fetching here left 420 of 720 rows with
    // positioning data and no price, which would have crippled the dataset.
    okx.fetchCandles("1h", 750, `${ccy}-USDT`).catch(() => []),
    fetchFunding(`${ccy}-USDT-SWAP`),
  ]);

  const byTs = new Map<number, Row>();
  const touch = (ts: number): Row => {
    const k = hourBucket(ts);
    let r = byTs.get(k);
    if (!r) { r = { ccy, ts: k }; byTs.set(k, r); }
    return r;
  };

  for (const r of oi) {
    const row = touch(parseInt(r[0]));
    row.openInterestUsd = parseFloat(r[1]);
    row.volumeUsd = parseFloat(r[2]);
  }
  for (const r of ls) touch(parseInt(r[0])).longShortRatio = parseFloat(r[1]);
  for (const r of tv) {
    const row = touch(parseInt(r[0]));
    row.takerSellUsd = parseFloat(r[1]);
    row.takerBuyUsd = parseFloat(r[2]);
  }
  for (const c of candles) {
    const row = byTs.get(hourBucket(c.openTime));
    if (row) row.price = c.close; // only annotate hours the stats already cover
  }
  // Funding settles every 8h; forward-fill it onto each hour in between.
  const sortedFunding = [...funding].sort((a, b) => a.ts - b.ts);
  for (const row of Array.from(byTs.values())) {
    let rate: number | undefined;
    for (const f of sortedFunding) { if (f.ts <= row.ts) rate = f.rate; else break; }
    row.fundingRate = rate;
  }

  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

async function fetchFunding(instId: string): Promise<Array<{ ts: number; rate: number }>> {
  const out: Array<{ ts: number; rate: number }> = [];
  let after: number | undefined;
  for (let page = 0; page < 3; page++) { // 300 settlements ≈ 100 days, ample for a 30-day window
    const q = new URLSearchParams({ instId, limit: "100" });
    if (after !== undefined) q.set("after", String(after));
    let rows: Array<{ fundingRate: string; fundingTime: string }> = [];
    try { rows = await okx.publicGet(`/api/v5/public/funding-rate-history?${q}`); } catch { break; }
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: parseInt(r.fundingTime), rate: parseFloat(r.fundingRate) });
    after = parseInt(rows[rows.length - 1].fundingTime);
  }
  return out;
}

/**
 * Collects one pass for every configured currency.
 *
 * Returns per-currency insert counts. Never throws: a data-gathering task must
 * not be able to take down signal generation.
 */
export async function collectPositioning(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const ccy of collectedCurrencies()) {
    try {
      const rows = await buildRows(ccy);
      if (!rows.length) { result[ccy] = 0; continue; }
      result[ccy] = await db.insertPositioningSnapshots(rows);
    } catch (e) {
      console.warn(`[Positioning] ${ccy} collection failed:`, e);
      result[ccy] = 0;
    }
  }
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const detail = Object.entries(result).filter(([, n]) => n > 0).map(([c, n]) => `${c}+${n}`).join(" ");
    console.log(`[Positioning] recorded ${total} new hourly rows (${detail})`);
  }
  return result;
}
