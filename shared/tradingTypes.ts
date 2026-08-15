/** Supported candle intervals (1m excluded — incompatible with this indicator set). */
export const SUPPORTED_INTERVALS = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type CandleInterval = (typeof SUPPORTED_INTERVALS)[number];

const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
};

/**
 * Returns the number of candles needed to cover SCOPE_DAYS of real-world history,
 * capped at MAX_CANDLES and floored at MIN_CANDLES (SMA-200 minimum + buffer).
 *
 * Using duration-based scope means indicators always reflect the same real-world
 * time window regardless of the candle interval chosen.
 */
const SCOPE_DAYS = 14;
const MIN_CANDLES = 250;
const MAX_CANDLES = 2000;

export function getCandleLimit(interval: string): number {
  const minutes = INTERVAL_MINUTES[interval as CandleInterval] ?? 60;
  const needed = Math.ceil((SCOPE_DAYS * 24 * 60) / minutes);
  return Math.min(MAX_CANDLES, Math.max(MIN_CANDLES, needed));
}

/**
 * Opportunity-cost weight (λ) for per-signal reward scoring.
 * A hold during a 1% absolute price move is penalised by λ × 1%.
 *
 * Used by championChallenger's reward function and the signal validation log,
 * where variants are compared on the SAME signal stream so the term does
 * discriminate between them. The walk-forward optimizer uses OPTIMIZER_LAMBDA
 * below instead — see the evidence recorded there.
 *
 * The earlier note here claimed λ ∈ [0, 1.5] made no out-of-sample difference
 * because the parameter sampler was too narrow. That diagnosis was wrong: the
 * sensitivity harness sliced its test set at the split point, leaving 217 bars
 * of which 200 were consumed as SMA-200 warm-up, so every λ was being scored on
 * 17 bars of near-nothing. Fixed 2026-08-15.
 */
export const OPPORTUNITY_COST_LAMBDA = 0.3;

/**
 * Opportunity-cost weight for the WALK-FORWARD OPTIMIZER specifically. Zero —
 * the term is switched off there, on evidence.
 *
 * The optimizer's objective is `totalReturn − λ × avgHoldRegret`. Measured on
 * 1440 real 1h candles, sweeping minConfidence 0.30 → 0.70:
 *
 *   minConf  trades  netReturn  avgHoldRegret
 *   0.30       252      0.14%       0.002430
 *   0.40        89      2.41%       0.002476
 *   0.55        15      0.17%       0.002615
 *   0.70         0      0.00%       0.002628   ← market mean |1h move|
 *
 * Net return varies 17-fold across that range; avgHoldRegret varies by 8%. As
 * the strategy holds more, its average missed move simply converges on the
 * market's own average absolute move — so the normalised term measures market
 * volatility, not strategy behaviour, and cannot rank candidates. Confirmed
 * directly: λ from 0 to 300 selects identical parameters and the same −2.66%
 * out-of-sample result.
 *
 * The unnormalised sum it replaced did discriminate, but only on hold COUNT,
 * which is turnover for its own sake: it made up 98.7% of the objective's
 * magnitude and pinned minConfidence at 0.30, the floor of the search range —
 * the single worst point on the return curve above.
 *
 * So neither formulation earns its place, and λ=0 leaves the optimizer
 * maximising net-of-fees return. That surface peaks at minConfidence 0.40–0.45,
 * which independently matches the strategyBacktest finding that a 0.45
 * threshold plus turnover control is the most robust configuration.
 *
 * Reinstating a working opportunity-cost term needs a measure that varies with
 * strategy behaviour rather than with market volatility — regret relative to an
 * achievable benchmark, not to an oracle that catches every move.
 */
export const OPTIMIZER_LAMBDA = 0;

/**
 * Below this absolute return, a hold is considered "correctly cautious"
 * (price stayed in noise). Above it, the hold missed a real move.
 * Used to categorise hold outcomes in the signal validation log.
 */
export const HOLD_NOISE_THRESHOLD = 0.005;

/**
 * Minimum signal validation horizon. Below this, price moves are too small
 * to give a meaningful reward signal regardless of cadence.
 */
export const MIN_VALIDATION_HORIZON_MS = 15 * 60 * 1000;

/**
 * Time to wait before evaluating a signal's outcome.
 *
 * Tied to heartbeat cadence so consecutive validation windows do not overlap.
 * Overlapping windows make the champion-challenger paired t-test see
 * autocorrelated differences, inflating apparent significance and risking
 * promotion on noise. Floored at MIN_VALIDATION_HORIZON_MS so very fast
 * cadences still measure a meaningful price move.
 */
