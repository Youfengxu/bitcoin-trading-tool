/**
 * Tests for the OKX integration.
 *
 * Everything here is offline and deterministic — no network, no credentials.
 * The focus is on the parts where a silent bug is expensive: request signing,
 * order sizing against instrument rules, and the venue-selection guardrails
 * that stand between a config typo and an unintended live trade.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildPrehash,
  signPrehash,
  toOkxBar,
  roundToLot,
  roundQuote,
  getOkxConfig,
} from "./engine/okxClient";
import { getExecutionVenue, resetExecutionVenue } from "./engine/executionVenue";

// ─── Signing ──────────────────────────────────────────────────────────

describe("OKX request signing", () => {
  const TS = "2020-12-08T09:08:57.715Z";

  it("concatenates timestamp + method + path + body in OKX's documented order", () => {
    expect(buildPrehash(TS, "GET", "/api/v5/account/balance?ccy=BTC", "")).toBe(
      "2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC"
    );
  });

  it("keeps the query string in the prehash", () => {
    // Dropping the query string is the classic cause of error 50113.
    const withQuery = buildPrehash(TS, "GET", "/api/v5/trade/order?instId=BTC-USDT&ordId=1", "");
    expect(withQuery).toContain("?instId=BTC-USDT&ordId=1");
  });

  it("includes the request body for POSTs", () => {
    const body = JSON.stringify({ instId: "BTC-USDT", side: "buy" });
    expect(buildPrehash(TS, "POST", "/api/v5/trade/order", body)).toBe(
      `${TS}POST/api/v5/trade/order${body}`
    );
  });

  it("produces a stable base64 HMAC-SHA256 signature", () => {
    const sig = signPrehash("secret", buildPrehash(TS, "GET", "/api/v5/account/balance", ""));
    expect(sig).toBe(signPrehash("secret", buildPrehash(TS, "GET", "/api/v5/account/balance", "")));
    // SHA-256 → 32 bytes → 44 base64 characters with padding.
    expect(sig).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("produces different signatures for different secrets", () => {
    const prehash = buildPrehash(TS, "GET", "/api/v5/account/balance", "");
    expect(signPrehash("secret-a", prehash)).not.toBe(signPrehash("secret-b", prehash));
  });
});

// ─── Interval mapping ─────────────────────────────────────────────────

describe("OKX bar mapping", () => {
  it("maps sub-hour intervals to lowercase OKX bars", () => {
    expect(toOkxBar("5m")).toBe("5m");
    expect(toOkxBar("15m")).toBe("15m");
    expect(toOkxBar("30m")).toBe("30m");
  });

  it("maps hour-and-above intervals to uppercase OKX bars", () => {
    // OKX rejects "1h" — it requires "1H". This casing difference is easy to miss.
    expect(toOkxBar("1h")).toBe("1H");
    expect(toOkxBar("4h")).toBe("4H");
    expect(toOkxBar("1d")).toBe("1D");
  });

  it("falls back to 1H for unknown intervals", () => {
    expect(toOkxBar("bogus")).toBe("1H");
  });

  it("covers every interval the app supports", () => {
    for (const i of ["5m", "15m", "30m", "1h", "4h", "1d"]) {
      expect(toOkxBar(i)).not.toBe(undefined);
    }
  });
});

// ─── Order sizing ─────────────────────────────────────────────────────

describe("order size rounding", () => {
  it("rounds base quantities down to the lot step", () => {
    expect(roundToLot(0.123456789, "0.00000001")).toBe("0.12345678");
  });

  it("never rounds up", () => {
    // Rounding up on a sell can exceed the balance and get the order rejected.
    const rounded = parseFloat(roundToLot(0.9999999999, "0.0001"));
    expect(rounded).toBeLessThanOrEqual(0.9999999999);
    expect(rounded).toBe(0.9999);
  });

  it("matches the lot step's decimal precision exactly", () => {
    expect(roundToLot(1.23456, "0.001")).toBe("1.234");
    expect(roundToLot(1.23456, "0.1")).toBe("1.2");
  });

  it("emits no floating point noise", () => {
    expect(roundToLot(0.3, "0.00000001")).not.toContain("e");
    expect(roundToLot(0.1 + 0.2, "0.0000001")).toBe("0.3000000");
  });

  it("returns the quantity unchanged when the step is unusable", () => {
    expect(roundToLot(1.5, "0")).toBe("1.5");
  });

  it("rounds quote amounts down to 2dp", () => {
    expect(roundQuote(1234.5678)).toBe("1234.56");
    expect(roundQuote(0.999)).toBe("0.99");
  });
});

// ─── Config + venue selection ─────────────────────────────────────────

const OKX_ENV = [
  "OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE",
  "OKX_DEMO", "OKX_BASE_URL", "OKX_INST_ID", "EXECUTION_VENUE",
] as const;

describe("configuration and venue selection", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(OKX_ENV.map((k) => [k, process.env[k]]));
    for (const k of OKX_ENV) delete process.env[k];
    resetExecutionVenue();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetExecutionVenue();
  });

  const withCreds = (demo: boolean) => {
    process.env.OKX_API_KEY = "key";
    process.env.OKX_SECRET_KEY = "secret";
    process.env.OKX_PASSPHRASE = "pass";
    if (demo) process.env.OKX_DEMO = "1";
  };

  it("returns null config when credentials are incomplete", () => {
    process.env.OKX_API_KEY = "key";
    process.env.OKX_SECRET_KEY = "secret";
    expect(getOkxConfig()).toBeNull();
  });

  it("defaults to the global site and BTC-USDT", () => {
    withCreds(false);
    const cfg = getOkxConfig();
    // Singapore accounts are on the global site.
    expect(cfg?.baseUrl).toBe("https://www.okx.com");
    expect(cfg?.instId).toBe("BTC-USDT");
    expect(cfg?.demo).toBe(false);
  });

  it("defaults to the internal paper ledger", () => {
    expect(getExecutionVenue().name).toBe("internal");
    expect(getExecutionVenue().isLive).toBe(false);
  });

  it("falls back to internal when OKX is requested without credentials", () => {
    process.env.EXECUTION_VENUE = "okx-demo";
    expect(getExecutionVenue().name).toBe("internal");
  });

  it("selects the OKX demo venue when demo credentials are present", () => {
    process.env.EXECUTION_VENUE = "okx-demo";
    withCreds(true);
    const venue = getExecutionVenue();
    expect(venue.name).toBe("okx-demo");
    expect(venue.isLive).toBe(false);
  });

  it("refuses okx-demo when OKX_DEMO is not set", () => {
    // Asking for demo while holding a live key must not trade the real account.
    process.env.EXECUTION_VENUE = "okx-demo";
    withCreds(false);
    expect(getExecutionVenue().name).toBe("internal");
  });

  it("refuses okx-live while OKX_DEMO=1", () => {
    process.env.EXECUTION_VENUE = "okx-live";
    withCreds(true);
    expect(getExecutionVenue().name).toBe("internal");
  });

  it("selects the live venue only on an unambiguous request", () => {
    process.env.EXECUTION_VENUE = "okx-live";
    withCreds(false);
    const venue = getExecutionVenue();
    expect(venue.name).toBe("okx-live");
    expect(venue.isLive).toBe(true);
  });

  it("treats an unrecognised venue name as internal", () => {
    process.env.EXECUTION_VENUE = "binance";
    withCreds(false);
    expect(getExecutionVenue().name).toBe("internal");
  });
});
