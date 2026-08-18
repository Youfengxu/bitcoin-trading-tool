/**
 * Option A — delta-neutral funding carry, UNLEVERED.
 *
 * Long spot, short the perpetual in equal notional, collect funding. Price risk
 * nets out, so the edge is mechanical rather than a forecast — the one property
 * no other option here has.
 *
 * ── Why unlevered halves the headline rate ────────────────────────────
 * "No leverage" means total notional must not exceed capital. A delta-neutral
 * position is TWO legs, so capital C supports only C/2 of spot and C/2 of short:
 *
 *     long  C/2 spot        short C/2 perp        net delta 0
 *
 * Funding accrues on the C/2 short notional, so the yield ON CAPITAL is HALF the
 * quoted funding rate. Every "10-30% APY" claim for this trade assumes leverage;
 * at 3-5x the numbers reconcile, and the liquidation risk on the short leg is
 * then the entire risk of the strategy.
 *
 * ── Costs charged ─────────────────────────────────────────────────────
 * Entry and exit on both legs at the account's real 10bps taker rate, plus
 * periodic rehedging: as price moves, the spot leg's value drifts from the short
 * notional and delta must be restored. Rehedging is what turns a clean carry
 * calculation into a real one, and it is the cost most often omitted.
 *
 * ── The limitation that governs the result ────────────────────────────
 * OKX serves only ~96 days of funding history, so this cannot be tested across a
 * cycle. Funding is regime-dependent — it collapses and turns negative in bear
 * markets — so a 3-month window that happens to be positive tells you very
 * little about the average. Treat the output as "what this quarter paid", not as
 * an expected return.
 */

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const CAPITAL = parseFloat(arg("capital") ?? "6581");
/** Restore delta when the legs drift this far apart, as a fraction of notional. */
const REHEDGE_BAND = parseFloat(arg("band") ?? "0.05");
const INSTS = (arg("perps") ?? "BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP,DOGE-USDT-SWAP").split(",");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fundingHistory(instId: string) {
  const out: { t: number; r: number }[] = [];
  let after: string | undefined;
  for (let p = 0; p < 40; p++) {
    const q = new URLSearchParams({ instId, limit: "100" });
    if (after) q.set("after", after);
    const res = await fetch(`https://www.okx.com/api/v5/public/funding-rate-history?${q}`,
      { signal: AbortSignal.timeout(20000) });
    const j: any = await res.json();
    const rows = j.data ?? [];
    if (!rows.length) break;
    for (const r of rows) out.push({ t: +r.fundingTime, r: parseFloat(r.fundingRate) });
    after = String(Math.min(...rows.map((r: any) => +r.fundingTime)));
    await pause(120);
    if (rows.length < 100) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

async function spotCloses(instId: string, fromTs: number) {
  // 4h candles are plenty to mark a position that rehedges on a 5% band.
  const out: { t: number; p: number }[] = [];
  let after: string | undefined;
  for (let p = 0; p < 30; p++) {
    const q = new URLSearchParams({ instId, bar: "4H", limit: "100" });
    if (after) q.set("after", after);
    const res = await fetch(`https://www.okx.com/api/v5/market/history-candles?${q}`,
      { signal: AbortSignal.timeout(20000) });
    const j: any = await res.json();
    const rows = j.data ?? [];
    if (!rows.length) break;
    for (const r of rows) out.push({ t: +r[0], p: parseFloat(r[4]) });
    after = String(Math.min(...rows.map((r: any) => +r[0])));
    await pause(120);
    if (Math.min(...rows.map((r: any) => +r[0])) < fromTs) break;
  }
  return out.filter((x) => x.t >= fromTs).sort((a, b) => a.t - b.t);
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padEnd(w);

async function main() {
  console.log(`\n${"═".repeat(94)}`);
  console.log(`Option A — delta-neutral funding carry, UNLEVERED · taker ${(FEE * 1e4).toFixed(0)}bps · $${CAPITAL.toLocaleString()}`);
  console.log("═".repeat(94));
  console.log(pad("perp", 18) + pad("days", 7) + pad("gross carry", 14) + pad("fees", 12) +
              pad("NET on capital", 16) + "rehedges");
  console.log("─".repeat(94));

  for (const inst of INSTS) {
    const fund = await fundingHistory(inst);
    if (!fund.length) { console.log(`${pad(inst, 18)}no funding data`); continue; }
    const spot = await spotCloses(inst.replace("-SWAP", ""), fund[0].t);
    if (spot.length < 10) { console.log(`${pad(inst, 18)}no spot data`); continue; }

    // Unlevered: half the capital in spot, half backing the short.
    const legNotional = CAPITAL / 2;
    const p0 = spot[0].p;
    let spotQty = legNotional / p0;
    let shortQty = legNotional / p0;      // equal and opposite
    let carry = 0, fees = 0, rehedges = 0;

    // Entry: both legs cross the spread.
    fees += legNotional * FEE * 2;

    const priceAt = (t: number) => {
      let last = spot[0].p;
      for (const s of spot) { if (s.t > t) break; last = s.p; }
      return last;
    };

    for (const f of fund) {
      const px = priceAt(f.t);
      // Shorts RECEIVE when funding is positive, on the short notional.
      carry += f.r * shortQty * px;

      // Rehedge: spot and short quantities drift apart in value terms as price
      // moves. Restoring delta costs a taker fee on the difference.
      const drift = Math.abs(spotQty - shortQty) / Math.max(spotQty, shortQty);
      if (drift > REHEDGE_BAND) {
        const adj = Math.abs(spotQty - shortQty) * px;
        fees += adj * FEE;
        shortQty = spotQty;
        rehedges++;
      }
    }
    // Exit both legs.
    const pEnd = spot[spot.length - 1].p;
    fees += legNotional * FEE * 2 * (pEnd / p0);

    const days = (fund[fund.length - 1].t - fund[0].t) / 86400_000;
    const grossApr = (carry / CAPITAL) * (365 / days);
    const netApr = ((carry - fees) / CAPITAL) * (365 / days);
    console.log(
      pad(inst.replace("-USDT-SWAP", ""), 18) + pad(days.toFixed(0), 7) +
      pad(pct(grossApr) + " APR", 14) + pad(`$${fees.toFixed(0)}`, 12) +
      pad(pct(netApr) + " APR", 16) + rehedges
    );
  }
  console.log("─".repeat(94));
  console.log("Gross carry is HALF the quoted funding rate: unlevered, capital funds two legs.");
  console.log("~96 days of history is all OKX serves — this is one quarter, not an expected return.");
  console.log("═".repeat(94) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
