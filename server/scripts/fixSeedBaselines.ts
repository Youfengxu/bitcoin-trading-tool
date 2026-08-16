/**
 * One-off repair: correct `seedAmountUsd` on books that were seeded with a
 * value other than the 10000 default.
 *
 * ── The bug ───────────────────────────────────────────────────────────
 * `seedAmountUsd` defaults to 10000 and is the baseline every return figure is
 * measured against. Two seeding routines set a book's holdings without updating
 * it, so both books reported losses they never took:
 *
 *   okx-demo       seeded with SGD 10,000 ≈ $7,809 USDT, baseline left at
 *                  $10,000 → displayed -22% while actually flat at -0.1% in SGD,
 *                  on a book with ZERO trades.
 *
 *   shadow-engine  seeded from the paper book's current $9,330.35, baseline left
 *                  at $10,000 → would have opened showing -6.7%, inheriting the
 *                  engine's past losses on its first day.
 *
 * Both seeding routines are fixed at source; this repairs the rows already
 * written.
 *
 * ── On the okx-demo figure ────────────────────────────────────────────
 * The exact USDT seeded is NOT recoverable: the book has never traded (so its
 * cash and BTC are untouched since seeding), but converting SGD 10,000 needs the
 * USDT-SGD rate at that moment, and the log line recording it has rotated away.
 * It is therefore RECONSTRUCTED from SGD 10,000 at the current rate. SGD is a
 * managed float and moved little, so the error is well under 1% — but this is an
 * estimate, not the original number, and is logged as such.
 *
 * The residual limitation is unfixed and deliberate: an SGD-denominated book
 * displayed in USD will always show a return that drifts with USDT-SGD. Fixing
 * that properly means displaying the book in its own currency, which is a UI
 * change rather than a data repair.
 *
 * Usage (on the host, where DATABASE_URL points at the live DB):
 *   docker compose exec app node -e "..."   or   pnpm tsx server/scripts/fixSeedBaselines.ts
 */

import * as db from "../db";
import * as okx from "../engine/okxClient";
import { SHADOW_VENUE } from "../engine/executionVenue";

const DRY = process.argv.includes("--dry");

async function main() {
  const capitalSgd = parseFloat(process.env.OKX_BOOK_CAPITAL_SGD ?? "0");

  const venues = await db.listSimulatorVenues();
  console.log(`venues: ${venues.join(", ")}\n`);

  for (const venue of venues) {
    const state = await db.getSimulatorState(venue);
    if (!state) continue;

    let correct: number | null = null;
    let why = "";

    if (venue === db.INTERNAL_VENUE) {
      // Genuinely started at 10000. Nothing to do.
      continue;
    } else if (venue === SHADOW_VENUE) {
      // Seeded from the paper book. Its opening value IS its baseline, and since
      // it has not traded yet that is still its current total.
      const trades = await db.getRecentTrades(1, SHADOW_VENUE);
      if (trades.length) {
        console.log(`  ${venue.padEnd(15)} SKIPPED — already has trades, opening value no longer recoverable`);
        continue;
      }
      correct = state.totalValueUsd;
      why = "opening value, copied from the paper book at seed";
    } else if (venue.startsWith("okx-") && capitalSgd > 0) {
      const rate = await okx.fetchUsdtSgdRate();
      if (!rate) { console.log(`  ${venue.padEnd(15)} SKIPPED — USDT-SGD rate unavailable`); continue; }
      correct = capitalSgd / rate;
      why = `RECONSTRUCTED: SGD ${capitalSgd.toLocaleString()} at the CURRENT rate ${rate} (original rate not recoverable)`;
    }

    if (correct === null) { console.log(`  ${venue.padEnd(15)} no rule — left alone`); continue; }

    const delta = Math.abs(correct - state.seedAmountUsd);
    if (delta < 0.01) { console.log(`  ${venue.padEnd(15)} already correct ($${correct.toFixed(2)})`); continue; }

    const before = ((state.totalValueUsd - state.seedAmountUsd) / state.seedAmountUsd) * 100;
    const after = ((state.totalValueUsd - correct) / correct) * 100;
    console.log(
      `  ${venue.padEnd(15)} seed $${state.seedAmountUsd.toFixed(2)} → $${correct.toFixed(2)}\n` +
      `  ${" ".repeat(15)} displayed return ${before >= 0 ? "+" : ""}${before.toFixed(1)}% → ${after >= 0 ? "+" : ""}${after.toFixed(1)}%\n` +
      `  ${" ".repeat(15)} ${why}`
    );
    if (!DRY) await db.updateSimulatorState({ seedAmountUsd: correct }, venue);
  }

  console.log(DRY ? "\nDRY RUN — nothing written\n" : "\nwritten\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
