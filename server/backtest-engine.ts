import {
  evaluateTrendContinuation, evaluateBBMeanReversal, evaluateRSIReversal,
  evaluateTrendFollow, evaluateS2Scalper, STRATEGY_DEFAULTS,
} from "./strategy-engine.js";
import { calculateRSI, calculateMACD, calculateSMA, calculateEMA, calculateBollingerBands, calculateVWAP, calculateVolumeZScore } from "./indicators.js";
import { costPct } from "./costs.js";

export interface BTCandle { ts: number; open: number; high: number; low: number; close: number; volume: number }
export interface BTTrade {
  id: number; side: "BUY" | "SELL"; optType?: "CE" | "PE"; strike?: number;
  entryTime: number; entryPrice: number; entryPremium?: number; stopLoss: number; target: number;
  exitTime: number; exitPrice: number; exitPremium?: number; exitReason: string;
  pnl: number; pnlPct: number; netPnlPct: number; bars: number; result: "WIN" | "LOSS";
}
export interface BTRun {
  strategy: string; trades: BTTrade[];
  summary: {
    totalTrades: number; winRate: number; profitFactor: number;
    totalPnlPct: number; avgPnlPct: number; avgBars: number;
    maxWinPct: number; maxLossPct: number;
  };
}
export interface BTOpts {
  strategy: string;
  // spot-% params (s2_scalper + 3 legacy)
  spotSLPct?: number; spotTPPct?: number; confidenceThreshold?: number;
  // premium params (option_rsi_mr + 4 new)
  optionRsiThreshold?: number; optionRsiPeriod?: number;
  maxEntryPremium?: number; premiumTargetPoints?: number; premiumStopLossPct?: number;
  premiumTargetPct?: number; thetaPctPerDay?: number;
  maxHoldBars?: number;
  maxGapMult?: number;
  // exit knobs (live parity)
  exitMode?: "sl_tp" | "phase";
  trailPct?: number;      // phase2/3 trail (live: 0.80)
  phase1TargetPct?: number; // phase1 → phase2 trigger (live: +4pts on ₹100-300 prem)
  sessionCloseMin?: number; // IST hhmm EOD forced exit (live: 1525)
  entryCutoffMin?: number; // IST hhmm — no NEW entries after (validated: 1415; exits still run)
  // instrument context
  instrument: string;
  // parameterized inline strategies (stage-0; defaults preserve legacy behavior)
  rsiPeriod?: number; overbought?: number; oversold?: number;
  bbPeriod?: number; bbStdDev?: number;
  smaPeriod?: number; emaPeriod?: number;
  // FVG params
  fvgTrendTf15m?: boolean; fvgTrendTf1h?: boolean;
  fvgRiskReward?: number; // default 1.8
  fvgLookback?: number; // candles to look back for FVGs
}

// Premium model — two-sided, mirrors the LIVE paper model (auto-scalper
// checkExit: entry + 0.6*spotChg, floor 0.15x entry). The old one-sided slope
// (0.006 below ATM, damped 0.5x in heldPrem) made a long CE SL unreachable at
// theta=0 — a money printer that faked the first promotions. Base 0.00385
// calibrates ATM premium to ~93-100 INR @ NIFTY 24350 (real capture).
// Index options only: the premium model (spot*0.00385 + 0.6*delta-linear) is
// calibrated to index IV (11-15%). Stock option IVs (20-40%) make real premiums
// 2-5x the model — backtests on stocks are garbage (WIPRO avg −38.8%/trade).
// Stock universe reverted; revisit only with per-stock IV + real bid/ask data.
const ATM_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100 };
const prem = (spot: number, atm: number, opt: "CE" | "PE") => {
  const d = spot - atm;
  const s = spot * 0.00385;
  return opt === "CE" ? s + 0.6 * d : s - 0.6 * d;
};
// Real-chain premium override (backtest-all.ts): map bar-ts → {CE, PE} LTP from
// tick captures. Null/undefined → falls back to modeled prem(). Engine's own
// model stays the default so existing sweep behavior is untouched.
let chainPrem: ((ts: number, opt: "CE" | "PE") => number | null | undefined) | null = null;
export function setChainPremium(fn: ((ts: number, opt: "CE" | "PE") => number | null | undefined) | null) { chainPrem = fn; }
function premC(ts: number, spot: number, atm: number, opt: "CE" | "PE"): number {
  const cp = chainPrem ? chainPrem(ts, opt) : null;
  return cp != null && cp > 0 ? cp : prem(spot, atm, opt);
}

