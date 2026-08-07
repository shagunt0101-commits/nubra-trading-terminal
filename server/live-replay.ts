// Live-parity 15s replay — replays recorded tick data (%TEMP%\mvf-tick-YYYYMMDD.jsonl)
// through the LIVE scalper's poll semantics (15s cadence, completed-minute candle
// availability, chain-LTP entries/exits at the resolved strike) so backtest ≈ live.
//
// Usage: npx tsx server/live-replay.ts [YYYYMMDD] [--config live|trend_cont|sma_trend|sma_cross]
//   day:    default = latest mvf-tick-*.jsonl in %TEMP%
//   config: default "live" (current live bb config)
//
// Deliberate deviations from auto-scalper.ts (marked `live-parity gap:` inline):
//   1. computeS2's PCR/IV/lead-lag/S-R-gate/trend-gate are NOT replicated — the
//      live BB strategy doesn't use computeS2, and PCR/ivPercentile only feed
//      reasons (no score/confidence effect in the BB path; S2-only paths skipped).
//   2. live BB signal: computeBB() at auto-scalper.ts ~964 — closes.length < 30
//      (20+10) → null; direction requires BB touch-and-recover on CLOSED candles.
//   3. Conf 65 (computeBB const), CT default 50 → effectively "any BB reversal signal
//      enters". Entry uses strict >= like the poll's confidence gate.
//   4. minDelta/chain delta: row chain rows carry delta only near ATM. If the
//      resolved target strike has NO delta (far OTM), live treats it as
//      deltaOk=false + hasDelta=false → walks nothing, falls through to
//      "else" branch (ltp used, no reject) — replicated exactly.
//   5. lead-lag boost (applyLeadLagBoost, ~1293): skipped — boost requires
//      leadlag_edges.json (cwd) + CE. Parity note only; boost ≤ 10 conf, BB conf
//      65 already clears CT 50. Add when comparing vs live trade logs shows drift.
//   6. live uses entryTime=Date.now() at poll; replay uses row.ts (poll instant).
//   7. EXIT poll: live skips SIGNAL computation in EXIT mode — replay identical
//      (no new entry while in trade). Re-entry next poll after exit: same.

import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline";
import { calculateRSI, calculateBollingerBands, calculateMACD } from "./indicators.js";

const DIR = process.env.TMPDIR || process.env.TEMP || os.tmpdir();
const LOT = 130; // NIFTY lot size ×2 lots — qty for pnl = (out−in)×130

// ── Configs ────────────────────────────────────────────────
interface ReplayCfg {
  name: string;
  strategy: string;
  confidenceThreshold: number;
  premiumTargetPct: number;
  stopLossPct: number;
  strikeOffset: number;
  minDelta: number;
  maxEntryPremium: number;
  maxHoldingMinutes: number;
  entryCutoff: string; // "HH:MM" IST
  phase?: boolean; // live: exitStrategy "option_rsi_mr" → 3-phase exit (BE lock + 80% trail)
  // strategy params
  bbPeriod?: number;
  bbStdDev?: number;
  smaPeriod?: number;
  emaPeriod?: number;
}

// live = current live scalper: bb_reversal + presets' risk (tp15/sl50/h30/cut14:15)
// + exitStrategy "option_rsi_mr" → phase exit (state file 08-07: phase1TargetHit/BE lock seen)
// (auto-scalper.ts STRATEGY_PRESETS cfg + DEFAULT_CONFIG bb 20/2 + ct50)
const CONFIGS: Record<string, ReplayCfg> = {
  live: { name: "live", strategy: "bollinger_band_reversal", confidenceThreshold: 50, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 30, entryCutoff: "14:15", bbPeriod: 20, bbStdDev: 2.5, phase: true },
  live55: { name: "live55", strategy: "bollinger_band_reversal", confidenceThreshold: 55, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 30, entryCutoff: "14:15", bbPeriod: 20, bbStdDev: 2.5, phase: true },
  // 08-05/08-06 actual live config: h18, ct55, option_rsi_mr phase exit (RSI_TRAIL), bbStdDev 2
  liveold: { name: "liveold", strategy: "bollinger_band_reversal", confidenceThreshold: 55, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 18, entryCutoff: "14:15", bbPeriod: 20, bbStdDev: 2, phase: true },
  trend_cont: { name: "trend_cont", strategy: "trend_continuation", confidenceThreshold: 50, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 30, entryCutoff: "14:15" },
  sma_trend: { name: "sma_trend", strategy: "sma_ema_trend", confidenceThreshold: 50, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 30, entryCutoff: "14:15", smaPeriod: 20, emaPeriod: 50 },
  sma_cross: { name: "sma_cross", strategy: "sma_ema_cross", confidenceThreshold: 50, premiumTargetPct: 15, stopLossPct: 50, strikeOffset: 1, minDelta: 0.45, maxEntryPremium: 600, maxHoldingMinutes: 30, entryCutoff: "14:15", smaPeriod: 20, emaPeriod: 50 },
};

