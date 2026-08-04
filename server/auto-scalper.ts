import { nubraApi, getSessionToken, nubraLogin, fetchOptionSymbol, fetchOptionCandles, fetchCandlesInternal } from "./nubra.js";
import { calculateRSI, calculateSMA, calculateEMA, calculateMACD, calculateBollingerBands, calculateADX } from "./indicators.js";
import { fetchCandles } from "./market-data.js";
import { evaluateTrendContinuation, evaluateBBMeanReversal, evaluateRSIReversal, evaluateTrendFollow } from "./strategy-engine.js";
import { readFileSync, existsSync } from "fs";
import { writeFile, readFile, rename } from "fs/promises";
import { join } from "path";
import logger from "./logger.js";

// Stored OUTSIDE repo root (tmp dir) — any file written inside cwd triggers a
// Vite full page reload ("page reload .scalper-state.json" in dev logs), which
// remounts the app and appears to "stop the scalper" on every persist.
const STATE_DIR = process.env.TMPDIR || process.env.TEMP || "/tmp";
const STATE_FILE = join(STATE_DIR, "mvf-scalper-state.json");
const TMP_FILE = join(STATE_DIR, "mvf-scalper-state.json.tmp");
const BACKUP_FILE = join(STATE_DIR, "mvf-scalper-state.json.bak");

// Async debounced persist — parsing/stringifying a 500-trade journal on every
// log line was blocking the poll. 150ms debounce + drain-on-exit/stop keeps
// durability while keeping the event loop free; a crash loses only ≤150ms of
// journal tail (worst trade state is the same file, re-synced by operator).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(fn: () => void) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(fn, 150);
}

interface PersistedState {
  trades: TradeRecord[];
  logs: TradeLog[];
  activeTrade: TradeRecord | null;
  stats: { totalPnl: number; totalWins: number; totalLosses: number };
  dailyPnl?: number;
  mode?: ScalperMode; // persisted so a server restart can resume scanning
  config?: Partial<ScalperConfig>; // persisted so tuning survives restart
}

function loadState(): PersistedState {
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      if (!parsed || typeof parsed !== "object") throw new Error("state is not an object");
      return parsed;
    } catch (e: any) {
      // Corruption (crash mid-write) must NOT silently reset to empty — the
      // operator needs to know an OPEN trade may exist. Log loudly, keep a .bak
      // if present. Atomic write (tmp+rename) below makes this path rare.
      logger.error({ err: e?.message, file: STATE_FILE }, "[Scalper] State file corrupt/unreadable — refusing to auto-resume. Check broker for open positions before restarting.");
      if (existsSync(BACKUP_FILE)) {
        try { return JSON.parse(readFileSync(BACKUP_FILE, "utf-8")); }
        catch { /* no backup either */ }
      }
      return { /* empty */ } as PersistedState;
    }
  }
  return { trades: [], logs: [], activeTrade: null, stats: { totalPnl: 0, totalWins: 0, totalLosses: 0 } };
}

async function saveState(state: PersistedState) {
  // Atomic write: tmp file + rename. A bare write truncates first — a crash
  // mid-write corrupts the file and loadState silently reset to zero.
  try {
    await writeFile(TMP_FILE, JSON.stringify(state, null, 2), "utf-8");
    try {
      if (existsSync(STATE_FILE)) { // existsSync sync is fine — tiny read, not the hot path
        const backup = await readFile(STATE_FILE);
        await writeFile(BACKUP_FILE, backup);
      }
    } catch { /* backup best-effort */ }
    await rename(TMP_FILE, STATE_FILE);
  } catch (e: any) {
    logger.error({ err: e?.message }, "[Scalper] Failed to persist state");
  }
}
export type ScalperMode = "SCANNING" | "ENTRY" | "EXIT" | "IDLE" | "STOPPED" | "ERROR";
export type OptSide = "CE" | "PE";
export type OrderSide = "BUY" | "SELL";

export interface ScalperConfig {
  symbol: string;
  exchange: string;
  assetType: string;               // "INDEX" for NIFTY/BANKNIFTY, "STOCK" for equities
  lotSize: number;
  lotCount: number;
  totalQty: number;
  pollIntervalMs: number;
  confidenceThreshold: number;     // 0-100, minimum confidence to enter
  premiumTargetPct: number;        // e.g. 50 → 50% gain on premium
  stopLossPct: number;             // e.g. 40 → 40% loss on premium
  maxSpreadPct: number;            // max bid-ask spread % allowed
  strikeOffset: number;            // strikes away from ATM (1 = ATM+1)
  strikeStep: number;              // strike interval: 50 (NIFTY group) or 100 (BANKNIFTY/SENSEX/CORPORATE)
  consecutiveLossLimit: number;
  minPremiumThreshold: number;
  optionExpiry: string;            // expiry date YYYY-MM-DD or "" for nearest
  strategy: string;
  paperMode: boolean;              // true = paper trade, no broker orders
  // Option RSI Mean Revert config
  optionRsiThreshold: number;      // RSI level to trigger entry (default 32)
  optionRsiPeriod: number;         // RSI period for option premium (default 14)
  premiumTargetPoints: number;     // phase1 target in premium points (default 4)
  premiumStopLossPct: number;      // SL % (default 50, expiry filter overrides to 35)
  targetMode: "points" | "percent"; // how SL/TP are calculated: points (absolute) or percent (relative)
  minDelta: number;                // minimum abs(delta) for strike selection (default 0.45)
  maxEntryPremium: number;         // skip if premium > ₹₹ (default 80)
  expiryFilterCE: string;          // skip CE after this HH:MM IST on expiry day (default "12:30")
  expiryFilterAll: string;         // skip all after this HH:MM IST on expiry day (default "13:30")
  exitStrategy: string;            // "standard" | "option_rsi_mr" — exit logic ("" uses strategy field)
  exitMode: "sl_tp" | "phase";     // "sl_tp" = plain SL/TP; "phase" = BE-lock + trail (option_rsi_mr parity)
  trailPct: number;                // phase mode: trail % of max premium seen (default 80)
  phase1TargetPct: number;         // phase mode: % gain to lock breakeven (default = premiumTargetPct)
  maxConcurrentTrades: number;     // max active trades at once (default 1)
  maxDailyLoss: number;            // max total loss pts per session (default 50)
  maxPositionSizePct: number;      // max position % of available margin (default 20)
  maxHoldingMinutes: number;       // force-exit a position after N minutes (default 15)
  entryCutoff: string;             // HH:MM IST — no new entries after this (default "15:20")
  // sma_ema_cross periods (grid-optimized; PGHO promoted 10/30)
  smaPeriod: number;
  emaPeriod: number;
  // bollinger_band_reversal (PGHO 1m promotion: 20/2.5)
  bbPeriod: number;
  bbStdDev: number;
  // Trend-confirmation gate: reject signals that fight a confirmed trend.
  // 0 = disabled. Nonzero = ADX threshold above which +DI/-DI decides direction
  // (S2 mean-reverts, so it may only enter WITH the trend).
  trendGateAdx: number;
}

export interface ScalperSignal {
  timestamp: number;
  direction: "BUY_CE" | "BUY_PE" | "NEUTRAL";
  confidence: number;
  reasons: string[];
  rsi: number;
  macd: string;
  vwapAbove: boolean;
  bbWidth: number;
  volumeZscore: number;
  pcr: number;
  ivPercentile: number;
  atmStrike: number;
  targetStrike: number;
  premium: number;
  spot: number;
  optType: OptSide;
  targetPremium?: number;     // fixed target premium (overrides config pct)
  stopLossPremium?: number;   // fixed SL premium (overrides config pct)
  entryDelta?: number;        // abs(delta) at the resolved strike
}

export interface TradeLog {
  id: string;
  ts: number;
  type: "SIGNAL" | "ENTRY" | "EXIT" | "SL_HIT" | "TARGET_HIT" | "SKIP" | "ERROR" | "STATE" | "WARN";
  msg: string;
  data?: any;
}

export interface TradeRecord {
  id: string;
  entryTime: number;
  entryPrice: number;
  entrySpot: number;
  qty: number;
  side: OrderSide;
  optType: OptSide;
  strike: number;
  expiry: string;
  entryPremium: number;
  entryDelta?: number;   // abs(delta) at entry — audit the delta rule
  stopLoss: number;
  target: number;
  exitTime?: number;
  exitPrice?: number;
  exitPremium?: number;
  exitReason?: string;
  pnl?: number;
  pnlPct?: number;
  status: "OPEN" | "CLOSED" | "STOPPED";
  // Option RSI MR phase tracking
  phase1TargetHit?: boolean;
  maxPriceSeen?: number;
  currentPremium?: number;
}