// Intra-bar premium range for a candle: CE rises with spot (range = prem at low→high),
// PE falls with spot (range = prem at high→low).
function premRange(c: BTCandle, atm: number, opt: "CE" | "PE"): [number, number] {
  if (opt === "CE") return [premC(c.ts, c.low, atm, "CE"), premC(c.ts, c.high, atm, "CE")];
  return [premC(c.ts, c.high, atm, "PE"), premC(c.ts, c.low, atm, "PE")];
}

// Per-bar theta decay: ATM near-expiry options bleed ~0.5-2% of premium per
// day. A held position's premium shrinks by this per bar — otherwise a long CE
// rides an uptrend indefinitely (spot-proportional model has no expiry),
// inflating wins. Multiplicative so TF-independent (per-bar, not per-day).
function thetaMult(barsHeld: number, thetaPctPerBar: number): number {
  return Math.pow(Math.max(0, 1 - thetaPctPerBar / 100), barsHeld);
}

// S2 signal surface for a candle index: RSI/MACD/VWAP/BB-width/volZ, exactly
// mirroring evaluateS2Scalper's scoring (bullScore≥3 / bearScore≥3, conf =
// max/4*100 + 10 if BB-width > 0.02) but O(1) per index via precomputed arrays.
export interface S2Surface { rsi: number[]; macdHist: number[]; vwap: number[]; volZ: number[]; bbWidth: number[] }
export function s2Surface(candles: BTCandle[]): S2Surface {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const vwap = calculateVWAP(candles as any);
  const volZ = calculateVolumeZScore(candles.map(c => c.volume), 20);
  const bb = calculateBollingerBands(closes, 20, 2);
  const bbWidth = bb.middle.map((m, i) => m > 0 ? (bb.upper[i] - bb.lower[i]) / m : 0);
  return { rsi, macdHist: macd.histogram, vwap, volZ, bbWidth };
}
export function s2SignalAt(S: S2Surface, closes: number[], i: number): { dir: "LONG" | "SHORT"; conf: number } | null {
  if (i < 1) return null;
  const lastRsi = S.rsi[i], lastMacdHist = S.macdHist[i];
  const lastVwap = S.vwap[i], lastVolZ = S.volZ[i], lastBbWidth = S.bbWidth[i];
  let bull = 0, bear = 0;
  if (lastRsi < 40) bull++;
  if (lastRsi > 60) bear++;
  if (lastMacdHist > 0) bull++;
  if (lastMacdHist < 0) bear++;
  if (closes[i] > lastVwap) bull++;
  if (closes[i] < lastVwap) bear++;
  if (lastVolZ > 1.5) { bull += 0.5; bear += 0.5; }
  let confidence = (Math.max(bull, bear) / 4) * 100;
  if (lastBbWidth > 0.02) confidence += 10;
  if (bull >= 3) return { dir: "LONG", conf: Math.round(confidence) };
  if (bear >= 3) return { dir: "SHORT", conf: Math.round(confidence) };
  return null;
}

// Import FVG utilities
import { detectFVGs, checkFVGMitigation, getTrendDirection, FVG } from "./strategy-engine";

