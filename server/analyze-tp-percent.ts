// Analyze signal→TP premium movement % across strategies (points→percent model).
// Replays recorded 15s tick rows (mvf-tick-YYYYMMDD.jsonl) through each strategy's
// signal entry; then measures, per entry: entry premium, TP (target), peak premium
// before TP, the % move entry→TP, time-to-TP, and whether TP was actually reached.
//
// Usage: npx tsx server/analyze-tp-percent.ts
// Output: JSON per strategy+day + aggregated summary (median/mean pct moves).

import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline"; // For streaming large files
import { calculateRSI, calculateBollingerBands, calculateMACD, calculateEMA, calculateSMA } from "./indicators.ts";

const DIR = process.env.TMPDIR || process.env.TEMP || os.tmpdir();

interface RawRow {
  ts: number;
  spot: number;
  candle?: { ts: number; open: number; high: number; low: number; close: number; volume: number } | Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>; // array of 1m candles per row
  chain?: { // option chain structure (nullable)
    ce: { sp: number; ltp: number | null; delta?: number }[];
    pe: { sp: number; ltp: number | null; delta?: number }[];
  };
}

interface ParsedRow {
  ts: number;
  spot: number;
  candle: { ts: number; open: number; high: number; low: number; close: number; volume: number };
  ce: Map<number, { ltp: number; delta?: number }>; // ltp in ₹
  pe: Map<number, { ltp: number; delta?: number }>; // ltp in ₹
}

const rowMinute = (ts: number) => ts - (ts % 60_000);

// Stream large files line by line
async function loadDayStream(file: string): Promise<{ rows: ParsedRow[], closes: number[] }> {
  const fileStream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const rows: ParsedRow[] = [];
  const closes: number[] = [];

  for await (const line of rl) {
    const raw: RawRow = JSON.parse(line);
    if (!raw.candle || !raw.chain) continue;

    // raw.candle is an array of 5 one-minute candles, take the last (most recent)
    const candleArray = Array.isArray(raw.candle) ? raw.candle : [raw.candle];
    const lastCandle = candleArray[candleArray.length - 1];
    if (!lastCandle) continue;

    const parsedCe = new Map<number, { ltp: number; delta?: number }>();
    for (const o of raw.chain.ce) {
      if (o.ltp != null) parsedCe.set(o.sp / 100, { ltp: o.ltp / 100, delta: o.delta }); // sp in paise, ltp in paise
    }
    const parsedPe = new Map<number, { ltp: number; delta?: number }>();
    for (const o of raw.chain.pe) {
      if (o.ltp != null) parsedPe.set(o.sp / 100, { ltp: o.ltp / 100, delta: o.delta }); // sp in paise, ltp in paise
    }

    // candle.ts is nanoseconds (e.g., 1785737040000000000), convert to milliseconds
    const candle = { ...lastCandle, ts: Math.floor(lastCandle.ts / 1_000_000) };

    rows.push({
      ts: raw.ts,
      spot: raw.spot,
      candle,
      ce: parsedCe,
      pe: parsedPe,
    });
    closes.push(candle.close);
  }
  return { rows, closes };
}

interface StrategyCfg {
  strategy: string;
  targetMode: "points" | "percent";
  premiumTargetPts: number;    // points-mode: +N premium points
  premiumTargetPct: number;    // percent-mode: +N% of entry premium
  stopLossPct: number;         // % of entry premium
  strikeOffset: number;        // ATM + 50*offset (e.g., 1 for OTM)
  minDelta: number;
  maxEntryPremium: number;
  confidenceThreshold: number;
  entryCutoff: string;         // HH:MM IST
  maxHoldingMinutes: number;
  bbPeriod?: number;
  bbStdDev?: number;
  smaPeriod?: number;
  emaPeriod?: number;
}

const STRATEGIES: StrategyCfg[] = [
  { strategy: "bollinger_band_reversal", targetMode: "percent", premiumTargetPts: 0, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, confidenceThreshold: 50, entryCutoff: "14:15", maxHoldingMinutes: 30, bbPeriod: 20, bbStdDev: 2.5 },
  { strategy: "option_rsi_mr",           targetMode: "percent",   premiumTargetPts: 0, premiumTargetPct: 5, stopLossPct: 30, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, confidenceThreshold: 55, entryCutoff: "14:15", maxHoldingMinutes: 15 },
  { strategy: "s2_scalper",              targetMode: "points",   premiumTargetPts: 4, premiumTargetPct: 0,  stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, confidenceThreshold: 55, entryCutoff: "14:15", maxHoldingMinutes: 15 },
  { strategy: "sma_ema_trend",           targetMode: "percent",  premiumTargetPts: 0, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, confidenceThreshold: 50, entryCutoff: "14:15", maxHoldingMinutes: 30, smaPeriod: 20, emaPeriod: 50 },
  { strategy: "sma_ema_cross",           targetMode: "percent",  premiumTargetPts: 0, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, confidenceThreshold: 50, entryCutoff: "14:15", maxHoldingMinutes: 30, smaPeriod: 20, emaPeriod: 50 },
];

