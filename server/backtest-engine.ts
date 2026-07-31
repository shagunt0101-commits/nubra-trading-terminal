import {
  evaluateTrendContinuation, evaluateBBMeanReversal, evaluateRSIReversal,
  evaluateTrendFollow, evaluateS2Scalper, STRATEGY_DEFAULTS,
} from "./strategy-engine.js";
import { calculateRSI, calculateMACD, calculateSMA, calculateEMA, calculateBollingerBands } from "./indicators.js";

export interface BTCandle { ts: number; open: number; high: number; low: number; close: number; volume: number }
export interface BTTrade {
  id: number; side: "BUY" | "SELL"; optType?: "CE" | "PE"; strike?: number;
  entryTime: number; entryPrice: number; entryPremium?: number; stopLoss: number; target: number;
  exitTime: number; exitPrice: number; exitPremium?: number; exitReason: string;
  pnl: number; pnlPct: number; bars: number; result: "WIN" | "LOSS";
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
  // instrument context
  instrument: string;
}

// Premium model (matches live engine): paise-free ₹ prices.
// CE ≈ spot*0.006 + max(0, (spot-ATM)*0.4); PE ≈ spot*0.005 + max(0, (ATM-spot)*0.4)
const ATM_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100 };
const prem = (spot: number, atm: number, opt: "CE" | "PE") =>
  opt === "CE" ? spot * 0.006 + Math.max(0, (spot - atm) * 0.4)
               : spot * 0.005 + Math.max(0, (atm - spot) * 0.4);

// Intra-bar premium range for a candle: CE rises with spot (range = prem at low→high),
// PE falls with spot (range = prem at high→low).
function premRange(c: BTCandle, atm: number, opt: "CE" | "PE"): [number, number] {
  if (opt === "CE") return [prem(c.low, atm, "CE"), prem(c.high, atm, "CE")];
  return [prem(c.high, atm, "PE"), prem(c.low, atm, "PE")];
}

// Theta decay: ATM near-expiry options bleed ~0.5-2% of premium per day. A held
// position's premium shrinks by this per bar — otherwise a long CE rides an
// uptrend indefinitely (spot-proportional model has no expiry), inflating wins.
function thetaMult(barsHeld: number, barsPerDay: number, thetaPctPerDay: number): number {
  return Math.max(0, 1 - (thetaPctPerDay / 100) * (barsHeld / barsPerDay));
}

