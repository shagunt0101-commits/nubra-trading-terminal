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

// ── Higher-TF S/R zone gate ─────────────────────────────────────────────────

// 15m candles oscillating 24600 ± 80 — repeated reactions near 24500 (lows)
// and 24700 (highs) form confirmed S/R clusters. ATR(14) ≈ 110 → 0.5*ATR
// filter ≈ 55, so these wicks qualify as real reactions.
function srCandles(levels: { price: number; kind: "S" | "R" }[]): any[] {
  const c: any[] = [];
  const n = 100;
  for (let i = 0; i < n; i++) {
    const base = 24600 + Math.sin(i / 5) * 80;
    let open = base, close = base, high = base + 60, low = base - 60;
    for (const lv of levels) {
      if (lv.kind === "S" && Math.abs(lv.price - base) < 40) { low = Math.min(low, lv.price - 2); }
      if (lv.kind === "R" && Math.abs(lv.price - base) < 40) { high = Math.max(high, lv.price + 2); }
    }
    c.push({ ts: i * 900_000, open, high, low, close, volume: 1_000_000 });
  }
  return c;
}

// Drive the S/R gate through computeSignal. Signal-candle direction: falling
// closes → RSI oversold → S2 leans BUY_CE; rising closes → BUY_PE. Mock
// srFetchCandles (higher TF) with the 15m candles, fetchCandles1m with the
// 1m signal series.
async function srDirection(spot: number, srTfCandles: any[], falling: boolean, srEnabled: boolean): Promise<{ dir: string; reasons: string[] }> {
  const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", strategy: "s2_scalper", trendGateAdx: 0, confidenceThreshold: 20, srEnabled, srTimeframe: "15m", srZonePct: 0.15 } as any) as any;
  // gentle 1m drift so RSI/MACD point where we want: falling closes → RSI 0 →
  // S2 leans BUY_CE; rising closes → RSI 100 → BUY_PE.
  const sigCandles: any[] = [];
  for (let i = 0; i < 60; i++) {
    const d = falling ? -0.5 : 0.5;
    const o = falling ? spot + 15 - i * 0.5 : spot - 15 + i * 0.5;
    sigCandles.push({ ts: i * 60_000, open: o, high: o + 1, low: o - 1, close: o + d, volume: 1_000_000 });
  }
  s.fetchCandles1m = vi.fn().mockResolvedValue(sigCandles);
  s.getCachedChain = vi.fn().mockResolvedValue({
    chain: {
      ce: [{ sp: spot * 100, ltp: 5000, delta: 0.55, oi: 100, iv: 15 }],
      pe: [{ sp: spot * 100, ltp: 5000, delta: -0.55, oi: 100, iv: 15 }],
    },
  });
  s.srFetchCandles = vi.fn().mockResolvedValue(srTfCandles);
  s.log = vi.fn();
  const sig = await s.computeSignal(spot);
  return { dir: sig ? sig.direction : "null", reasons: sig ? sig.reasons : [] };
}

describe("higher-TF S/R zone gate (S2)", () => {
  it("detects support and resistance levels from fractal pivots", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", srEnabled: true, srTimeframe: "15m" } as any) as any;
    s.srFetchCandles = vi.fn().mockResolvedValue(srCandles([{ price: 24700, kind: "R" }, { price: 24500, kind: "S" }]));
    const levels = await s.srLevels();
    expect(levels.length).toBeGreaterThanOrEqual(2);
    const kinds = levels.map(l => l.kind);
    expect(kinds).toContain("S");
    expect(kinds).toContain("R");
  });

  it("blocks BUY_CE into a resistance zone", async () => {
    // spot near resistance 24700 → BUY_CE must be blocked
    const candles = srCandles([{ price: 24700, kind: "R" }, { price: 24500, kind: "S" }]);
    const r = await srDirection(24695, candles, true, true);
    expect(r.dir).toBe("NEUTRAL");
  });

  it("blocks BUY_PE into a support zone", async () => {
    const candles = srCandles([{ price: 24700, kind: "R" }, { price: 24500, kind: "S" }]);
    const r = await srDirection(24505, candles, false, true);
    expect(r.dir).toBe("NEUTRAL");
  });

  it("boosts reversal BUY_CE at support (confidence +10)", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", strategy: "s2_scalper", trendGateAdx: 0, confidenceThreshold: 20, srEnabled: true, srTimeframe: "15m", srZonePct: 0.15 } as any) as any;
    const sigCandles: any[] = [];
    for (let i = 0; i < 60; i++) { const o = 24530 - i * 0.5; sigCandles.push({ ts: i * 60_000, open: o, high: o + 1, low: o - 1, close: o - 0.5, volume: 1_000_000 }); }
    s.fetchCandles1m = vi.fn().mockResolvedValue(sigCandles);
    s.getCachedChain = vi.fn().mockResolvedValue({ chain: { ce: [{ sp: 2450000, ltp: 5000, delta: 0.55, oi: 100, iv: 15 }], pe: [{ sp: 2450000, ltp: 5000, delta: -0.55, oi: 100, iv: 15 }] } });
    s.srFetchCandles = vi.fn().mockResolvedValue(srCandles([{ price: 24500, kind: "S" }, { price: 24700, kind: "R" }]));
    s.log = vi.fn();
    const sig = await s.computeSignal(24500);
    expect(sig?.direction).toBe("BUY_CE"); // not blocked — support reversal is fine
    expect(sig?.reasons.some((x: string) => x.includes("S/R"))).toBe(true);
  });

  it("passes signals away from any zone (no block, no boost)", async () => {
    const candles = srCandles([{ price: 24700, kind: "R" }, { price: 24500, kind: "S" }]);
    const r = await srDirection(24600, candles, true, true); // spot mid-range
    expect(r.dir).not.toBe("NEUTRAL");
    expect(r.reasons.some((x: string) => x.includes("S/R"))).toBe(false);
  });

  it("gate off (srEnabled false) never blocks", async () => {
    const candles = srCandles([{ price: 24700, kind: "R" }, { price: 24500, kind: "S" }]);
    const r = await srDirection(24695, candles, true, false);
    expect(r.dir).not.toBe("NEUTRAL");
  });
});
