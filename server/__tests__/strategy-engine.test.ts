import { describe, it, expect } from "vitest";
import {
  evaluateTrendContinuation,
  evaluateBBMeanReversal,
  evaluateRSIReversal,
  evaluateTrendFollow,
  evaluateS2Scalper,
  calculateTrailingSL,
} from "../strategy-engine.ts";

interface CL { open: number; high: number; low: number; close: number; volume: number; ts: number }

// Realistic OHLC (open != close, wicks, ts increments) — degenerate bars
// (open=high=low=close) pin RSI to 0/100 and break ADX/stoch.
const mk = (open: number, close: number, i: number, volume = 1_000_000): CL => ({
  open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1,
  close, volume, ts: 1_700_000_000_000 + i * 300_000,
});

// --- fixtures (verified in diag scripts to hit every engine branch) ---
function tcLong(): CL[] { // trend 60b + consolidation 40b + breakout
  const c: CL[] = []; let p = 100;
  for (let i = 0; i < 60; i++) { c.push(mk(p, p + 1.2, i)); p += 1.2; }
  const base = p - 1.2;
  for (let i = 0; i < 40; i++) c.push(mk(base + Math.sin(i) * 0.1, base + Math.sin(i + 1) * 0.1, 60 + i));
  c.push(mk(base, base + 0.4, 100));
  return c;
}
function tcShort(): CL[] {
  const c: CL[] = []; let p = 200;
  for (let i = 0; i < 60; i++) { c.push(mk(p, p - 1.2, i)); p -= 1.2; }
  const base = p + 1.2;
  for (let i = 0; i < 40; i++) c.push(mk(base - Math.sin(i) * 0.1, base - Math.sin(i + 1) * 0.1, 60 + i));
  c.push(mk(base, base - 0.4, 100));
  return c;
}
function rrLong(): CL[] { // 40b down + 4b flat + big bounce
  const c: CL[] = []; let p = 200;
  for (let i = 0; i < 40; i++) { c.push(mk(p, p - 0.8, i)); p -= 0.8; }
  for (let i = 0; i < 4; i++) { c.push(mk(p, p + 0.1, 40 + i)); p += 0.1; }
  c.push(mk(p, p + 3.0, 44));
  return c;
}
function rrShort(): CL[] {
  const c: CL[] = []; let p = 100;
  for (let i = 0; i < 40; i++) { c.push(mk(p, p + 0.8, i)); p += 0.8; }
  for (let i = 0; i < 4; i++) { c.push(mk(p, p - 0.1, 40 + i)); p -= 0.1; }
  c.push(mk(p, p - 3.0, 44));
  return c;
}
function bbLong(): CL[] { // flat + pierce lower + recover inside
  const c: CL[] = [];
  for (let i = 0; i < 60; i++) c.push(mk(100 + (i % 2 ? 1 : -1), 100 + (i % 2 ? 1 : -1), i));
  c.push(mk(99, 94, 60));
  c.push(mk(94, 97, 61));
  return c;
}
function bbShort(): CL[] {
  const c: CL[] = [];
  for (let i = 0; i < 60; i++) c.push(mk(100 + (i % 2 ? 1 : -1), 100 + (i % 2 ? 1 : -1), i));
  c.push(mk(101, 106, 60));
  c.push(mk(106, 103, 61));
  return c;
}
function s2Long(): CL[] { // down grind + sharp up reversal + volume spike
  const c: CL[] = []; let p = 150;
  for (let i = 0; i < 40; i++) { c.push(mk(p, p - 0.4, i)); p -= 0.4; }
  for (let i = 0; i < 12; i++) c.push(mk(p, p + 0.9, 40 + i, i === 11 ? 5_000_000 : 1_000_000)), (p += 0.9);
  return c;
}
function s2Short(): CL[] {
  const c: CL[] = []; let p = 100;
  for (let i = 0; i < 50; i++) { c.push(mk(p, p + 0.4, i)); p += 0.4; }
  for (let i = 0; i < 12; i++) c.push(mk(p, p - 0.9, 50 + i, i === 11 ? 5_000_000 : 1_000_000)), (p -= 0.9);
  return c;
}
function flat(n: number, base = 100): CL[] {
  return Array.from({ length: n }, (_, i) => mk(base, base, i));
}
function trendUp(n: number, base = 100, step = 1): CL[] {
  const c: CL[] = []; let p = base;
  for (let i = 0; i < n; i++) { c.push(mk(p, p + step, i)); p += step; }
  return c;
}
function trendDown(n: number, base = 200, step = 1): CL[] {
  const c: CL[] = []; let p = base;
  for (let i = 0; i < n; i++) { c.push(mk(p, p - step, i)); p -= step; }
  return c;
}

