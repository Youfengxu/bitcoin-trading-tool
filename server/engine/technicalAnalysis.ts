/**
 * Pure-function technical analysis library.
 * All functions operate on arrays of close prices (newest last).
 */

export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

// ─── Simple Moving Average ───────────────────────────────────────────
export function sma(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─── Exponential Moving Average ──────────────────────────────────────
export function ema(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    emaVal = data[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

// ─── RSI (Relative Strength Index) ──────────────────────────────────
export function rsi(data: number[], period: number = 14): number | null {
  if (data.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  // Initial average gain/loss
  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── MACD ────────────────────────────────────────────────────────────
export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

export function macd(
  data: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MACDResult | null {
  if (data.length < slowPeriod + signalPeriod) return null;
  // Compute MACD line values for signal calculation
  const macdValues: number[] = [];
  for (let i = slowPeriod; i <= data.length; i++) {
    const slice = data.slice(0, i);
    const fast = ema(slice, fastPeriod);
    const slow = ema(slice, slowPeriod);
    if (fast !== null && slow !== null) {
      macdValues.push(fast - slow);
    }
  }
  if (macdValues.length < signalPeriod) return null;
  const signalLine = ema(macdValues, signalPeriod);
  if (signalLine === null) return null;
  const macdLine = macdValues[macdValues.length - 1];
  return {
    macdLine,
    signalLine,
    histogram: macdLine - signalLine,
  };
}

// ─── Bollinger Bands ─────────────────────────────────────────────────
export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export function bollingerBands(
  data: number[],
  period = 20,
  stdDevMultiplier = 2
): BollingerBands | null {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + stdDevMultiplier * stdDev,
    middle: mean,
    lower: mean - stdDevMultiplier * stdDev,
  };
}

// ─── Z-Score ─────────────────────────────────────────────────────────
export interface ZScoreResult {
  zScore: number;
  rollingStdDev: number;
  mean: number;
}

export function zScore(data: number[], period = 20): ZScoreResult | null {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return { zScore: 0, rollingStdDev: 0, mean };
  const current = data[data.length - 1];
  return {
    zScore: (current - mean) / stdDev,
    rollingStdDev: stdDev,
    mean,
  };
}

// ─── Trend Classification ────────────────────────────────────────────
export function classifyTrend(
  zScoreVal: number,
  trendThreshold: number,
  blipThreshold: number
): "trend" | "blip" | "neutral" {
  const absZ = Math.abs(zScoreVal);
  if (absZ >= trendThreshold) return "trend";
  if (absZ <= blipThreshold) return "blip";
  return "neutral";
}

// ─── Volume Ratio ────────────────────────────────────────────────────
export function volumeRatio(volumes: number[], period = 20): number | null {
  if (volumes.length < period) return null;
  const avgVol = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avgVol === 0) return null;
  return volumes[volumes.length - 1] / avgVol;
}

// ─── Compute All Metrics ─────────────────────────────────────────────
export interface AllMetrics {
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

export function computeAllMetrics(
  candles: CandleData[],
  zScoreTrendThreshold = 2.0,
  zScoreBlipThreshold = 0.5
): AllMetrics {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const currentPrice = closes[closes.length - 1];

  const rsi14 = rsi(closes, 14);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes);
  const ema12Val = ema(closes, 12);
  const ema26Val = ema(closes, 26);
  const sma50Val = sma(closes, 50);
  const sma200Val = sma(closes, 200);
  const volSma20 = sma(volumes, 20);
  const volRatio = volumeRatio(volumes);
  const zResult = zScore(closes);

  let trendClass: "trend" | "blip" | "neutral" | null = null;
  if (zResult) {
    trendClass = classifyTrend(zResult.zScore, zScoreTrendThreshold, zScoreBlipThreshold);
  }

  return {
    price: currentPrice,
    rsi14,
    macdLine: macdResult?.macdLine ?? null,
    macdSignal: macdResult?.signalLine ?? null,
    macdHist: macdResult?.histogram ?? null,
    bbUpper: bbResult?.upper ?? null,
    bbMiddle: bbResult?.middle ?? null,
    bbLower: bbResult?.lower ?? null,
    ema12: ema12Val,
    ema26: ema26Val,
    sma50: sma50Val,
    sma200: sma200Val,
    volumeSma20: volSma20,
    volumeRatio: volRatio,
    zScore: zResult?.zScore ?? null,
    rollingStdDev: zResult?.rollingStdDev ?? null,
    trendClassification: trendClass,
  };
}