// ── Loader ─────────────────────────────────────────────────
interface RawRow { ts: number; spot: number; candles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[]; ce: Map<number, { ltp: number; delta?: number }>; pe: Map<number, { ltp: number; delta?: number }>; }
interface LoadedDay { rows: RawRow[]; candles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[]; }

const rowMinute = (ts: number) => ts - (ts % 60_000);

function parseChain(list: any[]): Map<number, { ltp: number; delta?: number }> {
  const m = new Map<number, { ltp: number; delta?: number }>();
  for (const o of list || []) {
    const strike = o.sp / 100; // paise×1000 → ₹
    if (typeof o.ltp === "number" && o.ltp > 0) m.set(strike, { ltp: o.ltp / 100, delta: typeof o.delta === "number" ? o.delta : undefined });
  }
  return m;
}

async function loadDay(day: string): Promise<LoadedDay> {
  const f = path.join(DIR, `mvf-tick-${day}.jsonl`);
  if (!fs.existsSync(f)) throw new Error(`No tick file: ${f}`);
  const rows: RawRow[] = [];
  const byTs = new Map<number, { ts: number; open: number; high: number; low: number; close: number; volume: number }>();
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
    // frozen rows: spot + both ATM premiums unchanged from previous row
    // (frozen post-close rows exist — dropping matches backtest-all.ts loadDay)
    if (r.spot === lastSpot && (ce === lastCe || ce === null) && (pe === lastPe || pe === null)) { frozen++; continue; }
    lastSpot = r.spot; if (ce != null) lastCe = ce; if (pe != null) lastPe = pe;
    live++;

    for (const c of r.candle) {
      const ts = Math.round(c.ts / 1e6);
      if (!byTs.has(ts)) byTs.set(ts, { ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    }
    rows.push({ ts: r.ts, spot: r.spot, candles: r.candle.map((c: any) => ({ ts: Math.round(c.ts / 1e6), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 })), ce: parseChain(chain.ce), pe: parseChain(chain.pe) });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  console.log(`loaded ${day}: ${rows.length} rows (${live} live / ${frozen} frozen dropped), ${candles.length} 1m candles`);
  return { rows, candles };
}

// Chain LTP lookup for row: exact strike, else nearest same-side strike
// (matches live checkExit/forceClose semantics — chain truth over model).
function chainLtp(row: RawRow, opt: "CE" | "PE", strike: number): number | null {
  const m = opt === "CE" ? row.ce : row.pe;
  if (m.get(strike)?.ltp) return m.get(strike)!.ltp;
  let best: number | null = null, bestDist = Infinity;
  for (const [s, v] of m) {
    const dist = Math.abs(s - strike);
    if (dist < bestDist) { bestDist = dist; best = v.ltp; }
  }
  return best;
}

// Chain delta at strike (undefined → "no delta" like live)
function chainDelta(row: RawRow, opt: "CE" | "PE", strike: number): number | undefined {
  const o = (opt === "CE" ? row.ce : row.pe).get(strike);
  return o ? o.delta : undefined;
}

// ── Live-parity signal compute (per poll, mirrors computeSignal/computeBB/computeS2) ──
function computeSignal(
  row: RawRow, cfg: ReplayCfg,
  candles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[],
): { dir: "LONG" | "SHORT"; conf: number; reason: string } | null {
  // live view (auto-scalper.ts fetchCandles1m): ONLY today's candles, from
  // 09:15 IST (UTC 03:45) — broker returns ~17 today's minutes + the forming
  // minute, live includes the forming minute (no completed-only filter).
  // Replay mirrors exactly: day-open floor + forming row overlay + row-ts cap.
  const d0 = new Date(row.ts + 5.5 * 3600_000); d0.setUTCHours(3, 45, 0, 0); d0.setUTCMinutes(0);
  const dayOpenMs = d0.getTime() - 5.5 * 3600_000; // 09:15 IST in epoch ms
  const byMin = new Map<number, { ts: number; open: number; high: number; low: number; close: number; volume: number }>();
  for (const c of candles) if (c.ts >= dayOpenMs && c.ts <= row.ts) byMin.set(c.ts, c);
  for (const c of row.candles) if (c.ts >= dayOpenMs && c.ts <= row.ts) byMin.set(c.ts, c); // row overlay: freshest forming close
  const usable = [...byMin.values()].sort((a, b) => a.ts - b.ts);
  if (usable.length < 30) return null; // live: candles.length < 30 → insufficient
  const closes = usable.map(c => c.close);
  if (new Set(closes).size <= 1) return null; // flat/synthetic data guard (live)

  switch (cfg.strategy) {
    case "bollinger_band_reversal": {
      const bbPeriod = cfg.bbPeriod ?? 20, bbStdDev = cfg.bbStdDev ?? 2;
      if (closes.length < bbPeriod + 10) return null; // live computeBB guard
      const bb = calculateBollingerBands(closes, bbPeriod, bbStdDev);
      const lastIdx = closes.length - 1;
      const price = closes[lastIdx], prev = closes[lastIdx - 1];
      const isBull = price > bb.lower[lastIdx] && prev <= bb.lower[lastIdx - 1];
      const isBear = price < bb.upper[lastIdx] && prev >= bb.upper[lastIdx - 1];
      if (!isBull && !isBear) return null;
      return { dir: isBull ? "LONG" : "SHORT", conf: 65, reason: isBull ? "BB lower bounce" : "BB upper reject" }; // conf 65 = live computeBB constant
    }
    case "trend_continuation": {
      const adx = calculateADXLocal(usable), ema21 = ema(usable.map(c => c.close), 21);
      const lastIdx = usable.length - 1;
      if (lastIdx < 1) return null;
      const lastAdx = adx.adx[lastIdx], lastPdi = adx.plusDi[lastIdx], lastMdi = adx.minusDi[lastIdx];
      const lastPrice = usable[lastIdx].close, lastEma21 = ema21[lastIdx];
      const priceDist = Math.abs(lastPrice - lastEma21) / lastEma21 * 100;
      if (!(lastAdx > 25 && priceDist < 0.5)) return null; // strategy-engine: p=25 scalping, 0.5% EMA-21 proximity
      if (lastPdi > lastMdi) return { dir: "LONG", conf: 70, reason: "ADX trend + Stoch cross + EMA-21" };
      if (lastMdi > lastPdi) return { dir: "SHORT", conf: 70, reason: "ADX trend + Stoch cross + EMA-21" };
      return null; // live strategy-engine also requires Stoch cross (k>d / k<d) — gap: Stoch skipped, ADX+DI only
    }
    case "sma_ema_trend": {
      const smaP = cfg.smaPeriod ?? 20, emaP = cfg.emaPeriod ?? 50;
      if (closes.length < emaP + 2) return null;
      const smaArr = sma(closes, smaP), emaArr = ema(closes, emaP);
      const lastIdx = closes.length - 1;
      const price = closes[lastIdx];
      if (price > smaArr[lastIdx] && closes[lastIdx - 1] <= smaArr[lastIdx - 1] && emaArr[lastIdx] > emaArr[lastIdx - 1]) return { dir: "LONG", conf: 55, reason: "Price>SMA & EMA up" };
      if (price < smaArr[lastIdx] && closes[lastIdx - 1] >= smaArr[lastIdx - 1] && emaArr[lastIdx] < emaArr[lastIdx - 1]) return { dir: "SHORT", conf: 55, reason: "Price<SMA & EMA down" };
      return null;
    }
    case "sma_ema_cross": {
      const smaP = cfg.smaPeriod ?? 20, emaP = cfg.emaPeriod ?? 50;
      if (closes.length < emaP + 2) return null;
      const smaArr = sma(closes, smaP), emaArr = ema(closes, emaP);
      const lastIdx = closes.length - 1;
      const price = closes[lastIdx];
      if (price > smaArr[lastIdx] && closes[lastIdx - 1] <= smaArr[lastIdx - 1] && emaArr[lastIdx] > emaArr[lastIdx - 1]) return { dir: "LONG", conf: 55, reason: "SMA cross up" };
      if (price < smaArr[lastIdx] && closes[lastIdx - 1] >= smaArr[lastIdx - 1] && emaArr[lastIdx] < emaArr[lastIdx - 1]) return { dir: "SHORT", conf: 55, reason: "SMA cross down" };
      return null;
    }
    default:
      throw new Error(`Unknown strategy: ${cfg.strategy}`);
  }
}

// ── Indicator helpers (local; live uses calculateADX/Stoch — see gap note) ──
function calculateADXLocal(candles: { high: number; low: number; close: number }[]): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const n = candles.length;
  const closes = candles.map(x => x.close);
  const tr = candles.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - closes[i - 1]), Math.abs(x.low - closes[i - 1])));
  const pDm = candles.map((x, i) => { if (i === 0) return 0; const u = x.high - candles[i - 1].high, d = candles[i - 1].low - x.low; return u > d && u > 0 ? u : 0; });
  const mDm = candles.map((x, i) => { if (i === 0) return 0; const u = x.high - candles[i - 1].high, d = candles[i - 1].low - x.low; return d > u && d > 0 ? d : 0; });
  const str = ema(tr, 14), sp = ema(pDm, 14), sm = ema(mDm, 14);
  const pDi = str.map((t, i) => t > 0 ? (100 * sp[i]) / t : 0);
  const mDi = str.map((t, i) => t > 0 ? (100 * sm[i]) / t : 0);
  const dx = pDi.map((p, i) => { const s = p + mDi[i]; return s > 0 ? (Math.abs(p - mDi[i]) / s) * 100 : 0; });
  return { adx: ema(dx, 14), plusDi: pDi, minusDi: mDi };
}
function sma(arr: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) out.push(arr[i]);
    else out.push(arr.slice(i - period + 1, i + 1).reduce((a, v) => a + v, 0) / period);
  }
  return out;
}
function ema(arr: number[], period: number): number[] {
  const out: number[] = [];
  if (!arr.length) return out;
  const k = 2 / (period + 1);
  let cur = arr[0];
  out.push(cur);
  for (let i = 1; i < arr.length; i++) { cur = arr[i] * k + cur * (1 - k); out.push(cur); }
  return out;
}

