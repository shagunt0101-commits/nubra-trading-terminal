// Comprehensive sweep: 5 instruments × 7 TFs × 9 strategies, tick-by-tick exits.
// Usage: npx tsx sweep.ts [daysBack]
import { writeFileSync } from "fs";
import { fetchCandles } from "./server/market-data.js";
import { runBacktest, BTCandle, BTOpts } from "./server/backtest-engine.js";

const INSTRUMENTS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const TFS = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"];
const STRATEGIES = ["s2_scalper", "option_rsi_mr", "trend_continuation", "bb_mean_reversion", "rsi_reversal", "sma_ema_trend", "sma_ema_cross", "rsi_overbought_oversold", "bollinger_band_reversal"];

// candles needed per TF for N trading days (6.25h market day)
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
        out.push({
          instrument: inst, tf, strategy: s, candles: candles.length,
          trades: r.summary.totalTrades, winRate: r.summary.winRate, profitFactor: r.summary.profitFactor,
          totalPnlPct: r.summary.totalPnlPct, avgPnlPct: r.summary.avgPnlPct, avgBars: r.summary.avgBars,
          maxWinPct: r.summary.maxWinPct, maxLossPct: r.summary.maxLossPct,
          tradeCount: r.trades.length,
        });
      }
      console.log(`[done] ${inst} ${tf}: ${candles.length} candles, ${STRATEGIES.length} strategies`);
    }
  }

  writeFileSync("sweep-results.json", JSON.stringify(out, null, 2));
  // CSV
  const cols = ["instrument", "tf", "strategy", "candles", "trades", "winRate", "profitFactor", "totalPnlPct", "avgPnlPct", "avgBars", "maxWinPct", "maxLossPct"];
  const csv = [cols.join(","), ...out.map(r => cols.map(c => r[c]).join(","))].join("\n");
  writeFileSync("sweep-results.csv", csv);
  console.log(`\nDone. ${out.length} runs, ${fetchErrors} fetch errors. sweep-results.json + sweep-results.csv written.`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