// ── Signal emitters (parity with auto-scalper.ts compute* + strategy-engine) ──
function bbSignal(closes: number[], cfg: StrategyCfg): { dir: "BUY_CE" | "BUY_PE"; conf: number } | null {
  if (closes.length < (cfg.bbPeriod ?? 30)) return null;
  const bb = calculateBollingerBands(closes, cfg.bbPeriod!, cfg.bbStdDev!);
  if (!bb || bb.upper.length < 2) return null; // Need at least two data points
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];
  const prevUpper = bb.upper[bb.upper.length - 2];
  const prevLower = bb.lower[bb.lower.length - 2];
  const price = closes[closes.length - 1];
  // Touch lower band then recover (or touch upper then fall)
  const touchLower = prevLower && price >= prevLower;
  const touchUpper = prevUpper && price <= prevUpper;
  if (touchLower) return { dir: "BUY_CE", conf: 65 };
  if (touchUpper) return { dir: "BUY_PE", conf: 65 };
  return null;
}

function emaCrossSignal(closes: number[], cfg: StrategyCfg): { dir: "BUY_CE" | "BUY_PE"; conf: number } | null {
  if (closes.length < (cfg.smaPeriod ?? 1) + (cfg.emaPeriod ?? 1)) return null;
  const s = calculateSMA(closes, cfg.smaPeriod!);
  const e = calculateEMA(closes, cfg.emaPeriod!);
  const sNow = s[s.length - 1], eNow = e[e.length - 1];
  const sPrev = s[s.length - 2], ePrev = e[e.length - 2];
  if (sNow == null || eNow == null || sPrev == null || ePrev == null) return null;
  if (sPrev <= ePrev && sNow > eNow) return { dir: "BUY_CE", conf: 55 };
  if (sPrev >= ePrev && sNow < eNow) return { dir: "BUY_PE", conf: 55 };
  return null;
}

function emaTrendSignal(closes: number[], cfg: StrategyCfg): { dir: "BUY_CE" | "BUY_PE"; conf: number } | null {
  if (closes.length < (cfg.emaPeriod ?? 1)) return null;
  const e = calculateEMA(closes, cfg.emaPeriod!); // Corrected: EMA only needs its own period length.
  const eNow = e[e.length - 1], ePrev = e[e.length - 2];
  if (eNow == null || ePrev == null) return null;
  if (eNow > ePrev) return { dir: "BUY_CE", conf: 55 };
  if (eNow < ePrev) return { dir: "BUY_PE", conf: 55 };
  return null;
}

function s2Signal(closes: number[], cfg: StrategyCfg, prevRsi: number | null): { dir: "BUY_CE" | "BUY_PE"; conf: number } | null {
  if (closes.length < 14) return null; // RSI needs 14 closes
  const rsi = calculateRSI(closes, 14);
  const r = rsi[rsi.length - 1];
  if (r == null || prevRsi == null) return null; // Ensure both current and prev RSI are available
  // S2: RSI cross up through 40 → BUY_CE; cross down through 60 → BUY_PE
  if (prevRsi < 40 && r >= 40) return { dir: "BUY_CE", conf: 55 };
  if (prevRsi > 60 && r <= 60) return { dir: "BUY_PE", conf: 55 };
  return null;
}

function optionRsiMrSignal(closes: number[], cfg: StrategyCfg, prevRsi: number | null): { dir: "BUY_CE" | "BUY_PE"; conf: number } | null {
  if (closes.length < 14) return null; // RSI needs 14 closes
  const rsi = calculateRSI(closes, 14);
  const r = rsi[rsi.length - 1];
  if (r == null || prevRsi == null) return null; // Ensure both current and prev RSI are available
  // Mean-reversion: RSI < 30 → BUY_CE (oversold), RSI > 70 → BUY_PE (overbought)
  if (prevRsi > 30 && r <= 30) return { dir: "BUY_CE", conf: 60 };
  if (prevRsi < 70 && r >= 70) return { dir: "BUY_PE", conf: 60 };
  return null;
}

