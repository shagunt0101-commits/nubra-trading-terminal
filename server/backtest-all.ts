// Full-strategy sweep on 3-day tick captures — replay every strategy × tuning
// on real 1m candles + REAL ATM option-chain LTP (no premium model).
//
// Data: %TEMP%\mvf-tick-YYYYMMDD.jsonl (15s poll: spot 1m candles + ATM chain).
//   - Dedupes rolling candle windows into one continuous per-minute series.
//   - Builds per-minute ATM CE/PE premium map from chain LTP (chain.atm =
//     strike; CE/PE rows matched by sp === atm; last-write-wins per minute).
//   - Drops post-close frozen rows (spot+premium unchanged → recorder kept
//     appending after 15:40/15:30 — would fabricate trades on stale data).
//
// Usage: npx tsx server/backtest-all.ts [days...]
//   days: 20260803 20260804 20260805 (default: all present in %TEMP%)

import os from "os";
import fs from "fs";
import path from "path";
import { runBacktest, setChainPremium, type BTCandle, type BTOpts } from "./backtest-engine.js";

const DIR = process.env.TMPDIR || process.env.TEMP || os.tmpdir();
const DAYS = (process.argv.slice(2).length ? process.argv.slice(2)
  : ["20260803", "20260804", "20260805"]).filter(d => fs.existsSync(path.join(DIR, `mvf-tick-${d}.jsonl`)));

interface ChainRow { ts: number; spot: number; atmCe: number | null; atmPe: number | null; }

