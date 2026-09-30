// PGHO CLI — Pooled-Grid Holdout Optimizer.
// Usage: npx tsx optimize.ts [daysBack] [seed] [bootstrapRuns]
// Fetches real Nubra candles, splits train/holdout at a session boundary,
// runs the 576-config grid per strategy, promotes on the once-only holdout.
// Writes optimize-results.json and prints the report.
import { writeFileSync } from "fs";
import { fetchCandles } from "./server/market-data.js";
import { BTCandle } from "./server/backtest-engine.js";
import { optimize, selectPlateau, gridFor, ConfigResult } from "./server/optimizer.js";
import { promote, assertDisjoint, splitAtSessionBoundary, PromoteResult } from "./server/promote.js";

const INSTRUMENTS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const STRATEGIES = ["rsi_overbought_oversold", "bollinger_band_reversal", "sma_ema_cross", "s2_scalper", "option_rsi_mr"];
const TF = "1m";
const TF_MIN = 60; // seconds per 1m bar
const DAY_SEC = 6.25 * 3600;

function candlesNeeded(days: number): number {
  return Math.ceil((days * DAY_SEC) / TF_MIN) + 80;
}

async function main() {
  const days = parseInt(process.argv[2] || "45", 10);
  const seed = parseInt(process.argv[3] || "42", 10);
  const bootstrapRuns = parseInt(process.argv[4] || "1000", 10);
  const count = candlesNeeded(days);

  // fetch once per instrument, split in memory
  const rawAll: { instrument: string; candles: BTCandle[] }[] = [];
  for (const inst of INSTRUMENTS) {
    try {
      const raw = await fetchCandles(inst, "NSE", TF, count);
      // Nubra returns ts in nanoseconds; engine + splitter expect ms
      const candles: BTCandle[] = raw.map((c: any) => ({ ts: c.ts > 1e15 ? Math.floor(c.ts / 1e6) : c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
      rawAll.push({ instrument: inst, candles });
      console.log(`[fetch] ${inst} ${TF}: ${candles.length} candles`);
    } catch (e: any) {
      console.log(`[err] ${inst}: ${e.message}`);
    }
  }
  if (rawAll.length < 3) { console.error("FATAL: too few instruments fetched"); process.exit(1); }

  const trainAll: { instrument: string; candles: BTCandle[] }[] = [];
  const holdoutAll: { instrument: string; candles: BTCandle[] }[] = [];
  for (const { instrument, candles } of rawAll) {
    const { train, holdout } = splitAtSessionBoundary(candles, 0.75);
    trainAll.push({ instrument, candles: train });
    holdoutAll.push({ instrument, candles: holdout });
    console.log(`[split] ${instrument}: train ${train.length} / holdout ${holdout.length} candles`);
  }
  assertDisjoint(trainAll, holdoutAll);
  console.log("[split] train/holdout ts-disjoint ✓");

  const results: Record<string, ConfigResult[]> = {};
  const promoted: Record<string, PromoteResult> = {};
  const report: string[] = [];

  for (const strategy of STRATEGIES) {
    console.log(`\n=== ${strategy} (${gridFor(strategy).length} configs) ===`);
    const res = optimize(trainAll, strategy, { seed, bootstrapRuns });
    results[strategy] = res;
    const m = res.length;
    const candidate = selectPlateau(res);
    report.push(`\n### ${strategy} (m=${m} configs; expected false promotions at 95% ≈ ${(0.05 * m).toFixed(1)})`);
    const best = res.reduce((a, b) => (b.q05 > a.q05 ? b : a), res[0]);
    const med = [...res].sort((a, b) => a.q05 - b.q05)[Math.floor(res.length / 2)];
    const delta = best.q05 - med.q05;
    report.push(`  best q05 ${best.q05.toFixed(4)} (n=${best.nTrades}) | median q05 ${med.q05.toFixed(4)} | Δ ${delta.toFixed(4)} ${delta < 0.05 ? "→ NO DISTINGUISHABLE EDGE" : ""}`);
    if (candidate) {
      const verdict = promote(strategy, candidate, holdoutAll);
      promoted[strategy] = verdict;
      report.push(`  candidate: ${JSON.stringify(candidate.cfg)} q05=${candidate.q05.toFixed(4)} n=${candidate.nTrades}`);
      report.push(`  holdout: n=${verdict.holdout.nTrades} meanNet=${verdict.holdout.meanNet.toFixed(4)} ${verdict.holdout.pass ? "PASS" : "FAIL"}`);
      report.push(`  VERDICT: ${verdict.verdict}`);
    } else {
      promoted[strategy] = { strategy, candidate: null, holdout: { nTrades: 0, meanNet: 0, pass: false }, promoted: false, verdict: "NO_CANDIDATE" };
      report.push("  no config passed G1–G5 → NO CANDIDATE");
    }
    // per-instrument table for the best gated config
    const gated = res.filter(r => r.gates.every(g => g.pass));
    if (gated.length) {
      report.push("  per-instrument (best gated):");
      const top = [...gated].sort((a, b) => b.q05 - a.q05)[0];
      for (const [inst, p] of Object.entries(top.perInstrument)) {
        report.push(`    ${inst}: n=${p.n} meanNet=${p.meanNet.toFixed(4)}`);
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    days, tf: TF, seed, bootstrapRuns,
    instruments: rawAll.map(r => `${r.instrument}:${r.candles.length}`),
    strategies: STRATEGIES,
    results,
    promoted,
  };
  writeFileSync("optimize-results.json", JSON.stringify(out, null, 2));

  console.log("\n" + report.join("\n"));
  console.log("\n[written] optimize-results.json");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
