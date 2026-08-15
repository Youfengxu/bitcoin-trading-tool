/**
 * Execution Venue
 *
 * Separates *what to trade* (the signal engine) from *where the trade happens*.
 * Before this existed, ledger arithmetic was inlined in two places —
 * heartbeatHandler.ts and routers.ts — which meant the scheduled path and the
 * manual "Generate Signal" button could drift apart silently.
 *
 * ── Two books, one signal stream ──────────────────────────────────────
 * The paper ledger ALWAYS runs — it is the analysis baseline. EXECUTION_VENUE
 * decides whether a second, real book runs beside it:
 *
 *   internal   (default)  Paper ledger only. Current behaviour.
 *   okx-demo             Paper ledger AND real orders against OKX's simulated
 *                        environment — real order book, real rounding, real
 *                        rejections, real fees, no real money.
 *   okx-live             Paper ledger AND real orders against the real account.
 *
 * Each book has its own row in simulator_state and its own trades, tagged by
 * venue. They size independently against their own holdings, so they drift
 * apart as execution reality diverges from theory. That drift is precisely the
 * error a backtest cannot model: slippage, partial fills, minimum sizes, and
 * the latency between deciding and filling.
 *
 * ── Lockstep ──────────────────────────────────────────────────────────
 * When a real venue is configured it executes FIRST, and if it does not fill —
 * rejected, undersized, unreachable — the paper book skips the trade too. The
 * two books therefore always hold the same set of trades, differing only in
 * execution quality. Without this the paper book would accumulate trades
 * reality never took, and the gap between the curves would stop being a
 * measurement of anything.
 *
 * The paper book still executes at the REFERENCE price with its own fee
 * assumption rather than copying the venue's fill. Copying the fill would make
 * the two curves identical by construction and measure nothing.
 *
 * SAFETY: okx-live is never selected implicitly. It requires
 * EXECUTION_VENUE=okx-live *and* OKX_DEMO to be unset/0, and it logs loudly at
 * construction. Everything else falls back to the internal paper ledger.
 */

import * as db from "../db";
import * as okx from "./okxClient";
import type { StrategyParameters } from "../../shared/tradingTypes";
import {
  TRADE_COOLDOWN_BARS,
  MIN_TRADE_NOTIONAL_USD,
  convictionScaledFraction,
} from "../../shared/tradingTypes";

/**
 * Capital the strategy is allowed to deploy on the OKX book, in SGD. Unset or 0
 * means "use the whole account".
 *
 * Why an allocation rather than the raw balance: demo funds cannot be
 * withdrawn. OKX seeds every demo account with a fixed basket (1 BTC, 10k USDT,
 * 10k USD, 10k SGD, 5k USDC, 1 ETH ≈ SGD 93k) and restores it periodically, so
 * there is no way to trade the account down to a chosen size — sells convert
 * BTC to USDT and the total stays put.
 *
 * With an allocation set, the tool tracks its OWN cash/BTC ledger for the venue
 * in simulator_state and uses the real balance only as a solvency check. That
 * also makes the book immune to OKX's periodic resets, which would otherwise
 * put a meaningless discontinuity in the equity curve.
 */
function okxBookCapitalSgd(): number {
  const v = parseFloat(process.env.OKX_BOOK_CAPITAL_SGD ?? "0");
  return isNaN(v) || v <= 0 ? 0 : v;
}

/** True when the OKX book is a tracked allocation rather than the raw account. */
export function isAllocatedBook(): boolean {
  return okxBookCapitalSgd() > 0;
}