// --- evaluateTrendContinuation ---
describe("evaluateTrendContinuation", () => {
  it("returns LONG on uptrend consolidation breakout", () => {
    const res = evaluateTrendContinuation(tcLong(), "scalping");
    expect(res.direction).toBe("LONG");
    expect(res.confidence).toBeGreaterThan(50);
    expect(res.reason).toContain("ADX");
  });

  it("returns SHORT on downtrend consolidation breakdown", () => {
    const res = evaluateTrendContinuation(tcShort(), "scalping");
    expect(res.direction).toBe("SHORT");
  });

  it("returns NONE on flat market", () => {
    expect(evaluateTrendContinuation(flat(80), "scalping").direction).toBe("NONE");
  });

  it("returns NONE on too few candles", () => {
    expect(evaluateTrendContinuation([mk(100, 100, 0)], "scalping").direction).toBe("NONE");
  });
});

// --- evaluateBBMeanReversal ---
describe("evaluateBBMeanReversal", () => {
  it("returns LONG after lower band touch + close back inside", () => {
    const res = evaluateBBMeanReversal(bbLong());
    expect(res.direction).toBe("LONG");
    expect(res.reason).toContain("BB Lower");
  });

  it("returns SHORT after upper band touch + close back inside", () => {
    const res = evaluateBBMeanReversal(bbShort());
    expect(res.direction).toBe("SHORT");
  });

  it("returns NONE on steady uptrend (no band touch)", () => {
    expect(evaluateBBMeanReversal(trendUp(80)).direction).toBe("NONE");
  });
});

// --- evaluateRSIReversal ---
describe("evaluateRSIReversal", () => {
  it("returns LONG on RSI oversold bounce (prev<=30, now>30)", () => {
    const res = evaluateRSIReversal(rrLong());
    expect(res.direction).toBe("LONG");
    expect(res.reason).toContain("Oversold");
  });

  it("returns SHORT on RSI overbought reversal (prev>=70, now<70)", () => {
    const res = evaluateRSIReversal(rrShort());
    expect(res.direction).toBe("SHORT");
  });

  it("returns NONE in mid-range RSI", () => {
    expect(evaluateRSIReversal(flat(80, 100)).direction).toBe("NONE");
  });
});

// --- evaluateTrendFollow ---
describe("evaluateTrendFollow", () => {
  it("returns LONG when price > SMA20 and EMA50 rising", () => {
    expect(evaluateTrendFollow(trendUp(80)).direction).toBe("LONG");
  });

  it("returns SHORT when price < SMA20 and EMA50 falling", () => {
    expect(evaluateTrendFollow(trendDown(80)).direction).toBe("SHORT");
  });

  it("returns NONE when price == SMA20 (flat)", () => {
    expect(evaluateTrendFollow(flat(80)).direction).toBe("NONE");
  });
});

// --- evaluateS2Scalper ---
describe("evaluateS2Scalper", () => {
  it("returns LONG on down-to-up reversal with volume spike + high PCR", () => {
    const res = evaluateS2Scalper(s2Long(), { pcr: 1.2 });
    expect(res.direction).toBe("LONG");
    expect(res.confidence).toBeGreaterThan(50);
  });

  it("returns SHORT on up-to-down reversal with volume spike + low PCR", () => {
    const res = evaluateS2Scalper(s2Short(), { pcr: 0.7 });
    expect(res.direction).toBe("SHORT");
  });

  it("returns NONE in flat market", () => {
    expect(evaluateS2Scalper(flat(80)).direction).toBe("NONE");
  });
});

// --- calculateTrailingSL ---
describe("calculateTrailingSL", () => {
  it("LONG: trails below highest price, never below entry", () => {
    const sl = calculateTrailingSL(100, 120, 95, 2, 1.5, "LONG");
    expect(sl).toBeCloseTo(117); // 120 - 2*1.5
    expect(sl).toBeGreaterThan(100);
  });

  it("SHORT: trails above lowest price, never above entry", () => {
    const sl = calculateTrailingSL(120, 125, 100, 2, 1.5, "SHORT");
    expect(sl).toBeCloseTo(103);
    expect(sl).toBeLessThan(120);
  });
});
