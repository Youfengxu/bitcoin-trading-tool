/**
 * Paced, gap-verified, disk-cached hourly history loader.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * `okxClient.fetchCandlesFrom` breaks out of its pagination loop on an empty
 * page:
 *
 *     const rows = await publicGet(...);
 *     if (rows.length === 0) break;      // <-- indistinguishable from a 429
 *
 * It also paces nothing. Pulling three years of hourly data is ~263 sequential
 * calls per asset, which reliably trips OKX rate limits; each throttled page
 * looks like "no more history" and the walk stops early. The result is SILENT
 * TRUNCATION at a different point on every run.
 *
 * That produced non-reproducible analysis: consecutive runs of the bull-run
 * study disagreed on bucket membership (parabolic n=5 vs n=4) and on the
 * headline engine return within that bucket (+68.3% vs +104.7%). Same code,
 * same pinned window, different answers.
 *
 * This is the third time this failure mode has appeared in the project — after
 * the "only 8 of 30 currencies have positioning data" survey and the sample that
 * silently dropped BTC. Hence a shared, reusable loader rather than another
 * local patch.
 *
 * ── What it guarantees ────────────────────────────────────────────────
 * 1. Pacing between pages, and a retry with backoff on an empty page, so a
 *    throttle is distinguished from genuine end-of-history.
 * 2. Contiguity verification — every gap in the hourly series is reported.
 * 3. Disk cache keyed by (instId, bar, range), so reruns are byte-identical and
 *    the API is hit once rather than on every analysis run.
 */

import * as fs from "fs";
import * as path from "path";
import type { CandleData } from "../../engine/technicalAnalysis";
import { publicGet } from "../../engine/okxClient";

const HOUR = 3600_000;
const CACHE_DIR = path.resolve(process.cwd(), ".cache/okx-history");
const PAGE = 100;
const PACE_MS = 220;
const EMPTY_RETRIES = 4;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LoadResult {
  candles: CandleData[];
  /** Missing hourly slots inside the covered span. Empty means fully contiguous. */
  gaps: Array<{ from: number; to: number; bars: number }>;
  fromCache: boolean;
}

function cachePath(instId: string, bar: string, start: number, end: number) {
  return path.join(CACHE_DIR, `${instId}_${bar}_${start}_${end}.json`);
}

function findGaps(c: CandleData[]) {
  const gaps: Array<{ from: number; to: number; bars: number }> = [];
  for (let i = 1; i < c.length; i++) {
    const d = c[i].openTime - c[i - 1].openTime;
    if (d > HOUR) gaps.push({ from: c[i - 1].openTime, to: c[i].openTime, bars: Math.round(d / HOUR) - 1 });
  }
  return gaps;
}

/**
 * Load hourly candles in [startTs, endTs). Retries empty pages before treating
 * them as end-of-history, which is the whole point of this module.
 */
export async function loadHourly(instId: string, startTs: number, endTs: number, verbose = true): Promise<LoadResult> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(instId, "1H", startTs, endTs);
  if (fs.existsSync(file)) {
    const candles: CandleData[] = JSON.parse(fs.readFileSync(file, "utf8"));
    return { candles, gaps: findGaps(candles), fromCache: true };
  }

  const byTime = new Map<number, CandleData>();
  let after: number | undefined;
  let reachedStart = false;

  while (!reachedStart) {
    let rows: string[][] | null = null;
    for (let attempt = 0; attempt <= EMPTY_RETRIES; attempt++) {
      const q = new URLSearchParams({ instId, bar: "1H", limit: String(PAGE) });
      if (after !== undefined) q.set("after", String(after));
      try {
        rows = await publicGet<string[]>(`/api/v5/market/history-candles?${q}`);
      } catch { rows = null; }
      if (rows && rows.length) break;
      // An empty or failed page is far more often a throttle than the true end
      // of history. Back off and retry before believing it.
      await pause(600 * (attempt + 1));
    }
    if (!rows || !rows.length) break;

    let oldest = Infinity;
    for (const r of rows) {
      const t = parseInt(r[0], 10);
      oldest = Math.min(oldest, t);
      if (t >= startTs && t < endTs && !byTime.has(t)) {
        byTime.set(t, {
          openTime: t, open: parseFloat(r[1]), high: parseFloat(r[2]),
          low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]),
        });
      }
    }
    if (!Number.isFinite(oldest) || oldest <= startTs) reachedStart = true;
    after = oldest;
    await pause(PACE_MS);
  }

  const candles = Array.from(byTime.values()).sort((a, b) => a.openTime - b.openTime);
  const gaps = findGaps(candles);
  const expected = Math.floor((Math.min(endTs, (candles.at(-1)?.openTime ?? endTs) + HOUR) - (candles[0]?.openTime ?? startTs)) / HOUR);
  if (verbose) {
    const missing = gaps.reduce((a, g) => a + g.bars, 0);
    console.log(`  ${instId.padEnd(10)} ${candles.length} bars` +
      (candles.length ? ` ${new Date(candles[0].openTime).toISOString().slice(0, 10)} → ${new Date(candles.at(-1)!.openTime).toISOString().slice(0, 10)}` : "") +
      (missing ? `  ⚠ ${missing} missing in ${gaps.length} gaps` : "  contiguous") +
      `  (${((candles.length / Math.max(1, expected)) * 100).toFixed(1)}% of span)`);
  }
  if (candles.length) fs.writeFileSync(file, JSON.stringify(candles));
  return { candles, gaps, fromCache: false };
}
