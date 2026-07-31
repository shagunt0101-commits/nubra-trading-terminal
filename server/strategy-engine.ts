import { Candle, calculateADX, calculateEMA, calculateStochastic, calculateBollingerBands, calculateRSI, calculateSMA, calculateVWAP, calculateVolumeZScore } from "./indicators.js";

export interface StrategySignal {
  direction: "LONG" | "SHORT" | "NONE";
  confidence: number; // 0-100
  reason?: string;
  metadata?: any;
}

export const STRATEGY_DEFAULTS = {
  trendContinuation: { scalping: { adxThreshold: 25, maxHold: 20 }, intraday: { adxThreshold: 20, maxHold: 45 } },
  bbMeanReversion: { period: 20, stdDev: 2, rsiPeriod: 14, slMult: 0.3, targetMult: 0.7, maxHold: 45 },
  rsiReversal: { rsiPeriod: 14 },
  smaEmaTrend: { smaPeriod: 20, emaPeriod: 50, adxPeriod: 14 },
  s2Scalper: { confidenceThreshold: 55, stopLossPct: 0.30, premiumTargetPct: 0.60 }
};

// 2. Trend Continuation Strategy
export function evaluateTrendContinuation(
  candles: Candle[],
  timeframe: "scalping" | "intraday" = "scalping"
): StrategySignal {
  const p = timeframe === "scalping" ? 25 : 20;
  const adxRes = calculateADX(candles, 14);
  const ema21 = calculateEMA(candles.map(c => c.close), 21);
  const stoch = calculateStochastic(candles);

  const lastIdx = candles.length - 1;
  if (lastIdx < 1) return { direction: "NONE", confidence: 0 };

  const lastAdx = adxRes.adx[lastIdx];
  const lastPdi = adxRes.plusDi[lastIdx];
  const lastMdi = adxRes.minusDi[lastIdx];
  const lastPrice = candles[lastIdx].close;
  const lastEma21 = ema21[lastIdx];
  const lastK = stoch.k[lastIdx];
  const lastD = stoch.d[lastIdx];

  const priceDist = Math.abs(lastPrice - lastEma21) / lastEma21 * 100;

  if (lastAdx > p && priceDist < 0.5) {
    if (lastPdi > lastMdi && lastK > lastD) {
      return { direction: "LONG", confidence: 70, reason: "ADX trend + Stoch cross + EMA-21 proximity" };
    }
    if (lastMdi > lastPdi && lastK < lastD) {
      return { direction: "SHORT", confidence: 70, reason: "ADX trend + Stoch cross + EMA-21 proximity" };
    }
  }

  return { direction: "NONE", confidence: 0 };
}

// 3. Bollinger Band Mean Reversal
export function evaluateBBMeanReversal(candles: Candle[]): StrategySignal {
  const bb = calculateBollingerBands(candles.map(c => c.close), 20, 2);
  const rsi = calculateRSI(candles.map(c => c.close), 14);

  const lastIdx = candles.length - 1;
  if (lastIdx < 1) return { direction: "NONE", confidence: 0 };

  const lastPrice = candles[lastIdx].close;
  const prevPrice = candles[lastIdx - 1].close;
  const lastLower = bb.lower[lastIdx];
  const lastUpper = bb.upper[lastIdx];
  const prevLower = bb.lower[lastIdx - 1];
  const prevUpper = bb.upper[lastIdx - 1];
  const lastRsi = rsi[lastIdx];

  // LONG: Prev touched lower, now back inside. RSI 30-50
  if (prevPrice <= prevLower && lastPrice > lastLower && lastRsi >= 30 && lastRsi <= 50) {
    return { direction: "LONG", confidence: 65, reason: "BB Lower touch + inside close + RSI 30-50" };
  }
  // SHORT: Prev touched upper, now back inside. RSI 50-70
  if (prevPrice >= prevUpper && lastPrice < lastUpper && lastRsi >= 50 && lastRsi <= 70) {
    return { direction: "SHORT", confidence: 65, reason: "BB Upper touch + inside close + RSI 50-70" };
  }

  return { direction: "NONE", confidence: 0 };
}

