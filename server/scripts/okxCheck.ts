/**
 * OKX Connectivity Preflight
 *
 * Verifies the OKX integration end to end before any trading is enabled.
 * Run it after setting credentials and again after every config change.
 *
 *   pnpm tsx server/scripts/okxCheck.ts            # public data + private read checks
 *   pnpm tsx server/scripts/okxCheck.ts --order    # additionally place ONE tiny test order
 *
 * --order places a real market order for the instrument's minimum size. It is
 * refused unless OKX_DEMO=1, so it can never spend real money.
 *
 * Environment (see .env.example):
 *   OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
 *   OKX_DEMO=1        use the simulated environment (requires a Demo Trading key)
 *   OKX_BASE_URL      default https://www.okx.com (global — correct for Singapore)
 *   OKX_INST_ID       default BTC-USDT
 */

import * as okx from "../engine/okxClient";

const PLACE_ORDER = process.argv.includes("--order");

function ok(label: string, detail: string) {
  console.log(`  ✓ ${label.padEnd(24)} ${detail}`);
}
function fail(label: string, e: unknown) {
  console.log(`  ✗ ${label.padEnd(24)} ${e instanceof Error ? e.message : String(e)}`);
}

async function main() {
  const hr = "─".repeat(72);
  console.log(`\n${hr}\nOKX Connectivity Preflight\n${hr}`);

  const instId = okx.getInstId();
  console.log(`\nEndpoint: ${okx.getPublicBaseUrl()}   Instrument: ${instId}`);

  // ── 1. Public market data — no credentials required ────────────────
  console.log("\n1. Public market data (no API key needed)");
  let refPrice = 0;
  try {
    const t = await okx.fetchTicker();
    refPrice = parseFloat(t.last);
    ok("ticker", `last $${refPrice.toLocaleString()}  24h ${t.low24h}–${t.high24h}`);
  } catch (e) {
    fail("ticker", e);
  }

  let instrument: okx.OkxInstrument | null = null;
  try {
    instrument = await okx.fetchInstrument();
    ok("instrument rules", `minSz ${instrument.minSz}  lotSz ${instrument.lotSz}  tickSz ${instrument.tickSz}  state ${instrument.state}`);
  } catch (e) {
    fail("instrument rules", e);
  }

  try {
    // 336 bars is what the production indicator pipeline requests, so this also
    // exercises the >300 pagination path.
    const candles = await okx.fetchCandles("1h", 336);
    const first = new Date(candles[0].openTime).toISOString().slice(0, 16);
    const last = new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 16);
    const unconfirmed = candles.filter((c) => !c.confirmed).length;
    ok("candles (1h × 336)", `${candles.length} bars  ${first} → ${last}  (${unconfirmed} still forming)`);
  } catch (e) {
    fail("candles (1h × 336)", e);
  }

  // ── 2. Credentials ─────────────────────────────────────────────────
  console.log("\n2. Credentials");
  const cfg = okx.getOkxConfig();
  if (!cfg) {
    console.log("  ✗ OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE not all set.");
    console.log("\n  Public data works without credentials, so Phase 1 (OKX as market");
    console.log("  data source) is already active. Set the three variables to continue.\n");
    return;
  }
  ok("mode", cfg.demo ? "DEMO (x-simulated-trading: 1)" : "⚠ LIVE — real funds");

  // ── 3. Private reads ───────────────────────────────────────────────
  console.log("\n3. Private endpoints (read)");
  try {
    const balances = await okx.fetchBalances(cfg);
    const shown = Object.entries(balances)
      .filter(([, v]) => v > 0)
      .map(([c, v]) => `${v} ${c}`)
      .join(", ");
    ok("balance", shown || "(all zero — fund the demo account from OKX's UI)");
  } catch (e) {
    fail("balance", e);
    console.log("\n  Signature failures (code 50113) usually mean the key/secret/passphrase");
    console.log("  don't match, or a live key is being used with OKX_DEMO=1 (or vice versa).\n");
    return;
  }

  try {
    const fee = await okx.fetchTradeFee(cfg);
    ok("trade fee", `maker ${(fee.maker * 100).toFixed(4)}%  taker ${(fee.taker * 100).toFixed(4)}%`);
    console.log(`\n  → Set TRADING_FEE_BPS=${Math.round(fee.taker * 10000)} so the internal simulator`);
    console.log(`    and the walk-forward optimizer charge your real taker rate.`);
  } catch (e) {
    fail("trade fee", e);
  }

  // ── 4. Optional test order ─────────────────────────────────────────
  if (!PLACE_ORDER) {
    console.log("\n4. Test order: skipped (pass --order to place one)");
    console.log(`\n${hr}\n`);
    return;
  }

  console.log("\n4. Test order");
  if (!cfg.demo) {
    console.log("  ✗ Refusing to place a test order against a LIVE account.");
    console.log("    Set OKX_DEMO=1 and use a Demo Trading API key.");
    console.log(`\n${hr}\n`);
    return;
  }
  if (!instrument || refPrice <= 0) {
    console.log("  ✗ Cannot size a test order without instrument rules and a price.");
    console.log(`\n${hr}\n`);
    return;
  }

  // Buy the minimum notional, then sell the filled quantity back.
  const notional = parseFloat(instrument.minSz) * refPrice * 1.05; // 5% headroom
  try {
    console.log(`  → buying ${okx.roundQuote(notional)} ${instId.split("-")[1]} at market...`);
    const order = await okx.placeMarketOrder(cfg, "buy", okx.roundQuote(notional));
    const detail = await okx.waitForFill(cfg, order.ordId);
    ok("buy filled", `${detail?.accFillSz} BTC @ $${detail?.avgPx}  state ${detail?.state}  fee ${detail?.fee} ${detail?.feeCcy}`);

    const filled = parseFloat(detail?.accFillSz ?? "0");
    if (filled > 0) {
      const sz = okx.roundToLot(filled, instrument.lotSz);
      console.log(`  → selling ${sz} back...`);
      const sellOrder = await okx.placeMarketOrder(cfg, "sell", sz);
      const sellDetail = await okx.waitForFill(cfg, sellOrder.ordId);
      ok("sell filled", `${sellDetail?.accFillSz} BTC @ $${sellDetail?.avgPx}  state ${sellDetail?.state}`);
    }
    console.log("\n  Round trip completed. The venue is wired correctly.");
  } catch (e) {
    fail("test order", e);
  }

  console.log(`\n${hr}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
