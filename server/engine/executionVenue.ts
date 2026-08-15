/**
 * Execution Venue
 *
 * Separates *what to trade* (the signal engine) from *where the trade happens*.
 * Before this existed, ledger arithmetic was inlined in two places —
 * heartbeatHandler.ts and routers.ts — which meant the scheduled path and the
 * manual "Generate Signal" button could drift apart silently.
 *
 * Three venues, selected by the EXECUTION_VENUE environment variable:
 *
 *   internal   (default)  Pure in-database paper ledger. Current behaviour.
 *   okx-demo             Real orders against OKX's simulated environment.
 *                        Real order book, real rounding, real rejections,
 *                        real fees — no real money.
 *   okx-live             Real orders against the real account.
 *
 * The intended progression is internal → okx-demo → okx-live, running okx-demo
 * alongside the internal ledger long enough to see how far the two diverge. That
 * divergence is the execution error a backtest cannot model: slippage, partial
 * fills, minimum sizes, and the latency between deciding and filling.
 *
 * SAFETY: okx-live is never selected implicitly. It requires
 * EXECUTION_VENUE=okx-live *and* OKX_DEMO to be unset/0, and it logs loudly at
 * construction. Everything else falls back to the internal paper ledger.
 */

import * as db from "../db";
import * as okx from "./okxClient";
import type { StrategyParameters } from "../../shared/tradingTypes";

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

/** Test seam — clears the memoized venue so env changes take effect. */
export function resetExecutionVenue(): void {
  cached = null;
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
  reasoning?: string;
  signalId?: number;
  ts?: number;
}): Promise<Fill | null> {
  const { action, price, params, reasoning, signalId } = opts;
  const ts = opts.ts ?? Date.now();
  const venue = getExecutionVenue();

  let state = await db.getSimulatorState();
  if (!state) state = (await db.initSimulatorState()) ?? null;
  if (!state || !state.isRunning) return null;

  // Size against the venue's own view of the account when it has one, so an OKX
  // deposit, withdrawal or manual trade is reflected on the next heartbeat.
  const holdings = (await venue.snapshot()) ?? {
    cashUsd: state.cashUsd,
    btcHolding: state.btcHolding,
  };

  let fill: Fill | null = null;
  if (action === "buy") {
    if (holdings.cashUsd <= 0) return null;
    fill = await venue.buy(holdings.cashUsd * params.maxPositionPct, price);
  } else {
    if (holdings.btcHolding <= 0) return null;
    fill = await venue.sell(holdings.btcHolding * params.maxPositionPct, price);
  }
  if (!fill) return null;

  // Re-read the venue after the fill; fall back to arithmetic if unreachable.
  const after = (await venue.snapshot()) ?? {
    cashUsd:
      action === "buy"
        ? holdings.cashUsd - fill.usdValue
        : holdings.cashUsd + fill.usdValue - fill.feeUsd,
    btcHolding:
      action === "buy"
        ? holdings.btcHolding + fill.btcAmount
        : holdings.btcHolding - fill.btcAmount,
  };

  const totalValue = after.cashUsd + after.btcHolding * fill.price;

  await db.updateSimulatorState({
    cashUsd: after.cashUsd,
    btcHolding: after.btcHolding,
    totalValueUsd: totalValue,
    lastPrice: fill.price,
  });

  const venueNote =
    venue.name === "internal"
      ? ""
      : `\n\n── Execution ──\nvenue: ${venue.name}` +
        `\norder: ${fill.venueOrderId ?? "n/a"}` +
        `\nfill: ${fill.btcAmount} BTC @ $${fill.price.toFixed(2)}` +
        `\nfee: $${fill.feeUsd.toFixed(4)}`;

  await db.insertSimulatorTrade({
    signalId,
    action,
    price: fill.price,
    btcAmount: fill.btcAmount,
    usdValue: fill.usdValue,
    cashAfter: after.cashUsd,
    btcAfter: after.btcHolding,
    totalValueAfter: totalValue,
    reasoning: reasoning ? `${reasoning}${venueNote}` : venueNote || undefined,
    ts,
  });

  return fill;
}
