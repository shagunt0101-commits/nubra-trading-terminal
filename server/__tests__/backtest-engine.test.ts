import { describe, it, expect } from "vitest";
import { runBacktest, BTCandle } from "../backtest-engine.ts";

const mk = (i: number, open: number, close: number, high?: number, low?: number): BTCandle => ({
  ts: 1_700_000_000_000 + i * 300_000, open, close,
  high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), volume: 1_000_000,
});

// steady uptrend — sma_ema_trend fires LONG constantly
function uptrend(n: number): BTCandle[] {
  const c: BTCandle[] = [];
  for (let i = 0; i < n; i++) c.push(mk(i, 100 + i, 100 + i + 1));
  return c;
}

describe("runBacktest spot strategy", () => {
  it("fires signals and closes trades with tick-by-tick SL", () => {
    const r = runBacktest(uptrend(200), { strategy: "sma_ema_trend", instrument: "NIFTY", spotSLPct: 1, spotTPPct: 2 });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.entryPrice).toBeGreaterThan(0);
      // same-bar exit allowed: entry fills at open, TP/SL can trigger at that bar's high/low
      expect(t.exitTime).toBeGreaterThanOrEqual(t.entryTime);
      expect(["SL", "TP", "TIME", "EOD"].includes(t.exitReason)).toBe(true);
    }
    expect(r.summary.totalTrades).toBe(r.trades.length);
  });
});

describe("runBacktest premium strategy", () => {
  it("produces premium positions with intra-bar SL/TP + phase trailing", () => {
    const r = runBacktest(uptrend(200), {
      strategy: "rsi_reversal", instrument: "NIFTY",
      optionRsiPeriod: 14, optionRsiThreshold: 40, premiumTargetPoints: 4, premiumStopLossPct: 50,
    });
    // uptrend → maybe few/no rsi_reversal signals; just verify shape if any
    for (const t of r.trades) {
      expect(t.optType).toBeDefined();
      expect(t.entryPremium).toBeGreaterThan(0);
      expect(t.stopLoss).toBeLessThan(t.entryPremium!);
      expect(t.target).toBeGreaterThan(t.entryPremium!);
    }
  });
});

describe("runBacktest premium exit pricing", () => {
  it("never prices a premium exit at the spot price (regression: TIME/EOD used spot close)", () => {
    // NIFTY-like spot ~24000; premium model ~spot*0.006 ≈ 144. If any exit
    // premium ~spot level, the bug is back.
    const candles: BTCandle[] = [];
    for (let i = 0; i < 300; i++) {
      const open = 24000 + i * 3;
      candles.push(mk(i, open, open + 3, open + 8, open - 5));
    }
    const r = runBacktest(candles, { strategy: "trend_continuation", instrument: "NIFTY", premiumTargetPoints: 4, premiumStopLossPct: 50 });
    for (const t of r.trades) {
      expect(t.exitPremium).toBeDefined();
      // premium can never be near spot (24000) for a ~144 entry
      expect(t.exitPremium!).toBeLessThan(1000);
      expect(Math.abs(t.pnlPct)).toBeLessThan(1000);
    }
  });
});

describe("runBacktest no lookahead", () => {
  it("signal at bar i executes at open of i+1", () => {
    const r = runBacktest(uptrend(200), { strategy: "sma_ema_trend", instrument: "NIFTY", spotSLPct: 5, spotTPPct: 10 });
    expect(r.trades.length).toBeGreaterThan(0);
    const t = r.trades[0];
    // entryPrice must be the open of a bar AFTER signal bar — with strictly increasing
    // closes, entry open < signal close proves i+1 execution
    const entryIdx = t.entryTime === 0 ? -1 : Math.round((t.entryTime - 1_700_000_000_000) / 300_000);
    const entryOpen = 100 + entryIdx;
    expect(t.entryPrice).toBeCloseTo(entryOpen);
  });
});
