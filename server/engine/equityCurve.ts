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
    // No trades: holdings never changed, so the current mark is all we can honestly place.
    return current ? [{ ts: current.ts, value: current.cashUsd + current.btcHolding * current.price }] : [];
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
