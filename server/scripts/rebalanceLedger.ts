/**
 * When does a static allocation actually take profits?
 *
 * "When do I cash in" has a mechanical answer under a rebalancing rule, and it
 * needs no forecast: the band sells whenever BTC has risen enough to exceed
 * target + band, and buys whenever it has fallen below target - band. Rallies
 * force sales; selloffs force purchases. That is systematic profit-taking, and
 * it is the reason a rebalanced book is not the same thing as buy-and-hold.
 *
 * This runs the configured rule continuously over the full history — NOT chopped
 * into 90-day episodes like the sizing study — and prints every trade it would
 * have made, so the cadence and direction are visible rather than asserted.
 *
 * It also reports realised vs unrealised P&L, since "cashing in" specifically
 * means the realised part.
 *
 * Usage:
 *   pnpm tsx server/scripts/rebalanceLedger.ts
 *   pnpm tsx server/scripts/rebalanceLedger.ts --w=0.40 --band=0.10 --years=3
 */

import { loadHourly } from "./lib/historyCache";
import { MIN_TRADE_NOTIONAL_USD } from "../../shared/tradingTypes";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const W = parseFloat(arg("w") ?? "0.40");
const BAND = parseFloat(arg("band") ?? "0.10");
const YEARS = parseFloat(arg("years") ?? "3");
const INST = arg("inst") ?? "BTC-USDT";
const SEED = parseFloat(arg("seed") ?? "10000");
const END = Date.parse("2026-08-16T00:00:00Z");
const START = END - YEARS * 365 * 24 * 3600 * 1000;

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  const { candles: c } = await loadHourly(INST, START, END);
  if (!c.length) { console.log("no data"); return; }

  console.log(`\n${"═".repeat(88)}`);
  console.log(`Rebalance ledger — ${INST} · target ${(W * 100).toFixed(0)}% · band ${(BAND * 100).toFixed(0)}pp · ${(FEE * 10000).toFixed(0)}bps`);
  console.log(`${new Date(c[0].openTime).toISOString().slice(0, 10)} → ${new Date(c.at(-1)!.openTime).toISOString().slice(0, 10)}, $${SEED.toLocaleString()} start`);
  console.log("═".repeat(88));

  let cash = SEED * (1 - W), u = (SEED * W) / c[0].close;
  let realised = 0, feesPaid = 0, costBasis = u * c[0].close;
  const trades: Array<{ t: number; side: "buy" | "sell"; px: number; usd: number; wBefore: number; realised: number }> = [];

  for (let i = 1; i < c.length; i++) {
    const px = c[i].close;
    const total = cash + u * px;
    if (total <= 0) break;
    const w = (u * px) / total;
    if (Math.abs(W - w) <= BAND) continue;

    const deltaBtc = (W * total) / px - u;
    const notional = Math.abs(deltaBtc) * px;
    if (notional < MIN_TRADE_NOTIONAL_USD) continue;

    const fee = notional * FEE;
    feesPaid += fee;
    let bookedNow = 0;
    if (deltaBtc < 0) {
      // Selling: realise the gain on the units disposed of, at average cost.
      const avgCost = u > 0 ? costBasis / u : px;
      bookedNow = (-deltaBtc) * (px - avgCost) - fee;
      realised += bookedNow;
      costBasis -= (-deltaBtc) * avgCost;
      cash += notional - fee;
    } else {
      costBasis += notional - fee;
      cash -= notional;
    }
    u += deltaBtc;
    trades.push({ t: c[i].openTime, side: deltaBtc > 0 ? "buy" : "sell", px, usd: notional, wBefore: w, realised: bookedNow });
  }

  const finalPx = c.at(-1)!.close;
  const finalTotal = cash + u * finalPx;
  const unrealised = u * finalPx - costBasis;
  const holdFinal = SEED * (finalPx / c[0].close);

  console.log(`\n${trades.length} rebalances in ${(YEARS * 12).toFixed(0)} months` +
    ` — ${trades.filter((t) => t.side === "sell").length} sells, ${trades.filter((t) => t.side === "buy").length} buys\n`);
  console.log("date".padEnd(13) + "action".padEnd(8) + pad("BTC price", 12) + pad("weight was", 12) +
              pad("traded", 10) + pad("cash booked", 13));
  console.log("─".repeat(88));
  for (const t of trades) {
    console.log(new Date(t.t).toISOString().slice(0, 10).padEnd(13) +
      (t.side === "sell" ? "SELL" : "BUY").padEnd(8) +
      pad(`$${t.px.toFixed(0)}`, 12) + pad(`${(t.wBefore * 100).toFixed(1)}%`, 12) +
      pad(usd(t.usd), 10) + pad(t.side === "sell" ? usd(t.realised) : "—", 13));
  }
  console.log("─".repeat(88));

  console.log(`\nPosition now      ${u.toFixed(6)} BTC (${usd(u * finalPx)}) + ${usd(cash)} cash = ${usd(finalTotal)}`);
  console.log(`  realised P&L    ${usd(realised)}   ← the part actually 'cashed in'`);
  console.log(`  unrealised      ${usd(unrealised)}   ← still riding`);
  console.log(`  fees paid       ${usd(feesPaid)}`);
  console.log(`\nstatic ${(W * 100).toFixed(0)}%   ${usd(finalTotal)}  (${pct(finalTotal / SEED - 1)})`);
  console.log(`buy & hold  ${usd(holdFinal)}  (${pct(holdFinal / SEED - 1)})`);
  console.log("═".repeat(88) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