function signal(candles: BTCandle[], i: number, s: string, opts: BTOpts): { dir: "LONG" | "SHORT"; conf: number } | null {
  const slice = candles.slice(0, i + 1);
  const closes = candles.slice(0, i + 1).map(c => c.close);
  switch (s) {
    case "trend_continuation": {
      const r = evaluateTrendContinuation(slice as any, "scalping");
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "bb_mean_reversion": {
      const r = evaluateBBMeanReversal(slice as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "rsi_reversal": {
      const r = evaluateRSIReversal(slice as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "sma_ema_trend": {
      const r = evaluateTrendFollow(slice as any);
      return r.direction === "NONE" ? null : { dir: r.direction, conf: r.confidence };
    }
    case "s2_scalper": {
      const r = evaluateS2Scalper(slice as any);
      if (r.direction === "NONE") return null;
      const ct = opts.confidenceThreshold ?? 55;
      return r.confidence >= ct ? { dir: r.direction, conf: r.confidence } : null;
    }
    case "sma_ema_cross": {
      const sma20 = calculateSMA(closes, 20); const ema50 = calculateEMA(closes, 50);
      if (i < 1) return null;
      if (closes[i] > sma20[i] && closes[i - 1] <= sma20[i - 1] && ema50[i] > ema50[i - 1]) return { dir: "LONG", conf: 55 };
      if (closes[i] < sma20[i] && closes[i - 1] >= sma20[i - 1] && ema50[i] < ema50[i - 1]) return { dir: "SHORT", conf: 55 };
      return null;
    }
    case "rsi_overbought_oversold": {
      const rsi = calculateRSI(closes, 14); if (i < 1) return null;
      if (rsi[i] > 30 && rsi[i - 1] <= 30) return { dir: "LONG", conf: 60 };
      if (rsi[i] < 70 && rsi[i - 1] >= 70) return { dir: "SHORT", conf: 60 };
      return null;
    }
    case "bollinger_band_reversal": {
      const bb = calculateBollingerBands(closes, 20, 2); if (i < 1) return null;
      if (closes[i] > bb.lower[i] && closes[i - 1] <= bb.lower[i - 1]) return { dir: "LONG", conf: 60 };
      if (closes[i] < bb.upper[i] && closes[i - 1] >= bb.upper[i - 1]) return { dir: "SHORT", conf: 60 };
      return null;
    }
    case "option_rsi_mr": {
      // premium RSI series (model) — same logic as live backtest handler
      const period = opts.optionRsiPeriod ?? 14;
      const thr = opts.optionRsiThreshold ?? 40;
      if (i < period + 2) return null;
      const atm = Math.round(closes[i] / ATM_STEP[opts.instrument] || 50) * (ATM_STEP[opts.instrument] || 50);
      const ceSeries = closes.map(c => prem(c, atm, "CE"));
      const peSeries = closes.map(c => prem(c, atm, "PE"));
      const spotRsi = calculateRSI(closes, 14);
      const ceRsi = calculateRSI(ceSeries, period); const peRsi = calculateRSI(peSeries, period);
      const spotRsiLast = spotRsi[spotRsi.length - 1] ?? 50;
      const ceLast = ceRsi[ceRsi.length - 1]; const peLast = peRsi[peRsi.length - 1];
      const maxPrem = opts.maxEntryPremium ?? 600;
      if (ceLast <= thr && spotRsiLast > 50 && ceSeries[ceSeries.length - 1] <= maxPrem) return { dir: "LONG", conf: 70 };
      if (peLast <= thr && spotRsiLast < 50 && peSeries[peSeries.length - 1] <= maxPrem) return { dir: "SHORT", conf: 70 };
      return null;
    }
    default: return null;
  }
}

const PREMIUM_STRATEGIES = new Set(["option_rsi_mr", "trend_continuation", "bb_mean_reversion", "rsi_reversal", "sma_ema_trend"]);

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
  // infer TF from bar spacing (ms between first two candles)
  const barMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 300_000;
  const barsPerDay = Math.max(1, Math.round((6.25 * 3600_000) / barMs));
  const thetaPct = opts.thetaPctPerDay ?? 1.0;
  // Real ATM option delta ≈ 0.5: premium moves at ~half the spot-model's rate.
  // The spot-proportional model (prem()) tracks spot 1:1, so held premium is
  // valued as entry + 0.5×(model move), then theta-decayed — an honest proxy.
  const heldPrem = (spot: number, entrySpot: number) =>
    pos.entryPremium! + (prem(spot, pos.atm, pos.optType!) - prem(entrySpot, pos.atm, pos.optType!)) * 0.5;

  const closeTrade = (exitC: BTCandle, exitBar: number, exitReason: string, exitPremium?: number, exitPriceOverride?: number) => {
    if (!pos) return;
    const exitPrice = exitPriceOverride ?? exitC.close;
    // For premium positions, an omitted exitPremium must be the MODELED premium
    // at exit spot — NOT the spot price (spot is ~24000 vs premium ~100-300).
    const barsHeld = exitBar - pos.entryBar;
    const premAtExit = pos.entryPremium != null
      ? heldPrem(exitC.close, pos.entryPrice) * thetaMult(barsHeld, barsPerDay, thetaPct) : 0;
    const effPrem = exitPremium ?? premAtExit;
    const pnl = pos.entryPremium != null
      ? (effPrem - pos.entryPremium) * 100
      : (exitPrice - pos.entryPrice) * (pos.side === "BUY" ? 1 : -1);
    const pnlPct = pos.entryPremium != null
      ? (effPrem / pos.entryPremium - 1) * 100
      : (exitPrice / pos.entryPrice - 1) * (pos.side === "BUY" ? 1 : -1) * 100;
    trades.push({
      id: trades.length + 1, side: pos.side, optType: pos.optType, strike: pos.atm,
      entryTime: pos.entryTime, entryPrice: pos.entryPrice, entryPremium: pos.entryPremium,
      stopLoss: pos.stopLoss, target: pos.target,
      exitTime: exitC.ts, exitPrice, exitPremium: exitPremium != null ? Math.round(exitPremium * 100) / 100 : undefined,
      exitReason, pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100,
      bars: exitBar - pos.entryBar, result: pnl > 0 ? "WIN" : "LOSS",
    });
    pos = null;
  };

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      // ---- tick-by-tick intra-bar exit check ----
      if (pos.entryPremium != null) {
        // held premium: entry + 0.5×model move, theta-decayed
        const decay = thetaMult(i - pos.entryBar, barsPerDay, thetaPct);
        const [rawLo, rawHi] = premRange(c, pos.atm, pos.optType!);
        const [entryLo, entryHi] = premRange({ ...c, high: pos.entryPrice, low: pos.entryPrice } as BTCandle, pos.atm, pos.optType!);
        const lo = (pos.entryPremium + (rawLo - entryLo) * 0.5) * decay;
        const hi = (pos.entryPremium + (rawHi - entryHi) * 0.5) * decay;
        if (!pos.phase1TargetHit) {
          const slHit = lo <= pos.stopLoss;
          const tpHit = hi >= pos.target;
          if (tpHit) { pos.phase1TargetHit = true; pos.maxPriceSeen = hi; pos.stopLoss = pos.entryPremium; }
          else if (slHit) { closeTrade(c, i, "SL", Math.min(lo, pos.stopLoss)); continue; }
        } else {
          const maxSeen = Math.max(pos.maxPriceSeen ?? pos.entryPremium, hi);
          pos.maxPriceSeen = maxSeen;
          const trail = maxSeen * 0.80;
          if (lo <= trail) { closeTrade(c, i, "TRAIL", lo); continue; }
        }
        if (maxHold && i - pos.entryBar >= maxHold) { closeTrade(c, i, "TIME"); continue; }
        if (i === candles.length - 1) { closeTrade(c, i, "EOD"); continue; }
      } else {
        // spot-% position
        const dir = pos.side === "BUY" ? 1 : -1;
        const slPrice = pos.side === "BUY" ? pos.entryPrice * (1 - spotSL) : pos.entryPrice * (1 + spotSL);
        const tpPrice = pos.side === "BUY" ? pos.entryPrice * (1 + spotTP) : pos.entryPrice * (1 - spotTP);
        const slHit = dir === 1 ? c.low <= slPrice : c.high >= slPrice;
        const tpHit = dir === 1 ? c.high >= tpPrice : c.low <= tpPrice;
        if (slHit || tpHit) { closeTrade(c, i, slHit ? "SL" : "TP", undefined, slHit ? slPrice : tpPrice); continue; }
        if (maxHold && i - pos.entryBar >= maxHold) { closeTrade(c, i, "TIME"); continue; }
        if (i === candles.length - 1) { closeTrade(c, i, "EOD"); continue; }
      }
      continue;
    }

    // ---- entry: signal on closed candle i, execute at open of i+1 (no lookahead) ----
    const sig = signal(candles, i, s, opts);
    if (!sig || i + 1 >= candles.length) continue;
    const entryC = candles[i + 1];
    const atm = Math.round(entryC.open / atmStep) * atmStep;
    if (isPremium) {
      const opt = sig.dir === "LONG" ? "CE" : "PE";
      const entryPremium = prem(entryC.open, atm, opt);
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
