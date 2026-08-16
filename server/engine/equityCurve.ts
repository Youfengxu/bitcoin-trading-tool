/**
 * Reconstructs a book's equity curve from its trades and a price series.
 *
 * ── Why this is needed ────────────────────────────────────────────────
 * Drawdown was computed by walking `trades[].totalValueAfter`, which samples
 * equity ONLY at the moments a trade happened. Under the engine that was a rough
 * proxy — hundreds of trades meant hundreds of samples. Under the static
 * allocation it is meaningless: the book trades roughly once a quarter, so the
 * curve has ~4 points a year and a 30% intra-quarter drawdown between two trades
 * is invisible. It would report ~0% drawdown for almost any market.
 *
 * Holdings only change AT a trade, so between trades the book's value is exactly
 * `cash + btc × price`. Combining the trade ledger with the price snapshots the
 * app already records each heartbeat therefore recovers the true curve at
 * heartbeat resolution, independent of how often the strategy trades.
 *
 * This matters beyond cosmetics: drawdown is the axis on which the static
 * allocation was chosen over the engine, so measuring it with a method that
 * silently favours low-turnover strategies would beg the question.
 */

export interface TradePoint {
  ts: number;
  cashAfter: number;
  btcAfter: number;
}

export interface PricePoint {
  ts: number;
  price: number;
}

export interface EquityPoint {
  ts: number;
  value: number;
}

/**
 * Builds the curve. `trades` and `prices` may be in any order; both are sorted
 * defensively because the DB helpers return newest-first.
 *
 * Points before the first trade are omitted: holdings are unknown there, and
 * guessing them would invent a curve rather than reconstruct one. `current`
 * appends today's mark so an open drawdown is visible before the next trade
 * closes it — without it a book that has fallen since its last trade would
 * report the drawdown as of that trade, not as of now.
 */
export function reconstructEquity(
  trades: TradePoint[],
  prices: PricePoint[],
  current?: { cashUsd: number; btcHolding: number; price: number; ts: number }
): EquityPoint[] {
  const t = [...trades].sort((a, b) => a.ts - b.ts);
  const p = [...prices].sort((a, b) => a.ts - b.ts);
  if (t.length === 0) {
    // No trades at all means holdings have NEVER changed since seeding, so the
    // current cash/BTC are also the historical cash/BTC and the whole series can
    // be valued from them. This is the normal case for a freshly seeded book and
    // for the static allocation between rebalances — returning a single point
    // there would make an untraded book look like it had no history to measure,
    // when in fact its history is fully recoverable.
    if (!current) return [];
    const out = p.map((pt) => ({ ts: pt.ts, value: current.cashUsd + current.btcHolding * pt.price }));
    const last = out[out.length - 1];
    if (!last || current.ts > last.ts) {
      out.push({ ts: current.ts, value: current.cashUsd + current.btcHolding * current.price });
    }
    return out;
  }

  const out: EquityPoint[] = [];
  let ti = 0;
  let cash = t[0].cashAfter;
  let btc = t[0].btcAfter;

  for (const point of p) {
    if (point.ts < t[0].ts) continue;
    while (ti + 1 < t.length && t[ti + 1].ts <= point.ts) {
      ti++;
      cash = t[ti].cashAfter;
      btc = t[ti].btcAfter;
    }
    out.push({ ts: point.ts, value: cash + btc * point.price });
  }

  // Trades occurring after the last price snapshot are deliberately NOT added:
  // valuing them would need a price we do not have, and substituting a
  // placeholder invents a data point rather than reconstructing one. A price
  // snapshot is written every heartbeat, so such a trade is at most one bar old
  // and `current` already represents it.
  if (current) {
    const last = out[out.length - 1];
    const value = current.cashUsd + current.btcHolding * current.price;
    if (!last || current.ts > last.ts) out.push({ ts: current.ts, value });
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/** Maximum peak-to-trough decline over the curve, as a fraction in [0,1]. */
export function maxDrawdown(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0;
  let peak = curve[0].value;
  let worst = 0;
  for (const pt of curve) {
    if (pt.value > peak) peak = pt.value;
    if (peak > 0) {
      const dd = (peak - pt.value) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

// ─── Risk-adjusted metrics ────────────────────────────────────────────

/**
 * Minimum evidence before a risk-adjusted ratio is reported at all.
 *
 * Ratios of a mean to a standard deviation are extremely unstable in small
 * samples, and annualising multiplies that instability by sqrt(periods/year) —
 * so a short window does not produce a rough number, it produces a confident
 * looking wrong one. Below these thresholds the metrics return null so the UI
 * can show "—" instead of inventing a figure.
 */
export const MIN_RETURN_SAMPLES = 30;
export const MIN_SPAN_DAYS = 14;

export interface RiskMetrics {
  /** Annualised, risk-free rate taken as 0. Null when there is too little data. */
  sharpe: number | null;
  /** Like Sharpe but penalising only downside deviation. */
  sortino: number | null;
  /** Annualised return divided by max drawdown. Well-behaved when returns are negative. */
  calmar: number | null;
  annualisedReturn: number | null;
  periodsPerYear: number;
  samples: number;
  spanDays: number;
  /**
   * True when the mean return is negative, where SHARPE INVERTS: reducing
   * volatility makes it more negative, so it penalises exactly the risk
   * reduction a defensive strategy exists to provide. Ranking strategies by
   * Sharpe over a losing period rewards the one that lost more wildly. Callers
   * must surface this rather than print the number bare — prefer Calmar here.
   */
  meanNegative: boolean;
}

const EMPTY: RiskMetrics = {
  sharpe: null, sortino: null, calmar: null, annualisedReturn: null,
  periodsPerYear: 0, samples: 0, spanDays: 0, meanNegative: false,
};

/**
 * Risk metrics computed from the equity curve itself.
 *
 * Deriving the annualisation factor from the curve's own median spacing rather
 * than assuming a fixed period keeps this correct across the 5m/15m/1h/4h/1d
 * intervals the app supports, and across gaps in the series.
 */
export function riskMetrics(curve: EquityPoint[]): RiskMetrics {
  if (curve.length < 2) return EMPTY;
  const c = [...curve].sort((a, b) => a.ts - b.ts);

  const rets: number[] = [];
  const gaps: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1].value > 0) rets.push(c[i].value / c[i - 1].value - 1);
    if (c[i].ts > c[i - 1].ts) gaps.push(c[i].ts - c[i - 1].ts);
  }
  const spanMs = c[c.length - 1].ts - c[0].ts;
  const spanDays = spanMs / 86400_000;
  if (!rets.length || !gaps.length) return { ...EMPTY, samples: rets.length, spanDays };

  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const periodsPerYear = medianGap > 0 ? (365 * 86400_000) / medianGap : 0;

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const meanNegative = mean < 0;
  const base = { periodsPerYear, samples: rets.length, spanDays, meanNegative };

  if (rets.length < MIN_RETURN_SAMPLES || spanDays < MIN_SPAN_DAYS) {
    return { ...EMPTY, ...base };
  }

  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const downside = rets.filter((r) => r < 0);
  const dd = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / rets.length)
    : 0;

  const total = c[c.length - 1].value / c[0].value - 1;
  const annualisedReturn = spanDays > 0 ? Math.pow(1 + total, 365 / spanDays) - 1 : null;
  const drawdown = maxDrawdown(c);

  return {
    ...base,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null,
    sortino: dd > 0 ? (mean / dd) * Math.sqrt(periodsPerYear) : null,
    calmar: drawdown > 0 && annualisedReturn !== null ? annualisedReturn / drawdown : null,
    annualisedReturn,
  };
}