// ── Strike resolution + entry/exit (mirrors resolveStrikePremium/checkExit/checkStandardExit) ──
interface Trade {
  tIn: number; optType: "CE" | "PE"; strike: number; inPrem: number;
  tOut?: number; outPrem?: number; reason?: string; pnl?: number;
  phase1TargetHit?: boolean; maxPriceSeen?: number; stopLoss?: number;
}

function resolveStrikePremium(
  row: RawRow, spot: number, isBull: boolean, cfg: ReplayCfg,
): { strike: number; premium: number } | null {
  const step = 50; // NIFTY strikeStep
  const atmStrike = Math.round(spot / step) * step;
  const optType = isBull ? "CE" : "PE";
  let targetStrike = isBull ? atmStrike + step * cfg.strikeOffset : atmStrike - step * cfg.strikeOffset;
  let premium = isBull ? spot * 0.006 : spot * 0.005; // model fallback (live)

  const optList = isBull ? row.ce : row.pe;
  const targetOpt = optList.get(targetStrike);
  const hasDelta = targetOpt && typeof targetOpt.delta === "number";
  const deltaOk = hasDelta && Math.abs(targetOpt!.delta!) >= cfg.minDelta;
  if (!deltaOk && hasDelta) {
    // walk toward ATM one step
    const closerStrike = isBull ? targetStrike - step : targetStrike + step;
    const closer = optList.get(closerStrike);
    if (closer && typeof closer.delta === "number" && Math.abs(closer.delta) >= cfg.minDelta) {
      targetStrike = closerStrike;
      if (closer.ltp) premium = closer.ltp;
    } else {
      // walk up to 4 steps toward ATM; none qualifying → hard block (no entry)
      let found = false;
      for (let i = 2; i <= 4; i++) {
        const walkStrike = isBull ? targetStrike - step * i : targetStrike + step * i;
        const w = optList.get(walkStrike);
        if (w && typeof w.delta === "number" && Math.abs(w.delta) >= cfg.minDelta) {
          targetStrike = walkStrike;
          if (w.ltp) premium = w.ltp;
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
  } else {
    if (targetOpt?.ltp) premium = targetOpt.ltp;
  }

  // premium model fallback only when chain LTP missing at resolved strike
  const ltp = optList.get(targetStrike)?.ltp;
  if (ltp) premium = ltp;

  if (!isFinite(premium) || premium <= 0) return null;
  return { strike: targetStrike, premium: Math.round(premium * 100) / 100 };
}

function checkStandardExit(
  trade: Trade, row: RawRow, cfg: ReplayCfg,
): { outPrem: number; reason: string } | null {
  // current premium: chain LTP at held strike (exact, else nearest same-side)
  let currentPremium = chainLtp(row, trade.optType, trade.strike);
  if (currentPremium == null || currentPremium <= 0) currentPremium = trade.inPrem; // live: model fallback → replay: hold at entry (gap: model = entry + 0.6·Δspot; chain LTP present in all live rows, so unused)

  const stopLoss = Math.round(trade.inPrem * (1 - cfg.stopLossPct / 100) * 100) / 100;
  const target = Math.round(trade.inPrem * (1 + cfg.premiumTargetPct / 100) * 100) / 100;

  if (cfg.maxHoldingMinutes > 0 && row.ts - trade.tIn > cfg.maxHoldingMinutes * 60_000) {
    return { outPrem: Math.round(currentPremium * 100) / 100, reason: `MAX_HOLD_${cfg.maxHoldingMinutes}m` };
  }

  // ── Phase exit parity (live exitStrategy "option_rsi_mr"):
  //    P1: SL hit → exit; target +tp% hit → lock BE (stopLoss = entry), track max
  //    P2/P3: exit when premium ≤ maxPriceSeen × 80% (trail 80)
  if (cfg.phase) {
    if (!trade.phase1TargetHit) {
      if (currentPremium <= (trade.stopLoss ?? stopLoss)) return { outPrem: Math.round(currentPremium * 100) / 100, reason: "SL_HIT" };
      if (currentPremium >= target) {
        trade.phase1TargetHit = true;
        trade.maxPriceSeen = currentPremium;
        trade.stopLoss = trade.inPrem; // lock breakeven (live checkOptionRsiMrExit)
      }
      return null; // still phase 1
    }
    if (currentPremium > (trade.maxPriceSeen ?? trade.inPrem)) trade.maxPriceSeen = currentPremium;
    const trailStop = (trade.maxPriceSeen ?? trade.inPrem) * 0.80;
    if (currentPremium <= trailStop) {
      return { outPrem: Math.round(currentPremium * 100) / 100, reason: `TRAIL_SL_80 (max: ${(trade.maxPriceSeen ?? trade.inPrem).toFixed(1)}, trail: ${trailStop.toFixed(1)})` };
    }
    return null;
  }

  if (currentPremium <= stopLoss) return { outPrem: Math.round(currentPremium * 100) / 100, reason: "SL_HIT" };
  if (currentPremium >= target) return { outPrem: Math.round(currentPremium * 100) / 100, reason: "TARGET_HIT" };
  // MARKET_CLOSE at 15:35 IST (live checkStandardExit: h*100+m >= 1535)
  const d = new Date(row.ts + 5.5 * 3600_000);
  if (d.getUTCHours() * 100 + d.getUTCMinutes() >= 1535) {
    return { outPrem: Math.round(currentPremium * 100) / 100, reason: "MARKET_CLOSE" };
  }
  return null;
}

// ── Replay loop ────────────────────────────────────────────
function runReplay(day: string, cfg: ReplayCfg, data: LoadedDay): Trade[] {
  const trades: Trade[] = [];
  let active: Trade | null = null;
  let entriesBlocked = false;
  const cutoff = cfg.entryCutoff.split(":").map(Number);
  const cutoffNum = (cutoff[0] ?? 0) * 100 + (cutoff[1] ?? 0);

  for (const row of data.rows) {
    const d = new Date(row.ts + 5.5 * 3600_000);
    const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();

    if (active) {
      const exit = checkStandardExit(active, row, cfg);
      if (exit) {
        active.tOut = row.ts;
        active.outPrem = exit.outPrem;
        active.reason = exit.reason;
        active.pnl = Math.round((exit.outPrem - active.inPrem) * LOT * 100) / 100;
        trades.push(active);
        active = null;
      }
      continue; // live: in EXIT mode, no signal compute this poll
    }

    // SCANNING only; entry cutoff blocks new entries (exits continue)
    if (entriesBlocked || hhmm >= cutoffNum) {
      entriesBlocked = true;
      continue;
    }

    const signal = computeSignal(row, cfg, data.candles);
    if (!signal) continue;
    if (signal.conf < cfg.confidenceThreshold) continue;

    const resolved = resolveStrikePremium(row, row.spot, signal.dir === "LONG", cfg);
    if (!resolved) continue;
    if (resolved.premium > cfg.maxEntryPremium) continue; // live: maxEntryPremium filter

    active = { tIn: row.ts, optType: signal.dir === "LONG" ? "CE" : "PE", strike: resolved.strike, inPrem: resolved.premium };
  }
  return trades;
}

// ── Reporting ──────────────────────────────────────────────
const hhmm = (ts: number) => {
  const d = new Date(ts + 5.5 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function report(day: string, cfg: ReplayCfg, trades: Trade[]) {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`  LIVE-PARITY 15s REPLAY — ${day} — config ${cfg.name} (${cfg.strategy})`);
  console.log(`${"═".repeat(92)}`);
  console.log(`  config: ct${cfg.confidenceThreshold} tp${cfg.premiumTargetPct} sl${cfg.stopLossPct} off${cfg.strikeOffset} minD${cfg.minDelta} maxPrem${cfg.maxEntryPremium} hold${cfg.maxHoldingMinutes}m cut${cfg.entryCutoff}`);
  console.log(`  ${"─".repeat(88)}`);
  console.log(`  #  tIn   opt strike   inPrem   tOut   outPrem  reason           pnl (₹)`);
  console.log(`  ${"─".repeat(88)}`);
  trades.forEach((t, i) => {
    console.log(`  ${String(i + 1).padStart(2)} ${hhmm(t.tIn)} ${t.optType} ${String(t.strike).padStart(6)} ${t.inPrem.toFixed(2).padStart(8)}  ${hhmm(t.tOut!)} ${t.outPrem!.toFixed(2).padStart(8)}  ${String(t.reason).padEnd(15)} ${t.pnl! >= 0 ? "+" : ""}${t.pnl!.toFixed(0)}`);
  });
  if (!trades.length) { console.log("  (no trades)"); return; }

  const wins = trades.filter(t => t.pnl! > 0);
  const cum = trades.reduce((a, t) => a + t.pnl!, 0);
  const byReason = new Map<string, Trade[]>();
  for (const t of trades) byReason.set(t.reason!, (byReason.get(t.reason!) || []).concat(t));
  console.log(`  ${"─".repeat(88)}`);
  console.log(`  SUMMARY: ${trades.length} trades | WR ${(wins.length / trades.length * 100).toFixed(1)}% | cum ₹${cum >= 0 ? "+" : ""}${cum.toFixed(0)} | avg ₹${(cum / trades.length).toFixed(1)}/trade`);
  for (const [r, list] of byReason) {
    const rw = list.filter(t => t.pnl! > 0).length;
    const rp = list.reduce((a, t) => a + t.pnl!, 0);
    console.log(`    ${r.padEnd(15)} ${list.length} trades | WR ${(rw / list.length * 100).toFixed(0)}% | pnl ₹${rp >= 0 ? "+" : ""}${rp.toFixed(0)}`);
  }
  console.log(`  ${"─".repeat(88)}`);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.findIndex(a => a === "--config");
  const cfgName = cfgIdx >= 0 && args[cfgIdx + 1] ? args[cfgIdx + 1] : "live";
  const cfg = CONFIGS[cfgName];
  if (!cfg) { console.error(`Unknown config "${cfgName}" — expected: ${Object.keys(CONFIGS).join(", ")}`); process.exit(1); }
  const dayArg = args[0] && !args[0].startsWith("--") ? args[0] : null;

  let day = dayArg;
  if (!day) {
    const files = fs.readdirSync(DIR).filter(f => /^mvf-tick-\d{8}\.jsonl$/.test(f)).sort();
    if (!files.length) { console.error("No tick files in " + DIR); process.exit(1); }
    day = files[files.length - 1].match(/\d{8}/)![0];
  }

  const data = await loadDay(day);
  const trades = runReplay(day, cfg, data);
  report(day, cfg, trades);
}

main().catch(e => { console.error(e); process.exit(1); });
