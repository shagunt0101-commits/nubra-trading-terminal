import React, { useState } from "react";
import { Play, TrendingUp, TrendingDown, Target, ShieldAlert, Award, FileText, BarChart2 } from "lucide-react";
import { Instrument, BacktestResult } from "../types";

interface BacktesterProps {
  selectedInstrument: Instrument | null;
  selectedInterval: string;
}

export default function Backtester({ selectedInstrument, selectedInterval }: BacktesterProps) {
  const [strategy, setStrategy] = useState("sma_ema_cross");
  const [stopLoss, setStopLoss] = useState(1.5);
  const [target, setTarget] = useState(3.0);
  const [results, setResults] = useState<BacktestResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleRunBacktest = async () => {
    if (!selectedInstrument) return;
    setIsLoading(true);
    setError("");
    setResults(null);

    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedInstrument.stock_name,
          strategy,
          interval: selectedInterval,
          stopLossPercent: stopLoss,
          targetPercent: target,
          length: 180,
        }),
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setResults(data);
    } catch (err: any) {
      setError(err.message || "Failed to execute backtesting simulation.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg p-5 shadow-2xl flex flex-col h-[650px] overflow-hidden">
      {/* Header Controls */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 border-b border-brand-border pb-3 mb-4 bg-black/20">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-gray-400" />
          <h2 className="font-serif italic text-sm text-gray-400">Backtesting Engine</h2>
        </div>

        {selectedInstrument && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="bg-black border border-brand-border text-xs text-white rounded px-2 py-1.5 focus:outline-none cursor-pointer font-mono"
            >
              <option value="sma_ema_cross">SMA / EMA Trend Follow</option>
              <option value="rsi_overbought_oversold">RSI Reversal Bounce</option>
              <option value="bollinger_band_reversal">Bollinger Bands Mean Reversal</option>
            </select>

            <button
              onClick={handleRunBacktest}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-black rounded text-xs font-semibold hover:bg-gray-100 cursor-pointer shadow-sm transition-all disabled:opacity-40"
            >
              <Play className="h-3 w-3 text-black" />
              {isLoading ? "Simulating..." : "Verify Strategy"}
            </button>
          </div>
        )}
      </div>

      {/* Result Workspace */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-4">
        {!selectedInstrument ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 text-xs text-center font-serif italic">
            <BarChart2 className="h-8 w-8 text-gray-700 mb-2 animate-pulse" />
            Pick an asset from the screener to start historical backtesting strategies.
          </div>
        ) : !results && !isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 text-xs text-center space-y-4">
            <FileText className="h-8 w-8 text-gray-700" />
            <p className="max-w-xs leading-relaxed font-serif italic">
              Verify trade success ratios, drawdowns, and returns for{" "}
              <span className="font-bold text-gray-300 not-italic">{selectedInstrument.stock_name}</span> using historical candles from Nubra.
            </p>

            {/* Parameter adjusters */}
            <div className="flex gap-4 max-w-sm bg-black p-3 rounded border border-brand-border text-left">
              <div>
                <label className="block text-[9px] uppercase font-bold text-gray-500 mb-1 tracking-wider font-mono">Stop-loss SL %</label>
                <input
                  type="number"
                  step="0.1"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(parseFloat(e.target.value))}
                  className="w-full bg-brand-card border border-brand-border rounded px-2 py-1 text-xs text-white font-mono focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[9px] uppercase font-bold text-gray-500 mb-1 tracking-wider font-mono">Take-Profit TP %</label>
                <input
                  type="number"
                  step="0.1"
                  value={target}
                  onChange={(e) => setTarget(parseFloat(e.target.value))}
                  className="w-full bg-brand-card border border-brand-border rounded px-2 py-1 text-xs text-white font-mono focus:outline-none"
                />
              </div>
            </div>

            <button
              onClick={handleRunBacktest}
              className="px-5 py-2.5 bg-white hover:bg-gray-100 text-black rounded font-bold text-xs shadow-md font-mono tracking-wider uppercase cursor-pointer transition-all"
            >
              Verify Strategy on Historical Dataset
            </button>
          </div>
        ) : isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 font-mono">
            <Play className="h-8 w-8 text-white animate-ping" />
            <p className="font-semibold text-white uppercase tracking-wider">Running quantitative verification...</p>
            <span className="text-[10px] text-gray-500 max-w-xs text-center font-serif italic">
              Processing {selectedInterval} interval candles, triggering SMA moving envelopes, and generating statistical return quotients.
            </span>
          </div>
        ) : error ? (
          <div className="p-4 bg-brand-red/10 border border-brand-red/20 text-brand-red rounded font-mono">
            {error}
          </div>
        ) : (
          /* Analysis results */
          <div className="space-y-4">
            {/* Summary Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-black p-3 rounded border border-brand-border">
                <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider font-mono">Cumulative Return</span>
                <span className={`block font-mono text-sm sm:text-base font-bold mt-1 ${results!.summary.totalPnl >= 0 ? "text-brand-green glow-green" : "text-brand-red glow-red"}`}>
                  {results!.summary.totalPnl >= 0 ? "+" : ""}₹{results!.summary.totalPnl.toLocaleString("en-IN")} ({results!.summary.returnPercent}%)
                </span>
              </div>

              <div className="bg-black p-3 rounded border border-brand-border">
                <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider font-mono">Trade Win Rate</span>
                <span className="block font-mono text-sm sm:text-base font-bold text-white mt-1">
                  {results!.summary.winRate}%
                </span>
              </div>

              <div className="bg-black p-3 rounded border border-brand-border">
                <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider font-mono">Total Trades</span>
                <span className="block font-mono text-sm sm:text-base font-bold text-gray-400 mt-1">
                  {results!.summary.totalTrades}
                </span>
              </div>

              <div className="bg-black p-3 rounded border border-brand-border">
                <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider font-mono">Profit Factor</span>
                <span className="block font-mono text-sm sm:text-base font-bold text-amber-400 mt-1">
                  {results!.summary.profitFactor}x
                </span>
              </div>
            </div>

            {/* Trades Ledger Table */}
            <div className="border border-brand-border rounded overflow-hidden">
              <table className="w-full text-left border-collapse text-[10px]">
                <thead>
                  <tr className="bg-black text-gray-400 uppercase font-mono tracking-wider font-semibold border-b border-brand-border">
                    <th className="p-2.5">ID</th>
                    <th className="p-2.5">Direction</th>
                    <th className="p-2.5">Entry Time</th>
                    <th className="p-2.5">Entry Price</th>
                    <th className="p-2.5">Exit Time</th>
                    <th className="p-2.5">Exit Price</th>
                    <th className="p-2.5">Qty</th>
                    <th className="p-2.5 text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border/40">
                  {results!.trades.slice(0, 15).map((tr) => {
                    const formatTs = (ts: number) => {
                      if (!ts) return "-";
                      const d = new Date(ts);
                      return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
                    };
                    return (
                      <tr key={tr.id} className="hover:bg-white/5 text-gray-300">
                        <td className="p-2.5 font-mono text-gray-500">#{tr.id}</td>
                        <td className="p-2.5">
                          <span className={`px-1.5 py-0.5 rounded font-bold font-mono text-[9px] ${
                            tr.side === "BUY" ? "bg-brand-green/10 text-brand-green" : "bg-brand-red/10 text-brand-red"
                          }`}>
                            {tr.side}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono text-gray-400">{formatTs(tr.entryTime)}</td>
                        <td className="p-2.5 font-mono">₹{tr.entryPrice.toFixed(2)}</td>
                        <td className="p-2.5 font-mono text-gray-400">{formatTs(tr.exitTime)}</td>
                        <td className="p-2.5 font-mono">₹{tr.exitPrice.toFixed(2)}</td>
                        <td className="p-2.5 font-mono">{tr.qty}</td>
                        <td className={`p-2.5 text-right font-bold font-mono ${tr.result === "WIN" ? "text-brand-green" : "text-brand-red"}`}>
                          {tr.pnl >= 0 ? "+" : ""}₹{tr.pnl.toLocaleString("en-IN")} ({tr.pnlPercent}%)
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {results!.trades.length > 15 && (
                <div className="bg-black p-2 text-center text-gray-500 text-[10px] font-mono border-t border-brand-border">
                  Showing top 15 trades out of {results!.trades.length} executed signals.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
