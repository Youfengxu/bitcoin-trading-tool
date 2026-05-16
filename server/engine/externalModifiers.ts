/**
 * External Market Signal Modifiers
 *
 * Applies multipliers to the raw buy/sell scores produced by signalGenerator.ts
 * based on external market data that the indicator pipeline cannot see:
 *
 *   1. Perpetual funding rate (Bybit)   — crowded-long / smart-money-short detection
 *   2. Fear & Greed Index (alternative.me) — sentiment extremes
 *   3. US 10Y yield velocity           — risk-off capital rotation
 *   4. ETF demand proxy (IBIT / Yahoo Finance)
 *        7-day rolling sum of sign(daily_return) × dollar_volume.
 *        Positive = net institutional buying; negative = net selling.
 *        Direction tracks Farside-reported actual flows; magnitude is ~5x larger
 *        because full volume (not just net flow) is used.
 *
 * All modifiers are multiplicative, matching the CUSUM (×1.2) and volume (×1.15)
 * pattern already present in signalGenerator.ts.  They amplify a directional lean
 * already present in the indicators — they cannot manufacture a signal from a
 * perfectly neutral indicator reading.
 *
 * This module is shared by:
 *   - server/heartbeatHandler.ts  (production, live signals)
 *   - server/scripts/historicalSignalReplay.ts  (backtesting / hypothesis testing)
 *
 * Threshold design principle: values are derived from first principles (e.g.
 * "funding > 0.10%/8h is historically extreme crowding"), not fitted to any
 * specific dataset window.
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface ExternalSignals {
  /** Bybit 8h perpetual funding rate (e.g. 0.0001 = 0.01%/8h) */
  fundingRate: number | null;
  /**
   * True when funding rate just flipped from positive to negative AND
   * current price is within 5% of the 14-day rolling high.
   * Signals smart-money building shorts near resistance.
   */
  fundingNegDivergence: boolean;
  /** alternative.me Fear & Greed Index, 0 (extreme fear) – 100 (extreme greed) */
  fearGreed: number | null;
  /** US 10Y Treasury daily yield change in percentage points.
   *  Positive = yields rising (risk-off pressure on equities and crypto). */
  yieldVelocity: number | null;
  /**
   * BTC spot ETF aggregate net flow 7-day SMA in $M/day (SosoValue, when available).
   * Negative = sustained net redemptions = structural sell pressure.
   * null when SosoValue is unreachable (blocked by Cloudflare as of May 2026).
   */
  etfNetflow7dSma: number | null;
  /**
   * IBIT 7-day rolling signed-flow proxy, in $M.
   *   Computed as: Σ sign(daily_return) × dollar_volume  over last 7 trading days.
   *   > 0 = net institutional demand (inflow regime).
   *   < 0 = net institutional selling (outflow regime).
   *
   * Calibrated thresholds (proxy scale ~5x actual Farside flows):
   *   > $4,000M  → strong inflow streak (Oct 2025 ATH run pattern)
   *   > $1,500M  → moderate sustained inflows
   *   < −$800M   → moderate outflows
   *   < −$2,000M → heavy outflows (like the $635M single-day May 13 2026 event)
   */
  ibitFlow7d: number | null;
}

// ─── Modifier Engine ─────────────────────────────────────────────────

/**
 * Apply all external signal modifiers to raw buy/sell scores.
 *
 * Returns:
 *  - modBuy / modSell: adjusted scores, ready for signalFromScores()
 *  - mods: human-readable list of active modifiers for logging / Telegram
 */
