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
import { getExecutionVenue, resetExecutionVenue, planRebalance, SHADOW_VENUE } from "./engine/executionVenue";
import {
  convictionScaledFraction,
  TRADE_COOLDOWN_BARS,
  MIN_TRADE_NOTIONAL_USD,
  CONVICTION_SIZE_MIN_MULT,
  CONVICTION_SIZE_MAX_MULT,
  strategyMode,
  staticTargetWeight,
  staticRebalanceBand,
} from "../shared/tradingTypes";

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

// ─── OPT5: turnover control and conviction sizing ───────────────────
// The backtest variant that beat the baseline at every fee level in both
// regimes (5/7 rolling blocks, +0.17% mean vs -0.62%). The raised threshold
// ALONE was worse than baseline out-of-sample, so these two rules are what
// make the configuration work — they are not optional trimming.
describe("Conviction sizing", () => {
  const base = 0.1461;
  const minConf = 0.45;

  it("halves the position at the confidence threshold", () => {
    expect(convictionScaledFraction(base, minConf, minConf)).toBeCloseTo(base * 0.5, 10);
  });

  it("doubles it at full confidence", () => {
    expect(convictionScaledFraction(base, 1.0, minConf)).toBeCloseTo(base * 2.0, 10);
  });

  it("scales monotonically between the two", () => {
    const f = [0.45, 0.55, 0.7, 0.85, 1.0].map((c) => convictionScaledFraction(base, c, minConf));
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
  });

  it("never exceeds a whole position", () => {
    expect(convictionScaledFraction(0.8, 1.0, 0.45)).toBeLessThanOrEqual(1);
    expect(convictionScaledFraction(0.9, 0.99, 0.3)).toBeLessThanOrEqual(1);
  });

  it("floors at the minimum multiplier below the threshold", () => {
    // Confidence under minConfidence should not produce a negative size.
    const f = convictionScaledFraction(base, 0.1, minConf);
    expect(f).toBeCloseTo(base * CONVICTION_SIZE_MIN_MULT, 10);
    expect(f).toBeGreaterThan(0);
  });

  it("tolerates a minConfidence of 1 without dividing by zero", () => {
    expect(Number.isFinite(convictionScaledFraction(base, 1.0, 1.0))).toBe(true);
  });
});

describe("Turnover control constants", () => {
  it("keeps a cooldown long enough to matter at the 1h interval", () => {
    expect(TRADE_COOLDOWN_BARS).toBeGreaterThanOrEqual(12); // 12h at 1h candles
  });

  it("sets a minimum notional well above OKX's minSz", () => {
    // OKX minSz is 0.00001 BTC (~$0.63). The rule exists to avoid fee-dominated
    // dust, not merely to satisfy the exchange.
    expect(MIN_TRADE_NOTIONAL_USD).toBeGreaterThanOrEqual(100);
  });

  it("multipliers bracket 1.0 so average size is near the base position", () => {
    expect(CONVICTION_SIZE_MIN_MULT).toBeLessThan(1);
    expect(CONVICTION_SIZE_MAX_MULT).toBeGreaterThan(1);
  });
});

// ─── Static allocation rebalancing ────────────────────────────────────

describe("static allocation config", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("defaults to the engine so a lost env does not silently change what trades", () => {
    delete process.env.STRATEGY_MODE;
    expect(strategyMode()).toBe("engine");
  });

  it("only switches to static on an exact opt-in", () => {
    process.env.STRATEGY_MODE = "static";
    expect(strategyMode()).toBe("static");
    process.env.STRATEGY_MODE = "STATIC";
    expect(strategyMode()).toBe("static");
    process.env.STRATEGY_MODE = "statik";
    expect(strategyMode()).toBe("engine");
  });

  it("clamps the target weight to [0,1] — the spot venue cannot lever or short", () => {
    process.env.STATIC_TARGET_WEIGHT = "1.8";
    expect(staticTargetWeight()).toBe(1);
    process.env.STATIC_TARGET_WEIGHT = "-0.3";
    expect(staticTargetWeight()).toBe(0);
    process.env.STATIC_TARGET_WEIGHT = "garbage";
    expect(staticTargetWeight()).toBeCloseTo(0.40, 10);
  });

  it("never allows a zero band, which would rebalance every heartbeat", () => {
    process.env.STATIC_REBALANCE_BAND = "0";
    expect(staticRebalanceBand()).toBeCloseTo(0.10, 10);
    process.env.STATIC_REBALANCE_BAND = "-1";
    expect(staticRebalanceBand()).toBeCloseTo(0.10, 10);
  });
});

