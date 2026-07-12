import React, { useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { LineChart, BarChart } from "lucide-react";
import { ChartDataPoint, Instrument } from "../types";
import { useMarketData } from "../context/MarketDataContext";

interface MarketChartProps {
  chartData?: ChartDataPoint[];
  instrument?: Instrument | null;
  selectedInterval: string;
  onChangeInterval: (interval: string) => void;
}

export default function MarketChart({
  chartData: propChartData,
  instrument: propInstrument,
  selectedInterval,
  onChangeInterval,
}: MarketChartProps) {
  const { selectedInstrument, chartData: ctxChartData } = useMarketData();
  const instrument = propInstrument !== undefined ? propInstrument : selectedInstrument;
  const chartData = propChartData && propChartData.length > 0 ? propChartData : ctxChartData;

  const [showSMA, setShowSMA] = useState(true);
  const [showEMA, setShowEMA] = useState(true);
  const [showBB, setShowBB] = useState(false);
  const [indicatorPanel, setIndicatorPanel] = useState<"RSI" | "MACD">("RSI");

  const intervals = ["1m", "5m", "15m", "30m", "1h", "1d"];

  if (!instrument) {
    return (
      <div className="bg-brand-card border border-brand-border rounded-lg p-12 text-center text-gray-500 h-[650px] flex flex-col justify-center items-center shadow-2xl">
        <LineChart className="h-10 w-10 text-gray-700 mb-2 animate-pulse" />
        <span className="font-serif italic text-white/90 text-sm mb-1">Interactive Charts Offline</span>
        <span className="text-[10px] text-gray-500 max-w-xs font-mono">Select an asset from the screener to view live charts and indicator grids.</span>
      </div>
    );
  }

  const latestPrice = chartData[chartData.length - 1]?.close || 0;
  const prevPrice = chartData[0]?.close || 0;
  const changePct = prevPrice > 0 ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg flex flex-col h-[650px] overflow-hidden shadow-2xl">
      {/* Chart Control Toolbar */}
      <div className="p-4 border-b border-brand-border bg-black/20 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="font-serif italic text-base">{instrument.stock_name}</span>
              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                changePct >= 0 
                  ? "bg-brand-green/10 text-brand-green glow-green" 
                  : "bg-brand-red/10 text-brand-red glow-red"
              }`}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            </h3>
            <span className="block text-[10px] text-gray-500 font-mono mt-0.5">
              Last LTP: ₹{latestPrice.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {/* Filters/Interval Select */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Intervals */}
          <div className="flex bg-black p-0.5 rounded border border-brand-border text-[10px] font-semibold">
            {intervals.map((int) => (
              <button
                key={int}
                onClick={() => onChangeInterval(int)}
                className={`px-2 py-0.5 rounded transition-all duration-150 cursor-pointer ${
                  selectedInterval === int
                    ? "bg-white text-black font-bold shadow"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {int}
              </button>
            ))}
          </div>

          {/* Indicators toggles */}
          <div className="flex bg-black p-0.5 rounded border border-brand-border text-[10px] font-semibold">
            <button
              onClick={() => setShowSMA(!showSMA)}
              className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                showSMA ? "bg-white/10 text-white font-bold" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              SMA
            </button>
            <button
              onClick={() => setShowEMA(!showEMA)}
              className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                showEMA ? "bg-white/10 text-brand-green font-bold" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              EMA
            </button>
            <button
              onClick={() => setShowBB(!showBB)}
              className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                showBB ? "bg-white/10 text-purple-400 font-bold" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              Bands
            </button>
          </div>

          {/* Primary Indicator Panel toggle */}
          <div className="flex bg-black p-0.5 rounded border border-brand-border text-[10px] font-semibold">
            <button
              onClick={() => setIndicatorPanel("RSI")}
              className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                indicatorPanel === "RSI" ? "bg-white/10 text-white font-bold" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              RSI
            </button>
            <button
              onClick={() => setIndicatorPanel("MACD")}
              className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                indicatorPanel === "MACD" ? "bg-white/10 text-white font-bold" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              MACD
            </button>
          </div>
        </div>
      </div>

      {/* Main Charts area */}
      <div className="flex-1 flex flex-col p-4 space-y-4">
        {/* Main Candle chart */}
        <div className="flex-1 min-h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorBB" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.06} />
                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="ts"
                tickFormatter={(val) => {
                  const d = new Date(val);
                  return selectedInterval === "1d"
                    ? d.toLocaleDateString("en-IN", { month: "short", day: "numeric" })
                    : d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "numeric", hour12: false });
                }}
                stroke="#475569"
                fontSize={9}
                fontFamily="monospace"
              />
              <YAxis
                domain={["auto", "auto"]}
                stroke="#475569"
                fontSize={9}
                fontFamily="monospace"
                tickFormatter={(val) => val.toFixed(1)}
              />
              <Tooltip
                contentStyle={{ backgroundColor: "#050505", borderColor: "rgba(255,255,255,0.08)", borderRadius: "4px" }}
                labelFormatter={(label) => new Date(label).toLocaleString()}
                formatter={(val: any, name: string) => {
                  const labels: Record<string, string> = { open: "Open", high: "High", low: "Low", close: "Close" };
                  return [val.toFixed(2), labels[name] || name];
                }}
                itemStyle={{ fontSize: "11px", color: "#fff" }}
              />

              {/* Candle line (close price) with colored area — keeps visual while providing chart scale */}
              <Area type="monotone" dataKey="close" stroke="#00ff9d" strokeWidth={0.8} fill="rgba(0,255,157,0.08)" dot={false} />

              {showBB && (
                <Area type="monotone" dataKey="bbUpper" stroke="#a855f7" strokeWidth={0.5} strokeDasharray="4 4" fill="url(#colorBB)" />
              )}
              {showBB && (
                <Line type="monotone" dataKey="bbLower" stroke="#a855f7" strokeWidth={0.5} strokeDasharray="4 4" dot={false} />
              )}

              {showSMA && <Line type="monotone" dataKey="sma20" stroke="#3b82f6" strokeWidth={1.2} dot={false} />}
              {showEMA && <Line type="monotone" dataKey="ema50" stroke="#00ff9d" strokeWidth={1.2} dot={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Secondary Indicator Panel */}
        <div className="h-[120px] border-t border-brand-border pt-3">
          <span className="block text-[9px] uppercase font-bold text-gray-500 tracking-wider mb-2 font-mono">
            {indicatorPanel === "RSI" ? "RSI (14) - Oscillator" : "MACD (12, 26, 9) - Convergence Divergence"}
          </span>
          <ResponsiveContainer width="100%" height="100%">
            {indicatorPanel === "RSI" ? (
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="ts" hide />
                <YAxis domain={[0, 100]} stroke="#475569" fontSize={8} fontFamily="monospace" ticks={[30, 50, 70]} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#050505", borderColor: "rgba(255,255,255,0.08)", borderRadius: "4px" }}
                  itemStyle={{ fontSize: "10px", color: "#fff" }}
                />
                <Line type="monotone" dataKey="rsi14" stroke="#00ff9d" strokeWidth={1.5} dot={false} />
                {/* Horizontal reference bands */}
                <Line type="monotone" dataKey={() => 70} stroke="#ff4b4b" strokeWidth={1} strokeDasharray="3 3" dot={false} />
                <Line type="monotone" dataKey={() => 30} stroke="#00ff9d" strokeWidth={1} strokeDasharray="3 3" dot={false} />
              </ComposedChart>
            ) : (
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="ts" hide />
                <YAxis stroke="#475569" fontSize={8} fontFamily="monospace" />
                <Tooltip
                  contentStyle={{ backgroundColor: "#050505", borderColor: "rgba(255,255,255,0.08)", borderRadius: "4px" }}
                  itemStyle={{ fontSize: "10px", color: "#fff" }}
                />
                <Bar dataKey="macdHist" fill="#3b82f6" radius={[1, 1, 0, 0]} />
                <Line type="monotone" dataKey="macdLine" stroke="#ff4b4b" strokeWidth={1.2} dot={false} />
                <Line type="monotone" dataKey="signalLine" stroke="#f59e0b" strokeWidth={1.2} dot={false} />
              </ComposedChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
