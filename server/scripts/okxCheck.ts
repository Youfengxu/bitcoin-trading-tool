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
import { AUTH_HINTS, OkxApiError } from "../engine/okxClient";

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

  // Whitespace pasted into .env is invisible in the file and produces the exact
  // same failure as a wrong credential, so check it before blaming the key.
  const fields: Array<[string, string]> = [
    ["OKX_API_KEY", cfg.apiKey],
    ["OKX_SECRET_KEY", cfg.secretKey],
    ["OKX_PASSPHRASE", cfg.passphrase],
  ];
  let dirty = false;
  for (const [name, value] of fields) {
    if (value !== value.trim()) {
      fail(name, `has leading/trailing whitespace (${value.length} chars, ${value.trim().length} trimmed)`);
      dirty = true;
    } else if (/["']/.test(value)) {
      fail(name, `contains a quote character — .env values should not be quoted`);
      dirty = true;
    }
  }
  if (!dirty) ok("credential format", "no stray whitespace or quotes");

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
    const code = e instanceof OkxApiError ? e.code : null;
    console.log("");

    // 50119/50101 mean the key is not registered on THIS site. Rather than
    // making the reader guess which of four hosts their account lives on, try
    // them. All candidates are OKX-owned, and the same signed read is sent.
    if (code === "50119" || code === "50101") {
      console.log("  The key is not registered on this site. Probing the other OKX sites...\n");
      const candidates = [
        ["https://www.okx.com", "global"],
        ["https://my.okx.com", "EEA / SG and others"],
        ["https://app.okx.com", "US"],
        ["https://tr.okx.com", "TR"],
      ];
      let found: string | null = null;
      for (const [baseUrl, label] of candidates) {
        if (baseUrl === cfg.baseUrl) continue;
        try {
          await okx.fetchBalances({ ...cfg, baseUrl });
          console.log(`    ✓ ${baseUrl.padEnd(22)} ${label} — KEY WORKS HERE`);
          found = baseUrl;
        } catch (probeErr) {
          const pc = probeErr instanceof OkxApiError ? probeErr.code : "?";
          console.log(`    ✗ ${baseUrl.padEnd(22)} ${label} (${pc})`);
        }
      }
      if (found) {
        console.log(`\n  → Set OKX_BASE_URL=${found} in .env and re-run.`);
        console.log("    Do not infer the site from your country; use the host you log in at.");
      } else {
        console.log("\n  → The key was not recognised on any OKX site. It was likely deleted,");
        console.log("    regenerated, or only partially pasted. Create a fresh key.");
      }
      console.log("");
      return;
    }

    if (code && AUTH_HINTS[code]) {
      console.log(`  OKX error ${code}: ${AUTH_HINTS[code]}`);
    } else {
      console.log("  Could not map that error to a known auth cause. Common ones:");
      for (const [c, hint] of Object.entries(AUTH_HINTS)) {
        console.log(`    ${c}  ${hint}`);
      }
    }
    console.log(`\n  Current config: site ${cfg.baseUrl}, ${cfg.demo ? "DEMO" : "LIVE"} mode.`);
    console.log("  Demo and live need SEPARATE keys; a key from one never works on the other.");
    console.log("");
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