describe("planRebalance", () => {
  const PX = 100_000;
  /** A book worth $10,000 total at the given BTC weight. */
  const bookAt = (weight: number, total = 10_000) => ({
    cashUsd: total * (1 - weight),
    btcHolding: (total * weight) / PX,
  });

  it("does nothing inside the band", () => {
    expect(planRebalance(bookAt(0.45), PX, 0.40, 0.10)).toBeNull();
    expect(planRebalance(bookAt(0.31), PX, 0.40, 0.10)).toBeNull();
  });

  it("sells down to target when overweight beyond the band", () => {
    const plan = planRebalance(bookAt(0.80), PX, 0.40, 0.10);
    expect(plan?.action).toBe("sell");
    // 80% -> 40% of a $10k book is $4,000 of BTC.
    expect(plan && "btcAmount" in plan ? plan.btcAmount * PX : 0).toBeCloseTo(4000, 6);
  });

  it("buys up to target when underweight beyond the band", () => {
    const plan = planRebalance(bookAt(0.10), PX, 0.40, 0.10);
    expect(plan?.action).toBe("buy");
    expect(plan && "usdAmount" in plan ? plan.usdAmount : 0).toBeCloseTo(3000, 6);
  });

  it("lands exactly on target — the resulting weight is the target", () => {
    const h = bookAt(0.80);
    const plan = planRebalance(h, PX, 0.40, 0.10)!;
    const btcAfter = h.btcHolding - ("btcAmount" in plan ? plan.btcAmount : 0);
    const cashAfter = h.cashUsd + ("btcAmount" in plan ? plan.btcAmount * PX : 0);
    const weightAfter = (btcAfter * PX) / (cashAfter + btcAfter * PX);
    expect(weightAfter).toBeCloseTo(0.40, 10);
  });

  it("refuses trades below the dust floor even when outside the band", () => {
    // A tiny book: 100% -> 40% is only $60, far under the minimum notional.
    expect(planRebalance(bookAt(1.0, 100), PX, 0.40, 0.10)).toBeNull();
  });

  it("returns null for an empty or unpriced book rather than dividing by zero", () => {
    expect(planRebalance({ cashUsd: 0, btcHolding: 0 }, PX, 0.40, 0.10)).toBeNull();
    expect(planRebalance(bookAt(0.9), 0, 0.40, 0.10)).toBeNull();
  });

  it("liquidates fully at a zero target, and never sells more BTC than held", () => {
    const h = bookAt(0.9);
    const plan = planRebalance(h, PX, 0, 0.10)!;
    expect(plan.action).toBe("sell");
    expect("btcAmount" in plan ? plan.btcAmount : 0).toBeCloseTo(h.btcHolding, 12);
    expect("btcAmount" in plan ? plan.btcAmount : 0).toBeLessThanOrEqual(h.btcHolding);
  });

  it("never asks to spend more cash than the book holds at a 100% target", () => {
    const h = bookAt(0.1);
    const plan = planRebalance(h, PX, 1, 0.10)!;
    expect(plan.action).toBe("buy");
    expect("usdAmount" in plan ? plan.usdAmount : 0).toBeLessThanOrEqual(h.cashUsd + 1e-6);
  });
});

describe("shadow book", () => {
  it("is a distinct venue from the live books, so it can never be confused for one", () => {
    expect(SHADOW_VENUE).not.toBe("internal");
    expect(SHADOW_VENUE).not.toBe("okx-demo");
    expect(SHADOW_VENUE).not.toBe("okx-live");
    // The name must say what it trades — it shows up verbatim in the UI dropdown.
    expect(SHADOW_VENUE).toContain("engine");
  });
});
