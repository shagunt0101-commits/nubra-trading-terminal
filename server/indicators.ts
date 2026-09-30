export interface Candle {
  ts: number; // nanoseconds or milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Technical Analysis calculation helpers
export function calculateSMA(closes: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      sma.push(closes[i]); // fill early values
    } else {
      const sum = closes.slice(i - period + 1, i + 1).reduce((acc, v) => acc + v, 0);
      sma.push(sum / period);
    }
  }
  return sma;
}

export function calculateEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  if (closes.length === 0) return ema;
  const k = 2 / (period + 1);
  let currentEma = closes[0];
  ema.push(currentEma);

  for (let i = 1; i < closes.length; i++) {
    currentEma = closes[i] * k + currentEma * (1 - k);
    ema.push(currentEma);
  }
  return ema;
}

export function calculateRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period) {
    return closes.map(() => 50); // neutral fallback
  }

  let gains = 0;
  let losses = 0;

  // First period
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  // Fill initial RSIs with neutral values
  for (let i = 0; i < period; i++) {
    rsi.push(50);
  }
  
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  return rsi;
}

export interface BollingerBands {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function calculateBollingerBands(closes: number[], period = 20, multiplier = 2): BollingerBands {
  const middle = calculateSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(closes[i]);
      lower.push(closes[i]);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      const avg = middle[i];
      const variance = slice.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      upper.push(avg + multiplier * stdDev);
      lower.push(avg - multiplier * stdDev);
    }
  }

  return { upper, middle, lower };
}

export function calculateMACD(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);
  const macdLine: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  const signalLine = calculateEMA(macdLine, signalPeriod);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }

  return { macdLine, signalLine, histogram };
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
  atr: number[];
}

// Standard 5-step Wilder's ADX: EMA-smoothed TR/+DM/-DM → +DI/-DI → DX → EMA-smoothed ADX
export function calculateADX(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const closes = candles.map((x) => x.close);
  const highs = candles.map((x) => x.high);
  const lows = candles.map((x) => x.low);

  const tr = candles.map((x, i) =>
    i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - closes[i - 1]), Math.abs(x.low - closes[i - 1]))
  );
  const pDm = candles.map((x, i) => {
    if (i === 0) return 0;
    const u = x.high - highs[i - 1];
    const d = lows[i - 1] - x.low;
    return u > d && u > 0 ? u : 0;
  });
  const mDm = candles.map((x, i) => {
    if (i === 0) return 0;
    const u = x.high - highs[i - 1];
    const d = lows[i - 1] - x.low;
    return d > u && d > 0 ? d : 0;
  });

  const str = calculateEMA(tr, period);        // smoothed TR (ATR)
  const sp = calculateEMA(pDm, period);        // smoothed +DM
  const sm = calculateEMA(mDm, period);        // smoothed -DM

  const pDi = str.map((t, i) => (t > 0 ? (100 * sp[i]) / t : 0));
  const mDi = str.map((t, i) => (t > 0 ? (100 * sm[i]) / t : 0));

  const dx = pDi.map((pdi, i) => {
    const sum = pdi + mDi[i];
    return sum > 0 ? (Math.abs(pdi - mDi[i]) / sum) * 100 : 0;
  });

  return { adx: calculateEMA(dx, period), plusDi: pDi, minusDi: mDi, atr: str };
}

export function calculateATR(candles: Candle[], period = 14): number[] {
  const tr = candles.map((x, i) =>
    i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - candles[i - 1].close), Math.abs(x.low - candles[i - 1].close))
  );
  return calculateEMA(tr, period);
}


export interface StochasticResult {
  k: number[];
  d: number[];
}

export function calculateStochastic(candles: Candle[], kPeriod = 14, dPeriod = 3, slowing = 3): StochasticResult {
  const k: number[] = [];
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) {
      k.push(50);
    } else {
      const highMax = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
      const lowMin = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
      const diff = highMax - lowMin;
      k.push(diff > 0 ? ((closes[i] - lowMin) / diff) * 100 : 50);
    }
  }

  // Smooth %K to get slowed %K, then smooth that to get %D
  const slowedK = calculateSMA(k, slowing);
  const d = calculateSMA(slowedK, dPeriod);

  return { k: slowedK, d };
}

export function calculateVWAP(candles: Candle[]): number[] {
  let cumulativePv = 0;
  let cumulativeVolume = 0;
  const vwap: number[] = [];

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePv += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
    vwap.push(cumulativeVolume > 0 ? cumulativePv / cumulativeVolume : c.close);
  }

  return vwap;
}

export function calculateVolumeZScore(volumes: number[], period = 20): number[] {
  const zScores: number[] = [];
  for (let i = 0; i < volumes.length; i++) {
    if (i < period - 1) {
      zScores.push(0);
    } else {
      const slice = volumes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      zScores.push(stdDev > 0 ? (volumes[i] - mean) / stdDev : 0);
    }
  }
  return zScores;
}