const DEFAULT_CONFIG: ScalperConfig = {
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
  maxSpreadPct: 5,
  strikeOffset: 1,
  strikeStep: 50,
  consecutiveLossLimit: 3,
  minPremiumThreshold: 0.5,
  optionExpiry: "",
  strategy: "s2_scalper",
  paperMode: true,
  optionRsiThreshold: 40,
  optionRsiPeriod: 14,
  premiumTargetPoints: 4,
  premiumStopLossPct: 50,
  targetMode: "points",
  minDelta: 0.45,
  maxEntryPremium: 600,              // skip if premium > ₹₹ (default 600 — covers NIFTY/SENSEX/BANKNIFTY)
  expiryFilterCE: "12:30",
  expiryFilterAll: "13:30",
  exitStrategy: "",
  exitMode: "sl_tp",
  trailPct: 80,
  phase1TargetPct: 0, // 0 → defaults to premiumTargetPct at exit time
  maxConcurrentTrades: 1,
  maxDailyLoss: 50,
  maxPositionSizePct: 20,
  maxHoldingMinutes: 15,
  entryCutoff: "15:20",
  smaPeriod: 10,
  emaPeriod: 30,
  bbPeriod: 20,
  bbStdDev: 2,
  trendGateAdx: 0,  // 0 = trend gate disabled (default preserves existing behavior)
};

// Per-instrument overrides — each instrument's risk profile (volatility, premium
// scale) demands different thresholds. Merged over DEFAULT_CONFIG on construct.
const INSTRUMENT_DEFAULTS: Record<string, Partial<ScalperConfig>> = {
  NIFTY: {
    lotSize: 65, lotCount: 2, totalQty: 130,
    minPremiumThreshold: 0.5, maxEntryPremium: 600,
    strikeOffset: 1, premiumTargetPoints: 4,
  },
  BANKNIFTY: {
    lotSize: 35, lotCount: 2, totalQty: 70,
    minPremiumThreshold: 1.0, maxEntryPremium: 900,
    strikeOffset: 1, premiumTargetPoints: 6,
    strikeStep: 100,
  },
  FINNIFTY: {
    lotSize: 65, lotCount: 2, totalQty: 130,
    minPremiumThreshold: 0.5, maxEntryPremium: 500,
    strikeOffset: 1, premiumTargetPoints: 3,
  },
  MIDCPNIFTY: {
    lotSize: 140, lotCount: 1, totalQty: 140,
    minPremiumThreshold: 0.5, maxEntryPremium: 500,
    strikeOffset: 1, premiumTargetPoints: 3,
  },
  SENSEX: {
    lotSize: 20, lotCount: 2, totalQty: 40,
    minPremiumThreshold: 1.0, maxEntryPremium: 1000,
    strikeOffset: 1, premiumTargetPoints: 6,
    strikeStep: 100,
  },
};

export class AutoScalper {
  private config: ScalperConfig;
  private mode: ScalperMode = "IDLE";
  private timer: ReturnType<typeof setInterval> | null = null;
  private logs: TradeLog[] = [];
  private trades: TradeRecord[] = [];
  private activeTrade: TradeRecord | null = null;
  private signalCount = 0;
  private totalPnl = 0;
  private totalWins = 0;
  private totalLosses = 0;
  private startTime = 0;
  private consecutiveErrors = 0;
  private lastSpot = 0;
  private consecutiveLosses = 0;
  private lastSide: OptSide | null = null;
  private dailyPnl = 0;
  private dailyPnlDate = "";

  // Option chain is read 6× per poll lifecycle (computeS2, resolveStrike, entry,
  // exits). 5s TTL collapses them to ~1 broker call per poll window.
  private chainCache: { data: any; ts: number } | null = null;
  private static readonly CHAIN_CACHE_TTL = 5_000;

  constructor(cfg?: Partial<ScalperConfig>) {
    this.loadLeadLagEdges();
    const state = loadState();
    // Merge persisted config over defaults, then runtime args (route) over both —
    // so a tuned strategy survives restarts, and an explicit cfg always wins.
    // Only merge persisted config when its symbol matches the requested one:
    // a stale NIFTY config (e.g. strikeStep 50) must not contaminate a fresh
    // BANKNIFTY/SENSEX instance.
    const persistedCfg = (state.config && (!state.config.symbol || state.config.symbol === (cfg?.symbol || "NIFTY"))) ? state.config : {};
    this.config = { ...DEFAULT_CONFIG, ...INSTRUMENT_DEFAULTS[cfg?.symbol || "NIFTY"], ...persistedCfg, ...cfg };
    this.trades = state.trades || [];
    this.logs = state.logs || [];
    this.activeTrade = state.activeTrade || null;
    this.totalPnl = state.stats?.totalPnl ?? 0;
    this.totalWins = state.stats?.totalWins ?? 0;
    this.totalLosses = state.stats?.totalLosses ?? 0;
    this.dailyPnl = state.dailyPnl || 0;
    // Auto-resume after a server restart so a page reload doesn't kill the engine.
    // Security-of-position: if the persisted state says an OPEN trade existed
    // (mode EXIT), we CANNOT trust that the broker still holds it — the exit may
    // have filled while we were down, or the broker squared it off at 15:30.
    // Resuming EXIT would re-issue a SELL for a position we may no longer have.
    // Stop the engine instead and let the operator reconcile against broker.
    if (state.mode === "SCANNING") {
      this.mode = "SCANNING";
      this.startTime = Date.now();
      this.log("STATE", "Restored SCANNING from persisted state");
      this.schedulePoll();
    } else if (state.mode === "EXIT" && state.activeTrade) {
      this.mode = "STOPPED";
      this.activeTrade = { ...state.activeTrade, status: "STOPPED" };
      this.log("STATE", "Restores EXIT with open trade — LEFT STOPPED: reconcile position against broker before resuming (see /api/scalper/positions)", { trade: this.activeTrade });
    }

    // Reconcile orphaned OPEN journal entries: any OPEN trade that is not the
    // active trade was left behind by an earlier restore (STOPPED) or a crash.
    // It can never be priced again — mark CLOSED/STALE so stats and UI are honest.
    const activeId = this.activeTrade?.id;
    const now = Date.now();
    for (const t of this.trades) {
      if (t.status === "OPEN" && t.id !== activeId) {
        t.status = "CLOSED";
        t.exitTime = now;
        t.exitReason = "STALE_RESTORE";
        this.log("WARN", `Reconciled orphaned OPEN trade ${t.id} → CLOSED (STALE_RESTORE): never active on this run`);
      }
    }
  }

  // Async, debounced: each mutation journaled to state via schedulePersist.
  public persist() {
    schedulePersist(() => { void saveState(this.stateSnapshot()); });
  }
  private stateSnapshot(): PersistedState {
    return {
      trades: this.trades.slice(-500),
      logs: this.logs.slice(-500),
      activeTrade: this.activeTrade,
      stats: { totalPnl: this.totalPnl, totalWins: this.totalWins, totalLosses: this.totalLosses },
      dailyPnl: this.dailyPnl,
      mode: this.mode,
      config: this.config,
    };
  }

  // Flush pending debounced persist immediately (stop/close/shutdown paths).
  public async flushPersist(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    await saveState(this.stateSnapshot());
  }

  // ── Risk helpers ────────────────────────────────────────

  private resetDailyPnlIfNewDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyPnlDate !== today) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }
  }

  /** Check position size against config % of margin. True = OK. */
  private checkPositionSize(premium: number, qty: number): boolean {
    if (this.config.maxPositionSizePct >= 100) return true;
    // ponytail: simplified SPAN estimate. Replace with broker margin API if accuracy matters.
    const estMargin = premium * qty * 0.25;
    const available = 500000; // ponytail: hardcoded ₹5L default, link to portfolio funds
    return (estMargin / available) * 100 <= this.config.maxPositionSizePct;
  }

  // ── Public API ──────────────────────────────────────────

  getConfig() { return { ...this.config }; }
  getMode() { return this.mode; }
  getLogs(n = 50) { return this.logs.slice(-n); }
  getTrades() { return [...this.trades]; }
  getActiveTrade() { return this.activeTrade; }
  getPnl() { return this.totalPnl; }
  getStats() {
    const total = this.totalWins + this.totalLosses;
    return {
      totalPnl: this.totalPnl,
      totalTrades: total,
      wins: this.totalWins,
      losses: this.totalLosses,
      winRate: total > 0 ? Math.round((this.totalWins / total) * 10000) / 100 : 0,
      signalCount: this.signalCount,
      mode: this.mode,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      lastSpot: this.lastSpot,
    };
  }

  updateConfig(cfg: Partial<ScalperConfig>) {
    this.config = { ...this.config, ...cfg };
    this.log("STATE", `Config updated: ${JSON.stringify(cfg)}`);
    this.persist();
  }

  private pollingInProgress = false;

  async start(): Promise<boolean> {
    if (this.mode === "SCANNING") return true;
    this.mode = "SCANNING";
    this.startTime = Date.now();
    this.consecutiveErrors = 0;
    this.log("STATE", "Scalper started — entering SCANNING mode");
    await this.poll();
    this.schedulePoll();
    return true;
  }

  private schedulePoll() {
    // Keep chain alive through IDLE (market-closed pause) so it auto-resumes at open
    if (this.mode === "STOPPED" || this.mode === "ERROR") return;
    this.timer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.mode = "STOPPED";
    this.log("STATE", "Scalper stopped");
  }

  reset(): void {
    this.stop();
    this.trades = [];
    this.activeTrade = null;
    this.logs = [];
    this.totalPnl = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.signalCount = 0;
    this.mode = "IDLE";
    this.persist();
  }

  clearOldTrades(): void {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();
    this.trades = this.trades.filter(t => t.entryTime >= todayTs);
    this.logs = this.logs.filter(l => l.ts >= todayTs);
    this.persist();
    this.log("STATE", `Old trades pruned, ${this.trades.length} remain today`);
  }

  // ── Core Poll Loop ──────────────────────────────────────

  private async poll() {
    if (this.pollingInProgress) return;
    this.pollingInProgress = true;
    try {
      // 1. Ensure broker session
      if (!getSessionToken()) {
        await nubraLogin();
        if (!getSessionToken()) {
          this.log("ERROR", "Broker login failed — skipping poll");
          return;
        }
      }

      // 2. Check market hours (NSE: 9:15-15:30 IST)
      const now = new Date();
      const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const h = ist.getHours(), m = ist.getMinutes();
      const timeNum = h * 100 + m;
      if (timeNum < 915 || timeNum > 1530) {
        if (this.mode !== "IDLE") {
          this.log("STATE", "Market closed — pausing scalper");
          this.mode = "IDLE";
        }
        return;
      }
      if (this.mode === "IDLE" && this.startTime > 0) {
        this.mode = "SCANNING";
        this.log("STATE", "Market open — resuming SCANNING");
      }

      // Entry cutoff: no NEW entries in the close window (MARKET_CLOSE force-exits
      // at 15:25, so a fresh entry after the cutoff is a guaranteed forced exit).
      // Exits keep running — only signal/entry generation stops.
      const cutoff = (this.config.entryCutoff || "15:20").split(":").map(Number);
      const cutoffNum = (cutoff[0] ?? 0) * 100 + (cutoff[1] ?? 0);
      const entryBlocked = timeNum >= cutoffNum;

      // 3. Fetch NIFTY spot price
      let spot: number;
      try {
        const quote = await nubraApi.getCurrentPrice(this.config.symbol, this.config.exchange);
        spot = (quote.price || 0) / 100;
        if (!spot || spot <= 0) throw new Error("Invalid spot price");
      } catch (e: any) {
        const msg = e.message || "";
        // Auth expired — force re-login before giving up
        if (msg.includes("Unauthorized") || msg.includes("440") || msg.includes("Session expired")) {
          this.log("STATE", "Auth expired — re-logging in");
          try {
            const { nubraLogin, clearSession } = await import("./nubra.js");
            if (typeof clearSession === "function") clearSession();
            const ok = await nubraLogin();
            if (ok) this.consecutiveErrors = 0;
            else this.consecutiveErrors++;
          } catch { this.consecutiveErrors++; }
        } else {
          this.consecutiveErrors++;
        }
        this.log("ERROR", `Spot price fetch failed: ${msg}`);
        if (this.consecutiveErrors > 5) {
          this.log("ERROR", "Too many consecutive errors — stopping");
          this.mode = "ERROR";
          this.stop();
        }
        return;
      }
      this.consecutiveErrors = 0;
      this.lastSpot = spot;

      // 4. If already in a trade, check exit conditions
      if (this.activeTrade && this.activeTrade.status === "OPEN") {
        await this.checkExit(spot);
        return;
      }

      // 5. Compute signal
      if (this.mode === "SCANNING") {
        // No new entries after the cutoff — exits continue in the close window.
        if (entryBlocked) {
          this.log("SIGNAL", `Entry cutoff ${this.config.entryCutoff} passed — no new entries, exits only`);
          return;
        }
        const signal = await this.computeSignal(spot);
        if (!signal) return;
        this.signalCount++;

        // Lead-lag edge boost BEFORE the confidence gate: a signal on an edge
        // strike must be able to cross the threshold. (Boosting inside
        // placeEntry never helped — a sub-threshold signal never got there.)
        this.applyLeadLagBoost(signal);

        if (signal.direction === "NEUTRAL" || signal.confidence < this.config.confidenceThreshold) {
          this.log("SIGNAL", `Skip — confidence ${signal.confidence}% < ${this.config.confidenceThreshold}%`, { signal });
          return;
        }

        // 6. ENTRY — place order
        this.log("SIGNAL", `Entry signal: ${signal.direction} @ ${signal.premium} (conf:${signal.confidence}%) strike=${signal.targetStrike}`, { signal });

        // Loss streak guard: skip entry if consecutive losses exceed limit
        if (this.consecutiveLosses >= this.config.consecutiveLossLimit) {
          this.log("SKIP", `Loss streak ${this.consecutiveLosses} >= limit ${this.config.consecutiveLossLimit} — skipping entry`, { signal });
          return;
        }

        // Min premium filter: skip if premium trivially small (would never fill live)
        if (signal.premium < this.config.minPremiumThreshold) {
          this.log("SKIP", `Premium ${signal.premium} < minThreshold ${this.config.minPremiumThreshold} — skipping`, { signal });
          return;
        }

        // Daily loss limit
        this.resetDailyPnlIfNewDay();
        if (this.dailyPnl <= -this.config.maxDailyLoss) {
          this.log("SKIP", `Daily loss ${this.dailyPnl.toFixed(1)} pts <= -${this.config.maxDailyLoss} — halting entries`);
          this.stop();
          return;
        }

        await this.placeEntry(signal);
      }
    } catch (e: any) {
      this.log("ERROR", `Poll error: ${e.message}`);
    } finally {
      this.pollingInProgress = false;
    }
  }

  // ── Signal Computation: Strategy-branched ──

  private async fetchCandles1m(): Promise<any[]> {
    // Delegate to market-data.ts fetchCandles — cache-first (10s TTL shared with WS/
    // routes, so one broker call per poll window), INDEX-aware (INDEXES set), and
    // multi-day for RSI/MACD. Removed: the http://localhost:3000 self-fetch fallback.
    let candles: any[] = [];
    try {
      candles = await fetchCandles(this.config.symbol, this.config.exchange, "1m", 120);
    } catch (e: any) { logger.warn({ err: e }, "[Scalper] Historical data fetch failed"); }
    // Filter intraday only (UTC 03:45 = IST 09:15). Broker ts is nanoseconds —
    // normalize to ms before comparing against the wall clock, else a ns epoch
    // (~1.7e18) is always >= ms open (~1.7e12) and every stale session passes.
    const marketOpenUTC = new Date(); marketOpenUTC.setUTCHours(3, 45, 0, 0); marketOpenUTC.setMilliseconds(0);
    const openMs = marketOpenUTC.getTime();
    return candles.filter(c => c.ts >= 1e15 ? c.ts / 1e6 >= openMs : c.ts >= openMs);
  }

  /**
   * Trend-confirmation gate (S2, hard block inside computeS2).
   *
   * S2 is mean-reverting — RSI/MACD extremes scream "reversal" at exactly the
   * moment a strong trend keeps going. When ADX confirms a trend (>= trendGateAdx)
   * and the signal fights it, the entry is blocked. Fade trades become
   * counter-trend lottery tickets that bleed against a trending day.
   *
   * Enabled via config `trendGateAdx` (0 = off). Uses the same 1m candles the
   * signal already computed — no extra broker call.
   */
  private trendDirection(candles: any[]): { trend: "up" | "down" | "none"; adx: number; plusDi: number; minusDi: number } {
    const thresh = this.config.trendGateAdx;
    if (!thresh) return { trend: "none", adx: 0, plusDi: 0, minusDi: 0 };
    if (candles.length < 30) return { trend: "none", adx: 0, plusDi: 0, minusDi: 0 };
    const adx = calculateADX(candles as any, 14);
    const last = adx.adx[adx.adx.length - 1];
    const plus = adx.plusDi[adx.plusDi.length - 1];
    const minus = adx.minusDi[adx.minusDi.length - 1];
    if (last >= thresh) return { trend: plus > minus ? "up" : "down", adx: last, plusDi: plus, minusDi: minus };
    return { trend: "none", adx: last, plusDi: plus, minusDi: minus };
  }

  private async computeS2(spot: number, candles: any[], closes: number[]): Promise<ScalperSignal | null> {
    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes);
    const last = candles[candles.length - 1];
    const rsiVal = rsi[rsi.length - 1];
    const macdLine = macd.macdLine[macd.macdLine.length - 1];
    const signalLine = macd.signalLine[macd.signalLine.length - 1];
    const macdHist = macd.histogram[macd.histogram.length - 1];
    const prevMacdHist = macd.histogram[macd.histogram.length - 2] || 0;
    const reasons: string[] = [];
    let bullScore = 0, bearScore = 0;
    let pcr = 1, atmIV = 0, ivPercentile = 15;

    if (rsiVal < 30) { bullScore += 2; reasons.push(`RSI oversold ${rsiVal.toFixed(1)}`); }
    else if (rsiVal > 70) { bearScore += 2; reasons.push(`RSI overbought ${rsiVal.toFixed(1)}`); }
    else if (rsiVal > 50) { bullScore += 1; } else { bearScore += 1; }

    const macdExpanding = macdLine > signalLine && macdHist > prevMacdHist;
    const macdContracting = macdLine < signalLine && macdHist < prevMacdHist;
    if (macdExpanding) { bullScore += 2; reasons.push("MACD expanding"); }
    else if (macdContracting) { bearScore += 2; reasons.push("MACD contracting"); }
    else if (macdLine > signalLine) { bullScore += 1; } else { bearScore += 1; }

    // BB Width / VWAP / Vol Z-score
    const bb = calculateBollingerBands(closes, 20, 2);
    const bbMid = bb.middle[bb.middle.length - 1];
    const bbWidth = bbMid > 0 ? ((bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bbMid) * 100 : 0;
    const bbSqueeze = bbWidth < 0.5;
    const vol20 = candles.slice(-20).map(c => c.volume || 0);
    const sumVol = vol20.reduce((a, b) => a + b, 0);
    const vwap = sumVol > 0 ? candles.slice(-20).reduce((a, c) => a + c.close * (c.volume || 0), 0) / sumVol : last.close;
    const vwapAbove = last.close > vwap;
    const volAvg = vol20.reduce((a, b) => a + b, 0) / vol20.length;
    const volStd = Math.sqrt(vol20.reduce((a, b) => a + (b - volAvg) ** 2, 0) / vol20.length);
    const volumeZscore = volStd > 0 ? (vol20[vol20.length - 1] - volAvg) / volStd : 0;

    let confidence = (bullScore + bearScore) > 0 ? Math.round((Math.max(bullScore, bearScore) / (bullScore + bearScore)) * 100) : 50;
    const isBull = bullScore > bearScore;
    const hasStrongSignal = rsiVal < 30 || rsiVal > 70 || macdExpanding || macdContracting;

    // Fetch option chain for PCR/IV
    try {
      const optChain = await this.getCachedChain();
      const chain = optChain?.chain || optChain;
      const ceList = (chain?.ce || []).filter((c: any) => (c.sp || 0) > 0);
      const peList = (chain?.pe || []).filter((p: any) => (p.sp || 0) > 0);
      const totalCallOI = ceList.reduce((a: number, c: any) => a + (c.oi || 0), 0);
      const totalPutOI = peList.reduce((a: number, c: any) => a + (c.oi || 0), 0);
      pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
      const atm = this.atmAround(spot);
      const atmCall = ceList.find((c: any) => Math.round((c.sp || 0) / 100) === atm);
      const atmPut = peList.find((p: any) => Math.round((p.sp || 0) / 100) === atm);
      atmIV = ((atmCall?.iv || 0) + (atmPut?.iv || 0)) / 2;
      ivPercentile = Math.round(Math.min(100, Math.max(0, (atmIV / 25) * 100)));
    } catch (e: any) { logger.warn({ err: e }, "[Scalper] PCR/IV data fetch failed"); }

    if (pcr > 1.2) { bearScore += 1; reasons.push(`PCR ${pcr.toFixed(2)} bearish`); }
    else if (pcr < 0.8) { bullScore += 1; reasons.push(`PCR ${pcr.toFixed(2)} bullish`); }
    else { bullScore += 1; bearScore += 1; }
    if (atmIV > 20) reasons.push(`IV ${atmIV.toFixed(1)}% elevated`);
    else if (atmIV < 12) reasons.push(`IV ${atmIV.toFixed(1)}% low`);
    if (vwapAbove) { bullScore += 1; reasons.push("VWAP above"); }
    else { bearScore += 1; reasons.push("VWAP below"); }
    if (bbSqueeze) { reasons.push(`BB squeeze ${bbWidth.toFixed(2)}%`); if (!hasStrongSignal) confidence = Math.max(0, confidence - 15); }
    else if (bbWidth > 1.5) { reasons.push(`BB wide ${bbWidth.toFixed(2)}%`); if (hasStrongSignal) confidence = Math.min(100, confidence + 10); }
    if (volumeZscore > 2) { if (isBull) { bullScore += 1; reasons.push(`Vol ${volumeZscore.toFixed(1)}σ`); } else { bearScore += 1; reasons.push(`Vol ${volumeZscore.toFixed(1)}σ`); } }

    if (!hasStrongSignal || confidence < this.config.confidenceThreshold || (bullScore + bearScore) < 3) {
      return { timestamp: Date.now(), direction: "NEUTRAL", confidence: 0, reasons: [], rsi: rsiVal,
        macd: macdLine > signalLine ? "Bullish" : "Bearish", vwapAbove, bbWidth, volumeZscore, pcr, ivPercentile,
        atmStrike: this.atmAround(spot), targetStrike: 0, premium: 0, spot, optType: "CE" };
    }

    // Trend-confirmation gate: S2 mean-reverts, so it may only enter WITH a
    // confirmed trend. ADX >= trendGateAdx + +DI/-DI direction decides. Fade
    // entries against confirmed momentum are the losing trades — hard block.
    // Uses the same candles — no extra broker call.
    const t = this.trendDirection(candles);
    if (t.trend !== "none") {
      const fights = (isBull && t.trend === "down") || (!isBull && t.trend === "up");
      reasons.push(`trend ${t.trend} ADX ${t.adx.toFixed(1)}`);
      if (fights) {
        this.log("SKIP", `Trend gate: ${isBull ? "BUY_CE" : "BUY_PE"} vs ${t.trend} trend (ADX ${t.adx.toFixed(1)} ≥ ${this.config.trendGateAdx}, +DI ${t.plusDi.toFixed(1)}/-DI ${t.minusDi.toFixed(1)}) — counter-trend, blocking`);
        return { timestamp: Date.now(), direction: "NEUTRAL", confidence: 0, reasons: [], rsi: rsiVal,
          macd: macdLine > signalLine ? "Bullish" : "Bearish", vwapAbove, bbWidth, volumeZscore, pcr, ivPercentile,
          atmStrike: this.atmAround(spot), targetStrike: 0, premium: 0, spot, optType: "CE" };
      }
    }

    return this.resolveStrikePremium(spot, isBull, confidence, reasons, rsiVal, macdLine > signalLine ? "Bullish" : "Bearish",
      vwapAbove, bbWidth, volumeZscore, pcr, ivPercentile);
  }

  private async computeSmaEma(spot: number, candles: any[], closes: number[]): Promise<ScalperSignal | null> {
    const smaP = this.config.smaPeriod || 10;
    const emaP = this.config.emaPeriod || 30;
    if (closes.length < emaP + 2) return null;
    const sma = calculateSMA(closes, smaP);
    const ema = calculateEMA(closes, emaP);
    const lastIdx = closes.length - 1;
    const price = closes[lastIdx];
    const prev = closes[lastIdx - 1];
    const isBull = price > sma[lastIdx] && prev <= sma[lastIdx - 1] && ema[lastIdx] > ema[lastIdx - 1];
    const isBear = price < sma[lastIdx] && prev >= sma[lastIdx - 1] && ema[lastIdx] < ema[lastIdx - 1];
    if (!isBull && !isBear) return null;
    const dir = isBull ? "BUY_CE" as const : "BUY_PE" as const;
    const reasons = [isBull ? `SMA${smaP} cross↑ EMA${emaP}↑` : `SMA${smaP} cross↓ EMA${emaP}↓`];
    return this.resolveStrikePremium(spot, isBull, 65, reasons, 50, "flat", false, 0, 0, 1, 15);
  }

  private async computeRsi(spot: number, candles: any[], closes: number[]): Promise<ScalperSignal | null> {
    if (closes.length < 30) return null;
    const rsi = calculateRSI(closes, 14);
    const rsiVal = rsi[rsi.length - 1];
    const prevRsi = rsi[rsi.length - 2] || 50;
    const isBull = rsiVal > 30 && prevRsi <= 30;
    const isBear = rsiVal < 70 && prevRsi >= 70;
    if (!isBull && !isBear) return null;
    const reasons = [isBull ? `RSI bounce ${prevRsi.toFixed(0)}→${rsiVal.toFixed(0)}` : `RSI drop ${prevRsi.toFixed(0)}→${rsiVal.toFixed(0)}`];
    return this.resolveStrikePremium(spot, isBull, 65, reasons, rsiVal, "flat", false, 0, 0, 1, 15);
  }

  private async computeBB(spot: number, candles: any[], closes: number[]): Promise<ScalperSignal | null> {
    const bbPeriod = this.config.bbPeriod || 20;
    const bbStdDev = this.config.bbStdDev || 2;
    if (closes.length < bbPeriod + 10) return null;
    const bb = calculateBollingerBands(closes, bbPeriod, bbStdDev);
    const lastIdx = closes.length - 1;
    const price = closes[lastIdx];
    const prev = closes[lastIdx - 1];
    const bbWidth = bb.middle[lastIdx] > 0 ? ((bb.upper[lastIdx] - bb.lower[lastIdx]) / bb.middle[lastIdx]) * 100 : 0;
    const isBull = price > bb.lower[lastIdx] && prev <= bb.lower[lastIdx - 1];
    const isBear = price < bb.upper[lastIdx] && prev >= bb.upper[lastIdx - 1];
    if (!isBull && !isBear) return null;
    const reasons = [isBull ? `BB lower bounce ${bbWidth.toFixed(2)}%` : `BB upper reject ${bbWidth.toFixed(2)}%`];
    return this.resolveStrikePremium(spot, isBull, 65, reasons, 50, "flat", false, bbWidth, 0, 1, 15);
  }

  /**
   * Option RSI Mean Revert Strategy
   * Entry CE: 1-min option CE RSI <= threshold AND 15-min spot RSI > 50
   * Entry PE: 1-min option PE RSI <= threshold AND 15-min spot RSI < 50
   * Target: fixed premium points (default 4), SL: fixed % of premium (default -50%)
   */
  private async computeOptionRsiMR(spot: number, candles: any[], closes: number[]): Promise<ScalperSignal | null> {
    const period = this.config.optionRsiPeriod || 14;
    const threshold = this.config.optionRsiThreshold || 32;
    if (closes.length < Math.max(period + 1, 30)) return null;

    // 1. Compute 15-min spot RSI for trend filter
    const f15: number[] = [];
    for (let i = 0; i < closes.length; i += 15) {
      const g = closes.slice(i, i + 15);
      if (g.length >= 5) f15.push(g[g.length - 1]);
    }
    const spotRsi15 = f15.length > 14 ? calculateRSI(f15, 14) : [];
    const spotRsiVal = spotRsi15.length > 0 ? spotRsi15[spotRsi15.length - 1] : 50;

    // 2. Expiry day filters
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const timeStr = `${String(ist.getHours()).padStart(2, "0")}:${String(ist.getMinutes()).padStart(2, "0")}`;
    const isExpiry = this.isExpiryDay();
    if (isExpiry && this.config.expiryFilterAll && timeStr >= this.config.expiryFilterAll) {
      this.log("SKIP", `Expiry day — past ${this.config.expiryFilterAll}, skipping all entries`);
      return null;
    }

    // 3. Fetch option chain for ATM/ITM strikes
    const optChain = await this.getCachedChain().catch(() => null);
    const chain = (optChain as any)?.chain || optChain || {};
    const ceList: any[] = (chain.ce || []).filter((c: any) => (c.sp || 0) > 0);
    const peList: any[] = (chain.pe || []).filter((p: any) => (p.sp || 0) > 0);

    const atm = this.atmAround(spot);
    const step = this.config.strikeStep || 50;
    const offset = this.config.strikeOffset || 0;
    const ceStrike = atm + step * offset;
    const peStrike = atm - step * offset;

    // 4. Fetch real option OHLC candles for CE and PE strikes
    let ceOptCandles: any[] = [];
    let peOptCandles: any[] = [];
    try {
      // Resolve CE/PE symbols and fetch their OHLC in parallel — sequential
      // awaits cost a full broker round-trip each.
      const [ceSym, peSym] = await Promise.all([
        fetchOptionSymbol(this.config.symbol, ceStrike, "CE", this.config.exchange),
        fetchOptionSymbol(this.config.symbol, peStrike, "PE", this.config.exchange),
      ]);
      const [ceCandles, peCandles] = await Promise.all([
        ceSym ? fetchCandlesInternal(ceSym, this.config.exchange, "1m", closes.length) : Promise.resolve([] as any[]),
        peSym ? fetchCandlesInternal(peSym, this.config.exchange, "1m", closes.length) : Promise.resolve([] as any[]),
      ]);
      ceOptCandles = ceCandles;
      peOptCandles = peCandles;
    } catch (e: any) { logger.warn({ err: e }, "[Scalper] Option candle fetch failed"); }

    const ceUsed = ceOptCandles.length >= period + 1;
    const peUsed = peOptCandles.length >= period + 1;

    // Real last-bar premium for each side (chain LTP wins; else best real candle close).
    const ceLtp = ceList.find((o: any) => Math.round((o.sp || 0) / 100) === ceStrike)?.ltp;
    const peLtp = peList.find((o: any) => Math.round((o.sp || 0) / 100) === peStrike)?.ltp;
    const lastIdx = closes.length - 1;
    const ceLastReal = ceLtp ? ceLtp / 100 : (ceUsed && ceOptCandles[lastIdx]?.close > 0 ? ceOptCandles[lastIdx].close : 0);
    const peLastReal = peLtp ? peLtp / 100 : (peUsed && peOptCandles[lastIdx]?.close > 0 ? peOptCandles[lastIdx].close : 0);

    // 5. Expiry day filter: skip PE after expiryFilterCE
    if (isExpiry && this.config.expiryFilterCE && timeStr >= this.config.expiryFilterCE) {
      this.log("SKIP", `Expiry day — past ${this.config.expiryFilterCE}, PE entries blocked`);
    }

    // 6. Build premium series from real option candles (aligned by timestamp index) or synthetic fallback.
    //    Synthetic is a fallback only for backtest/paper parity — live entries are gated below.
    const cePremia: number[] = [];
    const pePremia: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      const syntheticCe = c * 0.006 + Math.max(0, (c - atm) * 0.4);
      const syntheticPe = c * 0.005 + Math.max(0, (atm - c) * 0.4);
      cePremia.push(ceUsed && ceOptCandles[i]?.close > 0 ? ceOptCandles[i].close : syntheticCe);
      pePremia.push(peUsed && ceOptCandles[i]?.close > 0 ? peOptCandles[i].close : syntheticPe);
    }

    const ceRsiArr = calculateRSI(cePremia, period);
    const peRsiArr = calculateRSI(pePremia, period);
    if (!ceRsiArr.length || !peRsiArr.length) return null;

    const ceRsi = ceRsiArr[ceRsiArr.length - 1];
    const peRsi = peRsiArr[peRsiArr.length - 1];

    const prem = ceLtp ? ceLtp / 100 : cePremia[cePremia.length - 1];

    // 7. Max premium filter
    if (prem > this.config.maxEntryPremium) {
      this.log("SKIP", `Premium ${prem.toFixed(1)} > maxEntryPremium ${this.config.maxEntryPremium} — skipping`);
      return null;
    }

    // 8. Entry direction
    const direction: "BUY_CE" | "BUY_PE" | "NEUTRAL" =
      ceRsi <= threshold && spotRsiVal > 50 ? "BUY_CE" :
      peRsi <= threshold && spotRsiVal < 50 ? "BUY_PE" : "NEUTRAL";

    // 9. Entry-reality gate (LIVE MONEY): never send a broker BUY whose last-bar
    //    entry premium is synthetic. The side we enter must have a real chain LTP
    //    or a real per-bar option close at its strike. Synthetic entry only in paper mode.
    const live = !this.config.paperMode;
    const canTradeCE = direction === "BUY_CE" && (live ? ceLastReal > 0 : true);
    const canTradePE = direction === "BUY_PE" && (live ? peLastReal > 0 : true)
      && !(isExpiry && this.config.expiryFilterCE && timeStr >= this.config.expiryFilterCE);

    if (!canTradeCE && !canTradePE) {
      return { timestamp: Date.now(), direction: "NEUTRAL", confidence: 0, reasons: [],
        rsi: ceRsi, macd: "flat", vwapAbove: false, bbWidth: 0, volumeZscore: 0, pcr: 1, ivPercentile: 15,
        atmStrike: atm, targetStrike: 0, premium: 0, spot, optType: "CE" };
    }

    const isBull = canTradeCE;
    const finalPrem = isBull
      ? (ceLtp ? ceLtp / 100 : (ceLastReal > 0 ? ceLastReal : cePremia[cePremia.length - 1]))
      : (peLtp ? peLtp / 100 : (peLastReal > 0 ? peLastReal : pePremia[pePremia.length - 1]));
    const reasons = [
      `Option ${isBull ? "CE" : "PE"} 1m RSI ${(isBull ? ceRsi : peRsi).toFixed(1)} <= ${threshold}`,
      `Spot 15m RSI ${spotRsiVal.toFixed(1)} ${isBull ? "> 50" : "< 50"}`,
      isExpiry ? "(Expiry day)" : "",
      ceUsed ? "CE: real OHLC" : "CE: synthetic",
      peUsed ? "PE: real OHLC" : "PE: synthetic",
    ].filter(Boolean);

    // SL: min(entry * SL_pct/100, abs_SL_cap)
    const slPct = isExpiry ? 35 : 50;
    const absSlCap = 15;
    const slAmt = Math.min(finalPrem * slPct / 100, absSlCap);
    const stopLossPremium = Math.round((finalPrem - slAmt) * 100) / 100;
    const targetPremium = Math.round((finalPrem + this.config.premiumTargetPoints) * 100) / 100;

    return {
      timestamp: Date.now(), direction: isBull ? "BUY_CE" : "BUY_PE", confidence: 80, reasons,
      rsi: isBull ? ceRsi : peRsi, macd: "flat", vwapAbove: false, bbWidth: 0, volumeZscore: 0,
      pcr: 1, ivPercentile: 15, atmStrike: atm, targetStrike: isBull ? ceStrike : peStrike,
      premium: Math.round(finalPrem * 100) / 100, spot: Math.round(spot * 100) / 100,
      optType: isBull ? "CE" : "PE",
      targetPremium,
      stopLossPremium,
    };
  }

  private isExpiryDay(): boolean {
    if (!this.config.optionExpiry) return false;
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const today = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
    return today === this.config.optionExpiry;
  }

  /** Shared: fetch option chain, resolve ATM+offset strike & premium, return filled ScalperSignal */
  private async resolveStrikePremium(
    spot: number, isBull: boolean, confidence: number, reasons: string[],
    rsi: number, macd: string, vwapAbove: boolean, bbWidth: number, volumeZscore: number,
    pcr: number, ivPercentile: number,
  ): Promise<ScalperSignal> {
    const step = this.config.strikeStep || 50;
    const atmStrike = this.atmAround(spot);
    const optType: OptSide = isBull ? "CE" : "PE";

    // Resolve strike with delta check — walk toward ATM until delta >= minDelta
    let targetStrike = isBull ? atmStrike + step * this.config.strikeOffset : atmStrike - step * this.config.strikeOffset;
    let premium = isBull ? spot * 0.006 : spot * 0.005;

    try {
      const optChain = await this.getCachedChain();
      const chain = optChain?.chain || optChain;
      const optList = (isBull ? chain?.ce : chain?.pe) || [];

      const targetOpt = optList.find((o: any) => Math.round((o.sp || 0) / 100) === targetStrike);
      const hasDelta = targetOpt && typeof targetOpt.delta === "number";
      const deltaOk = hasDelta && Math.abs(targetOpt.delta) >= this.config.minDelta;
      if (!deltaOk && hasDelta) {
        // Walk toward ATM by one step
        const closerStrike = isBull ? targetStrike - step : targetStrike + step;
        const closer = optList.find((o: any) => Math.round((o.sp || 0) / 100) === closerStrike);
        if (closer && typeof closer.delta === "number" && Math.abs(closer.delta) >= this.config.minDelta) {
          targetStrike = closerStrike;
          reasons.push(`strike walked ${targetStrike} (delta ${Math.abs(closer.delta).toFixed(2)})`);
          if (closer.ltp) premium = closer.ltp / 100;
        } else {
          // Hard reject: delta below minDelta and no closer qualifying strike.
          // OTM options that pass minDelta but sit at poor delta must not enter —
          // the delta rule is a hard gate, not a hint. Walk beyond one step first.
          let found = false;
          for (let i = 2; i <= 4; i++) {
            const walkStrike = isBull ? targetStrike - step * i : targetStrike + step * i;
            const w = optList.find((o: any) => Math.round((o.sp || 0) / 100) === walkStrike);
            if (w && typeof w.delta === "number" && Math.abs(w.delta) >= this.config.minDelta) {
              targetStrike = walkStrike;
              if (w.ltp) premium = w.ltp / 100;
              reasons.push(`strike walked ${targetStrike} (delta ${Math.abs(w.delta).toFixed(2)})`);
              found = true;
              break;
            }
          }
          if (!found) {
            this.log("SKIP", `${optType}: delta ${Math.abs(targetOpt.delta || 0).toFixed(2)} < ${this.config.minDelta} at strike ${targetStrike} — no qualifying strike within 4 steps`);
            premium = NaN; // hard-block
          }
        }
      } else {
        if (targetOpt?.ltp) premium = targetOpt.ltp / 100;
        if (hasDelta) reasons.push(`delta ${Math.abs(targetOpt.delta).toFixed(2)}`);
      }

      // Entry-reality gate (live money): the premium we'd enter at must be a real
      // chain LTP. Without it the fallback computed below IS the spot model — a
      // phantom entry. Paper mode may use the model.
      if (!this.config.paperMode && !(targetOpt?.ltp)) {
        this.log("SKIP", `${optType}: no real LTP at strike ${targetStrike} — not entering on synthetic premium`);
        premium = NaN;
      }
    } catch (e: any) { logger.warn({ err: e }, "[Scalper] Signal chain data fetch failed"); }

    if (!isFinite(premium)) {
      return { timestamp: Date.now(), direction: "NEUTRAL", confidence: 0, reasons: [],
        rsi, macd, vwapAbove, bbWidth, volumeZscore: 0, pcr, ivPercentile,
        atmStrike, targetStrike: 0, premium: 0, spot: Math.round(spot * 100) / 100, optType };
    }

    // Capture abs(delta) of the final resolved strike for audit. Re-find it in
    // the list (walk may have changed targetStrike).
    let entryDelta: number | undefined;
    try {
      const optChain = await this.getCachedChain();
      const chain = optChain?.chain || optChain;
      const list = (isBull ? chain?.ce : chain?.pe) || [];
      const resolved = list.find((o: any) => Math.round((o.sp || 0) / 100) === targetStrike);
      if (resolved && typeof resolved.delta === "number") entryDelta = Math.abs(resolved.delta);
    } catch (_) { /* audit field only — ignore */ }

    return {
      timestamp: Date.now(), direction: isBull ? "BUY_CE" : "BUY_PE",
      confidence, reasons, rsi, macd, vwapAbove, bbWidth, volumeZscore, pcr, ivPercentile,
      atmStrike, targetStrike, premium: Math.round(premium * 100) / 100,
      spot: Math.round(spot * 100) / 100, optType, entryDelta,
    };
  }

  private evaluateEngineStrategy(candles: any[]) {
    switch (this.config.strategy) {
      case "trend_continuation":
        return evaluateTrendContinuation(candles as any, "scalping");
      case "bb_mean_reversion":
        return evaluateBBMeanReversal(candles as any);
      case "rsi_reversal":
        return evaluateRSIReversal(candles as any);
      case "sma_ema_trend":
        return evaluateTrendFollow(candles as any);
      default:
        return null;
    }
  }

  private async computeSignal(spot: number): Promise<ScalperSignal | null> {
    try {
      const candles = await this.fetchCandles1m();
      if (candles.length < 30) {
        this.log("SIGNAL", `Insufficient intraday candles: ${candles.length}`);
        return null;
      }
      const closes = candles.map(c => c.close);

      // Reject if all close values are identical (flat synthetic data)
      const uniqueCloses = new Set(closes);
      if (uniqueCloses.size <= 1) {
        this.log("SIGNAL", "Synthetic/flat candle data detected, skipping signal");
        return null;
      }

      const results = this.evaluateEngineStrategy(candles);
      if (results && results.direction !== "NONE") {
        const isBull = results.direction === "LONG";
        const sig = await this.resolveStrikePremium(spot, isBull, results.confidence, [results.reason || "engine"], 50, "flat", false, 0, 0, 1, 15);
        if (sig.direction !== "NEUTRAL") return sig;
        return null;
      }

      switch (this.config.strategy) {
        case "sma_ema_cross":
          return this.computeSmaEma(spot, candles, closes);
        case "rsi_overbought_oversold":
          return this.computeRsi(spot, candles, closes);
        case "bollinger_band_reversal":
          return this.computeBB(spot, candles, closes);
        case "option_rsi_mr":
          return this.computeOptionRsiMR(spot, candles, closes);
        case "s2_scalper":
        default:
          return this.computeS2(spot, candles, closes);
      }
    } catch (e: any) {
      this.log("ERROR", `Signal compute error: ${e.message}`);
      return null;
    }
  }

  // ── Order Placement ──────────────────────────────────────

  private leadLagEdges: Record<string,number> = {};
  private loadLeadLagEdges() {
    try {
      const filePath = join(process.cwd(), "leadlag_edges.json");
      const raw = readFileSync(filePath, "utf-8");
      this.leadLagEdges = JSON.parse(raw);
      logger.info({ path: filePath, edges: Object.keys(this.leadLagEdges).length }, "[Scalper] Lead-lag edges loaded");
    } catch { this.leadLagEdges = {}; }
  }
  /** Lead-lag edge confidence boost (CE only — edge data is CE→CE; PE inverted). */
  private applyLeadLagBoost(signal: ScalperSignal) {
    if (signal.optType === "CE" && signal.targetStrike && this.leadLagEdges[signal.targetStrike]) {
      const edge = this.leadLagEdges[signal.targetStrike];
      const boost = Math.min(10, edge / 2);
      signal.confidence = Math.min(100, (signal.confidence ?? 0) + boost);
      this.log("STATE", `Lead-lag edge ${edge}% on strike ${signal.targetStrike} → confidence boosted to ${signal.confidence}`);
    }
  }

  private async placeEntry(signal: ScalperSignal) {
    try {
      if (this.activeTrade && this.activeTrade.status === "OPEN") return;

      if (!this.checkPositionSize(signal.premium, this.config.totalQty)) {
        this.log("SKIP", `Position size exceeded — skipping entry`, { signal });
        return;
      }

      const qty = this.config.totalQty;
      const premiumPaise = Math.round(signal.premium * 100);
      const side: OrderSide = "BUY";
      const usePoints = this.config.targetMode === "points";
      const stopLossValue = signal.stopLossPremium ?? (
        usePoints
          ? Math.round((signal.premium - this.config.premiumTargetPoints) * 100) / 100
          : Math.round(signal.premium * (1 - this.config.stopLossPct / 100) * 100) / 100
      );
      const targetValue = signal.targetPremium ?? (
        usePoints
          ? Math.round((signal.premium + this.config.premiumTargetPoints) * 100) / 100
          : Math.round(signal.premium * (1 + this.config.premiumTargetPct / 100) * 100) / 100
      );

      // Lead-lag boost already applied in poll() before the confidence gate;
      // placeEntry must not re-apply it (would double-boost the log and mutate
      // confidence twice for signals that reached here).

      if (this.config.paperMode) {
        const trade: TradeRecord = {
          id: `T${Date.now()}`,
          entryTime: Date.now(),
          entryPrice: premiumPaise / 100,
          entrySpot: signal.spot,
          qty,
          side,
          optType: signal.optType,
          strike: signal.targetStrike,
          expiry: "",
          entryPremium: signal.premium,
          entryDelta: signal.entryDelta,
          stopLoss: stopLossValue,
          target: targetValue,
          status: "OPEN",
        };
        this.activeTrade = trade;
        this.trades.push(trade);
        this.mode = "EXIT";
        this.log("ENTRY", `Paper trade ${signal.optType} ${signal.targetStrike} @ ${signal.premium} delta=${signal.entryDelta?.toFixed(2) ?? "?"} qty=${qty} | SL=${stopLossValue} TP=${targetValue} mode=${this.config.targetMode} pts=${this.config.premiumTargetPoints}`, { trade });
        return;
      }

      // Find the correct ref_id for the target strike option
      let refId: number;
      try {
        const optChain = await this.getCachedChain().catch(() => null);
        const chain = optChain?.chain || optChain;
        const optList = signal.optType === "CE" ? chain?.ce || [] : chain?.pe || [];
        const match = optList.find((o: any) => Math.round((o.sp || 0) / 100) === signal.targetStrike);
        refId = match?.ref_id || 0;
      } catch (e: any) { logger.warn({ err: e }, "[Scalper] Order refId lookup failed"); refId = 0; }

      const orderPayload: any = {
        isMultiLeg: false,
        refId: refId || (signal.optType === "CE" ? 1497712 : 1497713), // fallback
        qty,
        side,
        deliveryType: "IDAY",
        priceType: "LIMIT",
        validityType: "DAY",
        entryPrice: premiumPaise,
        executionMode: "ENTRY",
        stratTags: ["auto-scalper", `conf-${signal.confidence}`],
      };

      let brokerRes: any = null;
      try {
        brokerRes = await nubraApi.createOrder([orderPayload]);
      } catch (e: any) {
        // Order-integrity: a LIMIT create may have REACHED the broker while the
        // response was lost (20s timeout → AbortError is indistinguishable from
        // a rejection in the catch). Blindly retrying MARKET here can DOUBLE the
        // position. Pre-retry, look the order up: if a matching open order exists,
        // the first one landed — do NOT place a second.
        try {
          const existing = await this.findPendingOrder(refId, qty);
          if (existing) {
            this.log("STATE", `First LIMIT order landed (found broker order ${existing.intentOrderId}) — not double-placing. Entry will be marked by the reconcile pass.`);
            brokerRes = existing;
          } else {
            this.log("WARN", `Order placement failed: ${e.message} — no broker order found, retrying once as MARKET`);
            orderPayload.priceType = "MARKET";
            delete orderPayload.entryPrice;
            brokerRes = await nubraApi.createOrder([orderPayload]);
          }
        } catch (e2: any) {
          this.log("ERROR", `Order retry also failed: ${e2.message} — leaving trade unopened`);
          return;
        }
      }

      const trade: TradeRecord = {
        id: `T${Date.now()}`,
        entryTime: Date.now(),
        entryPrice: premiumPaise / 100,
        entrySpot: signal.spot,
        qty,
        side,
        optType: signal.optType,
        strike: signal.targetStrike,
        expiry: "",
        entryPremium: signal.premium,
        entryDelta: signal.entryDelta,
        stopLoss: stopLossValue,
        target: targetValue,
        status: "OPEN",
      };

      this.activeTrade = trade;
      this.trades.push(trade);
      this.mode = "EXIT";
      this.log("ENTRY", `Bought ${signal.optType} ${signal.targetStrike} @ ${signal.premium} delta=${signal.entryDelta?.toFixed(2) ?? "?"} qty=${qty} | SL=${stopLossValue} TP=${targetValue} mode=${this.config.targetMode} pts=${this.config.premiumTargetPoints}`, { trade, brokerRes });
    } catch (e: any) {
      this.log("ERROR", `Entry error: ${e.message}`);
    }
  }

  // ── Exit Check ────────────────────────────────────────────

  private async checkExit(spot: number) {
    if (!this.activeTrade) return;
    const trade = this.activeTrade;

    try {
      let currentPremium = trade.entryPremium;

      // 1. Get candles for RSI computation (needed for Phase 3)
      const candles = await this.fetchCandles1m().catch(() => null);
      const closes = candles ? candles.map(c => c.close) : [];

      // Prefer real chain LTP in BOTH paper and live — paper exits must price
      // off the market, not a synthetic spot model (phantom exits).
      // Track presence with a flag: real LTP legitimately equal to entryPremium
      // must never be mistaken for "LTP missing" and replaced by the model.
      let ltpFound = false;
      try {
        const optChain = await this.getCachedChain();
        const chain = optChain?.chain || optChain;
        const optList = trade.optType === "CE" ? chain?.ce || [] : chain?.pe || [];
        const match = optList.find((o: any) => Math.round((o.sp || 0) / 100) === trade.strike);
        if (match?.ltp) { currentPremium = match.ltp / 100; ltpFound = true; }
      } catch (e: any) { logger.warn({ err: e }, "[Scalper] Premium fetch in exit failed"); }

      // If LTP genuinely absent, model premium via delta (0.6) with theta floor
      if (!ltpFound || currentPremium <= 0) {
        const spotChg = spot - trade.entrySpot;
        currentPremium = trade.entryPremium + (trade.optType === "CE" ? 1 : -1) * 0.6 * spotChg;
        currentPremium = Math.max(currentPremium, trade.entryPremium * 0.15);
      }

      // Store live premium on active trade for status response
      trade.currentPremium = Math.round(currentPremium * 100) / 100;

      // 2. Use exitStrategy to decide exit logic (fallback to strategy field)
      const exitStrat = this.config.exitStrategy || this.config.strategy;
      if (exitStrat === "option_rsi_mr") {
        await this.checkOptionRsiMrExit(trade, currentPremium, closes, spot);
      } else {
        await this.checkStandardExit(trade, currentPremium);
      }
    } catch (e: any) {
      this.log("ERROR", `Exit check error: ${e.message}`);
    }
  }

  private async checkStandardExit(trade: TradeRecord, currentPremium: number) {
    const phase = this.config.exitMode === "phase" || this.config.exitStrategy === "option_rsi_mr";

    // Max holding duration: a 1m scalper position must not ride for hours.
    if (this.config.maxHoldingMinutes > 0 && Date.now() - trade.entryTime > this.config.maxHoldingMinutes * 60_000) {
      await this.exitPosition(currentPremium, `MAX_HOLD_${this.config.maxHoldingMinutes}m`);
      return;
    }

    if (phase) {
      // ── Phase mode (option_rsi_mr parity): SL → BE-lock → 80% trail ──
      if (!trade.phase1TargetHit) {
        if (currentPremium <= trade.stopLoss) {
          await this.exitPosition(currentPremium, `SL_HIT`);
          return;
        }
        const phase1Pct = this.config.phase1TargetPct || this.config.premiumTargetPct;
        if (currentPremium >= trade.entryPremium * (1 + phase1Pct / 100)) {
          trade.phase1TargetHit = true;
          trade.maxPriceSeen = currentPremium;
          trade.stopLoss = trade.entryPremium; // lock breakeven
          this.log("EXIT", `Phase 2: target hit (+${phase1Pct}%), SL moved to breakeven (${trade.stopLoss})`);
        }
        return;
      }
      if (currentPremium > (trade.maxPriceSeen || trade.entryPremium)) {
        trade.maxPriceSeen = currentPremium;
      }
      const trailStop = (trade.maxPriceSeen || trade.entryPremium) * (this.config.trailPct / 100);
      if (currentPremium <= trailStop) {
        await this.exitPosition(currentPremium, `TRAIL_SL_${this.config.trailPct} (max: ${trade.maxPriceSeen?.toFixed(1)}, trail: ${trailStop.toFixed(1)})`);
        return;
      }
    } else {
      // ── Plain SL/TP ──
      if (currentPremium <= trade.stopLoss) {
        await this.exitPosition(currentPremium, `SL_HIT`);
        return;
      }
      if (currentPremium >= trade.target) {
        await this.exitPosition(currentPremium, `TARGET_HIT`);
        return;
      }
    }

    // Check market hours for forced square-off (15:25 IST)
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes();
    if (h * 100 + m >= 1525) {
      await this.exitPosition(currentPremium, `MARKET_CLOSE`);
      return;
    }

    // Log current floating P&L periodically
    const elapsed = (Date.now() - trade.entryTime) / 1000;
    if (elapsed > 60 && Math.round(elapsed) % 60 === 0) {
      const pnlPct = ((currentPremium - trade.entryPremium) / trade.entryPremium) * 100;
      this.log("STATE", `Floating P&L: ${pnlPct.toFixed(1)}% (prem: ${currentPremium})`);
    }
  }

  /**
   * 3-phase exit for option_rsi_mr:
   *  Phase 1 — initial SL/target (SL computed at entry via config)
   *  Phase 2 — move SL to breakeven after +4pts target hit, set phase1TargetHit=true
   *  Phase 3 — maxPriceSeen trailing: exit if option RSI ≥ 70 or price drops 80% from max
   */
  private async checkOptionRsiMrExit(trade: TradeRecord, currentPremium: number, closes: number[], spot: number) {
    const entry = trade.entryPremium;
    const pnlPts = currentPremium - entry;

    // Max holding duration (same as standard path)
    if (this.config.maxHoldingMinutes > 0 && Date.now() - trade.entryTime > this.config.maxHoldingMinutes * 60_000) {
      await this.exitPosition(currentPremium, `MAX_HOLD_${this.config.maxHoldingMinutes}m`);
      return;
    }

    // ── Phase 1: initial SL/target ──
    if (!trade.phase1TargetHit) {
      // SL exit
      if (currentPremium <= trade.stopLoss) {
        await this.exitPosition(currentPremium, `SL_HIT (phase1, pts: ${pnlPts.toFixed(1)})`);
        return;
      }
      // Target exit phase 1→2: hit +4pts, lock breakeven
      if (currentPremium >= trade.target) {
        trade.phase1TargetHit = true;
        trade.maxPriceSeen = currentPremium;
        // Move SL to breakeven
        trade.stopLoss = trade.entryPremium;
        this.log("EXIT", `Phase 2: target hit, SL moved to breakeven (${trade.stopLoss})`);
      }
      return; // still in phase 1, wait for target
    }

    // ── Phase 2 & 3: breakeven locked, now trail ──

    // Update max price seen
    if (currentPremium > (trade.maxPriceSeen || entry)) {
      trade.maxPriceSeen = currentPremium;
    }

    // 80% trailing SL exit
    const trailStop = (trade.maxPriceSeen || entry) * 0.80;
    if (currentPremium <= trailStop) {
      await this.exitPosition(currentPremium, `TRAIL_SL_80 (max: ${(trade.maxPriceSeen || entry).toFixed(1)}, trail: ${trailStop.toFixed(1)})`);
      return;
    }

    // RSI ≥ 70 exit (Phase 3) — use real option OHLC if available
    if (closes.length >= 15) {
      const period = this.config.optionRsiPeriod || 14;
      // Exit must match the INSTRUMENT the trade actually holds: resolve the
      // strike at entry (trade.strike), not the live ATM that drifts with spot.
      // A per-bar moving strike recomputes RSI on a different contract than the
      // one entered — a stale-SL artifact that exits winners early.
      const strike = trade.strike || this.atmAround(spot);

      // Try to fetch real option candles for the trade's optType
      let optCandles: any[] = [];
      try {
        const optSym = await fetchOptionSymbol(this.config.symbol, strike, trade.optType, this.config.exchange);
        if (optSym) optCandles = await fetchCandlesInternal(optSym, this.config.exchange, "1m", closes.length);
      } catch (e: any) { logger.warn({ err: e }, "[Scalper] Option candle fetch in checkExit failed"); }

      const optUsed = optCandles.length >= period + 1;

      // Build premium series from real option candles or synthetic fallback
      // (synthetic anchored at the held strike, mirroring engine prem() shape)
      const premSeries = closes.map((c, i) => {
        const synthetic = trade.optType === "CE"
          ? c * 0.00385 + Math.max(0, (c - strike) * 0.6)
          : c * 0.00385 - Math.max(0, (strike - c) * 0.6);
        return optUsed && optCandles[i]?.close > 0 ? optCandles[i].close : synthetic;
      });
      // Override last with real premium
      premSeries[premSeries.length - 1] = currentPremium;

      const rsiArr = calculateRSI(premSeries, period);
      const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
      if (rsi >= 70) {
        await this.exitPosition(currentPremium, `RSI_TRAIL (rsi: ${rsi.toFixed(1)} ≥ 70, max: ${(trade.maxPriceSeen || entry).toFixed(1)})`);
        return;
      }
    }

    // Market close forced exit
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours(), m = ist.getMinutes();
    if (h * 100 + m >= 1525) {
      await this.exitPosition(currentPremium, `MARKET_CLOSE`);
      return;
    }
  }

  private async exitPosition(exitPremium: number, reason: string) {
    if (!this.activeTrade) return;
    const trade = this.activeTrade;

    if (this.config.paperMode) {
      this.closeTrade(trade, exitPremium, reason);
      return;
    }

    try {
      const exitPremiumPaise = Math.round(exitPremium * 100);

      // Get correct refId for this strike+optType for the exit order
      let refId = 0;
      try {
        const optChain = await this.getCachedChain();
        const chain = optChain?.chain || optChain;
        const optList = trade.optType === "CE" ? chain?.ce || [] : chain?.pe || [];
        const match = optList.find((o: any) => Math.round((o.sp || 0) / 100) === trade.strike);
        if (match?.ref_id) refId = match.ref_id;
      } catch (e: any) { logger.warn({ err: e }, "[Scalper] Exit refId lookup failed"); }
      if (!refId) {
        this.log("ERROR", "Exit: Could not resolve refId for strike — marking closed without order");
        this.closeTrade(trade, exitPremium, reason);
        return;
      }

      const orderPayload: any = {
        isMultiLeg: false,
        refId,
        qty: trade.qty,
        side: "SELL" as OrderSide,
        deliveryType: "IDAY",
        priceType: "MARKET",
        validityType: "DAY",
        executionMode: "EXIT",
        stratTags: ["auto-scalper", `exit-${reason}`],
      };

      let brokerRes: any = null;
      try {
        brokerRes = await nubraApi.createOrder([orderPayload]);
      } catch (e: any) {
        // Order-integrity: a failed EXIT must NOT mark the trade closed. The
        // broker position is still open — the next poll would open a SECOND
        // position on top. Mark STOPPED, free the scanner, flag for reconcile.
        this.log("ERROR", `Exit order failed (${e.message}) — trade STOPPED for reconcile, broker position may still be open`);
        trade.status = "STOPPED";
        this.log("STATE", `${trade.optType} ${trade.strike} exit failed — broker position may be open. Reconcile via /api/scalper/positions before resume.`, { trade });
        this.activeTrade = null;
        this.mode = "SCANNING";
        this.persist();
        return;
      }

      this.closeTrade(trade, exitPremium, reason, brokerRes);
    } catch (e: any) {
      this.log("ERROR", `Exit error: ${e.message}`);
    }
  }

  private closeTrade(trade: TradeRecord, exitPremium: number, reason: string, brokerRes?: any) {
    const pnl = (exitPremium - trade.entryPremium) * trade.qty;
    const pnlPct = ((exitPremium - trade.entryPremium) / trade.entryPremium) * 100;

    trade.exitTime = Date.now();
    trade.exitPrice = exitPremium;
    trade.exitPremium = exitPremium;
    trade.exitReason = reason;
    trade.pnl = Math.round(pnl * 100) / 100;
    trade.pnlPct = Math.round(pnlPct * 100) / 100;
    trade.status = "CLOSED";

    this.totalPnl += trade.pnl;
    this.dailyPnl += trade.pnl;
    if (pnl > 0) {
      this.totalWins++;
      this.consecutiveLosses = 0;
    } else {
      this.totalLosses++;
      this.consecutiveLosses++;
      // Track last side for auto-flip
      this.lastSide = trade.optType;
    }

    this.log(reason as any, `${trade.optType} ${trade.strike} closed: ${reason} P&L=${trade.pnl}`, { trade, brokerRes });

    this.activeTrade = null;
    this.mode = "SCANNING";
    this.persist();
  }

  /** Look up a pending/filled broker order for the given ref+qty — idempotency
   *  guard so a lost response never causes a double entry. */
  // Round spot to nearest strike-step — 50 for NIFTY group, 100 for
  // BANKNIFTY/SENSEX/MIDCPNIFTY. Centralizes the ATM strike per instrument.
  private atmAround(spot: number): number {
    const step = this.config.strikeStep || 50;
    return Math.round(spot / step) * step;
  }

  // Cached chain getter — 5s TTL. Callers that read OI/IV/LTP/delta all tolerate
  // sub-poll staleness; fresh data still lands on the call that misses.
  private async getCachedChain(expiry?: string): Promise<any> {
    const key = `${this.config.symbol}|${expiry ?? this.config.optionExpiry}|${this.config.exchange}`;
    const now = Date.now();
    if (this.chainCache && this.chainCache.ts + AutoScalper.CHAIN_CACHE_TTL > now) return this.chainCache.data;
    const optChain = await nubraApi.getOptionChain(this.config.symbol, expiry ?? this.config.optionExpiry, this.config.exchange);
    this.chainCache = { data: optChain, ts: now };
    return optChain;
  }

  private async findPendingOrder(refId: number, qty: number): Promise<any | null> {
    const orders = await nubraApi.getOrders();
    const list = Array.isArray(orders) ? orders : (orders?.orders || orders?.data || []);
    return (list as any[]).find((o: any) => Number(o.refId) === refId && Number(o.orderQty) === qty) || null;
  }

  // ── Logging ────────────────────────────────────────────────

  private log(type: TradeLog["type"], msg: string, data?: any) {
    const entry: TradeLog = { id: `L${Date.now()}`, ts: Date.now(), type, msg, data };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info({ type, msg }, `[SCALPER] ${type}: ${msg}`);
    // Persist on every log so trade history survives crashes/restarts without hitting Vite watcher
    this.persist();
  }
}
