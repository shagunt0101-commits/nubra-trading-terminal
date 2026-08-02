// Same grid as sweep.ts, but keeps each cell's trades[] long enough to compute
// Sharpe ratio and max drawdown before discarding it (sweep.ts never captured
// this — its output has win rate / profit factor / avg PnL only).
// Usage: npx tsx risk-sweep.ts [daysBack]
import { writeFileSync } from "fs";
import { fetchCandles } from "./server/market-data.js";
import { runBacktest, BTCandle, BTOpts } from "./server/backtest-engine.js";
import { computeRiskMetrics } from "./server/risk-metrics.js";

const INSTRUMENTS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const TFS = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"];
// Only the 4 strategies SWEEP-ANALYTICS.md found evaluable on real prices
// (the 5 "premium" strategies' PnL is a modeling artifact per that report —
// re-add them here only after real per-strike LTP/IV data replaces the model).
const STRATEGIES = ["s2_scalper", "sma_ema_cross", "rsi_overbought_oversold", "bollinger_band_reversal"];

const TF_MIN: Record<string, number> = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
function candlesNeeded(tf: string, days: number): number {
  return Math.ceil((days * 6.25 * 3600) / TF_MIN[tf]) + 80;
}

async function main() {
  const days = parseInt(process.argv[2] || "45", 10);
  const out: any[] = [];
  let fetchErrors = 0;

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const count = candlesNeeded(tf, days);
      let candles: BTCandle[] = [];
      try {
        const raw = await fetchCandles(inst, "NSE", tf, count);
        candles = raw.map((c: any) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
        if (candles.length < 200) { console.log(`[skip] ${inst} ${tf}: only ${candles.length} candles`); fetchErrors++; continue; }
      } catch (e: any) { console.log(`[err] ${inst} ${tf}: ${e.message}`); fetchErrors++; continue; }

      for (const s of STRATEGIES) {
        const opts: BTOpts = {
          strategy: s, instrument: inst,
          confidenceThreshold: 55, spotSLPct: 1.5, spotTPPct: 3,
          optionRsiThreshold: 40, optionRsiPeriod: 14, maxEntryPremium: 600,
          premiumTargetPct: 30, premiumStopLossPct: 40, thetaPctPerDay: 1.0,
        };
        const r = runBacktest(candles, opts);
        const risk = computeRiskMetrics(r.trades);
        out.push({
          instrument: inst, tf, strategy: s, candles: candles.length,
          trades: r.summary.totalTrades, winRate: r.summary.winRate, profitFactor: r.summary.profitFactor,
          totalPnlPct: r.summary.totalPnlPct, avgPnlPct: r.summary.avgPnlPct, avgBars: r.summary.avgBars,
          sharpe: risk.sharpe, maxDrawdownPct: risk.maxDrawdownPct,
          maxDrawdownDurationDays: risk.maxDrawdownDurationDays, calmar: risk.calmar,
          annualizedReturnPct: risk.annualizedReturnPct, finalEquityPct: risk.finalEquityPct,
          tradesPerYear: risk.tradesPerYear,
        });
      }
      console.log(`[done] ${inst} ${tf}: ${candles.length} candles, ${STRATEGIES.length} strategies`);
    }
  }

  writeFileSync("risk-results.json", JSON.stringify(out, null, 2));
  const cols = ["instrument", "tf", "strategy", "candles", "trades", "winRate", "profitFactor",
    "totalPnlPct", "avgPnlPct", "avgBars", "sharpe", "maxDrawdownPct", "maxDrawdownDurationDays",
    "calmar", "annualizedReturnPct", "finalEquityPct", "tradesPerYear"];
  const csv = [cols.join(","), ...out.map(r => cols.map(c => r[c]).join(","))].join("\n");
  writeFileSync("risk-results.csv", csv);
  console.log(`\nDone. ${out.length} runs, ${fetchErrors} fetch errors. risk-results.json + risk-results.csv written.`);
  console.log(`Note: sharpe is null for any cell with <15 trades — not enough data to mean anything at that sample size.`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