/** Candle interval → milliseconds, for measuring the cooldown in bars. */
const INTERVAL_MS: Record<string, number> = {
  "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

// ─── Types ────────────────────────────────────────────────────────────

/** The result of an executed trade, in the units the database records. */
export interface Fill {
  action: "buy" | "sell";
  /** Average fill price. For the internal venue this is the reference price. */
  price: number;
  /** BTC transacted, always positive. */
  btcAmount: number;
  /** USD transacted, always positive, before fees. */
  usdValue: number;
  /** Fee charged, in USD. Zero for the internal venue unless TRADING_FEE_BPS is set. */
  feeUsd: number;
  /** Venue order id, when the venue has one. */
  venueOrderId?: string;
}

/** Current holdings, however the venue defines them. */
export interface VenueSnapshot {
  cashUsd: number;
  btcHolding: number;
}

export interface ExecutionVenue {
  readonly name: string;
  /** True only when real funds are at risk. */
  readonly isLive: boolean;
  /** Current holdings, or null when the venue is unreachable. */
  snapshot(): Promise<VenueSnapshot | null>;
  /** Spend `usdAmount` of cash on BTC. Returns null if the trade could not be placed. */
  buy(usdAmount: number, refPrice: number): Promise<Fill | null>;
  /** Sell `btcAmount` of BTC. Returns null if the trade could not be placed. */
  sell(btcAmount: number, refPrice: number): Promise<Fill | null>;
}

// ─── Internal paper ledger ────────────────────────────────────────────

/**
 * Per-side trading cost in basis points applied by the internal venue.
 *
 * Defaults to 0, which preserves the existing paper track record exactly. The
 * live account's real rate is available from OKX via
 * `GET /api/v5/account/trade-fee` (see scripts/okxCheck.ts) and setting it here
 * is what makes internal-vs-OKX comparisons meaningful — a fee-free simulator
 * flatters high-turnover strategies badly.
 */
function internalFeeRate(): number {
  const bps = parseFloat(process.env.TRADING_FEE_BPS ?? "0");
  return isNaN(bps) ? 0 : bps / 10000;
}

class InternalVenue implements ExecutionVenue {
  readonly name = "internal";
  readonly isLive = false;

  async snapshot(): Promise<VenueSnapshot | null> {
    const state = await db.getSimulatorState();
    if (!state) return null;
    return { cashUsd: state.cashUsd, btcHolding: state.btcHolding };
  }

  async buy(usdAmount: number, refPrice: number): Promise<Fill | null> {
    if (usdAmount <= 0 || refPrice <= 0) return null;
    const feeUsd = usdAmount * internalFeeRate();
    return {
      action: "buy",
      price: refPrice,
      btcAmount: (usdAmount - feeUsd) / refPrice,
      usdValue: usdAmount,
      feeUsd,
    };
  }

  async sell(btcAmount: number, refPrice: number): Promise<Fill | null> {
    if (btcAmount <= 0 || refPrice <= 0) return null;
    const gross = btcAmount * refPrice;
    return {
      action: "sell",
      price: refPrice,
      btcAmount,
      usdValue: gross,
      feeUsd: gross * internalFeeRate(),
    };
  }
}

// ─── OKX venue ────────────────────────────────────────────────────────

/**
 * Places real spot market orders on OKX — against the demo environment when
 * OKX_DEMO=1, against the real account otherwise.
 *
 * Instrument rules (minSz, lotSz) are fetched once and cached: they change
 * rarely, and an order that violates them is rejected outright.
 */
class OkxVenue implements ExecutionVenue {
  readonly name: string;
  readonly isLive: boolean;
  private instrument: okx.OkxInstrument | null = null;

  constructor(private cfg: okx.OkxConfig) {
    this.isLive = !cfg.demo;
    this.name = cfg.demo ? "okx-demo" : "okx-live";
  }

  private async rules(): Promise<okx.OkxInstrument> {
    if (!this.instrument) this.instrument = await okx.fetchInstrument(this.cfg.instId);
    return this.instrument;
  }

  /** Quote currency of the instrument, e.g. USDT for BTC-USDT. */
  private get quoteCcy(): string {
    return this.cfg.instId.split("-")[1] ?? "USDT";
  }

  private get baseCcy(): string {
    return this.cfg.instId.split("-")[0] ?? "BTC";
  }

  async snapshot(): Promise<VenueSnapshot | null> {
    try {
      const balances = await okx.fetchBalances(this.cfg);
      return {
        cashUsd: balances[this.quoteCcy] ?? 0,
        btcHolding: balances[this.baseCcy] ?? 0,
      };
    } catch (e) {
      console.error(`[${this.name}] balance fetch failed:`, e);
      return null;
    }
  }

  /**
   * Turns an acknowledged order into a Fill by polling for the actual execution.
   * OKX charges fees in either currency depending on side, so both are
   * normalised to USD here.
   */
  private async settle(ordId: string, action: "buy" | "sell", refPrice: number): Promise<Fill | null> {
    const detail = await okx.waitForFill(this.cfg, ordId);
    if (!detail) {
      console.error(`[${this.name}] order ${ordId} placed but never became queryable`);
      return null;
    }
    const filledBtc = parseFloat(detail.accFillSz || "0");
    if (filledBtc <= 0) {
      console.warn(`[${this.name}] order ${ordId} ended ${detail.state} with no fill`);
      return null;
    }
    const avgPx = parseFloat(detail.avgPx || "0") || refPrice;
    const feeRaw = Math.abs(parseFloat(detail.fee || "0"));
    // fee is charged in feeCcy: quote ccy on sells, base ccy on buys.
    const feeUsd = detail.feeCcy === this.baseCcy ? feeRaw * avgPx : feeRaw;

    return {
      action,
      price: avgPx,
      btcAmount: filledBtc,
      usdValue: filledBtc * avgPx,
      feeUsd,
      venueOrderId: ordId,
    };
  }

  async buy(usdAmount: number, refPrice: number): Promise<Fill | null> {
    if (usdAmount <= 0) return null;
    try {
      const rules = await this.rules();
      // Spot market buys are sized in quote currency, so the minSz floor (a base
      // quantity) has to be converted before it can be compared.
      const minNotional = parseFloat(rules.minSz) * refPrice;
      if (usdAmount < minNotional) {
        console.warn(
          `[${this.name}] buy of $${usdAmount.toFixed(2)} is below the ` +
          `${rules.minSz} ${this.baseCcy} minimum (~$${minNotional.toFixed(2)}) — skipped`
        );
        return null;
      }
      const order = await okx.placeMarketOrder(this.cfg, "buy", okx.roundQuote(usdAmount));
      return await this.settle(order.ordId, "buy", refPrice);
    } catch (e) {
      console.error(`[${this.name}] buy failed:`, e);
      return null;
    }
  }

  async sell(btcAmount: number, refPrice: number): Promise<Fill | null> {
    if (btcAmount <= 0) return null;
    try {
      const rules = await this.rules();
      const sz = okx.roundToLot(btcAmount, rules.lotSz);
      if (parseFloat(sz) < parseFloat(rules.minSz)) {
        console.warn(
          `[${this.name}] sell of ${sz} ${this.baseCcy} is below the ` +
          `${rules.minSz} minimum — skipped`
        );
        return null;
      }
      const order = await okx.placeMarketOrder(this.cfg, "sell", sz);
      return await this.settle(order.ordId, "sell", refPrice);
    } catch (e) {
      console.error(`[${this.name}] sell failed:`, e);
      return null;
    }
  }
}

// ─── Selection ────────────────────────────────────────────────────────

let cachedReal: ExecutionVenue | null = null;
let cachedResolved = false;

/**
 * The real-money (or demo-money) venue, if one is configured. Null means the
 * paper ledger is the only book.
 *
 * This is separate from getExecutionVenue() because the paper ledger ALWAYS
 * runs — it is the analysis baseline. Configuring OKX adds a second book beside
 * it rather than replacing it.
 */
export function getRealVenue(): ExecutionVenue | null {
  if (cachedResolved) return cachedReal;
  cachedResolved = true;
  const v = resolveRealVenue();
  cachedReal = v;
  return cachedReal;
}

function resolveRealVenue(): ExecutionVenue | null {
  const requested = (process.env.EXECUTION_VENUE ?? "internal").toLowerCase();
  if (requested !== "okx-demo" && requested !== "okx-live") return null;

  const cfg = okx.getOkxConfig();
  if (!cfg) {
    console.error(
      `[ExecutionVenue] EXECUTION_VENUE=${requested} but OKX_API_KEY / OKX_SECRET_KEY / ` +
      `OKX_PASSPHRASE are not all set. Paper ledger only.`
    );
    return null;
  }
  // Guard against the dangerous mismatch: asking for demo while holding a live
  // key, or asking for live while OKX_DEMO=1 silently routes to the simulator.
  if (requested === "okx-demo" && !cfg.demo) {
    console.error(
      "[ExecutionVenue] EXECUTION_VENUE=okx-demo requires OKX_DEMO=1 (and a Demo Trading " +
      "API key). Refusing to trade a live account by accident — paper ledger only."
    );
    return null;
  }
  if (requested === "okx-live" && cfg.demo) {
    console.error(
      "[ExecutionVenue] EXECUTION_VENUE=okx-live but OKX_DEMO=1. Refusing to guess which " +
      "you meant — paper ledger only. Unset OKX_DEMO to trade live."
    );
    return null;
  }
  if (requested === "okx-live") {
    console.warn(
      `[ExecutionVenue] ⚠ LIVE TRADING ENABLED on ${cfg.baseUrl} (${cfg.instId}). ` +
      `Real funds will be spent.`
    );
  } else {
    console.log(`[ExecutionVenue] OKX demo trading enabled (${cfg.instId}).`);
  }
  return new OkxVenue(cfg);
}

let cached: ExecutionVenue | null = null;

/**
 * Resolves the configured venue, falling back to the internal paper ledger
 * whenever OKX is requested but not properly configured. Failing closed matters
 * here: a misconfigured live venue must never silently become a no-op that the
 * dashboard still reports as a filled trade.
 */
export function getExecutionVenue(): ExecutionVenue {
  if (cached) return cached;

  const requested = (process.env.EXECUTION_VENUE ?? "internal").toLowerCase();

  if (requested === "okx-demo" || requested === "okx-live") {
    const cfg = okx.getOkxConfig();
    if (!cfg) {
      console.error(
        `[ExecutionVenue] EXECUTION_VENUE=${requested} but OKX_API_KEY / OKX_SECRET_KEY / ` +
        `OKX_PASSPHRASE are not all set. Falling back to the internal paper ledger.`
      );
      cached = new InternalVenue();
      return cached;
    }
    // Guard against the dangerous mismatch: asking for demo while holding a live
    // key, or asking for live while OKX_DEMO=1 silently routes to the simulator.
    if (requested === "okx-demo" && !cfg.demo) {
      console.error(
        "[ExecutionVenue] EXECUTION_VENUE=okx-demo requires OKX_DEMO=1 (and a Demo Trading " +
        "API key). Refusing to trade a live account by accident — using the internal ledger."
      );
      cached = new InternalVenue();
      return cached;
    }
    if (requested === "okx-live" && cfg.demo) {
      console.error(
        "[ExecutionVenue] EXECUTION_VENUE=okx-live but OKX_DEMO=1. Refusing to guess which " +
        "you meant — using the internal ledger. Unset OKX_DEMO to trade live."
      );
      cached = new InternalVenue();
      return cached;
    }
    if (requested === "okx-live") {
      console.warn(
        `[ExecutionVenue] ⚠ LIVE TRADING ENABLED on ${cfg.baseUrl} (${cfg.instId}). ` +
        `Real funds will be spent.`
      );
    } else {
      console.log(`[ExecutionVenue] OKX demo trading enabled (${cfg.instId}).`);
    }
    cached = new OkxVenue(cfg);
    return cached;
  }

  cached = new InternalVenue();
  return cached;
}

/**
 * Resolves the configured venue at startup and reports what it decided.
 *
 * Venue resolution is otherwise lazy — first triggered inside
 * executeSignalTrade — so a misconfiguration stays invisible until a signal
 * finally confirms, which can be many hours after the deploy that caused it.
 * That is the worst possible time to discover the venue quietly fell back to
 * paper. Calling this at boot turns a silent 3am surprise into a log line at
 * the moment of the change, and the credential probe means "enabled" reflects
 * a real authenticated round trip rather than merely well-formed config.
 *
 * Never throws: a venue that cannot be reached must not stop the server. It
 * degrades to paper, which is exactly what getRealVenue() already does.
 */
/**
 * Creates the allocated OKX book on first use, sized to OKX_BOOK_CAPITAL_SGD and
 * split to match the paper book's current BTC weight.
 *
 * Matching the weight matters: sizing is fractional, so absolute size is
 * irrelevant to comparing the books, but a different starting ALLOCATION makes
 * the two curves diverge for reasons that have nothing to do with execution
 * quality — which is the only thing the comparison is meant to measure.
 *
 * Does nothing if the book already exists, so it never overwrites a running one.
 */
export async function seedAllocatedBook(venueName: string, btcPrice: number): Promise<void> {
  const capitalSgd = okxBookCapitalSgd();
  if (capitalSgd <= 0) return;

  const existing = await db.getSimulatorState(venueName);
  if (existing) return;

  const rate = await okx.fetchUsdtSgdRate();
  if (!rate) {
    console.error(`[ExecutionVenue] cannot seed ${venueName}: USDT-SGD rate unavailable`);
    return;
  }
  const capitalUsdt = capitalSgd / rate;

  // Mirror the paper book's BTC weight so the two start comparable.
  const paper = await db.getSimulatorState(db.INTERNAL_VENUE);
  const paperTotal = paper ? paper.cashUsd + paper.btcHolding * btcPrice : 0;
  const btcWeight = paper && paperTotal > 0 ? (paper.btcHolding * btcPrice) / paperTotal : 0.5;

  const btcHolding = (capitalUsdt * btcWeight) / btcPrice;
  const cashUsd = capitalUsdt * (1 - btcWeight);

  await db.initSimulatorState(venueName);
  await db.updateSimulatorState(
    { cashUsd, btcHolding, totalValueUsd: capitalUsdt, lastPrice: btcPrice },
    venueName
  );
  console.log(
    `[ExecutionVenue] seeded ${venueName} book with SGD ${capitalSgd.toLocaleString()} ` +
    `(${capitalUsdt.toFixed(2)} USDT @ ${rate}) — ${cashUsd.toFixed(2)} cash / ` +
    `${btcHolding.toFixed(8)} BTC, matching the paper book's ${(btcWeight * 100).toFixed(1)}% BTC weight`
  );
}

export async function announceExecutionVenue(): Promise<void> {
  const requested = (process.env.EXECUTION_VENUE ?? "internal").toLowerCase();
  const real = getRealVenue();

  if (!real) {
    if (requested === "internal") {
      console.log("[ExecutionVenue] Paper ledger only (EXECUTION_VENUE=internal).");
    } else {
      console.error(
        `[ExecutionVenue] ⚠ EXECUTION_VENUE=${requested} did NOT take — running paper-only. ` +
        `See the error above for why.`
      );
    }
    return;
  }

  try {
    const snap = await real.snapshot();
    if (!snap) {
      console.error(
        `[ExecutionVenue] ⚠ ${real.name} is configured but its balance could not be read. ` +
        `Orders will fail and, in lockstep, the paper book will skip those trades too.`
      );
      return;
    }
    if (isAllocatedBook()) {
      try {
        const t = await okx.fetchTicker();
        await seedAllocatedBook(real.name, parseFloat(t.last));
      } catch (e) {
        console.error(`[ExecutionVenue] could not seed the allocated book:`, e);
      }
      const book = await db.getSimulatorState(real.name);
      console.log(
        `[ExecutionVenue] ${real.name} ACTIVE (allocated book) — ` +
        `${book?.cashUsd.toFixed(2) ?? "?"} cash / ${book?.btcHolding ?? "?"} BTC. ` +
        `Account holds ${snap.cashUsd.toFixed(2)} quote / ${snap.btcHolding} base; ` +
        `only the allocation is traded.`
      );
    } else {
      console.log(
        `[ExecutionVenue] ${real.name} ACTIVE alongside the paper ledger — ` +
        `holdings ${snap.cashUsd.toFixed(2)} quote / ${snap.btcHolding} base`
      );
    }
    if (snap.cashUsd <= 0 && snap.btcHolding <= 0) {
      console.error(
        `[ExecutionVenue] ⚠ ${real.name} holds nothing. Every order will be rejected, and ` +
        `lockstep means the paper book stops trading too. Fund the account.`
      );
    }
  } catch (e) {
    console.error(`[ExecutionVenue] ⚠ ${real.name} health check failed:`, e);
  }
}

/** Test seam — clears the memoized venues so env changes take effect. */
export function resetExecutionVenue(): void {
  cached = null;
  cachedReal = null;
  cachedResolved = false;
}

// ─── Shared trade execution ───────────────────────────────────────────

/**
 * Sizes and executes a signal, then records the result.
 *
 * This is the single path used by both the scheduled heartbeat and the manual
 * "Generate Signal" action. Position sizing is unchanged from the original
 * inline implementations: a buy spends `maxPositionPct` of available cash, a
 * sell disposes of `maxPositionPct` of BTC held.
 *
 * The recorded cash/BTC balances come from the venue after the fill, so on OKX
 * the database mirrors the real account rather than a parallel guess at it.
 */
export async function executeSignalTrade(opts: {
  action: "buy" | "sell";
  price: number;
  params: StrategyParameters;
  /** Signal confidence, for conviction sizing. Omitted → base size unscaled. */
  confidence?: number;
  /** Candle interval, so the cooldown is measured in bars rather than wall time. */
  candleInterval?: string;
  reasoning?: string;
  signalId?: number;
  ts?: number;
}): Promise<{ paper: Fill | null; real: Fill | null; skipped?: string }> {
  const { action, price, params, reasoning, signalId } = opts;
  const ts = opts.ts ?? Date.now();
  const real = getRealVenue();

  // ── Turnover control ───────────────────────────────────────────────
  // Both gates are evaluated ONCE, against the paper book, and applied to both
  // books. The paper ledger is the canonical strategy state; letting each book
  // gate itself would let them diverge on cooldown or size and break lockstep.
  const intervalMs = INTERVAL_MS[opts.candleInterval ?? "1h"] ?? 3600_000;
  const [lastTrade] = await db.getRecentTrades(1, db.INTERNAL_VENUE);
  if (lastTrade) {
    const barsSince = (ts - lastTrade.ts) / intervalMs;
    if (barsSince < TRADE_COOLDOWN_BARS) {
      const wait = (TRADE_COOLDOWN_BARS - barsSince).toFixed(1);
      console.log(
        `[ExecutionVenue] ${action.toUpperCase()} skipped — cooldown ` +
        `(${barsSince.toFixed(1)}/${TRADE_COOLDOWN_BARS} bars, ${wait} to go)`
      );
      return { paper: null, real: null, skipped: "cooldown" };
    }
  }

  // ── Conviction sizing ──────────────────────────────────────────────
  const fraction =
    opts.confidence === undefined
      ? params.maxPositionPct
      : convictionScaledFraction(params.maxPositionPct, opts.confidence, params.minConfidence);

  // ── Minimum notional ───────────────────────────────────────────────
  let paperState = await db.getSimulatorState(db.INTERNAL_VENUE);
  if (!paperState) paperState = (await db.initSimulatorState(db.INTERNAL_VENUE)) ?? null;
  if (!paperState || !paperState.isRunning) return { paper: null, real: null, skipped: "not-running" };

  const notional =
    action === "buy"
      ? paperState.cashUsd * fraction
      : paperState.btcHolding * fraction * price;
  if (notional < MIN_TRADE_NOTIONAL_USD) {
    console.log(
      `[ExecutionVenue] ${action.toUpperCase()} skipped — $${notional.toFixed(2)} ` +
      `below the $${MIN_TRADE_NOTIONAL_USD} minimum notional`
    );
    return { paper: null, real: null, skipped: "too-small" };
  }

  // ── Reality first ──────────────────────────────────────────────────
  // In lockstep mode the paper book only records what actually happened, so a
  // rejected, undersized or unfilled OKX order means neither book moves. The
  // difference between the two curves is then purely execution quality —
  // slippage and fees — rather than trades reality never took.
  let realFill: Fill | null = null;
  if (real) {
    realFill = await executeOnVenue(real, real.name, opts, ts, fraction);
    if (!realFill) {
      console.warn(
        `[ExecutionVenue] ${real.name} did not fill — paper book skipped too (lockstep).`
      );
      return { paper: null, real: null };
    }
  }

  // ── Paper ledger ───────────────────────────────────────────────────
  // Always runs: it is the analysis baseline. It executes at the reference
  // price with its own fee assumption, deliberately NOT the venue's fill price,
  // so the gap between the books measures execution cost.
  const paperFill = await executeOnVenue(new InternalVenue(), db.INTERNAL_VENUE, opts, ts, fraction);

  return { paper: paperFill, real: realFill };
}

/**
 * Sizes and executes against one venue, then records the result under that
 * venue's book. Sizing is unchanged from the original inline implementations:
 * a buy spends `maxPositionPct` of available cash, a sell disposes of
 * `maxPositionPct` of BTC held — each measured against that venue's own
 * holdings, so the two books size independently as they drift apart.
 */
async function executeOnVenue(
  venue: ExecutionVenue,
  bookName: string,
  opts: {
    action: "buy" | "sell";
    price: number;
    params: StrategyParameters;
    reasoning?: string;
    signalId?: number;
  },
  ts: number,
  fraction: number
): Promise<Fill | null> {
  const { action, price, reasoning, signalId } = opts;

  let state = await db.getSimulatorState(bookName);
  if (!state) state = (await db.initSimulatorState(bookName)) ?? null;
  if (!state || !state.isRunning) return null;

  // An allocated book tracks its own ledger: the venue's raw balance is the
  // whole OKX account, not the slice the strategy is allowed to deploy. The
  // paper book is always tracked this way. Otherwise size against the venue's
  // own view, so a deposit or manual trade shows up on the next heartbeat.
  const tracked = bookName === db.INTERNAL_VENUE || isAllocatedBook();
  const holdings = tracked
    ? { cashUsd: state.cashUsd, btcHolding: state.btcHolding }
    : (await venue.snapshot()) ?? { cashUsd: state.cashUsd, btcHolding: state.btcHolding };

  let fill: Fill | null = null;
  if (action === "buy") {
    if (holdings.cashUsd <= 0) return null;
    fill = await venue.buy(holdings.cashUsd * fraction, price);
  } else {
    if (holdings.btcHolding <= 0) return null;
    fill = await venue.sell(holdings.btcHolding * fraction, price);
  }
  if (!fill) return null;

  // Apply the fill to the tracked ledger. For an allocated book this MUST be
  // arithmetic — re-reading the venue would replace the allocation with the
  // whole account balance and silently undo the allocation on the first trade.
  const arithmetic = {
    cashUsd:
      action === "buy"
        ? holdings.cashUsd - fill.usdValue
        : holdings.cashUsd + fill.usdValue - fill.feeUsd,
    btcHolding:
      action === "buy"
        ? holdings.btcHolding + fill.btcAmount
        : holdings.btcHolding - fill.btcAmount,
  };
  const after = tracked ? arithmetic : (await venue.snapshot()) ?? arithmetic;

  const totalValue = after.cashUsd + after.btcHolding * fill.price;

  await db.updateSimulatorState(
    {
      cashUsd: after.cashUsd,
      btcHolding: after.btcHolding,
      totalValueUsd: totalValue,
      lastPrice: fill.price,
    },
    bookName
  );

  await db.insertSimulatorTrade({
    signalId,
    action,
    price: fill.price,
    btcAmount: fill.btcAmount,
    usdValue: fill.usdValue,
    cashAfter: after.cashUsd,
    btcAfter: after.btcHolding,
    totalValueAfter: totalValue,
    reasoning,
    ts,
    venue: bookName,
    venueOrderId: fill.venueOrderId,
    feeUsd: fill.feeUsd,
  });

  return fill;
}
