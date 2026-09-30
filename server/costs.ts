// Per-class trading costs, % of notional (entryPremium for options, entryPrice for spot).
// Net PnL of every backtest trade = gross pnlPct − costPct(class). The optimizer
// must never rank on raw PnL — costs are what eat the measured ~0.26%/trade edge.
// Premium round trip = 2*0.5 + 0.1 + 0.15 = 1.25%, itemized @ P=100:
// brokerage 0.62 (₹20×2 / ₹6500 notional) + STT sell 0.1 + TCC 0.07 + GST 0.12
// + stamp 0.003 + spread 0.25 + impact 0.1 = 1.26%. Old 0.7125% was ~2× too cheap.
// Spot (index futures): STT 0.02% since 2024; slippage 0.05/side, fees 0.03.
export const COSTS = {
  premium: { slippage: 0.5, stt: 0.1, fees: 0.15 },
  spot: { slippage: 0.05, stt: 0.02, fees: 0.03 },
} as const;

export type CostClass = keyof typeof COSTS;

export function costPct(kind: CostClass): number {
  const c = COSTS[kind];
  return 2 * c.slippage + c.stt + c.fees;
}