// ── Replay ────────────────────────────────────────────────
interface TradeSample {
  strategy: string;
  day: string;
  ts: number;
  dir: string;
  strike: number;
  entryPremium: number;
  tpPremium: number;       // target premium (paise-based calc → ₹)
  pctMoveToTp: number;     // (tpPremium − entryPremium) / entryPremium × 100
  peakPremium: number;     // max premium seen until TP (or until exit)
  pctMoveToPeak: number;
  timeToTpSec: number | null;
  tpReached: boolean;
  exitReason: string;
}

async function replay(cfg: StrategyCfg, day: { rows: ParsedRow[], closes: number[] }, dayLabel: string, out: TradeSample[]) {
  let inTrade = false;
  let entry = 0, tp = 0, peak = 0, entryTs = 0, strike = 0, dir = "";
  let tpReached = false, reason = "";

  let prevRsiAtSignal: number | null = null;
  // Pre-calculate all RSI values for the day's closes
  const rsiValues = calculateRSI(day.closes, 14);

  for (let i = 0; i < day.rows.length; i++) {
    const row = day.rows[i];
    const now = new Date(row.ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const hhmm = now.split(",")[1]?.trim().split(" ")[0] || "";
    // Entry cutoff (IST HH:MM)
    const cutoffH = parseInt(cfg.entryCutoff.split(":")[0], 10), cutoffM = parseInt(cfg.entryCutoff.split(":")[1], 10);
    const tH = parseInt(hhmm.split(":")[0], 10), tM = parseInt(hhmm.split(":")[1], 10);

    // Get closes up to current row for indicator calculation
    const closesSlice = day.closes.slice(0, i + 1);
    const currentRsi = rsiValues[i]; // Use pre-calculated RSI
    const prevRsi = i > 0 ? rsiValues[i - 1] : null; // Use pre-calculated previous RSI

    if (!inTrade) {
      if (tH * 100 + tM > cutoffH * 100 + cutoffM) continue; // Skip entries after cutoff

      let sig: { dir: "BUY_CE" | "BUY_PE"; conf: number } | null = null;
      switch (cfg.strategy) {
        case "bollinger_band_reversal": sig = bbSignal(closesSlice, cfg); break;
        case "sma_ema_cross": sig = emaCrossSignal(closesSlice, cfg); break;
        case "sma_ema_trend": sig = emaTrendSignal(closesSlice, cfg); break;
        case "s2_scalper": sig = s2Signal(closesSlice, cfg, prevRsi); break;
        case "option_rsi_mr": sig = optionRsiMrSignal(closesSlice, cfg, prevRsi); break;
      }
      if (!sig || sig.conf < cfg.confidenceThreshold) continue;

      // DELAYED ENTRY: enter on NEXT tick row
      if (i + 1 >= day.rows.length) continue;
      const nextRow = day.rows[i + 1];

      // Resolve strike premium from chain (sp in ₹, ltp in ₹)
      const atm = Math.round(nextRow.spot / 50) * 50;
      const opts = sig.dir === "BUY_CE" ? nextRow.ce : nextRow.pe;
      const strikes = [...opts.keys()].sort((a, b) => a - b);
      // Target strike logic (ATM +/- strikeOffset * 50 for ITM/OTM)
      const targetStrikeValue = atm + (sig.dir === "BUY_CE" ? cfg.strikeOffset * 50 : -cfg.strikeOffset * 50);
      const target = strikes.find((s) => s >= targetStrikeValue) || strikes[0]; // Fallback to first strike if none found

      const o = target ? opts.get(target) : null;
      if (!o || o.ltp == null) continue;
      const prem = o.ltp;
      if (prem <= 0 || prem > cfg.maxEntryPremium) continue;
      // Delta filter
      if (o.delta != null && Math.abs(o.delta) < cfg.minDelta) continue;

      inTrade = true;
      entry = prem;
      tp = cfg.targetMode === "points"
        ? prem + cfg.premiumTargetPts
        : prem * (1 + cfg.premiumTargetPct / 100);
      peak = prem;
      entryTs = nextRow.ts; // Entry at next row
      strike = target;
      dir = sig.dir;
      tpReached = false;
      reason = "";
      prevRsiAtSignal = currentRsi; // Store RSI at entry
      i++; // Skip next row for signal check
      continue;
    }

    // In trade: track peak + TP hit
    const o = (dir === "BUY_CE" ? row.ce : row.pe).get(strike);
    const cur = o?.ltp != null ? o.ltp : null; // ltp already in ₹
    if (cur != null && cur > peak) peak = cur;
    if (cur != null && cur >= tp) {
      tpReached = true;
      reason = "TP_HIT";
    }
    if (cur != null && cur <= entry * (1 - cfg.stopLossPct / 100)) {
      reason = "SL_HIT";
    }
    // Max holding
    if (row.ts - entryTs > cfg.maxHoldingMinutes * 60_000) reason = "MAX_HOLD";

    // NOTE: RSI exit for option_rsi_mr removed from replay — the actual strategy
    // uses option premium RSI (not spot RSI). The replay uses spot RSI which
    // triggers premature exits. Let the percent target + SL govern exits here.

    if (reason) {
      out.push({
        strategy: cfg.strategy, day: dayLabel, ts: entryTs, dir, strike,
        entryPremium: entry, tpPremium: tp,
        pctMoveToTp: ((tp - entry) / entry) * 100,
        peakPremium: peak, pctMoveToPeak: ((peak - entry) / entry) * 100,
        timeToTpSec: tpReached ? Math.round((row.ts - entryTs) / 1000) : null,
        tpReached, exitReason: reason,
      });
      inTrade = false;
    }
  }
  if (inTrade) {
    out.push({
      strategy: cfg.strategy, day: dayLabel, ts: entryTs, dir, strike,
      entryPremium: entry, tpPremium: tp,
      pctMoveToTp: ((tp - entry) / entry) * 100,
      peakPremium: peak, pctMoveToPeak: ((peak - entry) / entry) * 100,
      timeToTpSec: null, tpReached, exitReason: "END_OF_DAY",
    });
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const dayFiles = fs.readdirSync(DIR).filter((f) => /^mvf-tick-(\d{8})\.jsonl$/.test(f)).sort();
  if (!dayFiles.length) { console.error("No mvf-tick-*.jsonl in " + DIR); process.exit(1); }

  const all: TradeSample[] = [];
  for (const f of dayFiles) {
    const dayLabel = f.match(/mvf-tick-(\d{8})\.jsonl/)![1];
    console.log(`Processing ${f}...`);
    const day = await loadDayStream(path.join(DIR, f));
    if (!day.rows.length) { console.error(`skip ${f} (empty or no valid rows)`); continue; }
    for (const cfg of STRATEGIES) {
      await replay(cfg, day, dayLabel, all); // await replay for async operations
    }
  }

  // ── Aggregate ─────────────────────────────────────────────
  function stats(arr: number[]) {
    if (!arr.length) return { n: 0, mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return {
      n: s.length,
      mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
      median: +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(2),
      p25: +s[Math.floor(s.length * 0.25)].toFixed(2),
      p75: +s[Math.floor(s.length * 0.75)].toFixed(2),
      min: +s[0].toFixed(2),
      max: +s[s.length - 1].toFixed(2),
    };
  }

  const byStrat: Record<string, TradeSample[]> = {};
  for (const t of all) (byStrat[t.strategy] ||= []).push(t);

  console.log("\n=== SIGNAL → TP MOVEMENT (% of entry) — points vs percent model ===\n");
  console.log("strategy                     |  n | tpReached% | pctToTp median | pctToTp mean | pctToPeak median | pctToPeak mean | timeToTp (s)");
  console.log("-----------------------------|----|------------|----------------|--------------|------------------|----------------|--------------");
  for (const strat of Object.keys(byStrat).sort()) {
    const ts = byStrat[strat];
    const reached = ts.filter((t) => t.tpReached);
    const pctTp = reached.map((t) => t.pctMoveToTp);
    const pctPeak = ts.map((t) => t.pctMoveToPeak);
    const tt = reached.map((t) => t.timeToTpSec!);
    const sTp = stats(pctTp), sPk = stats(pctPeak), sTt = stats(tt);
    console.log(
      `${strat.padEnd(28)} | ${String(ts.length).padStart(2)} | ${(reached.length / ts.length * 100).toFixed(0).padStart(3)}% | ` +
      `${sTp.median.toFixed(2).padStart(6)}% | ${sTp.mean.toFixed(2).padStart(6)}% | ` +
      `${sPk.median.toFixed(2).padStart(6)}% | ${sPk.mean.toFixed(2).padStart(6)}% | ` +
      `${sTt.median?.toFixed(0) ?? "—"}`
    );
  }

  // Full detail dump
  fs.writeFileSync("tp-percent-analysis.json", JSON.stringify(all, null, 2));
  console.log("\nFull trade samples → tp-percent-analysis.json");
}

main();
