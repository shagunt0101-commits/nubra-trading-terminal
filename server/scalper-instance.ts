import { AutoScalper } from "./auto-scalper.js";

export const scalper = new AutoScalper({
  symbol: "NIFTY",
  exchange: "NSE",
  assetType: "INDEX",
  lotSize: 65,
  lotCount: 2,
  totalQty: 130,
  pollIntervalMs: 15_000,
  confidenceThreshold: 55,
  premiumTargetPct: 30,
  stopLossPct: 20,
  strikeOffset: 1,
  maxConcurrentTrades: 1,
});

scalper.updateConfig({ symbol: "NIFTY", exchange: "NSE", strikeOffset: 1 });
