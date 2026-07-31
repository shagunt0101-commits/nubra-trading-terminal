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
