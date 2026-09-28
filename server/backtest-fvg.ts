// FVG Strategy Backtest — 1m candles from tick captures + real chain premium
// Usage: npx tsx server/backtest-fvg.ts [days...]

import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline";
import { runBacktest, type BTCandle, type BTOpts, setChainPremium } from "./backtest-engine.js";
import { detectFVGs, checkFVGMitigation, getTrendDirection } from "./strategy-engine.js";
import { calculateEMA } from "./indicators.js";

const DIR = process.env.TMPDIR || process.env.TEMP || os.tmpdir();
const DAYS = (process.argv.slice(2).length ? process.argv.slice(2)
  : ["20260810", "20260811"]).filter(d => fs.existsSync(path.join(DIR, `mvf-tick-${d}.jsonl`)));

interface ChainRow { ts: number; spot: number; atmCe: number | null; atmPe: number | null; }

async function loadDay(day: string): Promise<{ candles: BTCandle[]; prem: Map<number, { CE: number; PE: number }> }> {
  const f = path.join(DIR, `mvf-tick-${day}.jsonl`);
  const byTs = new Map<number, BTCandle>();
  const prem = new Map<number, { CE: number; PE: number }>();
  let lastSpot = 0, lastCe = 0, lastPe = 0, live = 0, frozen = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(f, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.symbol !== "NIFTY" || !Array.isArray(r.candle)) continue;

    const chain = r.chain || {};
    const atmStrike = typeof chain.atm === "number" ? chain.atm : null;
    let ce: number | null = null, pe: number | null = null;
    if (atmStrike) {
      for (const o of (chain.ce || [])) if (o.sp === atmStrike && typeof o.ltp === "number" && o.ltp > 0) { ce = o.ltp / 100; break; }
      for (const o of (chain.pe || [])) if (o.sp === atmStrike && typeof o.ltp === "number" && o.ltp > 0) { pe = o.ltp / 100; break; }
    }
    const spot = r.spot;
    if (spot === lastSpot && (ce === lastCe || ce === null) && (pe === lastPe || pe === null)) { frozen++; continue; }
    lastSpot = spot; if (ce != null) lastCe = ce; if (pe != null) lastPe = pe;
    live++;

    for (const c of r.candle) {
      const ts = Math.round(c.ts / 1e6);
      if (!byTs.has(ts)) byTs.set(ts, { ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    }
    const rowMinute = r.ts - (r.ts % 60_000);
    if (ce != null && pe != null) prem.set(rowMinute, { CE: ce, PE: pe });
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  console.log(`${day}: ${candles.length} candles, ${prem.size} min w/ chain, ${live} live / ${frozen} frozen rows`);
  return { candles, prem };
}

function chainFn(prem: Map<number, { CE: number; PE: number }>) {
  const keys = [...prem.keys()].sort((a, b) => a - b);
  return (ts: number, opt: "CE" | "PE"): number | null => {
    let lo = 0, hi = keys.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    if (ans < 0) return null;
    const v = prem.get(keys[ans])!;
    return opt === "CE" ? v.CE : v.PE;
  };
}

async function main() {
  if (!DAYS.length) { console.error("No tick files found in " + DIR); process.exit(1); }
  const allCandles: BTCandle[] = [];
  const allPrem = new Map<number, { CE: number; PE: number }>();
  for (const d of DAYS) {
    const { candles, prem } = await loadDay(d);
    allCandles.push(...candles);
    for (const [k, v] of prem) allPrem.set(k, v);
  }
  allCandles.sort((a, b) => a.ts - b.ts);
  console.log(`\nTotal: ${allCandles.length} candles, ${allPrem.size} chain-minutes over ${DAYS.join(", ")}`);

  // Set up chain premium for backtest
  setChainPremium(chainFn(allPrem));

  // FVG Strategy config
  const fvgOpts: BTOpts = {
    strategy: "fvg_strategy",
    instrument: "NIFTY",
    maxEntryPremium: 600,
    fvgRiskReward: 1.8,
    maxHoldBars: 60, // 1h max hold
    premiumTargetPct: 30,
    premiumStopLossPct: 40,
    exitMode: "sl_tp",
    entryCutoffMin: 1415, // no new entries after 14:15
    sessionCloseMin: 1530, // force close at 15:30
  };

  console.log("\n=== FVG STRATEGY BACKTEST ===");
  const run = runBacktest(allCandles, fvgOpts);

  console.log(`\nTrades: ${run.trades.length}`);
  console.log(`Win Rate: ${run.summary.winRate}%`);
  console.log(`Total PnL%: ${run.summary.totalPnlPct}%`);
  console.log(`Avg PnL%: ${run.summary.avgPnlPct}%`);
  console.log(`Profit Factor: ${run.summary.profitFactor}`);
  console.log(`Max Win: ${run.summary.maxWinPct}%`);
  console.log(`Max Loss: ${run.summary.maxLossPct}%`);
  console.log(`Avg Hold: ${run.summary.avgBars} bars`);

  if (run.trades.length > 0) {
    console.log("\n--- TRADES ---");
    for (const t of run.trades.slice(0, 20)) {
      const d = new Date(t.entryTime);
      const exitD = new Date(t.exitTime);
      console.log(`${d.toISOString().slice(11,16)} ${t.side} ${t.optType} ${t.strike} entry@${t.entryPremium} exit@${t.exitPremium} pnl%=${t.pnlPct.toFixed(1)} ${t.result} ${t.exitReason} hold=${t.bars}m`);
    }
    if (run.trades.length > 20) console.log(`... and ${run.trades.length - 20} more trades`);
  }

  // Also run parameter sweep
  console.log("\n=== PARAMETER SWEEP ===");
  const rrValues = [1.5, 1.8, 2.0, 2.5, 3.0];
  const holdValues = [30, 45, 60, 90];
  const cutoffValues = [0, 1330, 1415, 1500];

  for (const rr of rrValues) {
    for (const hold of holdValues) {
      for (const cutoff of cutoffValues) {
        const opts: BTOpts = {
          ...fvgOpts,
          fvgRiskReward: rr,
          maxHoldBars: hold,
          entryCutoffMin: cutoff,
        };
        const r = runBacktest(allCandles, opts);
        if (r.trades.length >= 5) {
          console.log(`RR=${rr} Hold=${hold}m Cutoff=${cutoff} Trades=${r.trades.length} WR=${r.summary.winRate}% AvgPnL=${r.summary.avgPnlPct}% PF=${r.summary.profitFactor} MaxDD=${r.summary.maxLossPct}%`);
        }
      }
    }
  }

  setChainPremium(null);
}

main().catch(e => { console.error(e); process.exit(1); });