import type { StrategyParameters } from "../../shared/tradingTypes";
import type { AllMetrics } from "./technicalAnalysis";

export interface SignalOutput {
  signal: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
}

interface SignalComponent {
  name: string;
  direction: "buy" | "sell" | "neutral";
  strength: number; // 0-1
  reason: string;
}

export function generateSignal(
  metrics: AllMetrics,
  params: StrategyParameters
): SignalOutput {
  const components: SignalComponent[] = [];

  // 1. RSI Signal
  if (metrics.rsi14 !== null) {
    if (metrics.rsi14 < params.rsiBuyThreshold) {
      const strength = Math.min(1, (params.rsiBuyThreshold - metrics.rsi14) / 30);
      components.push({
        name: "RSI",
        direction: "buy",
        strength,
        reason: `RSI at ${metrics.rsi14.toFixed(1)} is below oversold threshold of ${params.rsiBuyThreshold}`,
      });
    } else if (metrics.rsi14 > params.rsiSellThreshold) {
      const strength = Math.min(1, (metrics.rsi14 - params.rsiSellThreshold) / 30);
      components.push({
        name: "RSI",
        direction: "sell",
        strength,
        reason: `RSI at ${metrics.rsi14.toFixed(1)} is above overbought threshold of ${params.rsiSellThreshold}`,
      });
    } else {
      components.push({
        name: "RSI",
        direction: "neutral",
        strength: 0,
        reason: `RSI at ${metrics.rsi14.toFixed(1)} is in neutral zone`,
      });
    }
  }

  // 2. MACD Signal
  if (metrics.macdHist !== null) {
    if (metrics.macdHist > params.macdBuyThreshold) {
      const strength = Math.min(1, Math.abs(metrics.macdHist) / 100);
      components.push({
        name: "MACD",
        direction: "buy",
        strength,
        reason: `MACD histogram at ${metrics.macdHist.toFixed(2)} shows bullish momentum`,
      });
    } else if (metrics.macdHist < params.macdSellThreshold) {
      const strength = Math.min(1, Math.abs(metrics.macdHist) / 100);
      components.push({
        name: "MACD",
        direction: "sell",
        strength,
        reason: `MACD histogram at ${metrics.macdHist.toFixed(2)} shows bearish momentum`,
      });
    } else {
      components.push({
        name: "MACD",
        direction: "neutral",
        strength: 0,
        reason: `MACD histogram near zero, no clear momentum`,
      });
    }
  }

  // 3. Bollinger Bands Signal
  if (metrics.bbUpper !== null && metrics.bbLower !== null && metrics.bbMiddle !== null) {
    const bbWidth = metrics.bbUpper - metrics.bbLower;
    if (bbWidth > 0) {
      if (metrics.price <= metrics.bbLower) {
        const strength = Math.min(1, (metrics.bbLower - metrics.price) / bbWidth);
        components.push({
          name: "Bollinger Bands",
          direction: "buy",
          strength: Math.max(0.3, strength),
          reason: `Price $${metrics.price.toFixed(0)} at or below lower Bollinger Band $${metrics.bbLower.toFixed(0)}`,
        });
      } else if (metrics.price >= metrics.bbUpper) {
        const strength = Math.min(1, (metrics.price - metrics.bbUpper) / bbWidth);
        components.push({
          name: "Bollinger Bands",
          direction: "sell",
          strength: Math.max(0.3, strength),
          reason: `Price $${metrics.price.toFixed(0)} at or above upper Bollinger Band $${metrics.bbUpper.toFixed(0)}`,
        });
      } else {
        components.push({
          name: "Bollinger Bands",
          direction: "neutral",
          strength: 0,
          reason: `Price within Bollinger Bands range`,
        });
      }
    }
  }

  // 4. EMA Crossover Signal
  if (metrics.ema12 !== null && metrics.ema26 !== null) {
    const diff = metrics.ema12 - metrics.ema26;
    const pctDiff = (diff / metrics.ema26) * 100;
    if (diff > 0) {
      components.push({
        name: "EMA Crossover",
        direction: "buy",
        strength: Math.min(1, Math.abs(pctDiff) * params.emaCrossoverWeight),
        reason: `EMA12 ($${metrics.ema12.toFixed(0)}) above EMA26 ($${metrics.ema26.toFixed(0)}), bullish crossover`,
      });
    } else {
      components.push({
        name: "EMA Crossover",
        direction: "sell",
        strength: Math.min(1, Math.abs(pctDiff) * params.emaCrossoverWeight),
        reason: `EMA12 ($${metrics.ema12.toFixed(0)}) below EMA26 ($${metrics.ema26.toFixed(0)}), bearish crossover`,
      });
    }
  }

  // 5. Statistical Significance (Z-Score)
  if (metrics.zScore !== null && metrics.trendClassification !== null) {
    if (metrics.trendClassification === "trend") {
      const dir = metrics.zScore > 0 ? "sell" : "buy";
      components.push({
        name: "Z-Score Trend",
        direction: dir,
        strength: Math.min(1, Math.abs(metrics.zScore) / 3),
        reason: `Z-score ${metrics.zScore.toFixed(2)} indicates statistically significant ${dir === "buy" ? "downward" : "upward"} trend (|z| > ${params.zScoreTrendThreshold})`,
      });
    } else if (metrics.trendClassification === "blip") {
      components.push({
        name: "Z-Score Blip",
        direction: "neutral",
        strength: 0,
        reason: `Z-score ${metrics.zScore.toFixed(2)} indicates noise/blip, not a significant move (|z| < ${params.zScoreBlipThreshold})`,
      });
    }
  }

  // 6. Volume Confirmation
  let volumeConfirmed = false;
  if (metrics.volumeRatio !== null) {
    volumeConfirmed = metrics.volumeRatio >= params.volumeRatioThreshold;
    if (volumeConfirmed) {
      components.push({
        name: "Volume",
        direction: "neutral",
        strength: 0.2,
        reason: `Volume ratio ${metrics.volumeRatio.toFixed(2)}x confirms signal strength (threshold: ${params.volumeRatioThreshold}x)`,
      });
    }
  }

  // 7. ADX — trend strength and direction
  if (metrics.adx !== null && metrics.adxPlus !== null && metrics.adxMinus !== null) {
    if (metrics.adx > 25) {
      const strength = Math.min(1, (metrics.adx - 25) / 50);
      const dir = metrics.adxPlus > metrics.adxMinus ? "buy" : "sell";
      components.push({
        name: "ADX",
        direction: dir,
        strength,
        reason: `ADX ${metrics.adx.toFixed(1)} confirms strong trend; +DI ${metrics.adxPlus.toFixed(1)} vs -DI ${metrics.adxMinus.toFixed(1)} favors ${dir}`,
      });
    } else {
      components.push({
        name: "ADX",
        direction: "neutral",
        strength: 0,
        reason: `ADX ${metrics.adx.toFixed(1)} below 25 — no strong trend confirmed`,
      });
    }
  }

  // Aggregate signals with Hurst-aware regime weighting.
  // Trend-following components (MACD, EMA, Z-Score, ADX) are amplified when H > 0.5.
  // Mean-reversion components (RSI, Bollinger Bands) are amplified when H < 0.5.
  const trendFollowing = new Set(["MACD", "EMA Crossover", "Z-Score Trend", "ADX"]);
  const meanReverting = new Set(["RSI", "Bollinger Bands"]);
  const h = metrics.hurstExponent ?? 0.5;
  const trendMult = Math.max(0.1, 1 + (h - 0.5) * 2);
  const mrMult = Math.max(0.1, 1 + (0.5 - h) * 2);

  let buyScore = 0;
  let sellScore = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const comp of components) {
    let mult = 1.0;
    if (metrics.hurstExponent !== null) {
      if (trendFollowing.has(comp.name)) mult = trendMult;
      else if (meanReverting.has(comp.name)) mult = mrMult;
    }
    if (comp.direction === "buy") {
      buyScore += comp.strength * mult;
      buyCount++;
    } else if (comp.direction === "sell") {
      sellScore += comp.strength * mult;
      sellCount++;
    }
  }

  const totalComponents = Math.max(1, components.filter((c) => c.direction !== "neutral").length);
  const normalizedBuy = buyScore / Math.max(1, totalComponents);
  const normalizedSell = sellScore / Math.max(1, totalComponents);

  // Volume boost
  const volumeMultiplier = volumeConfirmed ? 1.15 : 1.0;

  let finalBuy = normalizedBuy * volumeMultiplier;
  let finalSell = normalizedSell * volumeMultiplier;

  // CUSUM boost: an active changepoint alarm in the prevailing direction adds 20% confidence.
  if (metrics.cusumAlarm && metrics.cusumUp !== null && metrics.cusumDown !== null) {
    if (metrics.cusumUp > metrics.cusumDown && finalBuy >= finalSell) finalBuy *= 1.2;
    else if (metrics.cusumDown >= metrics.cusumUp && finalSell > finalBuy) finalSell *= 1.2;
  }

  // Determine signal
  let signal: "buy" | "sell" | "hold" = "hold";
  let confidence = 0;

  if (finalBuy > finalSell && finalBuy >= params.minConfidence) {
    signal = "buy";
    confidence = Math.min(1, finalBuy);
  } else if (finalSell > finalBuy && finalSell >= params.minConfidence) {
    signal = "sell";
    confidence = Math.min(1, finalSell);
  } else {
    confidence = 1 - Math.max(finalBuy, finalSell);
  }

  // Build reasoning
  const activeComponents = components.filter((c) => c.direction !== "neutral" || c.strength > 0);
  const reasoningParts = activeComponents.map(
    (c) => `[${c.name}] ${c.reason} (${c.direction}, strength: ${(c.strength * 100).toFixed(0)}%)`
  );

  const hurstLabel = metrics.hurstExponent !== null
    ? ` | Hurst ${metrics.hurstExponent.toFixed(2)} (${metrics.hurstExponent > 0.6 ? "trending" : metrics.hurstExponent < 0.45 ? "mean-reverting" : "random walk"})`
    : "";
  const cusumLabel = metrics.cusumAlarm ? " | CUSUM alarm active" : "";

  const summary =
    signal === "hold"
      ? `HOLD: No clear directional consensus. Buy score: ${(finalBuy * 100).toFixed(0)}%, Sell score: ${(finalSell * 100).toFixed(0)}%. Minimum confidence threshold: ${(params.minConfidence * 100).toFixed(0)}%.${hurstLabel}${cusumLabel}`
      : `${signal.toUpperCase()}: Combined ${signal} score ${((signal === "buy" ? finalBuy : finalSell) * 100).toFixed(0)}% exceeds minimum confidence of ${(params.minConfidence * 100).toFixed(0)}%.${hurstLabel}${cusumLabel}`;

  const reasoning = [summary, "", "Component Analysis:", ...reasoningParts].join("\n");

  return { signal, confidence, reasoning };
}