// Precomputed per-strategy signal arrays (stage-0): indicators are causal
// (value at i depends only on candles ≤ i), so a one-pass array walk over the
// full series is identical to per-bar slice recomputation, but O(n) not O(n²).
// Required for 1m backtests (~17000 bars × 1260 configs).
export interface PrecomputedSignals {
  long: boolean[]; short: boolean[]; conf: number[];
}
export function precomputeSignals(candles: BTCandle[], s: string, opts: BTOpts): PrecomputedSignals {
  const n = candles.length;
  const long = new Array(n).fill(false);
  const short = new Array(n).fill(false);
  const conf = new Array(n).fill(0);
  const closes = candles.map(c => c.close);
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const ob = opts.overbought ?? 70;
  const os = opts.oversold ?? 30;
  const bbPeriod = opts.bbPeriod ?? 20;
  const bbStdDev = opts.bbStdDev ?? 2;
  const smaPeriod = opts.smaPeriod ?? 20;
  const emaPeriod = opts.emaPeriod ?? 50;
  const ct = opts.confidenceThreshold ?? 55;
  let rsi: number[] = [], bbUpper: number[] = [], bbLower: number[] = [];
  let sma: number[] = [], ema: number[] = [];
  const rsiP = opts.optionRsiPeriod ?? 14, rsiThr = opts.optionRsiThreshold ?? 40;
  const maxPrem = opts.maxEntryPremium ?? 600;
  let spotRsi: number[] = [], ceRsi: number[] = [], peRsi: number[] = [], ceS: number[] = [], peS: number[] = [];
  let S2: S2Surface | null = null;
  if (s === "rsi_overbought_oversold") rsi = calculateRSI(closes, rsiPeriod);
  else if (s === "bollinger_band_reversal") { const bb = calculateBollingerBands(closes, bbPeriod, bbStdDev); bbUpper = bb.upper; bbLower = bb.lower; }
  else if (s === "sma_ema_cross") { sma = calculateSMA(closes, smaPeriod); ema = calculateEMA(closes, emaPeriod); }
  else if (s === "s2_scalper") S2 = s2Surface(candles);
  else if (s === "option_rsi_mr") {
    const atmStep = ATM_STEP[opts.instrument] || 50;
    // ROLLING ATM per bar (live resolves ATM from current spot): CE/PE RSI on
    // the premium series of the strike that is ATM AT THAT BAR. The old fixed
    // last-bar ATM made mid-run premium series stale (premium drifts ITM and
    // its RSI decorrelates from spot) — a quiet lookahead-ish artifact.
    const atmArr = closes.map(c => Math.round(c / atmStep) * atmStep);
    spotRsi = calculateRSI(closes, 14);
    ceS = closes.map((c, i) => premC(candles[i].ts, c, atmArr[i], "CE"));
    peS = closes.map((c, i) => premC(candles[i].ts, c, atmArr[i], "PE"));
    ceRsi = calculateRSI(ceS, rsiP); peRsi = calculateRSI(peS, rsiP);
  }
  for (let i = 0; i < n; i++) {
    const sig = signalAt(candles, i, s, opts, { rsi, bbUpper, bbLower, sma, ema, spotRsi, ceRsi, peRsi, ceS, peS, rsiPeriod, ob, os, bbPeriod, bbStdDev, smaPeriod, emaPeriod, ct, rsiP, rsiThr, maxPrem, S2, closes });
    if (sig) { long[i] = sig.dir === "LONG"; short[i] = sig.dir === "SHORT"; conf[i] = sig.conf; }
  }
  return { long, short, conf };
}

// legacy per-bar entry point (used by tests); delegates to precomputed arrays
function signal(candles: BTCandle[], i: number, s: string, opts: BTOpts): { dir: "LONG" | "SHORT"; conf: number } | null {
  const P = precomputeSignals(candles, s, opts);
  return P.long[i] ? { dir: "LONG", conf: P.conf[i] } : P.short[i] ? { dir: "SHORT", conf: P.conf[i] } : null;
}

