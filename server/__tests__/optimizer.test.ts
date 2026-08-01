import { describe, it, expect } from "vitest";
import { runBacktest, BTCandle, precomputeSignals, s2Surface, s2SignalAt, BTOpts } from "../backtest-engine.ts";
import { mulberry32, clusterBootstrapQ05, gridFor, optimize, selectPlateau } from "../optimizer.ts";
import { splitAtSessionBoundary, assertDisjoint } from "../promote.ts";
import { costPct } from "../costs.ts";
import { evaluateS2Scalper } from "../strategy-engine.ts";
import { calculateRSI } from "../indicators.ts";

const BAR_MS = 900_000; // 15m
const mk = (i: number, open: number, close: number, high?: number, low?: number): BTCandle => ({
  ts: 1_700_000_000_000 + i * BAR_MS, open, close,
  high: high ?? Math.max(open, close), low: low ?? Math.min(open, close), volume: 1_000_000,
});

// sharp sine (amp 0.6%, period 5) on index scale with slight drift →
// RSI(14) crosses 30/70 on every swing, mean reversion wins with tight SL/TP.
// 520 bars = 20 clean 15m days (26/day). Base 24000 ≈ NIFTY level so the
// premium model (spot*0.006) prices ~₹140 ATM options like live; amp 150 gives
// ~₹1-5 premium swings — enough to hit % targets against premium cost.
function dataFor(bars = 520): { instrument: string; candles: BTCandle[] }[] {
  return ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].map((instrument, j) => {
    const candles: BTCandle[] = [];
    let prev = 24000 + j * 1000;
    for (let i = 0; i < bars; i++) {
      const close = 24000 + j * 1000 + 150 * Math.sin(i / 5) + 0.1 * i;
      candles.push(mk(i, prev, close, Math.max(prev, close) + 2, Math.min(prev, close) - 2));
      prev = close;
    }
    return { instrument, candles };
  });
}

describe("costs", () => {
  it("spot cost ≈ 0.15%, premium ≈ 1.25%", () => {
    expect(costPct("spot")).toBeCloseTo(0.15, 5);
    expect(costPct("premium")).toBeCloseTo(1.25, 5);
  });
});

