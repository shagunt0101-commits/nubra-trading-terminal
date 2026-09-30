import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Clock, Bell, Activity, Check, ArrowUpRight, ArrowDownRight,
  Grid3X3, Rows3, Table2, X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface SpotData {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  change: number;
  pChange: number;
  ltp: number;
  ema9: number;
  adx3m: number;
  adx5m: number;
}

interface AlertTarget {
  instrument: string;
  targetPrice: number;
  condition: "ABOVE" | "BELOW";
  triggered: boolean;
}

const indices = [
  { symbol: "NIFTY", exchange: "NSE" },
  { symbol: "BANKNIFTY", exchange: "NSE" },
  { symbol: "SENSEX", exchange: "BSE" },
  { symbol: "FINNIFTY", exchange: "NSE" },
  { symbol: "MIDCPNIFTY", exchange: "NSE" },
];

export default function SpotOHLCTracker({
  selectedInstrument,
  onSelectInstrument,
}: {
  selectedInstrument?: { asset?: string; stock_name?: string } | null;
  onSelectInstrument?: (inst: { asset: string; exchange: string; derivative_type: string }) => void;
}) {
  const [spotData, setSpotData] = useState<Record<string, SpotData>>({});
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [viewMode, setViewMode] = useState<"GRID" | "COMPACT" | "DETAILED">("GRID");
  const [priceFlashMap, setPriceFlashMap] = useState<Record<string, "UP" | "DOWN" | null>>({});
  const [alerts, setAlerts] = useState<AlertTarget[]>([]);
  const [newAlertInst, setNewAlertInst] = useState("NIFTY");
  const [newAlertPrice, setNewAlertPrice] = useState("");
  const [showAlertModal, setShowAlertModal] = useState(false);
  const prevPricesRef = useRef<Record<string, number>>({});

  const flashTimeout = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let cancelled = false;
    const fetchSpot = async () => {
      const results: Record<string, SpotData> = {};
      // parallel — serial loop made each 5s tick take 5 × broker RTT
      await Promise.all(indices.map(async (idx) => {
        try {
          const res = await fetch(`/api/market/spot/${idx.symbol}?exchange=${idx.exchange}`);
          if (res.ok) {
            const data = await res.json();
            results[idx.symbol] = {
              symbol: idx.symbol,
              open: data.open || data.prevClose || 0,
              high: data.high || data.price || 0,
              low: data.low || data.price || 0,
              close: data.price || 0,
              prevClose: data.prevClose || 0,
              change: data.pointChange ?? data.change ?? 0,
              pChange: data.changePct ?? data.change ?? 0,
              ltp: data.price || 0,
              ema9: data.ema9 || 0,
              adx3m: data.adx3m || 0,
              adx5m: data.adx5m || 0,
            };
          }
        } catch {}
      }));
      if (!cancelled && Object.keys(results).length > 0) {
        setSpotData((prev) => ({ ...prev, ...results }));
        setLastUpdate(new Date());
      }
    };

    fetchSpot();
    const interval = setInterval(fetchSpot, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Flash on price change (800ms ring + color)
  useEffect(() => {
    Object.values(spotData).forEach((d) => {
      const prev = prevPricesRef.current[d.symbol];
      if (prev !== undefined && prev !== d.ltp) {
        const dir = d.ltp > prev ? "UP" : "DOWN";
        setPriceFlashMap((p) => ({ ...p, [d.symbol]: dir }));
        if (flashTimeout.current[d.symbol]) clearTimeout(flashTimeout.current[d.symbol]);
        flashTimeout.current[d.symbol] = setTimeout(() => {
          setPriceFlashMap((p) => ({ ...p, [d.symbol]: null }));
        }, 800);
      }
      prevPricesRef.current[d.symbol] = d.ltp;
    });
  }, [spotData]);

  // Trigger alerts when price crosses target
  useEffect(() => {
    setAlerts((prevAlerts) => {
      let changed = false;
      const next = prevAlerts.map((alt) => {
        if (alt.triggered) return alt;
        const d = spotData[alt.instrument];
        if (!d) return alt;
        if ((alt.condition === "ABOVE" && d.ltp >= alt.targetPrice) || (alt.condition === "BELOW" && d.ltp <= alt.targetPrice)) {
          changed = true;
          return { ...alt, triggered: true };
        }
        return alt;
      });
      return changed ? next : prevAlerts;
    });
  }, [spotData]);

  const handleAddAlert = () => {
    const val = parseFloat(newAlertPrice);
    if (isNaN(val) || val <= 0) return;
    const d = spotData[newAlertInst];
    const currPrice = d ? d.ltp : 0;
    const condition = val >= currPrice ? "ABOVE" : "BELOW";
    setAlerts((prev) => [...prev, { instrument: newAlertInst, targetPrice: val, condition, triggered: false }]);
    setNewAlertPrice("");
    setShowAlertModal(false);
  };

  const selectInst = useCallback((symbol: string) => {
    if (!onSelectInstrument) return;
    const idx = indices.find((i) => i.symbol === symbol);
    if (idx) onSelectInstrument({ asset: symbol, exchange: idx.exchange, derivative_type: "INDEX" });
  }, [onSelectInstrument]);

  const isSelected = (symbol: string) =>
    selectedInstrument?.asset === symbol || selectedInstrument?.stock_name === symbol;

  const formatPrice = (price: number) =>
    `₹${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statsOf = (d: SpotData) => {
    const pointChange = d.ltp - d.prevClose;
    const pctChange = d.prevClose > 0 ? (pointChange / d.prevClose) * 100 : 0;
    const rangeSpan = d.high - d.low;
    const rangePct = rangeSpan > 0 ? Math.min(100, Math.max(0, ((d.ltp - d.low) / rangeSpan) * 100)) : 50;
    const distFromEma = d.ema9 > 0 ? d.ltp - d.ema9 : 0;
    return { pointChange, pctChange, rangePct, distFromEma };
  };

  const trendOf = (d: SpotData) => {
    if (d.adx3m >= 20) {
      const ema = d.ema9 || d.ltp;
      if (d.ltp > ema) return { label: "BULLISH SCALP", cls: "text-emerald-400 bg-emerald-950/80 border-emerald-800/60" };
      if (d.ltp < ema) return { label: "BEARISH SCALP", cls: "text-rose-400 bg-rose-950/80 border-rose-800/60" };
    }
    return { label: "TRENDING / WATCH", cls: "text-amber-400 bg-amber-950/80 border-amber-800/60" };
  };

  const changeCls = (v: number) => (v >= 0 ? "text-emerald-400" : "text-rose-400");

  // ---------------- CARD (shared by GRID) ----------------
  const renderCard = (idx: { symbol: string }) => {
    const d = spotData[idx.symbol];
    if (!d || d.close === 0) return null;
    const stats = statsOf(d);
    const flash = priceFlashMap[idx.symbol];
    const selected = isSelected(idx.symbol);
    const trend = trendOf(d);

    return (
      <motion.div
        key={idx.symbol}
        whileHover={{ scale: 1.01 }}
        onClick={() => selectInst(idx.symbol)}
        className={`cursor-pointer rounded-xl p-3 border transition-all relative overflow-hidden ${
          selected
            ? "bg-gradient-to-br from-gray-900/90 via-gray-900 to-amber-950/20 border-amber-500/60 shadow-lg shadow-amber-900/10"
            : "glass-base border border-white/6 hover:border-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/10"
        } ${flash === "UP" ? "ring-2 ring-emerald-500/80" : flash === "DOWN" ? "ring-2 ring-rose-500/80" : ""}`}
      >
        {selected && (
          <div className="absolute top-0 right-0 bg-amber-500 text-black text-[9px] font-bold font-mono px-2 py-0.5 rounded-bl-lg uppercase tracking-wider">
            Selected for Scalp
          </div>
        )}

        <div className="flex items-center justify-between mb-1.5">
          <span className="font-bold text-slate-100 text-[11px]">{idx.symbol}</span>
          <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold font-mono border ${trend.cls}`}>
            {trend.label}
          </span>
        </div>

        <div className="flex items-baseline justify-between mb-1.5">
          <span className={`font-mono text-sm font-bold transition-colors ${flash === "UP" ? "text-emerald-400" : flash === "DOWN" ? "text-rose-400" : "text-slate-100"}`}>
            {formatPrice(d.ltp)}
          </span>
          <span className={`flex items-center gap-0.5 font-mono text-[10px] font-bold ${changeCls(stats.pointChange)}`}>
            {stats.pointChange >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {stats.pointChange >= 0 ? "+" : ""}{stats.pointChange.toFixed(2)} ({stats.pctChange >= 0 ? "+" : ""}{stats.pctChange.toFixed(2)}%)
          </span>
        </div>

        {/* Day-range bar: fill from LOW to current spot (green→yellow→red), marker at spot */}
        <div className="space-y-1 mb-1.5 bg-black/30 p-1.5 rounded-lg border border-white/5">
          <div className="flex justify-between text-[9px] font-mono text-slate-400">
            <span>Low: <strong className="text-slate-300">{formatPrice(d.low)}</strong></span>
            <span>High: <strong className="text-slate-300">{formatPrice(d.high)}</strong></span>
          </div>
          <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 h-full transition-all duration-300"
              style={{ width: `${stats.rangePct}%` }}
              title={`Spot ${formatPrice(d.ltp)} (${stats.rangePct.toFixed(0)}% of day range)`}
            />
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,1)]"
              style={{ left: `${stats.rangePct}%` }}
            />
          </div>
          <div className="flex justify-between text-[8px] font-mono text-slate-500">
            <span>O {formatPrice(d.open)}</span>
            <span>9EMA {formatPrice(d.ema9 || d.ltp)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between text-[9px] font-mono text-slate-500">
          <span className={stats.distFromEma >= 0 ? "text-emerald-400" : "text-rose-400"}>
            EMAΔ {stats.distFromEma >= 0 ? "+" : ""}{stats.distFromEma.toFixed(2)}
          </span>
          <span className="text-amber-400">ADX {d.adx3m.toFixed(1)}/{d.adx5m.toFixed(1)}</span>
        </div>
      </motion.div>
    );
  };

  return (
    <div className="glass-surface border border-white/6 rounded-2xl p-3 md:p-4 mb-3 w-full mx-auto max-w-[1400px]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 md:gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
            <span className="text-[9px] uppercase font-bold tracking-wider">Spot Tracker</span>
            {lastUpdate && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-black/30 border border-white/5 rounded">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                LIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500">
            <Clock className="h-3 w-3" />
            <span className="text-gray-300">
              {new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })} IST
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowAlertModal(!showAlertModal)}
            className="px-2.5 py-1.5 rounded-lg bg-black/30 hover:bg-black/50 border border-white/5 text-[10px] font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition"
          >
            <Bell className="w-3.5 h-3.5 text-amber-400" />
            Alerts ({alerts.filter((a) => !a.triggered).length})
          </button>

          <div className="flex items-center bg-black/30 p-0.5 rounded-lg border border-white/5">
            {([["GRID", Grid3X3], ["COMPACT", Rows3], ["DETAILED", Table2]] as const).map(([mode, Icon]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={mode}
                className={`px-2 py-1 rounded-md transition ${viewMode === mode ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Triggered alerts banner */}
      {alerts.some((a) => a.triggered) && (
        <div className="mt-2 p-2.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-300 text-[10px] font-mono flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-400 animate-bounce" />
            <strong>Price Alert Triggered!</strong>{" "}
            {alerts.filter((a) => a.triggered).map((a) => `${a.instrument} hit ${a.condition} ${a.targetPrice}`).join(" | ")}
          </span>
          <button
            onClick={() => setAlerts((prev) => prev.filter((a) => !a.triggered))}
            className="px-2 py-0.5 rounded bg-amber-900/60 hover:bg-amber-800 text-amber-200 text-[9px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Alert modal */}
      <AnimatePresence>
        {showAlertModal && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 p-3.5 rounded-xl bg-gray-900/90 border border-gray-800 space-y-3"
          >
            <div className="text-xs font-bold text-white font-mono flex items-center justify-between">
              <span>Set Custom Spot Price Alert</span>
              <button onClick={() => setShowAlertModal(false)} className="text-gray-400 hover:text-white text-xs">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={newAlertInst}
                onChange={(e) => setNewAlertInst(e.target.value)}
                className="bg-gray-950 text-white border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs font-mono"
              >
                {indices.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
              </select>
              <input
                type="number"
                placeholder="Target Spot Price"
                value={newAlertPrice}
                onChange={(e) => setNewAlertPrice(e.target.value)}
                className="bg-gray-950 text-white border border-gray-800 rounded-lg px-3 py-1.5 text-xs font-mono w-36 focus:outline-none focus:border-amber-500"
              />
              <button
                onClick={handleAddAlert}
                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs font-mono transition"
              >
                Add Alert
              </button>
            </div>
            {alerts.length > 0 && (
              <div className="text-[11px] font-mono text-gray-400 space-y-1">
                <div className="text-gray-300 font-semibold">Active Alerts:</div>
                <div className="flex flex-wrap gap-2">
                  {alerts.map((alt, i) => (
                    <span key={i} className="px-2 py-0.5 rounded bg-gray-950 border border-gray-800 text-gray-300 flex items-center gap-1.5">
                      {alt.instrument} {alt.condition} {alt.targetPrice}
                      <button onClick={() => setAlerts((prev) => prev.filter((_, idx) => idx !== i))} className="text-rose-400 hover:text-rose-300 ml-1">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* VIEW: GRID */}
      {viewMode === "GRID" && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5 mt-3">
          {indices.map((idx) => renderCard(idx))}
        </div>
      )}

      {/* VIEW: COMPACT ticker bar */}
      {viewMode === "COMPACT" && (
        <div className="mt-3 bg-black/30 border border-white/5 rounded-xl p-2 flex flex-wrap items-center justify-between gap-3">
          {indices.map((idx) => {
            const d = spotData[idx.symbol];
            if (!d || d.close === 0) return null;
            const stats = statsOf(d);
            const flash = priceFlashMap[idx.symbol];
            const selected = isSelected(idx.symbol);
            return (
              <div
                key={idx.symbol}
                onClick={() => selectInst(idx.symbol)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-all ${selected ? "bg-amber-500/10 border border-amber-500/40" : "hover:bg-gray-900 border border-transparent"}`}
              >
                <span className={`font-mono font-bold text-xs ${selected ? "text-amber-400" : "text-slate-200"}`}>{idx.symbol}</span>
                <span className={`font-mono text-xs font-semibold ${flash === "UP" ? "text-emerald-400" : flash === "DOWN" ? "text-rose-400" : "text-white"}`}>
                  {formatPrice(d.ltp)}
                </span>
                <span className={`font-mono text-[10px] ${changeCls(stats.pointChange)}`}>
                  {stats.pointChange >= 0 ? "+" : ""}{stats.pointChange.toFixed(2)} ({stats.pctChange >= 0 ? "+" : ""}{stats.pctChange.toFixed(2)}%)
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* VIEW: DETAILED analytics table */}
      {viewMode === "DETAILED" && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px] font-mono">
            <thead>
              <tr className="text-slate-400 border-b border-white/10 bg-black/30">
                <th className="py-2 px-3">Instrument</th>
                <th className="py-2 px-3">Live Spot</th>
                <th className="py-2 px-3">Day Change</th>
                <th className="py-2 px-3">Day High / Low</th>
                <th className="py-2 px-3">Open</th>
                <th className="py-2 px-3">9 EMA</th>
                <th className="py-2 px-3">EMA Offset</th>
                <th className="py-2 px-3">ADX (3M/5M)</th>
                <th className="py-2 px-3">Signal</th>
                <th className="py-2 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-slate-200">
              {indices.map((idx) => {
                const d = spotData[idx.symbol];
                if (!d || d.close === 0) return null;
                const stats = statsOf(d);
                const selected = isSelected(idx.symbol);
                const trend = trendOf(d);
                return (
                  <tr key={idx.symbol} onClick={() => selectInst(idx.symbol)} className={`hover:bg-white/5 cursor-pointer transition ${selected ? "bg-amber-950/20" : ""}`}>
                    <td className="py-2 px-3 font-bold text-white flex items-center gap-1.5">
                      {idx.symbol} {selected && <Check className="w-3.5 h-3.5 text-amber-400" />}
                    </td>
                    <td className="py-2 px-3 font-bold text-white">{formatPrice(d.ltp)}</td>
                    <td className={`py-2 px-3 font-semibold ${changeCls(stats.pointChange)}`}>
                      {stats.pointChange >= 0 ? "+" : ""}{stats.pointChange.toFixed(2)} ({stats.pctChange >= 0 ? "+" : ""}{stats.pctChange.toFixed(2)}%)
                    </td>
                    <td className="py-2 px-3 text-slate-400">{formatPrice(d.high)} / {formatPrice(d.low)}</td>
                    <td className="py-2 px-3 text-slate-400">{formatPrice(d.open)}</td>
                    <td className="py-2 px-3 text-slate-300">{formatPrice(d.ema9 || d.ltp)}</td>
                    <td className={`py-2 px-3 font-semibold ${changeCls(stats.distFromEma)}`}>
                      {stats.distFromEma >= 0 ? "+" : ""}{stats.distFromEma.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-amber-400">{d.adx3m.toFixed(1)} / {d.adx5m.toFixed(1)}</td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${trend.cls}`}>{trend.label}</span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); selectInst(idx.symbol); }}
                        className={`px-2.5 py-1 rounded text-[10px] font-bold transition ${selected ? "bg-amber-500 text-black" : "bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white"}`}
                      >
                        {selected ? "Active" : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
