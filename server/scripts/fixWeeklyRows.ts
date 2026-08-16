/**
 * One-off repair of `weekly_performance`: de-duplicate, then recompute each
 * week's return from the equity curve.
 *
 * ── Two bugs wrote these rows ─────────────────────────────────────────
 *
 * 1. WRONG QUANTITY. generateWeeklyReport used `seedAmountUsd` as the week's
 *    opening value, so `returnPct` held the CUMULATIVE return since inception in
 *    a column every consumer reads as the week's return. All rows were negative
 *    simply because the book has been down since inception, and the Performance
 *    page's Sharpe was computed from them.
 *
 * 2. DUPLICATES. The "run once a week" marker lived in memory, so every process
 *    restart re-fired the report. Eight rows for 2026-W33 were written by eight
 *    deploys in one afternoon.
 *
 * Both are fixed at source. This repairs what was already written.
 *
 * ── Method ────────────────────────────────────────────────────────────
 * Rows are grouped by ISO week and all but one per week deleted, keeping the row
 * whose window is longest (the earliest start / latest end), since a report
 * re-fired minutes later covers a near-identical window and carries no extra
 * information. Each survivor's startValue/endValue are then re-read from the
 * reconstructed equity curve and returnPct recomputed from them.
 *
 * A row whose window the curve does not cover is LEFT ALONE and reported, not
 * silently guessed at — the price history only reaches back so far, and
 * fabricating a value would be worse than an honest gap.
 *
 * `btcBuyHoldReturnPct` is not touched: it was computed from 8 daily candles as
 * a genuine 7-day price return, which was always correct.
 *
 * Usage:
 *   docker compose --profile tools run --rm tools pnpm tsx server/scripts/fixWeeklyRows.ts --dry
 */

import * as db from "../db";
import { reconstructEquity, type EquityPoint } from "../engine/equityCurve";
import { utcWeekKey } from "../heartbeatHandler";

const DRY = process.argv.includes("--dry");

/** Equity at or immediately before `ts`, or null when the curve starts later. */
function valueAt(curve: EquityPoint[], ts: number): number | null {
  let best: EquityPoint | null = null;
  for (const p of curve) {
    if (p.ts <= ts) best = p;
    else break;
  }
  return best?.value ?? null;
}

async function main() {
  const rows = await db.getWeeklyPerformance(500);
  if (!rows.length) { console.log("no weekly rows"); return; }
  console.log(`${rows.length} weekly rows\n`);

  const state = await db.getSimulatorState(db.INTERNAL_VENUE);
  const trades = await db.getRecentTrades(5000, db.INTERNAL_VENUE);
  const prices = (await db.getRecentMetrics(20000)).map((m) => ({ ts: m.ts, price: m.price }));
  const curve = reconstructEquity(
    trades.map((t) => ({ ts: t.ts, cashAfter: t.cashAfter, btcAfter: t.btcAfter })),
    prices,
    state
      ? {
          cashUsd: state.cashUsd, btcHolding: state.btcHolding,
          price: state.lastPrice ?? prices[prices.length - 1]?.price ?? 0,
          ts: Date.now(),
        }
      : undefined,
  );
  if (curve.length < 2) { console.log("equity curve too short to repair anything"); return; }
  console.log(
    `equity curve: ${curve.length} points, ` +
    `${new Date(curve[0].ts).toISOString().slice(0, 10)} → ${new Date(curve[curve.length - 1].ts).toISOString().slice(0, 10)}\n`
  );

  // ── 1. De-duplicate by ISO week ─────────────────────────────────────
  const byWeek = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = utcWeekKey(new Date(r.weekEnd));
    byWeek.set(k, [...(byWeek.get(k) ?? []), r]);
  }

  const keep: typeof rows = [];
  const drop: typeof rows = [];
  for (const [week, group] of Array.from(byWeek.entries())) {
    // Longest window wins; ties keep the newest id, which has the latest data.
    const sorted = [...group].sort(
      (a, b) => (b.weekEnd - b.weekStart) - (a.weekEnd - a.weekStart) || b.id - a.id
    );
    keep.push(sorted[0]);
    drop.push(...sorted.slice(1));
    if (group.length > 1) {
      console.log(`  ${week}  ${group.length} rows → keeping id ${sorted[0].id}, deleting ${sorted.slice(1).map((r) => r.id).join(", ")}`);
    }
  }
  console.log(`\nde-duplication: keep ${keep.length}, delete ${drop.length}\n`);

  // ── 2. Recompute the survivors ──────────────────────────────────────
  console.log("week      window                    startValue        returnPct");
  console.log("─".repeat(78));
  let fixed = 0, skipped = 0;
  for (const r of keep.sort((a, b) => a.weekEnd - b.weekEnd)) {
    const week = utcWeekKey(new Date(r.weekEnd));
    const start = valueAt(curve, r.weekStart);
    const end = valueAt(curve, r.weekEnd) ?? state?.totalValueUsd ?? null;

    if (start === null || end === null || start <= 0) {
      console.log(`${week}  ${new Date(r.weekStart).toISOString().slice(5, 10)}→${new Date(r.weekEnd).toISOString().slice(5, 10)}  ` +
                  `curve does not cover this window — LEFT ALONE`);
      skipped++;
      continue;
    }

    const ret = ((end - start) / start) * 100;
    console.log(
      `${week}  ${new Date(r.weekStart).toISOString().slice(5, 10)}→${new Date(r.weekEnd).toISOString().slice(5, 10)}  ` +
      `$${r.startValue.toFixed(0)} → $${start.toFixed(0)}   ` +
      `${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(2)}% → ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`
    );
    if (!DRY) await db.updateWeeklyPerformance(r.id, { startValue: start, endValue: end, returnPct: ret });
    fixed++;
  }

  if (!DRY) {
    for (const r of drop) await db.deleteWeeklyPerformance(r.id);
  }

  console.log("─".repeat(78));
  console.log(`${fixed} recomputed, ${skipped} left alone, ${drop.length} duplicates ${DRY ? "would be " : ""}deleted`);
  console.log(DRY ? "\nDRY RUN — nothing written\n" : "\nwritten\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
