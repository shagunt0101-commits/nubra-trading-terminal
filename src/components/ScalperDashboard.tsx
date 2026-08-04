import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Instrument, QuoteData, PremiumData } from "../types";
import {
  Play, Square, RotateCcw, Activity, TrendingUp, TrendingDown,
  BarChart3, Target, AlertTriangle, Clock, DollarSign, Zap,
  RefreshCw, ChevronDown, ChevronUp, List, Settings
} from "lucide-react";

interface ScalperConfig {
  symbol: string;
  lotSize: number;
  lotCount: number;
  totalQty: number;
  pollIntervalMs: number;
  confidenceThreshold: number;
  premiumTargetPct: number;
  premiumTargetPoints: number;
  stopLossPct: number;
  strikeOffset: number;
  strategy: string;
  paperMode: boolean;
  targetMode: string;
  minDelta: number;
  exitStrategy: string;
  trendGateAdx: number;
  srEnabled: boolean;
  srTimeframe: string;
  srZonePct: number;
}

interface ScalperStats {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  signalCount: number;
  mode: string;
  uptime: number;
  lastSpot: number;
}

interface ActiveTrade {
  id?: number;
  symbol?: string;
  strike: number;
  optType: "CE" | "PE";
  entryPremium: number;
  currentPremium?: number;
  qty: number;
  sl?: number;
  tp?: number;
  entryTime?: number;
  entrySpot?: number;
}

interface Trade {
  id: number;
  symbol: string;
  strike: number;
  optType: "CE" | "PE";
  side: "BUY" | "SELL";
  entryPremium: number;
  exitPremium: number;
  qty: number;
  pnl: number;
  pnlPts: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
  entrySpot?: number;
  exitSpot?: number;
  status?: string;
  currentPremium?: number;
  stopLoss?: number;
  target?: number;
}

interface ScalperLog {
  id: string;
  ts: number;
  type: string;
  msg: string;
}

interface ScalperStatus {
  mode: string;
  config: ScalperConfig;
  stats: ScalperStats;
  activeTrade: ActiveTrade | null;
  trades: Trade[];
  logs: ScalperLog[];
}

const SYMBOL_REF_MAP: Record<string, number> = {
  NIFTY: 1001, BANKNIFTY: 1002, SENSEX: 1003, MIDCPNIFTY: 1004, FINNIFTY: 1005,
};

const DEFAULT_SYMBOL_CONFIG: Record<string, { exchange: string; lotSize: number }> = {
  NIFTY:     { exchange: "NSE", lotSize: 65 },
  BANKNIFTY: { exchange: "NSE", lotSize: 25 },
  SENSEX:    { exchange: "BSE", lotSize: 10 },
  FINNIFTY:  { exchange: "NSE", lotSize: 40 },
  MIDCPNIFTY:{ exchange: "NSE", lotSize: 75 },
};

// Override defaults with broker instrument data when available
function buildSymbolConfig(insts: Instrument[]): Record<string, { exchange: string; lotSize: number }> {
  const map = { ...DEFAULT_SYMBOL_CONFIG };
  for (const inst of insts) {
    const key = inst.asset;
    if (map[key]) {
      map[key] = { exchange: inst.exchange, lotSize: inst.lot_size };
    }
  }
  return map;
}

