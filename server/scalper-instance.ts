import { AutoScalper } from "./auto-scalper.js";

// PGHO 1m promotion (2026-08-01): bollinger_band_reversal 20/2.5,
// TP 15% / SL 50% / theta 0 / sl_tp — holdout n=160 meanNet +0.91 PASS.
// Old sma_ema_cross config died under honest 1.25% costs; replaced.
export const scalper = new AutoScalper({
  symbol: "NIFTY",
  exchange: "NSE",
  assetType: "INDEX",
  lotSize: 65,
  lotCount: 2,
  totalQty: 130,
  pollIntervalMs: 15_000,
  strategy: "bollinger_band_reversal",
  paperMode: true,
  confidenceThreshold: 55,
  premiumTargetPct: 15,
  stopLossPct: 50,
  targetMode: "percent",
  bbPeriod: 20,
  bbStdDev: 2.5,
  exitMode: "sl_tp",
  strikeOffset: 1,
  maxConcurrentTrades: 1,
});

scalper.updateConfig({ symbol: "NIFTY", exchange: "NSE", strikeOffset: 1 });
