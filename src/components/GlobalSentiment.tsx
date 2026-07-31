import React, { useState, useEffect } from "react";
import { TrendingUp, TrendingDown, Minus, Globe, RefreshCw, Activity } from "lucide-react";

interface SentimentItem {
  key: string;
  name: string;
  category: string;
  price: number;
  change: number;
  changePct: number;
  sentiment: number;
  trend: string;
}

interface SentimentData {
  overall: number;
  groups: { indices: SentimentItem[]; commodities: SentimentItem[]; crypto: SentimentItem[] };
  updatedAt: string;
}

export default function GlobalSentiment() {
  const [data, setData] = useState<SentimentData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSentiment = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/global/sentiment");
      if (res.ok) setData(await res.json());
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => {
    fetchSentiment();
    const interval = setInterval(fetchSentiment, 120_000);
    return () => clearInterval(interval);
  }, []);

  const overallSentiment = data?.overall ?? 50;
  const overallTrend = overallSentiment > 60 ? "bullish" : overallSentiment < 40 ? "bearish" : "neutral";
  const overallColor = overallTrend === "bullish" ? "text-emerald-400" : overallTrend === "bearish" ? "text-rose-400" : "text-amber-400";

  return (
    <div className="glass-surface border border-brand-border rounded-xl flex flex-col shadow-2xl overflow-hidden glass-enter">
      {/* Header */}
      <div className="p-3 glass-base/50 border-b border-brand-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-indigo-400" />
          <h2 className="font-serif italic text-sm text-gray-200">Global Sentiment</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[11px] font-bold font-mono px-1.5 py-0.5 rounded border ${
            overallTrend === "bullish" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
            : overallTrend === "bearish" ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
            : "bg-amber-500/10 border-amber-500/20 text-amber-400"
          }`}>{overallTrend.toUpperCase()}</span>
          <button onClick={fetchSentiment} disabled={loading} className="p-1.5 rounded hover:bg-white/5 border border-brand-border text-slate-500 hover:text-white cursor-pointer transition-colors">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Overall Meter */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span>Bearish</span>
          <span className="text-xs font-bold font-mono text-white">{overallSentiment}</span>
          <span>Bullish</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              overallSentiment > 60 ? "bg-emerald-500" : overallSentiment < 40 ? "bg-rose-500" : "bg-amber-500"
            }`}
            style={{ width: `${overallSentiment}%` }}
          />
        </div>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {loading && !data ? (
          <div className="flex items-center justify-center py-8 text-slate-500 text-xs">
            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            Loading global data...
          </div>
        ) : !data ? (
          <div className="text-center py-8 text-slate-500 text-xs">Failed to load global sentiment.</div>
        ) : (
          <>
            {/* Indices */}
            <div>
              <h3 className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3" /> Indices
              </h3>
              <div className="space-y-1">
                {data.groups.indices.map(item => <Row key={item.key} item={item} />)}
              </div>
            </div>

            {/* Commodities */}
            <div>
              <h3 className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Activity className="h-3 w-3" /> Commodities
              </h3>
              <div className="space-y-1">
                {data.groups.commodities.map(item => <Row key={item.key} item={item} />)}
              </div>
            </div>

            {/* Crypto */}
            <div>
              <h3 className="text-[10px] font-bold text-purple-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Activity className="h-3 w-3" /> Crypto
              </h3>
              <div className="space-y-1">
                {data.groups.crypto.map(item => <Row key={item.key} item={item} />)}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="px-3 pb-2 text-[9px] text-slate-600 font-mono text-right">
        {data?.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : ""}
      </div>
    </div>
  );
}

function Row({ item }: { item: SentimentItem }) {
  const trendColor = item.trend === "bullish" ? "text-emerald-400" : item.trend === "bearish" ? "text-rose-400" : "text-amber-400";
  const trendBg = item.trend === "bullish" ? "bg-emerald-500" : item.trend === "bearish" ? "bg-rose-500" : "bg-amber-500";
  return (
    <div className="glass-surface-sm border border-brand-border p-2 rounded-lg flex items-center gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-slate-300 font-medium truncate">{item.name}</span>
      <span className="w-16 shrink-0 text-right font-mono text-white font-bold">{item.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <span className={`w-14 shrink-0 text-right font-mono font-bold ${item.change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
        {item.change >= 0 ? "+" : ""}{item.changePct.toFixed(2)}%
      </span>
      {/* Mini sentiment meter bar */}
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden min-w-[40px]">
        <div className={`h-full rounded-full ${trendBg}`} style={{ width: `${item.sentiment}%` }} />
      </div>
      {item.trend === "bullish" ? <TrendingUp className="h-3 w-3 shrink-0 text-emerald-400" /> :
       item.trend === "bearish" ? <TrendingDown className="h-3 w-3 shrink-0 text-rose-400" /> :
       <Minus className="h-3 w-3 shrink-0 text-amber-400" />}
    </div>
  );
}