export function getValidationHorizonMs(heartbeatScheduleMinutes: number): number {
  const fromSchedule = heartbeatScheduleMinutes * 60 * 1000;
  return Math.max(fromSchedule, MIN_VALIDATION_HORIZON_MS);
}

/**
 * Scales minConfidence upward for sub-hourly intervals to compensate for
 * higher indicator noise at shorter timeframes.
 */
export function getConfidenceMultiplier(interval: string): number {
  switch (interval as CandleInterval) {
    case "5m":  return 1.5;
    case "15m": return 1.2;
    case "30m": return 1.1;
    default:    return 1.0;
  }
}

/** Default strategy parameters used by the signal generator and walk-forward optimizer */
export interface StrategyParameters {
  // RSI thresholds
  rsiBuyThreshold: number;   // buy when RSI < this (oversold)
  rsiSellThreshold: number;  // sell when RSI > this (overbought)

  // MACD
  macdBuyThreshold: number;  // buy when MACD histogram > this
  macdSellThreshold: number; // sell when MACD histogram < this

  // Bollinger Bands
  bbBuyDeviation: number;    // buy when price < lower band by this factor
  bbSellDeviation: number;   // sell when price > upper band by this factor

  // Z-Score (statistical significance)
  zScoreTrendThreshold: number;  // |z| > this = statistically significant trend
  zScoreBlipThreshold: number;   // |z| < this = noise/blip

  // Volume confirmation
  volumeRatioThreshold: number;  // volume ratio > this confirms signal

  // EMA crossover
  emaCrossoverWeight: number; // weight for EMA12/EMA26 crossover signal

  // Position sizing
  maxPositionPct: number;    // max % of portfolio per trade (0-1)

  // Confidence threshold
  minConfidence: number;     // minimum combined confidence to trigger signal
}

// ─── Champion-Challenger Variants ────────────────────────────────────
export const STRATEGY_VARIANTS = ["champion", "aggressive", "conservative"] as const;
export type StrategyVariant = (typeof STRATEGY_VARIANTS)[number];

/** Significance threshold for paired t-test on (challenger reward − champion reward). */
export const CHALLENGER_PROMOTION_PVALUE = 0.05;
/** Minimum paired observations before any promotion is allowed. */
export const CHALLENGER_PROMOTION_MIN_N = 30;

/**
 * Derive challenger params from the active champion via fixed transforms.
 * - aggressive: lower confidence threshold + tighter z-score band (acts more often)
 * - conservative: higher confidence threshold + wider z-score band (acts less often)
 */
export function deriveChallengerParams(
  champion: StrategyParameters,
  variant: StrategyVariant
): StrategyParameters {
  if (variant === "champion") return champion;
  const aggressive = variant === "aggressive";
  const confMult = aggressive ? 0.85 : 1.15;
  const zMult = aggressive ? 0.9 : 1.1;
  return {
    ...champion,
    minConfidence: Math.max(0.3, Math.min(0.95, champion.minConfidence * confMult)),
    zScoreTrendThreshold: Math.max(1.0, Math.min(3.5, champion.zScoreTrendThreshold * zMult)),
  };
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParameters = {
  rsiBuyThreshold: 30,
  rsiSellThreshold: 70,
  macdBuyThreshold: 0,
  macdSellThreshold: 0,
  bbBuyDeviation: 0,
  bbSellDeviation: 0,
  zScoreTrendThreshold: 2.0,
  zScoreBlipThreshold: 0.5,
  volumeRatioThreshold: 1.5,
  emaCrossoverWeight: 0.2,
  maxPositionPct: 0.25,
  minConfidence: 0.45,
};

export interface MetricsData {
  price: number;
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  ema12: number | null;
  ema26: number | null;
  sma50: number | null;
  sma200: number | null;
  volumeSma20: number | null;
  volumeRatio: number | null;
  zScore: number | null;
  rollingStdDev: number | null;
  trendClassification: "trend" | "blip" | "neutral" | null;
}

export interface SignalResult {
  signal: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
  metrics: MetricsData;
}

export interface SimulatorPortfolio {
  cashUsd: number;
  btcHolding: number;
  totalValueUsd: number;
  seedAmountUsd: number;
  lastPrice: number;
  isRunning: boolean;
}
