// PGHO — promotion side. This module OWNS the holdout data; the search
// (optimizer.ts) has no access to it. Promotion applies gate G6 exactly once:
// the top-1 config per strategy must reproduce on the untouched holdout,
// else the strategy reports NO TRADABLE CONFIG. A failed holdout NEVER
// restarts the search.
import { BTCandle, runBacktest } from "./backtest-engine.js";
import { ConfigResult } from "./optimizer.js";

export interface PromoteResult {
  strategy: string;
  candidate: ConfigResult | null;
  holdout: { nTrades: number; meanNet: number; pass: boolean };
  promoted: boolean;
  verdict: "PROMOTED" | "NO_TRADABLE_CONFIG" | "NO_CANDIDATE";
}

export function promote(
  strategy: string,
  candidate: ConfigResult | null,
  holdoutCandles: OptimizeCfg[]
): PromoteResult {
  if (!candidate) return { strategy, candidate: null, holdout: { nTrades: 0, meanNet: 0, pass: false }, promoted: false, verdict: "NO_CANDIDATE" };
  let n = 0, sum = 0;
  for (const d of holdoutCandles) {
    const run = runBacktest(d.candles, { ...candidate.cfg, strategy, instrument: d.instrument, maxGapMult: 4 });
    n += run.trades.length;
    sum += run.trades.reduce((a, t) => a + t.netPnlPct, 0);
  }
  const meanNet = n ? sum / n : 0;
  const pass = n >= 10 && meanNet > 0;
  return {
    strategy, candidate,
    holdout: { nTrades: n, meanNet, pass },
    promoted: pass,
    verdict: pass ? "PROMOTED" : "NO_TRADABLE_CONFIG",
  };
}

// ts-disjoint assertion: the holdout must be strictly AFTER the train split.
// Called by the CLI with the split boundary before any promotion runs.
export function assertDisjoint(train: OptimizeCfg[], holdout: OptimizeCfg[]): void {
  for (const t of train) {
    for (const h of holdout) {
      if (t.instrument === h.instrument) {
        const maxTrain = t.candles[t.candles.length - 1].ts;
        const minHoldout = h.candles[0].ts;
        if (minHoldout <= maxTrain) {
          throw new Error(`ts-overlap between train and holdout for ${t.instrument} (train ends ${maxTrain}, holdout starts ${minHoldout})`);
        }
      }
    }
  }
}

// Helper: split candles at the session boundary nearest 75% of trading days.
export function splitAtSessionBoundary(candles: BTCandle[], frac = 0.75): { train: BTCandle[]; holdout: BTCandle[] } {
  const days = new Set(candles.map(c => new Date(c.ts).toISOString().slice(0, 10)));
  const dayList = [...days].sort();
  const holdoutDays = new Set(dayList.slice(Math.ceil(dayList.length * frac)));
  const idx = candles.findIndex(c => holdoutDays.has(new Date(c.ts).toISOString().slice(0, 10)));
  const cut = idx === -1 ? Math.floor(candles.length * frac) : idx;
  return { train: candles.slice(0, cut), holdout: candles.slice(cut) };
}

interface OptimizeCfg { instrument: string; candles: BTCandle[] }