function signalAt(
  candles: BTCandle[], i: number, s: string, opts: BTOpts,
  P: { rsi: number[]; bbUpper: number[]; bbLower: number[]; sma: number[]; ema: number[];
       spotRsi: number[]; ceRsi: number[]; peRsi: number[]; ceS: number[]; peS: number[];
       rsiPeriod: number; ob: number; os: number; bbPeriod: number; bbStdDev: number;
       smaPeriod: number; emaPeriod: number; ct: number; rsiP: number; rsiThr: number; maxPrem: number;
       S2: S2Surface | null; closes: number[] }
): { dir: "LONG" | "SHORT"; conf: number } | null {
  const closes = P.closes;
  switch (s) {
    case "trend_continuation": {
      const r = evaluateTrendContinuation(candles.slice(0, i + 1) as any, "scalping");
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "bb_mean_reversion": {
      const r = evaluateBBMeanReversal(candles.slice(0, i + 1) as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "rsi_reversal": {
      const r = evaluateRSIReversal(candles.slice(0, i + 1) as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "sma_ema_trend": {
      const r = evaluateTrendFollow(candles.slice(0, i + 1) as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "s2_scalper": {
      // O(1) per bar via precomputed surface — O(n) total vs O(n²) slice eval
      const sig = P.S2 ? s2SignalAt(P.S2, closes, i) : null;
      if (!sig) return null;
      return sig.conf >= P.ct ? sig : null;
    }
    case "sma_ema_cross": {
      if (i < 1) return null;
      if (closes[i] > P.sma[i] && closes[i - 1] <= P.sma[i - 1] && P.ema[i] > P.ema[i - 1]) return { dir: "LONG", conf: 55 };
      if (closes[i] < P.sma[i] && closes[i - 1] >= P.sma[i - 1] && P.ema[i] < P.ema[i - 1]) return { dir: "SHORT", conf: 55 };
      return null;
    }
    case "rsi_overbought_oversold": {
      if (i < 1) return null;
      if (P.rsi[i] > P.os && P.rsi[i - 1] <= P.os) return { dir: "LONG", conf: 60 };
      if (P.rsi[i] < P.ob && P.rsi[i - 1] >= P.ob) return { dir: "SHORT", conf: 60 };
      return null;
    }
    case "bollinger_band_reversal": {
      if (i < 1) return null;
      if (closes[i] > P.bbLower[i] && closes[i - 1] <= P.bbLower[i - 1]) return { dir: "LONG", conf: 60 };
      if (closes[i] < P.bbUpper[i] && closes[i - 1] >= P.bbUpper[i - 1]) return { dir: "SHORT", conf: 60 };
      return null;
    }
    case "option_rsi_mr": {
      if (i < P.rsiP + 2) return null;
      const spotRsiLast = P.spotRsi[i] ?? 50;
      const ceLast = P.ceRsi[i]; const peLast = P.peRsi[i];
      if (ceLast <= P.rsiThr && spotRsiLast > 50 && P.ceS[i] <= P.maxPrem) return { dir: "LONG", conf: 70 };
      if (peLast <= P.rsiThr && spotRsiLast < 50 && P.peS[i] <= P.maxPrem) return { dir: "SHORT", conf: 70 };
      return null;
    }
    case "fvg_strategy": {
      // FVG strategy handled in runBacktest directly (requires multi-TF candles)
      return null;
    }
    default: return null;
  }
}

// The live scalper trades OPTION PREMIUMS for every strategy (resolveStrikePremium
// buys CE/PE at LTP, exits on premium points/% target). The backtest must price the
// same trade: premium entries with premium exits + premium cost class. Spot-% modeling
// of a premium trade is a different instrument — it invalidated the first optimizer run.
export const PREMIUM_STRATEGIES = new Set(["option_rsi_mr", "s2_scalper", "sma_ema_cross", "rsi_overbought_oversold", "bollinger_band_reversal", "trend_continuation", "bb_mean_reversion", "rsi_reversal", "sma_ema_trend", "fvg_strategy"]);

export function runBacktest(candles: BTCandle[], opts: BTOpts): BTRun {
  const s = opts.strategy;
  const isPremium = PREMIUM_STRATEGIES.has(s);
  const atmStep = ATM_STEP[opts.instrument] || 50;
  const maxHold = opts.maxHoldBars ?? (s === "trend_continuation" ? STRATEGY_DEFAULTS.trendContinuation.scalping.maxHold
    : s === "bb_mean_reversion" ? STRATEGY_DEFAULTS.bbMeanReversion.maxHold : 0);

  const trades: BTTrade[] = [];
  let pos: {
    side: "BUY" | "SELL"; optType: "CE" | "PE"; entryTime: number; entryPrice: number;
    entryPremium?: number; stopLoss: number; target: number; maxPriceSeen?: number; phase1TargetHit?: boolean;
    entryBar: number; atm: number;
  } | null = null;

  const spotSL = (opts.spotSLPct ?? 1.5) / 100;
  const spotTP = (opts.spotTPPct ?? 3) / 100;
  // infer TF from the MEDIAN bar spacing (robust to a single bad gap),
  // plus session-gap detection: a gap > 4×median means a missing session or
  // data hole — force-flatten open positions at the prior close so a gap can
  // never become one giant bar that phantom-SLs.
  const medians = candles.slice(1).map((c, i) => c.ts - candles[i].ts).sort((a, b) => a - b);
  const barMs = medians.length ? medians[Math.floor(medians.length / 2)] : 300_000;
  const barsPerDay = Math.max(1, Math.round((6.25 * 3600_000) / barMs));
  const thetaPctPerBar = (opts.thetaPctPerDay ?? 1.0) / barsPerDay;
  const gapMult = opts.maxGapMult ?? 4;
  // live exit parity knobs
  const exitMode = opts.exitMode ?? "sl_tp";
  const trailPct = (opts.trailPct ?? 80) / 100;
  const phase1TargetPct = opts.phase1TargetPct ?? opts.premiumTargetPct ?? 30;
  const sessionCloseMin = opts.sessionCloseMin ?? 0;
  // IST hhmm from bar ts (TZ-safe: UTC+5:30 arithmetic, no local-tz reliance)
  const istClock = (ts: number) => {
    const d = new Date(ts + 5.5 * 3600_000);
    return d.getUTCHours() * 100 + d.getUTCMinutes();
  };
  const signals = precomputeSignals(candles, s, opts);
  const closes = candles.map(c => c.close);

  // FVG Strategy: Multi-timeframe trend + FVG detection + retest entry
  let fvgTrend15m: "bullish" | "bearish" | "neutral" = "neutral";
  let fvgTrend1h: "bullish" | "bearish" | "neutral" = "neutral";
  let fvgs: FVG[] = [];
  let pendingFVG: FVG | null = null;
  let ema21_15m: number[] = [];
  let ema50_15m: number[] = [];
  let ema21_1h: number[] = [];
  let ema50_1h: number[] = [];
  if (s === "fvg_strategy") {
    // Use adaptive periods based on data length
    const n = candles.length;
    const p15m_fast = Math.min(21, Math.max(5, Math.floor(n / 15)));
    const p15m_slow = Math.min(50, Math.max(10, Math.floor(n / 6)));
    const p1h_fast = Math.min(21, Math.max(5, Math.floor(n / 60)));
    const p1h_slow = Math.min(50, Math.max(10, Math.floor(n / 25)));

    ema21_15m = calculateEMA(closes, p15m_fast);
    ema50_15m = calculateEMA(closes, p15m_slow);
    ema21_1h = calculateEMA(closes, p1h_fast);
    ema50_1h = calculateEMA(closes, p1h_slow);
    console.log(`[FVG] Data length=${n}, 15m EMA periods: ${p15m_fast}/${p15m_slow}, 1h EMA periods: ${p1h_fast}/${p1h_slow}`);

    // Detect all FVGs upfront
    fvgs = detectFVGs(candles);
    console.log(`[FVG] Detected ${fvgs.length} FVGs total`);
  }
  // Real ATM option delta ≈ 0.5: premium moves at ~half the spot-model's rate.
  // Held premium = entry + 0.5×(model move), theta-decayed, floored at 0.15×
  // entry (live parity — auto-scalper paper exit keeps the same floor; without
  // it a deep ITM-away move would price premium to zero and grant free exits).
  const heldPrem = (spot: number, entrySpot: number) =>
    Math.max(pos.entryPremium! * 0.15,
      pos.entryPremium! + (premC(spot ? 0 : 0, spot, pos.atm, pos.optType!) - premC(0, entrySpot, pos.atm, pos.optType!)) * 0.5);

  const closeTrade = (exitC: BTCandle, exitBar: number, exitReason: string, exitPremium?: number, exitPriceOverride?: number) => {
    if (!pos) return;
    const exitPrice = exitPriceOverride ?? exitC.close;
    // For premium positions, an omitted exitPremium must be the MODELED premium
    // at exit spot — NOT the spot price (spot is ~24000 vs premium ~100-300).
    const barsHeld = exitBar - pos.entryBar;
    const premAtExit = pos.entryPremium != null
      ? heldPrem(exitC.close, pos.entryPrice) * thetaMult(barsHeld, thetaPctPerBar) : 0;
    const effPrem = exitPremium ?? premAtExit;
    const pnl = pos.entryPremium != null
      ? (effPrem - pos.entryPremium) * 100
      : (exitPrice - pos.entryPrice) * (pos.side === "BUY" ? 1 : -1);
    const pnlPct = pos.entryPremium != null
      ? (effPrem / pos.entryPremium - 1) * 100
      : (exitPrice / pos.entryPrice - 1) * (pos.side === "BUY" ? 1 : -1) * 100;
    const cost = pos.entryPremium != null ? costPct("premium") : costPct("spot");
    trades.push({
      id: trades.length + 1, side: pos.side, optType: pos.optType, strike: pos.atm,
      entryTime: pos.entryTime, entryPrice: pos.entryPrice, entryPremium: pos.entryPremium,
      stopLoss: pos.stopLoss, target: pos.target,
      exitTime: exitC.ts, exitPrice, exitPremium: exitPremium != null ? Math.round(exitPremium * 100) / 100 : undefined,
      exitReason, pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100,
      netPnlPct: Math.round((pnlPct - cost) * 100) / 100,
      bars: exitBar - pos.entryBar, result: pnl > 0 ? "WIN" : "LOSS",
    });
    pos = null;
  };

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];

    // FVG Strategy logic
    if (s === "fvg_strategy") {
      // Update trend on every bar (using precomputed EMAs)
      if (i < ema50_15m.length && i < ema50_1h.length) {
        fvgTrend15m = ema21_15m[i] > ema50_15m[i] && closes[i] > ema21_15m[i] ? "bullish"
          : ema21_15m[i] < ema50_15m[i] && closes[i] < ema21_15m[i] ? "bearish" : "neutral";
        fvgTrend1h = ema21_1h[i] > ema50_1h[i] && closes[i] > ema21_1h[i] ? "bullish"
          : ema21_1h[i] < ema50_1h[i] && closes[i] < ema21_1h[i] ? "bearish" : "neutral";
      }

      // Check if any unmitigated FVG is now mitigated (retest)
      for (const fvg of fvgs) {
        if (!fvg.mitigated && fvg.index < i) {
          const mitigated = checkFVGMitigation(candles, fvg, i);
          if (mitigated) {
            fvg.mitigated = true;
            fvg.mitigationIndex = i;
            // Check if trend aligns for entry
            const trendAlign = (fvg.type === "bullish" && (fvgTrend15m === "bullish" || fvgTrend1h === "bullish"))
              || (fvg.type === "bearish" && (fvgTrend15m === "bearish" || fvgTrend1h === "bearish"));
            if (trendAlign && !pendingFVG) {
              pendingFVG = fvg;
              console.log(`[FVG] Pending ${fvg.type} FVG at i=${fvg.index}, trend15m=${fvgTrend15m} trend1h=${fvgTrend1h}, mitigation@${i}`);
            }
          }
        }
      }

      // Debug: log trend every 50 bars
      if (i % 50 === 0 && i > 0) {
        console.log(`[FVG] i=${i} trend15m=${fvgTrend15m} trend1h=${fvgTrend1h} pending=${pendingFVG?.type||"none"} fvgs_mitigated=${fvgs.filter(f=>f.mitigated).length}/${fvgs.length}`);
      }
    }

    if (pos) {
      // Skip exit check on entry bar (prevents instant SL hit from same-bar range)
      if (i === pos.entryBar) continue;

      // session gap: force-flatten at prior close (no phantom SL through a missing session).
      // A position entered at the PREVIOUS bar's open would otherwise flatten at that
      // same bar's close → exitTime === entryTime; close it at the gap bar instead.
      const gap = c.ts - candles[i - 1].ts;
      if (gap > gapMult * barMs) {
        if (pos.entryBar < i - 1) { closeTrade(candles[i - 1], i - 1, "SESSION"); continue; }
        if (pos.entryBar === i - 1) { closeTrade(c, i, "SESSION"); continue; }
      }
      // ---- tick-by-tick intra-bar exit check ----
      if (pos.entryPremium != null) {
        // held premium: entry + 0.5×model move, theta-decayed (per-bar, TF-independent)
        const decay = thetaMult(i - pos.entryBar, thetaPctPerBar);
        const [rawLo, rawHi] = premRange(c, pos.atm, pos.optType!);
        const [entryLo, entryHi] = premRange({ ...c, high: pos.entryPrice, low: pos.entryPrice } as BTCandle, pos.atm, pos.optType!);
        const lo = (pos.entryPremium + (rawLo - entryLo) * 0.5) * decay;
        const hi = (pos.entryPremium + (rawHi - entryHi) * 0.5) * decay;
        if (exitMode === "phase") {
          // live option_rsi_mr parity: phase1 TP→BE lock, then trail (default 80%)
          if (!pos.phase1TargetHit) {
            const slHit = lo <= pos.stopLoss;
            const tpHit = hi >= pos.entryPremium * (1 + phase1TargetPct / 100);
            if (tpHit) { pos.phase1TargetHit = true; pos.maxPriceSeen = hi; pos.stopLoss = pos.entryPremium; }
            else if (slHit) { closeTrade(c, i, "SL", Math.min(lo, pos.stopLoss)); continue; }
          } else {
            const maxSeen = Math.max(pos.maxPriceSeen ?? pos.entryPremium, hi);
            pos.maxPriceSeen = maxSeen;
            if (lo <= maxSeen * trailPct) { closeTrade(c, i, "TRAIL", lo); continue; }
          }
        } else {
          // sl_tp: direction-aware SL/TP for CE (LONG) vs PE (SHORT)
          // CE/LONG: premium rises with spot → SL = lo <= stopLoss, TP = hi >= target
          // PE/SHORT: premium rises when spot falls → SL = hi >= stopLoss, TP = lo <= target
          const isLong = pos.optType === "CE";
          if (isLong) {
            if (lo <= pos.stopLoss) { closeTrade(c, i, "SL", Math.min(lo, pos.stopLoss)); continue; }
            if (hi >= pos.target) { closeTrade(c, i, "TP", Math.max(hi, pos.target)); continue; }
          } else {
            if (hi >= pos.stopLoss) { closeTrade(c, i, "SL", Math.max(hi, pos.stopLoss)); continue; }
            if (lo <= pos.target) { closeTrade(c, i, "TP", Math.min(lo, pos.target)); continue; }
          }
        }
        if (maxHold && i - pos.entryBar >= maxHold) { closeTrade(c, i, "TIME"); continue; }
        if (sessionCloseMin && istClock(c.ts) >= sessionCloseMin) { closeTrade(c, i, "EOD"); continue; }
        if (i === candles.length - 1) { closeTrade(c, i, "EOD"); continue; }
      } else {
        // spot-% position
        const dir = pos.side === "BUY" ? 1 : -1;
        const slPrice = pos.side === "BUY" ? pos.entryPrice * (1 - spotSL) : pos.entryPrice * (1 + spotSL);
        const tpPrice = pos.side === "BUY" ? pos.entryPrice * (1 + spotTP) : pos.entryPrice * (1 - spotTP);
        const slHit = dir === 1 ? c.low <= slPrice : c.high >= slPrice;
        const tpHit = dir === 1 ? c.high >= tpPrice : c.low <= tpPrice;
        if (slHit || tpHit) {
          // gap fill: if the exit bar OPENED through the level, fill at the open
          // (adversarial — no free fills); otherwise fill exactly at the level
          const fill = slHit ? slPrice : tpPrice;
          const gapFill = dir === 1 ? Math.min(c.open, fill) : Math.max(c.open, fill);
          const worse = dir === 1 ? gapFill < fill : gapFill > fill;
          const exitPrice = worse ? c.open : fill;
          closeTrade(c, i, slHit ? "SL" : "TP", undefined, exitPrice); continue;
        }
        if (maxHold && i - pos.entryBar >= maxHold) { closeTrade(c, i, "TIME"); continue; }
        if (i === candles.length - 1) { closeTrade(c, i, "EOD"); continue; }
      }
      continue;
    }

    // ---- FVG entry: check for pending mitigated FVG with trend alignment ----
    if (s === "fvg_strategy" && pendingFVG) {
      const entryC = candles[i + 1];
      if (entryC) {
        const atm = Math.round(entryC.open / atmStep) * atmStep;
        const rr = opts.fvgRiskReward ?? 1.8;
        const isBullish = pendingFVG.type === "bullish";
        const opt = isBullish ? "CE" : "PE";
        const entryPremium = premC(entryC.ts, entryC.open, atm, opt);
        const minPrem = opts.maxEntryPremium ?? 600;

        if (entryPremium > 0 && entryPremium <= minPrem) {
          // SL at FVG high/low (spot levels converted to premium)
          // Premium model: prem = spot * 0.00385 + 0.6 * (spot - atm) for CE
          // Premium change per spot point = 0.60385 for CE, -0.60385 for PE
          const fvgSpotSL = isBullish ? pendingFVG.bottom : pendingFVG.top;
          const fvgSpotEntry = entryC.open;
          const spotDist = Math.abs(fvgSpotEntry - fvgSpotSL);
          const premPerSpot = opt === "CE" ? 0.60385 : -0.60385;
          const slDist = spotDist * Math.abs(premPerSpot);
          const slPrice = isBullish ? entryPremium - slDist : entryPremium + slDist;
          const tpPrice = isBullish ? entryPremium + slDist * rr : entryPremium - slDist * rr;

          // Fallback: if slDist too small (< 0.5), use 2% of entry premium
          const minSlDist = entryPremium * 0.02;
          const effectiveSlDist = Math.max(slDist, minSlDist);
          const effectiveSlPrice = isBullish ? entryPremium - effectiveSlDist : entryPremium + effectiveSlDist;
          const effectiveTpPrice = isBullish ? entryPremium + effectiveSlDist * rr : entryPremium - effectiveSlDist * rr;

          pos = {
            side: isBullish ? "BUY" : "SELL", optType: opt, entryTime: entryC.ts, entryPrice: entryC.open,
            entryPremium, atm,
            stopLoss: Math.round(effectiveSlPrice * 100) / 100,
            target: Math.round(effectiveTpPrice * 100) / 100,
            entryBar: i + 1, maxPriceSeen: entryPremium, phase1TargetHit: false,
          };
          pendingFVG = null;
          console.log(`[FVG] Entry ${isBullish?"LONG":"SHORT"} @ ${entryPremium.toFixed(2)}, SL ${effectiveSlPrice.toFixed(2)} (spot:${fvgSpotSL.toFixed(1)}), TP ${effectiveTpPrice.toFixed(2)}, RR=${rr}, spotDist=${spotDist.toFixed(1)}, slDist=${effectiveSlDist.toFixed(2)}`);
        }
      }
    }

    // ---- entry: signal on closed candle i, execute at open of i+1 (no lookahead) ----
    if (!signals.long[i] && !signals.short[i] || i + 1 >= candles.length) continue;
    const sig = { dir: signals.long[i] ? ("LONG" as const) : ("SHORT" as const), conf: signals.conf[i] };
    // Session-tail cutoff: no new entries after entryCutoffMin (exits continue).
    // Validated on 3-day tick chain-truth: cutting entries at 14:15 lifted net
    // +2866 → +4842 (avoids the 15:15 tail trade, the session's worst).
    if (opts.entryCutoffMin && istClock(candles[i].ts) >= opts.entryCutoffMin) continue;
    const entryC = candles[i + 1];
    const atm = Math.round(entryC.open / atmStep) * atmStep;
    if (isPremium) {
      const opt = sig.dir === "LONG" ? "CE" : "PE";
      const entryPremium = premC(entryC.ts, entryC.open, atm, opt);
      const minPrem = opts.maxEntryPremium ?? 600;
      if (entryPremium <= 0 || entryPremium > minPrem) continue;
      // Symmetric premium risk: % target vs % SL (matches live
      // premiumTargetPct/stopLossPct). Points-mode (premiumTargetPoints) makes
      // a +4pt target vs -50% SL = ~1:18 reward:risk on a ₹144 premium —
      // every drift-up wins, SL never triggers; garbage analytics.
      const tpPct = opts.premiumTargetPct ?? 30;
      const slPct = opts.premiumStopLossPct ?? 40;
      pos = {
        side: sig.dir === "LONG" ? "BUY" : "SELL", optType: opt, entryTime: entryC.ts, entryPrice: entryC.open,
        entryPremium, atm,
        stopLoss: Math.round(entryPremium * (1 - slPct / 100) * 100) / 100,
        target: Math.round(entryPremium * (1 + tpPct / 100) * 100) / 100,
        entryBar: i + 1, maxPriceSeen: entryPremium, phase1TargetHit: false,
      };
    } else {
      pos = {
        side: sig.dir === "LONG" ? "BUY" : "SELL", optType: "CE", entryTime: entryC.ts, entryPrice: entryC.open,
        atm, stopLoss: 0, target: 0, entryBar: i + 1,
      };
    }
  }

  const n = trades.length;
  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const totalPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0);
  return {
    strategy: s, trades,
    summary: {
      totalTrades: n,
      winRate: n ? Math.round((wins.length / n) * 10000) / 100 : 0,
      profitFactor: losses.length ? Math.round((wins.reduce((a, t) => a + Math.abs(t.pnl), 0) / losses.reduce((a, t) => a + Math.abs(t.pnl), 0)) * 100) / 100 : (wins.length ? 99 : 0),
      totalPnlPct: Math.round(totalPnlPct * 100) / 100,
      avgPnlPct: n ? Math.round((totalPnlPct / n) * 100) / 100 : 0,
      avgBars: n ? Math.round(trades.reduce((a, t) => a + t.bars, 0) / n * 10) / 10 : 0,
      maxWinPct: n ? Math.round(Math.max(...trades.map(t => t.pnlPct)) * 100) / 100 : 0,
      maxLossPct: n ? Math.round(Math.min(...trades.map(t => t.pnlPct)) * 100) / 100 : 0,
    },
  };
}
