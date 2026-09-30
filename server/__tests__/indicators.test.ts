import { describe, it, expect } from 'vitest';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateBollingerBands,
  calculateMACD,
} from '../indicators.ts';

describe('calculateSMA', () => {
  it('returns correct SMA for known input', () => {
    const closes = [1, 2, 3, 4, 5];
    const result = calculateSMA(closes, 3);
    // indices: 0->1 (fill), 1->2 (fill), 2->(1+2+3)/3=2, 3->(2+3+4)/3=3, 4->(3+4+5)/3=4
    expect(result[2]).toBeCloseTo(2);
    expect(result[3]).toBeCloseTo(3);
    expect(result[4]).toBeCloseTo(4);
  });

  it('fills early values with the original close', () => {
    const closes = [10, 20, 30];
    const result = calculateSMA(closes, 3);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
  });

  it('returns empty array for empty input', () => {
    expect(calculateSMA([], 5)).toEqual([]);
  });
});

describe('calculateEMA', () => {
  it('returns first value as initial EMA seed', () => {
    const closes = [42, 44, 46];
    const result = calculateEMA(closes, 3);
    expect(result[0]).toBe(42);
  });

  it('converges toward the mean for flat data', () => {
    const closes = [10, 10, 10, 10, 10];
    const result = calculateEMA(closes, 3);
    result.forEach(v => expect(v).toBe(10));
  });

  it('returns empty array for empty input', () => {
    expect(calculateEMA([], 5)).toEqual([]);
  });
});

describe('calculateRSI', () => {
  it('returns ~50 for symmetric sinusoidal data', () => {
    // sin wave over a full cycle: roughly equal gains and losses
    const closes: number[] = [];
    for (let i = 0; i < 100; i++) {
      closes.push(100 + Math.sin(i * 0.3) * 10);
    }
    const result = calculateRSI(closes, 14);
    const last = result[result.length - 1];
    expect(last).toBeGreaterThan(30);
    expect(last).toBeLessThan(70);
  });

  it('returns 100 when all gains', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const result = calculateRSI(closes, 14);
    expect(result[result.length - 1]).toBe(100);
  });

  it('fills early positions with 50', () => {
    const closes = [10, 11, 12, 13, 14];
    const result = calculateRSI(closes, 14);
    expect(result.length).toBe(5);
    result.forEach(v => expect(v).toBe(50));
  });
});

describe('calculateBollingerBands', () => {
  it('upper is symmetric above SMA and lower below', () => {
    const closes = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19, 18, 20, 19, 21];
    const { upper, middle, lower } = calculateBollingerBands(closes, 5, 2);
    const last = upper.length - 1;
    expect(middle[last]).toBeGreaterThan(lower[last]);
    expect(upper[last]).toBeGreaterThan(middle[last]);
    // distance from middle to upper ≈ distance from middle to lower
    expect(upper[last] - middle[last]).toBeCloseTo(middle[last] - lower[last], 5);
  });

  it('fills early values with close price', () => {
    const closes = [10, 20, 30];
    const { upper, lower } = calculateBollingerBands(closes, 20);
    expect(upper[0]).toBe(10);
    expect(lower[0]).toBe(10);
  });
});

describe('calculateMACD', () => {
  it('returns macdLine, signalLine, and histogram arrays matching input length', () => {
    const closes = [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52];
    const result = calculateMACD(closes, 12, 26, 9);
    expect(result.macdLine.length).toBe(closes.length);
    expect(result.signalLine.length).toBe(closes.length);
    expect(result.histogram.length).toBe(closes.length);
  });

  it('produces histogram as macdLine minus signalLine', () => {
    const closes = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
      45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57];
    const { macdLine, signalLine, histogram } = calculateMACD(closes, 12, 26, 9);
    for (let i = 0; i < histogram.length; i++) {
      expect(histogram[i]).toBeCloseTo(macdLine[i] - signalLine[i], 10);
    }
  });
});