describe("precomputeSignals invariance", () => {
  it("precomputed signals identical to per-bar slice evaluation (no lookahead)", () => {
    const candles = dataFor()[0].candles;
    const P = precomputeSignals(candles, "rsi_overbought_oversold", { strategy: "rsi_overbought_oversold", instrument: "NIFTY" });
    const closes = candles.map(c => c.close);
    let mismatches = 0;
    for (let i = 50; i < candles.length; i++) {
      const rsi = calculateRSI(closes.slice(0, i + 1), 14);
      const expLong = rsi[i] > 30 && rsi[i - 1] <= 30;
      const expShort = rsi[i] < 70 && rsi[i - 1] >= 70;
      if (P.long[i] !== expLong || P.short[i] !== expShort) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe("optimizer determinism", () => {
  it("same seed → same q05", () => {
    const data = { A: [4, 4], B: [3, 3], C: [2, 2], D: [1, 1], E: [0.5, 0.5] };
    const a = clusterBootstrapQ05(data, mulberry32(7), 1000);
    const b = clusterBootstrapQ05(data, mulberry32(7), 1000);
    expect(a.q05).toBe(b.q05);
  });
});

describe("grid surfaces", () => {
  it("2520 total configs across the 5 strategies (×2 exit modes)", () => {
    const total = ["rsi_overbought_oversold", "bollinger_band_reversal", "sma_ema_cross", "s2_scalper", "option_rsi_mr"]
      .reduce((a, s) => a + gridFor(s).length, 0);
    expect(total).toBe(2520);
  });
});

describe("optimize gates", () => {
  it("zigzag data: known-good config passes G1–G5", () => {
    // rsi_overbought_oversold on a sine wave: RSI crosses 30-up near swing
    // lows (bounce wins) and 70-down near swing highs (fade wins) — genuinely
    // mean-reverting, so a tight SL/TP config must be net-positive.
    const res = optimize(dataFor(), "rsi_overbought_oversold", { seed: 42, bootstrapRuns: 100 });
    const allPass = res.filter(r => r.gates.every(g => g.pass));
    expect(allPass.length).toBeGreaterThan(0);
    const any = allPass[0];
    expect(any.nTrades).toBeGreaterThanOrEqual(30);
    expect(any.meanNet).toBeGreaterThan(0);
  });

  it("selectPlateau returns config within 0.05 of best q05", () => {
    const res = optimize(dataFor(), "rsi_overbought_oversold", { seed: 42, bootstrapRuns: 100 });
    const cand = selectPlateau(res);
    expect(cand).not.toBeNull();
    const best = Math.max(...res.filter(r => r.gates.every(g => g.pass)).map(r => r.q05));
    expect(cand!.q05).toBeGreaterThanOrEqual(best - 0.05);
  });
});

describe("split + disjoint", () => {
  it("splitAtSessionBoundary cuts ~75%, holdout strictly later, full days", () => {
    const candles = dataFor()[0].candles; // 520 bars = 20 days
    const { train, holdout } = splitAtSessionBoundary(candles, 0.75);
    expect(train.length + holdout.length).toBe(candles.length);
    expect(holdout.length).toBeGreaterThan(25); // ~5 full days
    expect(holdout[0].ts).toBeGreaterThan(train[train.length - 1].ts);
  });

  it("assertDisjoint throws on overlap", () => {
    const d = dataFor();
    expect(() => assertDisjoint([d[0]], [{ instrument: "NIFTY", candles: d[0].candles }])).toThrow(/ts-overlap/);
  });
});

describe("phase exit mode", () => {
  it("sl_tp vs phase produce different exit distributions (BE-lock + trail)", () => {
    const candles = dataFor()[0].candles;
    const base: BTOpts = { strategy: "rsi_overbought_oversold", instrument: "NIFTY", rsiPeriod: 5, premiumTargetPct: 15, premiumStopLossPct: 30, thetaPctPerDay: 0 };
    const plain = runBacktest(candles, { ...base, exitMode: "sl_tp" });
    const phase = runBacktest(candles, { ...base, exitMode: "phase" });
    expect(phase.trades.length).toBeGreaterThan(0);
    // phase mode has TRAIL exits; plain never does
    expect(phase.trades.some(t => t.exitReason === "TRAIL")).toBe(true);
    expect(plain.trades.some(t => t.exitReason === "TRAIL")).toBe(false);
  });
});

describe("s2 precompute parity", () => {
  it("s2SignalAt matches evaluateS2Scalper slice eval", () => {
    const candles = dataFor()[0].candles;
    const S = s2Surface(candles);
    const closes = candles.map(c => c.close);
    let mismatches = 0;
    for (let i = 50; i < candles.length; i++) {
      const r = evaluateS2Scalper(candles.slice(0, i + 1) as any);
      const sig = s2SignalAt(S, closes, i);
      const exp = r.direction === "NONE" ? null : { dir: r.direction, conf: Math.round(r.confidence) };
      if (!sig !== !exp) mismatches++;
      else if (sig && (sig.dir !== exp!.dir || sig.conf !== exp!.conf)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe("engine regression: gap + session + cost", () => {
  it("SESSION exit on gaps and netPnlPct = pnlPct − premium cost", () => {
    // steady uptrend (sma_ema_trend fires constantly, premium class); ts gap at bar 150
    const candles: BTCandle[] = [];
    for (let i = 0; i < 200; i++) {
      candles.push({ ...mk(i, 100 + i, 100 + i + 1), ts: 1_700_000_000_000 + i * BAR_MS + (i >= 150 ? 10 * BAR_MS : 0) });
    }
    const r = runBacktest(candles, { strategy: "sma_ema_trend", instrument: "NIFTY", premiumTargetPct: 1000, premiumStopLossPct: 1000, thetaPctPerDay: 0, maxGapMult: 4 });
    expect(new Set(r.trades.map(t => t.exitReason)).has("SESSION")).toBe(true);
    for (const t of r.trades) {
      // engine rounds the cost-adjusted value the same way as pnlPct
      expect(t.netPnlPct).toBe(Math.round((t.pnlPct - costPct("premium")) * 100) / 100);
    }
  });
});