export default function ScalperDashboard({ quotes, premium, fnoInstruments }: { quotes?: Record<number, QuoteData>, premium?: PremiumData | null, fnoInstruments: Instrument[] }) {
  const [status, setStatus] = useState<ScalperStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [saveMsg, setSaveMsg] = useState("");
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const SYMBOL_CONFIG = useMemo(() => buildSymbolConfig(fnoInstruments), [fnoInstruments]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/scalper/status");
      if (res.ok) setStatus(await res.json());
    } catch (_) { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (showLogs && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [status?.logs, showLogs, showConsole]);

  // Poll live status while running
  useEffect(() => {
    if (status?.mode === "SCANNING" || status?.mode === "EXIT") {
      const t = setInterval(fetchStatus, 3000);
      return () => clearInterval(t);
    }
  }, [status?.mode, fetchStatus]);

  const doAction = async (action: string, body?: Record<string, unknown>) => {
    setActionLoading(action);
    setActionError("");
    try {
      const res = await fetch(`/api/scalper/${action}`, {
        method: action === "status" ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const txt = await res.text();
        setActionError(`${action}: ${txt ? txt.slice(0, 140) : `HTTP ${res.status}`}`);
      }
      await fetchStatus();
    } catch (err: unknown) {
      setActionError(`action failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setActionLoading(null);
  };

  if (loading) return (
    <div className="glass-surface border border-white/6 rounded-2xl p-6 animate-pulse">
      <div className="h-4 bg-slate-800 rounded w-1/2 mb-4" />
      <div className="h-20 bg-slate-800 rounded" />
    </div>
  );

  const s = status;
  if (!s) return (
    <div className="glass-surface border border-white/6 rounded-2xl p-6 text-center text-slate-500">
      <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
      <p className="text-sm">Could not reach scalper engine</p>
      <button onClick={fetchStatus} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 font-mono">
        Retry
      </button>
    </div>
  );

  const running = s.mode === "SCANNING" || s.mode === "EXIT";
  const modeColor = running ? "text-emerald-400" : s.mode === "ERROR" ? "text-red-400" : "text-slate-400";
  const modeBg = running ? "bg-emerald-500/10 border-emerald-500/20" : s.mode === "ERROR" ? "bg-red-500/10 border-red-500/20" : "bg-slate-800/50 border-slate-700/30";
  // Live data from WS quotes (ref_id keyed) and premium (option LTP, 2s)
  const wsRef = SYMBOL_REF_MAP[s.config.symbol];
  const wsQuote = wsRef && quotes ? quotes[wsRef] : null;
  const liveSpot = wsQuote?.price ?? 0;
  // Prefer WS premium (2s tick) over polled currentPremium (3s)
  const wsPremium = premium && premium.strike === s.activeTrade?.strike && premium.optType === s.activeTrade?.optType
    ? premium.ltp : null;
  const effectivePremium = wsPremium ?? s.activeTrade?.currentPremium ?? null;
  const livePnl = effectivePremium != null && s.activeTrade?.entryPremium != null
    ? Math.round(((effectivePremium - s.activeTrade.entryPremium) * s.activeTrade.qty) * 100) / 100
    : null;

  return (
    <div className="glass-surface border border-white/6 rounded-2xl">
      {/* Header */}
      <div className="p-3 border-b border-white/6 glass-base/60 rounded-t-2xl flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className={`h-4 w-4 ${running ? "text-emerald-400 animate-pulse" : "text-slate-400"}`} />
          <span className="text-xs font-bold font-mono text-white">AutoScalper</span>
          <select
            className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-slate-800 border border-slate-700 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
            value={s.config.symbol}
            onChange={async (e) => {
              const sym = e.target.value;
              const cfg = SYMBOL_CONFIG[sym];
              if (!cfg) return;
              await fetch("/api/scalper/config", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ symbol: sym, exchange: cfg.exchange, lotSize: cfg.lotSize, totalQty: cfg.lotSize * (s.config.lotCount || 2) }),
              });
              fetchStatus();
            }}
          >
            {Object.keys(SYMBOL_CONFIG).map(sym => (
              <option key={sym} value={sym}>{sym}</option>
            ))}
          </select>
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold border ${modeBg} ${modeColor}`}>
            {s.mode}
          </span>
          <select
            className="text-[8px] px-1 py-0.5 rounded font-mono bg-slate-800 border border-slate-700 text-indigo-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
            value={s.config.exitStrategy || ""}
            onChange={async (e) => {
              await fetch("/api/scalper/config", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ exitStrategy: e.target.value }),
              });
              fetchStatus();
            }}
            title="Exit strategy — separate from entry strategy"
          >
            <option value="">Exit: same as entry</option>
            <option value="standard">Exit: SL/TP</option>
            <option value="option_rsi_mr">Exit: RSI MR trail</option>
          </select>
          {s.config.paperMode && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">
              PAPER
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {!running ? (
            <button onClick={() => doAction("start")} disabled={actionLoading === "start"}
              className="flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-[10px] font-bold font-mono uppercase cursor-pointer">
              <Play className="h-3 w-3" /> Start
            </button>
          ) : (
            <button onClick={() => doAction("stop")} disabled={actionLoading === "stop"}
              className="flex items-center gap-1 px-2 py-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-[10px] font-bold font-mono uppercase cursor-pointer">
              <Square className="h-3 w-3" /> Stop
            </button>
          )}
          <button onClick={() => doAction("reset")} disabled={actionLoading === "reset"}
            className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-50 cursor-pointer" title="Reset">
            <RotateCcw className="h-3 w-3" />
          </button>
          <button onClick={fetchStatus} disabled={actionLoading === "status"}
            className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-50 cursor-pointer" title="Refresh">
            <RefreshCw className={`h-3 w-3 ${actionLoading === "status" ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-2 p-3">
        <div className="glass-base rounded-xl p-2.5 border border-white/6">
          <div className="text-[9px] text-slate-500 font-mono uppercase mb-1">P&L</div>
          <div className={`text-sm font-bold font-mono ${s.stats.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {s.stats.totalPnl >= 0 ? "+" : ""}{s.stats.totalPnl.toFixed(0)}
          </div>
          <div className="text-[8px] text-slate-600 font-mono mt-0.5">
            {s.stats.totalTrades}T / {s.stats.winRate.toFixed(0)}% WR
          </div>
        </div>
        <div className="glass-base rounded-xl p-2.5 border border-white/6">
          <div className="text-[9px] text-slate-500 font-mono uppercase mb-1">Trade</div>
          {s.activeTrade ? (
            <>
              <div className={`text-sm font-bold font-mono ${s.activeTrade.optType === "CE" ? "text-emerald-400" : "text-red-400"}`}>
                {s.activeTrade.optType} {s.activeTrade.strike}
              </div>
              <div className="text-[8px] text-slate-500 font-mono mt-0.5">
                @ {s.activeTrade.entryPremium} × {s.activeTrade.qty}
              </div>
              {livePnl != null && (
                <div className={`text-[9px] font-mono mt-1 ${livePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {livePnl >= 0 ? "+" : ""}{livePnl.toFixed(0)}
                </div>
              )}
              <button
                onClick={() => doAction("close-trade")}
                disabled={actionLoading === "close-trade"}
                className="mt-1.5 flex items-center gap-1 px-2 py-0.5 bg-orange-600/80 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg text-[9px] font-bold font-mono uppercase cursor-pointer"
                title="Force close the open position at market premium"
              >
                <Square className="h-2.5 w-2.5" /> Close Trade
              </button>
            </>
          ) : (
            <>
              <div className="text-sm font-bold font-mono text-slate-400">—</div>
              <div className="text-[8px] text-slate-600 font-mono mt-0.5">No active position</div>
            </>
          )}
        </div>
        <div className="glass-base rounded-xl p-2.5 border border-white/6">
          <div className="text-[9px] text-slate-500 font-mono uppercase mb-1">Spot</div>
          <div className="text-sm font-bold font-mono text-white">
            {liveSpot > 0 ? liveSpot.toFixed(1) : (s.stats.lastSpot > 0 ? s.stats.lastSpot.toFixed(1) : "—")}
          </div>
          <div className="text-[8px] text-slate-600 font-mono mt-0.5">
            {s.config.symbol}
          </div>
        </div>
      </div>

      {/* W/L bars */}
      <div className="px-3 pb-2">
        <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-800">
          <div className="bg-emerald-500 transition-all duration-500" style={{ width: s.stats.totalTrades > 0 ? `${s.stats.winRate}%` : "50%" }} />
          <div className="bg-red-500 transition-all duration-500" style={{ width: s.stats.totalTrades > 0 ? `${100 - s.stats.winRate}%` : "50%" }} />
        </div>
        <div className="flex justify-between mt-1 text-[8px] font-mono text-slate-600">
          <span>{s.stats.wins}W</span>
          <span>Signal: {s.stats.signalCount}</span>
          <span>{s.stats.losses}L</span>
        </div>
      </div>

      {/* Trade Log */}
      <div className="px-3 pb-1 flex items-center gap-1">
        <button onClick={() => setShowLogs(!showLogs)}
          className="flex items-center gap-1 text-[9px] font-mono uppercase text-slate-500 hover:text-slate-300 cursor-pointer">
          {showLogs ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          <List className="h-3 w-3" /> Trade Log ({s.trades.length})
        </button>
        <button onClick={() => doAction("clear-old-trades")}
          className="px-1.5 py-0.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded text-[7px] font-mono cursor-pointer">
          Clear
        </button>
      </div>
      {showLogs && (
        <div className="px-3 pb-3 max-h-[220px] overflow-y-auto">
          {s.trades.length === 0 ? (
            <div className="text-[10px] text-slate-600 font-mono text-center py-4">No trades yet</div>
          ) : (
            <table className="w-full text-[8px] font-mono border-collapse">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr className="text-slate-500 uppercase tracking-wider">
                  <th className="text-left py-1 pr-1">Time</th>
                  <th className="text-left py-1 pr-1">Strike</th>
                  <th className="text-center py-1 pr-1">Entry</th>
                  <th className="text-center py-1 pr-1">LTP</th>
                  <th className="text-center py-1 pr-1">SL</th>
                  <th className="text-center py-1 pr-1">TP</th>
                  <th className="text-center py-1 pr-1">Exit</th>
                  <th className="text-right py-1 pr-1">P&L</th>
                  <th className="text-center py-1">Rsn</th>
                </tr>
              </thead>
              <tbody>
                {[...s.trades].reverse().map((t, i) => {
                  const win = (t.pnl || 0) >= 0;
                  const ts = t.entryTime ? new Date(t.entryTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "";
                  const isActive = t.status === "OPEN";
                  const currentLtp = isActive
                    ? (effectivePremium && t.strike === s.activeTrade?.strike && t.optType === s.activeTrade?.optType ? effectivePremium : t.currentPremium ?? null)
                    : null;
                  return (
                    <tr key={i} className="border-t border-slate-800/40 hover:bg-slate-800/30">
                      <td className="py-1 pr-1 text-slate-500 whitespace-nowrap">{ts}</td>
                      <td className={`py-1 pr-1 font-bold whitespace-nowrap ${t.optType === "CE" ? "text-emerald-400" : "text-red-400"}`}>{t.optType}{t.strike}</td>
                      <td className="py-1 pr-1 text-center text-white">{t.entryPremium?.toFixed(1)}</td>
                      <td className={`py-1 pr-1 text-center font-bold ${isActive ? "text-cyan-300" : "text-slate-600"}`}>{currentLtp !== null ? currentLtp.toFixed(1) : "—"}</td>
                      <td className="py-1 pr-1 text-center text-red-400">{t.stopLoss?.toFixed(1)}</td>
                      <td className="py-1 pr-1 text-center text-emerald-400">{t.target?.toFixed(1)}</td>
                      <td className="py-1 pr-1 text-center text-slate-300">{t.exitPremium?.toFixed(1) || "—"}</td>
                      <td className={`py-1 pr-1 text-right font-bold ${win ? "text-emerald-400" : "text-red-400"}`}>{win ? "+" : ""}{t.pnl?.toFixed(0) || "0"}</td>
                      <td className={`py-1 text-center ${t.exitReason === "TARGET_HIT" ? "text-emerald-400" : t.exitReason === "SL_HIT" ? "text-red-400" : "text-slate-500"}`}>
                        {t.exitReason === "TARGET_HIT" ? "TP" : t.exitReason === "SL_HIT" ? "SL" : t.exitReason === "MARKET_CLOSE" ? "MC" : t.status === "OPEN" ? "—" : (t.exitReason || "?")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Log stream */}
      <div className="border-t border-slate-800">
        <button onClick={() => setShowConfig(!showConfig)}
          className="flex items-center justify-between w-full px-3 py-1.5 text-[9px] font-mono text-slate-500 hover:text-slate-300 cursor-pointer">
          <span className="flex items-center gap-1">
            <Settings className="h-3 w-3" /> {showConfig ? "Hide" : "Show"} config
          </span>
          {showConfig ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>
        {showConfig && (
          <div className="px-3 pb-3 grid grid-cols-2 gap-x-4 gap-y-2">
            {Object.entries(s.config).map(([k, v]) => {
              const editable = !["symbol", "lotSize", "totalQty", "exchange", "assetType"].includes(k);
              const val = editConfig[k] ?? String(v);
              return (
                <div key={k} className="flex items-center gap-1">
                  <span className="text-[8px] text-slate-500 font-mono min-w-[60px]">{k}</span>
                  {editable && k === "paperMode" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                    >
                      <option value="true">True (paper)</option>
                      <option value="false">False (live)</option>
                    </select>
                  ) : editable && k === "targetMode" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                    >
                      <option value="points">Points (absolute)</option>
                      <option value="percent">Percent (relative)</option>
                    </select>
                  ) : editable && k === "strategy" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                    >
                      <option value="s2_scalper">S2 Scalper (RSI+MACD+VWAP+BB)</option>
                      <option value="sma_ema_cross">SMA/EMA Trend Follow</option>
                      <option value="rsi_overbought_oversold">RSI Reversal Bounce</option>
                      <option value="bollinger_band_reversal">BB Mean Reversal</option>
                      <option value="option_rsi_mr">Option RSI Mean Revert (new)</option>
                      <option value="trend_continuation">Trend Continuation (ADX+Stoch)</option>
                      <option value="bb_mean_reversion">BB Mean Reversion (new)</option>
                      <option value="rsi_reversal">RSI Reversal (new)</option>
                      <option value="sma_ema_trend">SMA/EMA Trend (new)</option>
                    </select>
                  ) : editable && k === "trendGateAdx" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                      title="S2 trend filter: ADX threshold. 0=off; >=25 blocks entries that fight a confirmed trend"
                    >
                      <option value="0">0 — Off</option>
                      <option value="20">20 — Weak</option>
                      <option value="25">25 — Standard</option>
                      <option value="30">30 — Strict</option>
                    </select>
                  ) : editable && k === "srEnabled" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                      title="Higher-TF S/R zone gate: blocks entries INTO a level, boosts reversal trades at a level"
                    >
                      <option value="true">True (on)</option>
                      <option value="false">False (off)</option>
                    </select>
                  ) : editable && k === "srTimeframe" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                      title="S/R zone candle timeframe — 15m (default) or 1h"
                    >
                      <option value="15m">15m</option>
                      <option value="1h">1h</option>
                    </select>
                  ) : editable && k === "exitStrategy" ? (
                    <select
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                    >
                      <option value="">Same as entry strategy</option>
                      <option value="standard">Standard (SL/TP)</option>
                      <option value="option_rsi_mr">Option RSI MR (trail + RSI exit)</option>
                    </select>
                  ) : editable ? (
                    <input
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[8px] font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                      value={val}
                      onChange={e => setEditConfig(prev => ({ ...prev, [k]: e.target.value }))}
                    />
                  ) : (
                    <span className="text-[8px] text-slate-300 font-mono">{v}</span>
                  )}
                </div>
              );
            })}
            <div className="col-span-2 flex gap-1 mt-1">
              <button onClick={async () => {
                const body: Partial<ScalperConfig> = {};
                for (const k of Object.keys(editConfig)) {
                  const raw = editConfig[k];
                  const orig = s.config[k as keyof ScalperConfig];
                  (body as Record<string, unknown>)[k] = (k === "paperMode" || k === "srEnabled") ? raw === "true" : typeof orig === "number" ? (raw.includes(".") ? parseFloat(raw) : parseInt(raw, 10)) : raw;
                }
                if (Object.keys(body).length) {
                  await fetch("/api/scalper/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                  setSaveMsg("Saved ✓");
                  setTimeout(() => setSaveMsg(""), 2000);
                  setEditConfig({});
                  fetchStatus();
                }
              }} className="flex-1 px-1 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[8px] font-bold font-mono cursor-pointer">Apply</button>
              {saveMsg && <span className="text-[8px] text-emerald-400 font-mono">{saveMsg}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Console logs */}
      <div className="border-t border-slate-800">
        <button onClick={() => setShowConsole(!showConsole)}
          className="flex items-center gap-1 w-full px-3 py-1.5 text-[9px] font-mono text-slate-500 hover:text-slate-300 cursor-pointer">
          <Activity className="h-3 w-3 mt-[2px]" /> Console ({s.logs.length})
          {showConsole ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {showConsole && (
        <div className="max-h-[120px] overflow-y-auto px-3 pb-3 space-y-0.5">
          {[...s.logs].reverse().slice(0, 30).map((l, i) => {
            const t = new Date(l.ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
            const typeColor = l.type === "ERROR" ? "text-red-400" : l.type === "ENTRY" ? "text-white font-bold" : l.type === "SL_HIT" ? "text-red-400 font-bold" : l.type === "TARGET_HIT" ? "text-emerald-400 font-bold" : "text-slate-400"; // ENTRY white, TARGET green, SL red
            return (
              <div key={i} className="text-[8px] font-mono leading-relaxed">
                <span className="text-slate-600">[{t}]</span>{" "}
                <span className={typeColor}>[{l.type}]</span>{" "}
                <span className="text-slate-400" dangerouslySetInnerHTML={{ __html: l.msg
                  .replace(/\b(CE|PE) (\d+)\b/g, '<span class="font-bold text-cyan-400">$1 $2</span>') // CE/PE strike
                  .replace(/@ (\d+\.?\d*)/g, '@ <span class="text-white font-bold">$1</span>')
                  .replace(/SL=(\d+\.?\d*)/g, 'SL=<span class="text-red-400 font-bold">$1</span>')
                  .replace(/TP=(\d+\.?\d*)/g, 'TP=<span class="text-emerald-400 font-bold">$1</span>')
                }} />
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="mx-3 mb-2 px-2 py-1 rounded border border-red-500/30 bg-red-500/10 text-red-400 text-[9px] font-mono">
          {actionError}
        </div>
      )}
    </div>
  );
}
