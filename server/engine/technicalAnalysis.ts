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

// ─── CUSUM (Cumulative Sum Control Chart) ────────────────────────────
export interface CUSUMResult {
  cusumUp: number;
  cusumDown: number;
  alarm: boolean;
}

/**
 * Detects mean-shifts in log returns via two-sided CUSUM.
 * k (allowance) and h (threshold) are expressed in units of the return std dev,
 * so the detector self-calibrates to the observed volatility regime.
 */
export function cusum(closes: number[], k = 0.5, h = 5.0): CUSUMResult | null {
  if (closes.length < 2) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const sigma = Math.sqrt(variance);
  if (sigma === 0) return { cusumUp: 0, cusumDown: 0, alarm: false };
  const kS = k * sigma;
  const hS = h * sigma;
  let sUp = 0;
  let sDown = 0;
  for (const r of returns) {
    sUp = Math.max(0, sUp + (r - mean) - kS);
    sDown = Math.max(0, sDown - (r - mean) - kS);
  }
  return { cusumUp: sUp, cusumDown: sDown, alarm: sUp > hS || sDown > hS };
}

// ─── Hurst Exponent (R/S analysis) ──────────────────────────────────
/**
 * Estimates the Hurst exponent via rescaled-range (R/S) analysis on log returns.
 * H > 0.6 → trending/persistent, H < 0.45 → mean-reverting, H ≈ 0.5 → random walk.
 */
export function hurst(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (logReturns.length < 20) return null;
  const minScale = 10;
  const maxScale = Math.floor(logReturns.length / 2);
  if (maxScale < minScale) return null;
  const nScales = Math.min(8, maxScale - minScale + 1);
  const scales: number[] = [];
  const rsValues: number[] = [];
  for (let i = 0; i < nScales; i++) {
    const n = Math.round(
      minScale * Math.pow(maxScale / minScale, i / Math.max(1, nScales - 1))
    );
    if (n < minScale || n > maxScale) continue;
    const numWindows = Math.floor(logReturns.length / n);
    if (numWindows < 1) continue;
    let rsSum = 0;
    let rsCount = 0;
    for (let w = 0; w < numWindows; w++) {
      const slice = logReturns.slice(w * n, (w + 1) * n);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      let cumSum = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      for (const r of slice) {
        cumSum += r - mean;
        if (cumSum > maxCum) maxCum = cumSum;
        if (cumSum < minCum) minCum = cumSum;
      }
      const range = maxCum - minCum;
      const stdDev = Math.sqrt(
        slice.reduce((s, r) => s + (r - mean) ** 2, 0) / slice.length
      );
      if (stdDev > 0) { rsSum += range / stdDev; rsCount++; }
    }
    if (rsCount > 0) {
      scales.push(Math.log(n));
      rsValues.push(Math.log(rsSum / rsCount));
    }
  }
  if (scales.length < 2) return null;
  // OLS slope of log(R/S) on log(n) = Hurst exponent
  const n = scales.length;
  const xMean = scales.reduce((a, b) => a + b, 0) / n;
  const yMean = rsValues.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (scales[i] - xMean) * (rsValues[i] - yMean);
    den += (scales[i] - xMean) ** 2;
  }
  if (den === 0) return null;
  return Math.max(0, Math.min(1, num / den));
}

// ─── ADX (Average Directional Index, Wilder) ─────────────────────────
export interface ADXResult {
  adx: number;
  plusDI: number;
  minusDI: number;
}

/**
 * Wilder's ADX with +DI / -DI.
 * ADX > 25 signals a strong trend; +DI > -DI = bullish, -DI > +DI = bearish.
 */
export function adx(candles: CandleData[], period = 14): ADXResult | null {
  if (candles.length < period * 2 + 1) return null;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  if (trs.length < period) return null;
  // Wilder initial sums
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = (tr: number, pdm: number, mdm: number): number => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr;
    const mdi = 100 * mdm / tr;
    const sum = pdi + mdi;
    return sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
  };
  const dxVals: number[] = [dx(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPDM = sPDM - sPDM / period + plusDMs[i];
    sMDM = sMDM - sMDM / period + minusDMs[i];
    dxVals.push(dx(sTR, sPDM, sMDM));
  }
  if (dxVals.length < period) return null;
  let adxVal = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adxVal = (adxVal * (period - 1) + dxVals[i]) / period;
  }
  return {
    adx: adxVal,
    plusDI: sTR > 0 ? 100 * sPDM / sTR : 0,
    minusDI: sTR > 0 ? 100 * sMDM / sTR : 0,
  };
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
  // Change-detection indicators
  cusumAlarm: boolean | null;
  cusumUp: number | null;
  cusumDown: number | null;
  hurstExponent: number | null;
  adx: number | null;
  adxPlus: number | null;
  adxMinus: number | null;
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
  const cusumResult = cusum(closes);
  const hurstVal = hurst(closes);
  const adxResult = adx(candles);

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
    cusumAlarm: cusumResult?.alarm ?? null,
    cusumUp: cusumResult?.cusumUp ?? null,
    cusumDown: cusumResult?.cusumDown ?? null,
    hurstExponent: hurstVal,
    adx: adxResult?.adx ?? null,
    adxPlus: adxResult?.plusDI ?? null,
    adxMinus: adxResult?.minusDI ?? null,
  };
}