// 4. RSI Reversal Bounce
export function evaluateRSIReversal(candles: Candle[]): StrategySignal {
  const rsi = calculateRSI(candles.map(c => c.close), 14);
  const lastIdx = candles.length - 1;
  if (lastIdx < 1) return { direction: "NONE", confidence: 0 };

  const lastRsi = rsi[lastIdx];
  const prevRsi = rsi[lastIdx - 1];

  if (prevRsi <= 30 && lastRsi > 30) return { direction: "LONG", confidence: 60, reason: "RSI Oversold Bounce" };
  if (prevRsi >= 70 && lastRsi < 70) return { direction: "SHORT", confidence: 60, reason: "RSI Overbought Reversal" };

  return { direction: "NONE", confidence: 0 };
}

// 5. SMA/EMA Trend Follow
export function evaluateTrendFollow(candles: Candle[]): StrategySignal {
  const sma20 = calculateSMA(candles.map(c => c.close), 20);
  const ema50 = calculateEMA(candles.map(c => c.close), 50);

  const lastIdx = candles.length - 1;
  if (lastIdx < 2) return { direction: "NONE", confidence: 0 };

  const lastPrice = candles[lastIdx].close;
  const lastSma20 = sma20[lastIdx];
  const lastEma50 = ema50[lastIdx];
  const prevEma50 = ema50[lastIdx - 1];

  if (lastPrice > lastSma20 && lastEma50 > prevEma50) {
    return { direction: "LONG", confidence: 55, reason: "Price > SMA-20 & EMA-50 up" };
  }
  if (lastPrice < lastSma20 && lastEma50 < prevEma50) {
    return { direction: "SHORT", confidence: 55, reason: "Price < SMA-20 & EMA-50 down" };
  }

  return { direction: "NONE", confidence: 0 };
}

// 6. S2 Scalper Strategy
export function evaluateS2Scalper(
  candles: Candle[],
  context?: { pcr?: number; iv?: number }
): StrategySignal {
  const rsi = calculateRSI(candles.map(c => c.close), 14);
  // MACD (12, 26, 9)
  const macd = (function() {
    const fastEMA = calculateEMA(candles.map(c => c.close), 12);
    const slowEMA = calculateEMA(candles.map(c => c.close), 26);
    const line = fastEMA.map((f, i) => f - slowEMA[i]);
    const signal = calculateEMA(line, 9);
    const hist = line.map((l, i) => l - signal[i]);
    return { line, signal, hist };
  })();
  const vwap = calculateVWAP(candles);
  const bb = calculateBollingerBands(candles.map(c => c.close), 20, 2);
  const volZ = calculateVolumeZScore(candles.map(c => c.volume), 20);

  const lastIdx = candles.length - 1;
  if (lastIdx < 1) return { direction: "NONE", confidence: 0 };

  const lastPrice = candles[lastIdx].close;
  const lastRsi = rsi[lastIdx];
  const lastMacdHist = macd.hist[lastIdx];
  const lastVwap = vwap[lastIdx];
  const lastVolZ = volZ[lastIdx];
  const bbWidth = (bb.upper[lastIdx] - bb.lower[lastIdx]) / bb.middle[lastIdx];

  let bullScore = 0;
  let bearScore = 0;

  if (lastRsi < 40) bullScore++;
  if (lastRsi > 60) bearScore++;
  if (lastMacdHist > 0) bullScore++;
  if (lastMacdHist < 0) bearScore++;
  if (lastPrice > lastVwap) bullScore++;
  if (lastPrice < lastVwap) bearScore++;
  if (lastVolZ > 1.5) { bullScore += 0.5; bearScore += 0.5; }

  if (context?.pcr) {
    if (context.pcr > 1.1) bullScore++;
    if (context.pcr < 0.8) bearScore++;
  }

  // BB Width modifier
  let confidence = (Math.max(bullScore, bearScore) / 4) * 100;
  if (bbWidth > 0.02) confidence += 10; // volatility expansion

  if (bullScore >= 3) return { direction: "LONG", confidence, reason: `S2 Bullish Score: ${bullScore}` };
  if (bearScore >= 3) return { direction: "SHORT", confidence, reason: `S2 Bearish Score: ${bearScore}` };

  return { direction: "NONE", confidence: 0 };
}

export function calculateTrailingSL(
  entryPrice: number,
  highestPrice: number,
  lowestPrice: number,
  atr: number,
  multiplier: number,
  direction: "LONG" | "SHORT"
): number {
  return direction === "LONG"
    ? Math.max(entryPrice, highestPrice - atr * multiplier)
    : Math.min(entryPrice, lowestPrice + atr * multiplier);
}
