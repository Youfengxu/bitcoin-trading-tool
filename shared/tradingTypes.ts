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
  minConfidence: 0.55,
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
