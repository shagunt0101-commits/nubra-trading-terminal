// Trend-confirmation gate: S2 entries must not fight a confirmed trend.
// Up-trend (ADX >= threshold, +DI > -DI) blocks BUY_PE; down-trend blocks
// BUY_CE. Disabled at trendGateAdx=0. Regression: S2 mean-reverts into
// trending days and bleeds.
import { describe, it, expect, vi } from "vitest";
import { AutoScalper } from "../auto-scalper.js";

// 60 rising bars (price +1.5/bar) — strong up-trend, high ADX, +DI > -DI.
const upTrendCandles = () => {
  const c: any[] = [];
  let p = 24500;
  for (let i = 0; i < 60; i++) {
    c.push({ ts: i, open: p, high: p + 1.2, low: p - 0.8, close: p + 1.5, volume: 1_000_000 });
    p += 1.5;
  }
  return c;
};
const downTrendCandles = () => {
  const c: any[] = [];
  let p = 25100;
  for (let i = 0; i < 60; i++) {
    c.push({ ts: i, open: p, high: p + 0.8, low: p - 1.2, close: p - 1.5, volume: 1_000_000 });
    p -= 1.5;
  }
  return c;
};

// Drive computeS2 through computeSignal with the fixture candles — the gate
// must turn a would-be BUY into NEUTRAL (direction === "NEUTRAL").
async function s2Direction(candles: any[], gateAdx: number, spot: number): Promise<string> {
  const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", strategy: "s2_scalper", trendGateAdx: gateAdx, confidenceThreshold: 20 } as any) as any;
  s.fetchCandles1m = vi.fn().mockResolvedValue(candles);
  s.getCachedChain = vi.fn().mockResolvedValue({
    chain: {
      ce: [{ sp: spot * 100, ltp: 5000, delta: 0.55, oi: 100, iv: 15 }],
      pe: [{ sp: spot * 100, ltp: 5000, delta: -0.55, oi: 100, iv: 15 }],
    },
  });
  s.log = vi.fn();
  const sig = await s.computeSignal(spot);
  return sig ? sig.direction : "null";
}

describe("trend-confirmation gate (S2)", () => {
  it("blocks BUY_PE during a confirmed up-trend (ADX >= threshold)", async () => {
    // up-trend fixture is strongly overbought (RSI 100) → S2 says SELL (BUY_PE).
    // Gate must block that counter-trend fade.
    expect(await s2Direction(upTrendCandles(), 25, 24600)).toBe("NEUTRAL");
  });

  it("blocks BUY_CE during a confirmed down-trend", async () => {
    expect(await s2Direction(downTrendCandles(), 25, 24600)).toBe("NEUTRAL");
  });

  it("allows the fade when the gate is disabled (default 0)", async () => {
    // same up-trend, gate off → counter-trend BUY_PE passes
    expect(await s2Direction(upTrendCandles(), 0, 24600)).toBe("BUY_PE");
  });

  it("gate blocks only counter-trend; aligned signal passes", async () => {
    // down-trend fixture: S2 lean is bullish (RSI 0) → BUY_CE — fights the
    // down-trend → blocked. With gate off, the same signal passes.
    expect(await s2Direction(downTrendCandles(), 25, 24600)).toBe("NEUTRAL");
    expect(await s2Direction(downTrendCandles(), 0, 24600)).toBe("BUY_CE");
  });

  it("trendDirection reports none when ADX below threshold", async () => {
    // flat/choppy candles → low ADX
    const c: any[] = [];
    for (let i = 0; i < 60; i++) c.push({ ts: i, open: 100 + (i % 2), high: 102 + (i % 2), low: 99 + (i % 2), close: 101 + (i % 2), volume: 100 });
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", trendGateAdx: 25 } as any) as any;
    const t = s.trendDirection(c);
    expect(t.trend).toBe("none");
    expect(t.adx).toBeLessThan(25);
  });
});
