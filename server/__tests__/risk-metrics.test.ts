import { describe, it, expect } from "vitest";
import { computeRiskMetrics } from "../risk-metrics.ts";
import { BTTrade } from "../backtest-engine.ts";

const day = 86_400_000;
const t0 = 1_700_000_000_000;

function mkTrade(i: number, netPnlPct: number): BTTrade {
  return {
    id: i, side: "BUY", entryTime: t0 + i * day, entryPrice: 100,
    stopLoss: 0, target: 0, exitTime: t0 + i * day + 3_600_000, exitPrice: 101,
    exitReason: "TP", pnl: 1, pnlPct: netPnlPct, netPnlPct,
    bars: 5, result: netPnlPct > 0 ? "WIN" : "LOSS",
  };
}

describe("computeRiskMetrics", () => {
  it("returns zero drawdown and null sharpe on identical returns (degenerate variance)", () => {
    const r = computeRiskMetrics(Array.from({ length: 100 }, (_, i) => mkTrade(i, 1)));
    expect(r.maxDrawdownPct).toBe(0);
    // sharpe must not blow up from float noise on near-zero variance
    expect(r.sharpe).toBeNull();
    expect(r.finalEquityPct).toBeGreaterThan(0);
  });

  it("computes a real drawdown and positive sharpe on alternating win/loss with positive expectancy", () => {
    const trades = Array.from({ length: 60 }, (_, i) => mkTrade(i, i % 2 === 0 ? 2 : -1));
    const r = computeRiskMetrics(trades);
    expect(r.maxDrawdownPct).toBeLessThan(0);
    expect(r.sharpe).not.toBeNull();
    expect(r.sharpe!).toBeGreaterThan(0);
    expect(r.finalEquityPct).toBeGreaterThan(0);
  });

  it("captures a large single-trade crash as max drawdown", () => {
    const trades = [
      ...Array.from({ length: 20 }, (_, i) => mkTrade(i, 1)),
      mkTrade(20, -30),
      ...Array.from({ length: 10 }, (_, i) => mkTrade(21 + i, 0.5)),
    ];
    const r = computeRiskMetrics(trades);
    expect(r.maxDrawdownPct).toBeLessThan(-25);
    expect(r.maxDrawdownPct).toBeGreaterThan(-35);
  });

  it("returns null sharpe below the 15-trade minimum sample size", () => {
    const r = computeRiskMetrics(Array.from({ length: 5 }, (_, i) => mkTrade(i, 1)));
    expect(r.sharpe).toBeNull();
  });

  it("handles an empty trade list without throwing", () => {
    const r = computeRiskMetrics([]);
    expect(r.n).toBe(0);
    expect(r.maxDrawdownPct).toBe(0);
    expect(r.sharpe).toBeNull();
  });
});