export function loadDay(day: string): { candles: BTCandle[]; prem: Map<number, { CE: number; PE: number }> } {
  const f = path.join(DIR, `mvf-tick-${day}.jsonl`);
  const byTs = new Map<number, BTCandle>();
  const prem = new Map<number, { CE: number; PE: number }>();
  let lastSpot = 0, lastCe = 0, lastPe = 0, live = 0, frozen = 0;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.symbol !== "NIFTY" || !Array.isArray(r.candle)) continue;

    const chain = r.chain || {};
    const atmStrike = typeof chain.atm === "number" ? chain.atm : null;
    let ce: number | null = null, pe: number | null = null;
    if (atmStrike) {
      // chain ltp/sp are in paise (sp 2465000 = 24650.00) → /100 for rupees
      for (const o of (chain.ce || [])) if (o.sp === atmStrike && typeof o.ltp === "number" && o.ltp > 0) { ce = o.ltp / 100; break; }
      for (const o of (chain.pe || [])) if (o.sp === atmStrike && typeof o.ltp === "number" && o.ltp > 0) { pe = o.ltp / 100; break; }
    }
    const spot = r.spot;
    // frozen post-close rows: spot + both premiums unchanged from previous row
    if (spot === lastSpot && (ce === lastCe || ce === null) && (pe === lastPe || pe === null)) { frozen++; continue; }
    lastSpot = spot; if (ce != null) lastCe = ce; if (pe != null) lastPe = pe;
    live++;

    for (const c of r.candle) {
      const ts = Math.round(c.ts / 1e6);
      if (!byTs.has(ts)) byTs.set(ts, { ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    }
    // per-minute premium: snap to minute bucket of row ts (r.ts is ms already)
    const rowMinute = r.ts - (r.ts % 60_000);
    if (ce != null && pe != null) prem.set(rowMinute, { CE: ce, PE: pe });
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  console.log(`${day}: ${candles.length} candles, ${prem.size} min w/ chain, ${live} live / ${frozen} frozen rows`);
  return { candles, prem };
}

export function chainFn(prem: Map<number, { CE: number; PE: number }>) {
  // bar-ts = minute-start; lookup exact minute, else nearest prior minute ≤ ts
  const keys = [...prem.keys()].sort((a, b) => a - b);
  return (ts: number, opt: "CE" | "PE"): number | null => {
    let lo = 0, hi = keys.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    if (ans < 0) return null;
    const v = prem.get(keys[ans])!;
    return opt === "CE" ? v.CE : v.PE;
  };
}

// ── sweep definition: per-strategy tunings (entry × exit) ────────────────────
interface SweepCfg { label: string; opts: BTOpts; }

// Live data shows PT/SL almost never bind (0 of 22 live exits; 1m premium
// swings ±20-40% are rare) — MAX_HOLD is the real exit in both engine and
// live. So the exit dimension is maxHoldBars (live = 18), PT/SL pinned to
// live parity (25/20) so only the binding knob varies.
const BASE_EXIT = { premiumTargetPct: 25, premiumStopLossPct: 20, exitMode: "sl_tp" as const };
const HOLD_GRID = [10, 18, 30];
const CT = [50, 60];

function base(strategy: string, extra: Record<string, any> = {}): BTOpts {
  return { strategy, instrument: "NIFTY", ...extra };
}

const SWEEPS: SweepCfg[] = [];
const seen = new Set<string>();
function add(label: string, opts: BTOpts) {
  const key = JSON.stringify(opts);
  if (seen.has(key)) return;
  seen.add(key);
  SWEEPS.push({ label, opts });
}

for (const ct of CT) {
  for (const mh of HOLD_GRID) {
    const ex = { ...BASE_EXIT, maxHoldBars: mh };
    add(`s2 ct${ct} h${mh}`, { ...base("s2_scalper", { confidenceThreshold: ct }), ...ex });
    add(`sma_ema ct${ct} h${mh}`, { ...base("sma_ema_cross", { confidenceThreshold: ct }), ...ex });
    add(`rsi_oo ct${ct} h${mh}`, { ...base("rsi_overbought_oversold", { confidenceThreshold: ct }), ...ex });
    add(`bb_rev ct${ct} h${mh}`, { ...base("bollinger_band_reversal", { confidenceThreshold: ct }), ...ex });
    add(`opt_rsi ct${ct} h${mh}`, { ...base("option_rsi_mr", { confidenceThreshold: ct }), ...ex });
    add(`trend_cont ct${ct} h${mh}`, { ...base("trend_continuation", { confidenceThreshold: ct }), ...ex });
    add(`bb_mr ct${ct} h${mh}`, { ...base("bb_mean_reversion", { confidenceThreshold: ct }), ...ex });
    add(`rsi_rev ct${ct} h${mh}`, { ...base("rsi_reversal", { confidenceThreshold: ct }), ...ex });
    add(`sma_trend ct${ct} h${mh}`, { ...base("sma_ema_trend", { confidenceThreshold: ct }), ...ex });
  }
}
// ── validated 08-06 fix: session-tail entry cutoff ──
// Chain-truth replay (fixed strike) proved: directional gates (EMA level/slope,
// ADX direction) separate NOTHING on 08-05 — blocks 0/22 fades. Shorter hold
// (12m) is worse (cuts winners). Cutoff 14:15 is the only lever that helps:
// +2866 → +4842 (avoids 15:15 tail, the session's worst trade).
for (const cut of [0, 1415]) {
  const tag = `s2fix c${cut ? "1415" : "off"}`;
  add(tag, { ...base("s2_scalper", cut ? { entryCutoffMin: cut } : {}), ...BASE_EXIT, maxHoldBars: 18 });
}

// entry-param tunings for strategies with knobs (h18 = live parity)
for (const ex of [18].map(mh => ({ ...BASE_EXIT, maxHoldBars: mh }))) {
  for (const bb of [[15, 2], [20, 2], [20, 2.5], [25, 2]]) {
    add(`bb_rev p${bb[0]}s${bb[1]} h18`, { ...base("bollinger_band_reversal", { bbPeriod: bb[0], bbStdDev: bb[1] }), ...ex });
  }
  for (const se of [[10, 30], [20, 50], [5, 15]]) {
    add(`sma_ema ${se[0]}/${se[1]} h18`, { ...base("sma_ema_cross", { smaPeriod: se[0], emaPeriod: se[1] }), ...ex });
  }
  for (const rp of [14, 9, 21]) {
    add(`rsi_oo p${rp} h18`, { ...base("rsi_overbought_oversold", { rsiPeriod: rp }), ...ex });
  }
  for (const rt of [30, 40, 50]) {
    add(`opt_rsi t${rt} h18`, { ...base("option_rsi_mr", { optionRsiThreshold: rt }), ...ex });
  }
}

function runAll(candles: BTCandle[], prem: Map<number, { CE: number; PE: number }>) {
  setChainPremium(chainFn(prem));
  const results: { label: string; trades: number; wr: number; avg: number; maxDD: number; exp: number; pf: number }[] = [];
  const reliability: { label: string; trades: number; wr: number; avg: number; maxDD: number; exp: number; pf: number }[] = [];
  for (const sw of SWEEPS) {
    const run = runBacktest(candles, sw.opts);
    const t = run.trades;
    if (t.length < 3) continue;
    const reliable = t.length >= 10;
    const wins = t.filter(x => x.result === "WIN");
    const wr = wins.length / t.length * 100;
    const avg = t.reduce((a, x) => a + x.pnlPct, 0) / t.length;
    let peak = 0, dd = 0, cum = 0;
    for (const x of t) { cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const grossP = wins.reduce((a, x) => a + Math.max(0, x.pnl), 0);
    const grossL = t.reduce((a, x) => a + Math.max(0, -x.pnl), 0);
    const exp = (wr / 100) * (wins.length ? wins.reduce((a, x) => a + x.pnlPct, 0) / wins.length : 0)
      + (1 - wr / 100) * (t.length - wins.length ? (t.reduce((a, x) => a + x.pnlPct, 0) - wins.reduce((a, x) => a + x.pnlPct, 0)) / (t.length - wins.length) : 0);
    const row = { label: sw.label, trades: t.length, wr, avg, maxDD: dd, exp, pf: grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0) };
    results.push(row);
    if (reliable) reliability.push(row);
  }
  setChainPremium(null);
  results.sort((a, b) => b.exp - a.exp);
  reliability.sort((a, b) => b.exp - a.exp);
  return { results, reliability };
}

function main() {
  if (!DAYS.length) { console.error("No tick files found in " + DIR); process.exit(1); }
  const allCandles: BTCandle[] = [];
  const allPrem = new Map<number, { CE: number; PE: number }>();
  for (const d of DAYS) {
    const { candles, prem } = loadDay(d);
    allCandles.push(...candles);
    for (const [k, v] of prem) allPrem.set(k, v);
  }
  allCandles.sort((a, b) => a.ts - b.ts);
  console.log(`\nTotal: ${allCandles.length} candles, ${allPrem.size} chain-minutes over ${DAYS.join(", ")}`);

  const { results, reliability } = runAll(allCandles, allPrem);

  console.log(`\n${"═".repeat(88)}`);
  console.log(`  STRATEGY × TUNING SWEEP — REAL CHAIN PREMIUM (${DAYS.length}d)`);
  console.log(`${"═".repeat(88)}`);
  console.log(`  #  ${"label".padEnd(38)}  Trades  WR%   Avg%  MaxDD  Exp%   PF`);
  console.log(`  ${"─".repeat(80)}`);
  results.slice(0, 30).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)} ${r.label.padEnd(38)} ${String(r.trades).padStart(5)} ${r.wr.toFixed(0).padStart(5)} ${r.avg.toFixed(1).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${r.exp.toFixed(2).padStart(6)} ${r.pf === Infinity ? "∞" : r.pf.toFixed(2).padStart(5)}${r.trades >= 10 ? "  ✓reliable" : ""}`);
  });

  console.log(`\n${"─".repeat(88)}`);
  console.log("  RELIABLE-ONLY (≥10 trades) — sorted by expectancy");
  console.log(`  ${"─".repeat(80)}`);
  if (!reliability.length) console.log("  (none — no config reached 10 trades in 3 sessions)");
  reliability.slice(0, 20).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)} ${r.label.padEnd(38)} ${String(r.trades).padStart(5)} ${r.wr.toFixed(0).padStart(5)} ${r.avg.toFixed(1).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${r.exp.toFixed(2).padStart(6)} ${r.pf === Infinity ? "∞" : r.pf.toFixed(2).padStart(5)}`);
  });

  // per-strategy best
  console.log(`\n${"─".repeat(88)}`);
  console.log("  PER-STRATEGY BEST (by expectancy)");
  console.log(`  ${"─".repeat(80)}`);
  const byStr = new Map<string, typeof results>();
  for (const r of reliability.length ? reliability : results) {
    const key = r.label.split(" ")[0];
    if (!byStr.has(key)) byStr.set(key, []);
    byStr.get(key)!.push(r);
  }
  for (const [k, list] of byStr) {
    const best = list[0];
    console.log(`  ${k.padEnd(16)} ${best.label} — ${best.trades} trades, ${best.wr.toFixed(0)}% WR, ${best.avg.toFixed(1)}% avg, ${best.exp.toFixed(2)}% exp`);
  }
  setChainPremium(null);
}

main();
