// Sharpe ratio + max drawdown from a BTTrade[] equity curve.
// Neither backtest-engine.ts nor sweep.ts computed these before — summary only
// tracked win rate / profit factor / avg PnL. This derives both from the same
// trades[] array runBacktest already produces, using compounding equity
// (each trade's netPnlPct applied sequentially in exit-time order — matches
// the engine's single-position-at-a-time model, no look-ahead).
import { BTTrade } from "./backtest-engine.js";

export interface RiskMetrics {
  sharpe: number | null;          // annualized, trade-return based
  maxDrawdownPct: number;         // most negative peak-to-trough equity move, %
  maxDrawdownDurationDays: number | null; // longest stretch (calendar days) equity spent below its prior peak
  calmar: number | null;          // annualized return / |maxDrawdownPct|
  annualizedReturnPct: number | null;
  finalEquityPct: number;         // total compounded return, %
  tradesPerYear: number | null;
  n: number;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeRiskMetrics(trades: BTTrade[]): RiskMetrics {
  const n = trades.length;
  if (n === 0) {
    return {
      sharpe: null, maxDrawdownPct: 0, maxDrawdownDurationDays: null,
      calmar: null, annualizedReturnPct: null, finalEquityPct: 0,
      tradesPerYear: null, n: 0,
    };
  }

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const rets = sorted.map(t => t.netPnlPct / 100); // fractional per-trade return

  // Compounding equity curve, starting at 1.0
  let equity = 1;
  const curve: { t: number; equity: number }[] = [{ t: sorted[0].entryTime, equity: 1 }];
  for (const r of rets.map((r, i) => ({ r, t: sorted[i].exitTime }))) {
    equity *= (1 + r.r);
    curve.push({ t: r.t, equity });
  }
  const finalEquityPct = (equity - 1) * 100;

  // Max drawdown (peak-to-trough on the compounding curve) + duration in
  // calendar days spent below the prior peak.
  let peak = curve[0].equity;
  let peakTime = curve[0].t;
  let maxDD = 0;
  let maxDDDurationMs = 0;
  for (const pt of curve) {
    if (pt.equity > peak) { peak = pt.equity; peakTime = pt.t; }
    const dd = (pt.equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    const underwaterMs = pt.t - peakTime;
    if (underwaterMs > maxDDDurationMs) maxDDDurationMs = underwaterMs;
  }
  const maxDrawdownPct = maxDD * 100;
  const maxDrawdownDurationDays = maxDDDurationMs > 0 ? Math.round(maxDDDurationMs / 86_400_000 * 10) / 10 : 0;

  // Time span covered, for annualization. Guard against a single-day span
  // (or n=1) producing a nonsensical multiplier.
  const spanMs = sorted[n - 1].exitTime - sorted[0].entryTime;
  const spanDays = spanMs / 86_400_000;
  const tradesPerYear = spanDays >= 1 ? n / (spanDays / 365) : null;

  // Trade-return Sharpe, annualized by sqrt(trades/year). This is the
  // defensible choice for low-frequency strategies (documented elsewhere in
  // this repo at ~0.08 trades/cell/day): a daily-bucketed Sharpe would treat
  // near-zero-trade days as zero-return days and silently deflate volatility,
  // inflating Sharpe. Requires n≥~15 to mean anything; flag below that.
  const meanRet = rets.reduce((a, b) => a + b, 0) / n;
  const sd = stdev(rets);
  // Guard against near-zero variance (e.g. every trade hitting the identical
  // % SL/TP): floating-point noise in sd (~1e-18) divided into meanRet
  // produces an astronomical, meaningless Sharpe. 1e-6 is well below any
  // real trade-return dispersion but well above float rounding error.
  const sharpe = (sd > 1e-6 && tradesPerYear && n >= 15)
    ? (meanRet / sd) * Math.sqrt(tradesPerYear)
    : null;

  const annualizedReturnPct = (tradesPerYear && spanDays >= 30)
    ? (Math.pow(equity, 365 / spanDays) - 1) * 100
    : null;

  const calmar = (annualizedReturnPct != null && maxDrawdownPct < 0)
    ? annualizedReturnPct / Math.abs(maxDrawdownPct)
    : null;

  return {
    sharpe: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    maxDrawdownDurationDays,
    calmar: calmar != null ? Math.round(calmar * 100) / 100 : null,
    annualizedReturnPct: annualizedReturnPct != null ? Math.round(annualizedReturnPct * 100) / 100 : null,
    finalEquityPct: Math.round(finalEquityPct * 100) / 100,
    tradesPerYear: tradesPerYear != null ? Math.round(tradesPerYear) : null,
    n,
  };
}