export function applyExternalModifiers(
  rawBuy:  number,
  rawSell: number,
  ext:     ExternalSignals,
): { modBuy: number; modSell: number; mods: string[] } {
  let mBuy  = rawBuy;
  let mSell = rawSell;
  const mods: string[] = [];

  // 1. Funding rate — extreme long crowding → sell pressure
  if (ext.fundingRate !== null) {
    if (ext.fundingRate > 0.001) {        // > 0.10%/8h — extreme
      mSell *= 1.25;
      mBuy  *= 0.85;
      mods.push(`fund=+${(ext.fundingRate * 100).toFixed(3)}%[extreme×1.25]`);
    } else if (ext.fundingRate > 0.0005) { // > 0.05%/8h — elevated
      mSell *= 1.10;
      mods.push(`fund=+${(ext.fundingRate * 100).toFixed(3)}%[long×1.10]`);
    }
  }

  // 2. Funding negative divergence — smart money building shorts near resistance
  if (ext.fundingNegDivergence) {
    mSell *= 1.15;
    mods.push(`fund-flip-neg[smart-short×1.15]`);
  }

  // 3. Fear & Greed — sentiment extremes
  if (ext.fearGreed !== null) {
    if (ext.fearGreed >= 80) {     // Extreme Greed — historically precedes corrections
      mBuy  *= 0.80;
      mSell *= 1.10;
      mods.push(`F&G=${ext.fearGreed}[greed buy×0.80 sell×1.10]`);
    } else if (ext.fearGreed <= 20) { // Extreme Fear — suppresses false sells
      mSell *= 0.85;
      mods.push(`F&G=${ext.fearGreed}[fear sell×0.85]`);
    }
  }

  // 4. Yield velocity — sharp spike = risk-off capital rotation out of crypto
  if (ext.yieldVelocity !== null) {
    if (ext.yieldVelocity > 0.15) {      // > 15bps/day — significant
      mSell *= 1.15;
      mBuy  *= 0.90;
      mods.push(`US10Y+${ext.yieldVelocity.toFixed(2)}bps[risk-off×1.15]`);
    } else if (ext.yieldVelocity > 0.08) { // > 8bps/day — moderate
      mSell *= 1.08;
      mods.push(`US10Y+${ext.yieldVelocity.toFixed(2)}bps[risk-off×1.08]`);
    }
  }

  // 5. Actual ETF netflow SMA (SosoValue) — takes priority over IBIT proxy when available
  if (ext.etfNetflow7dSma !== null) {
    if (ext.etfNetflow7dSma < -300) {      // > $300M/day net outflow
      mSell *= 1.20;
      mods.push(`ETF-SMA=${ext.etfNetflow7dSma.toFixed(0)}M/d[inst-exit×1.20]`);
    } else if (ext.etfNetflow7dSma < -100) { // > $100M/day — moderate exit
      mSell *= 1.10;
      mods.push(`ETF-SMA=${ext.etfNetflow7dSma.toFixed(0)}M/d[inst-exit×1.10]`);
    } else if (ext.etfNetflow7dSma > 300) {  // > $300M/day inflow — strong demand
      mBuy  *= 1.15;
      mods.push(`ETF-SMA=+${ext.etfNetflow7dSma.toFixed(0)}M/d[inst-inflow buy×1.15]`);
    }
  }

  // 6. IBIT signed-flow proxy — institutional ETF demand direction
  //    Only fires when actual SosoValue data is absent (prevents double-counting).
  if (ext.ibitFlow7d !== null && ext.etfNetflow7dSma === null) {
    if (ext.ibitFlow7d > 4000) {        // Strong inflow streak → amplify buy
      mBuy  *= 1.20;
      mSell *= 0.88;
      mods.push(`IBIT-7d=+${ext.ibitFlow7d.toFixed(0)}M[strong-inflow buy×1.20]`);
    } else if (ext.ibitFlow7d > 1500) { // Moderate inflows → mild buy boost
      mBuy  *= 1.12;
      mods.push(`IBIT-7d=+${ext.ibitFlow7d.toFixed(0)}M[inflow buy×1.12]`);
    } else if (ext.ibitFlow7d < -2000) { // Heavy outflows (like $635M single-day) → amplify sell
      mSell *= 1.20;
      mBuy  *= 0.90;
      mods.push(`IBIT-7d=${ext.ibitFlow7d.toFixed(0)}M[heavy-outflow sell×1.20]`);
    } else if (ext.ibitFlow7d < -800) {  // Moderate outflows
      mSell *= 1.10;
      mods.push(`IBIT-7d=${ext.ibitFlow7d.toFixed(0)}M[outflow sell×1.10]`);
    }
  }

  return { modBuy: mBuy, modSell: mSell, mods };
}

// ─── Signal Re-evaluation ─────────────────────────────────────────────

/**
 * Re-evaluate a buy/sell/hold signal from modifier-adjusted raw scores.
 * Mirrors the final threshold comparison in signalGenerator.ts.
 */
export function signalFromScores(
  buy:     number,
  sell:    number,
  minConf: number,
): { signal: "buy" | "sell" | "hold"; confidence: number } {
  if (buy > sell && buy >= minConf) {
    return { signal: "buy",  confidence: Math.min(1, buy)  };
  } else if (sell > buy && sell >= minConf) {
    return { signal: "sell", confidence: Math.min(1, sell) };
  } else {
    return { signal: "hold", confidence: 1 - Math.max(buy, sell) };
  }
}
