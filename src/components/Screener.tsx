import React, { useState, useMemo } from "react";
import { Search, Percent, TrendingUp, TrendingDown, RefreshCw, BarChart2, Layers, BookOpen } from "lucide-react";
import { Instrument } from "../types";

interface ScreenerProps {
  instruments: Instrument[];
  selectedInstrument: Instrument | null;
  onSelectInstrument: (inst: Instrument) => void;
  quotes: Record<number, { price: number; prev_close: number; change: number }>;
  onRefreshQuotes: () => void;
  isLoading: boolean;
  tradingMode: "EQ" | "FNO" | "NONE";
}

export default function Screener({
  instruments,
  selectedInstrument,
  onSelectInstrument,
  quotes,
  onRefreshQuotes,
  isLoading,
  tradingMode,
}: ScreenerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [fnoFilter, setFnoFilter] = useState<"ALL" | "INDEX" | "FUT" | "OPT">("ALL");

  // Build F&O underlyings list from broker data: unique assets that have FUT or OPT derivatives
  const fnoUnderlyings = React.useMemo(() => {
    const assetMap = new Map<string, { asset: string; exchange: string }>();
    for (const inst of instruments) {
      if (inst.derivative_type === "FUT" || inst.derivative_type === "OPT") {
        if (!assetMap.has(inst.asset)) {
          assetMap.set(inst.asset, { asset: inst.asset, exchange: inst.exchange });
        }
      }
    }
    // Ensure major indices are always present
    for (const idx of ["NIFTY", "BANKNIFTY", "SENSEX", "MIDCPNIFTY", "FINNIFTY"]) {
      if (!assetMap.has(idx)) assetMap.set(idx, { asset: idx, exchange: idx === "SENSEX" ? "BSE" : "NSE" });
    }
    return Array.from(assetMap.values()).sort((a, b) => a.asset.localeCompare(b.asset));
  }, [instruments]);

  // Filtering based on Active Workspace Mode
  const INDEX_ASSETS = ["NIFTY", "BANKNIFTY", "SENSEX", "MIDCPNIFTY", "FINNIFTY"];
  const handleSelectFnoAsset = (asset: string) => {
    // Indices should always use virtual instrument (stock-type) to show spot chart, not FUT
    if (!INDEX_ASSETS.includes(asset)) {
      let matchedInst = instruments.find((i) => i.asset === asset && i.derivative_type !== "OPT" && i.derivative_type !== "FUT");
      if (!matchedInst) {
        matchedInst = instruments.find((i) => i.asset === asset && i.derivative_type === "FUT");
      }
      if (matchedInst) {
        onSelectInstrument(matchedInst);
        return;
      }
    }
    const info = fnoUnderlyings.find(f => f.asset === asset);
    const exchange = info?.exchange || (asset === "SENSEX" ? "BSE" : "NSE");
    fetch(`/api/market/spot/${asset}?exchange=${exchange}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const spotPrice = d?.price || 0;
        onSelectInstrument({
          ref_id: 1500000,
          token: 1500000,
          stock_name: asset,
          asset,
          option_type: "N/A",
          strike_price: 0,
          lot_size: 50,
          exchange,
          derivative_type: "STOCK",
          tick_size: 5,
          underlying_prev_close: Math.round(spotPrice * 100),
          expiry: 0,
        });
      })
      .catch(() => {});
  };

  // On-demand price cache for F&O assets still showing as 0
  const [fallbackPrices, setFallbackPrices] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    if (tradingMode !== "FNO") return;
    const needFetch = fnoUnderlyings.filter(item => {
      const opt = instruments.find(i => i.asset === item.asset && i.derivative_type === "OPT");
      return !opt || !quotes[opt.ref_id];
    });
    for (const item of needFetch) {
      if (fallbackPrices[item.asset]) continue;
      const opt = instruments.find(i => i.asset === item.asset && i.derivative_type === "OPT");
      if (opt) {
        fetch(`/api/market/quote/${opt.ref_id}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.price) setFallbackPrices(p => ({ ...p, [item.asset]: d.price })); })
          .catch(() => {});
      } else {
        // No broker instrument at all (e.g. SENSEX) — use spot endpoint
        fetch(`/api/market/spot/${item.asset}?exchange=${item.exchange || 'NSE'}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.price) setFallbackPrices(p => ({ ...p, [item.asset]: d.price })); })
          .catch(() => {});
      }
    }
  }, [tradingMode, fnoUnderlyings, instruments, quotes]);

  if (tradingMode === "FNO") {
    const filteredFno = fnoUnderlyings.filter(item => {
      if (fnoFilter === "INDEX") return ["NIFTY","BANKNIFTY","SENSEX","MIDCPNIFTY","FINNIFTY"].includes(item.asset);
      if (fnoFilter === "FUT") return instruments.some(i => i.asset === item.asset && i.derivative_type === "FUT");
      return true;
    }).filter(item => item.asset.toUpperCase().includes(searchQuery.toUpperCase()));

    const showOptions = fnoFilter === "OPT" || (searchQuery.length >= 3 && (/\d/.test(searchQuery) || /CE|PE/i.test(searchQuery)));
    const matchedOptions = showOptions
      ? instruments.filter(inst => {
          if (inst.derivative_type !== "OPT") return false;
          const name = (inst.stock_name + " " + inst.asset).toUpperCase();
          return name.includes(searchQuery.toUpperCase().replace(/\s+/g, ''));
        }).slice(0, 50)
      : [];

    return (
      <div className="bg-brand-card border border-brand-border rounded-lg flex flex-col h-[650px] overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-brand-border bg-black/20 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-emerald-400" />
              <h2 className="font-serif italic text-sm text-gray-400">F&O Screener</h2>
            </div>
            <div className="flex gap-0.5 bg-black/60 rounded-lg p-0.5 border border-brand-border">
              {(["ALL","INDEX","FUT","OPT"] as const).map(f => (
                <button key={f} onClick={() => setFnoFilter(f)}
                  className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono cursor-pointer transition-all ${fnoFilter === f ? "bg-emerald-600 text-white shadow" : "text-gray-400 hover:text-white"}`}
                >{f}</button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
            <input
              type="text"
              placeholder={fnoFilter === "OPT" ? 'Search e.g. "NIFTY 24250 CE"...' : "Search ticker..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 bg-black border border-brand-border rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/20 font-sans"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-brand-border bg-black/10 p-2 space-y-1">
          {matchedOptions.length > 0 ? matchedOptions.map((opt) => {
            const isSelected = selectedInstrument?.ref_id === opt.ref_id;
            const strike = Math.round((opt.strike_price || 0) / 100);
            return (
              <div key={opt.ref_id} onClick={() => onSelectInstrument(opt)}
                className={`p-3 rounded transition-all duration-150 flex items-center justify-between cursor-pointer ${isSelected ? "bg-emerald-500/10 border border-emerald-500/40 text-white" : "hover:bg-white/[0.02] text-gray-300 border border-transparent"}`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-white tracking-tight">{opt.asset}</span>
                    <span className="text-[9px] px-1 bg-black border border-brand-border rounded font-mono">{opt.option_type}</span>
                    <span className="text-[9px] px-1 bg-black border border-brand-border rounded font-mono">{strike}</span>
                  </div>
                  <span className="text-[10px] text-gray-500 font-mono">
                    Exp: {opt.expiry?.toString().slice(0,4)}-{opt.expiry?.toString().slice(4,6)}-{opt.expiry?.toString().slice(6)} | Lot: {opt.lot_size}
                  </span>
                </div>
              </div>
            );
          }) : filteredFno.map((item) => {
            const isSelected = selectedInstrument?.asset === item.asset;
            const optInst = instruments.find((i) => i.asset === item.asset && i.derivative_type === "OPT");
            const quote = optInst ? (quotes[optInst.ref_id] || null) : null;
            const price = quote?.price ?? fallbackPrices[item.asset];
            const change = quote?.change ?? 0;

            return (
              <div
                key={item.asset}
                onClick={() => handleSelectFnoAsset(item.asset)}
                className={`p-3 rounded transition-all duration-150 flex items-center justify-between cursor-pointer ${
                  isSelected
                    ? "bg-emerald-500/10 border border-emerald-500/40 text-white"
                    : "hover:bg-white/[0.02] text-gray-300 border border-transparent"
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-white tracking-tight">{item.asset}</span>
                    <span className="text-[9px] px-1 bg-black border border-brand-border text-gray-400 rounded font-mono">F&O</span>
                  </div>
                </div>
                <div className="text-right space-y-0.5">
                  {price != null ? (
                    <>
                      <span className="block font-mono text-xs font-bold text-white">
                        ₹{price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      {change !== 0 && (
                        <div className={`flex items-center justify-end text-[10px] font-semibold font-mono ${change >= 0 ? "text-brand-green" : "text-brand-red"}`}>
                          {change >= 0 ? "+" : ""}{(change * 100).toFixed(2)}%
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-[9px] text-slate-500">Loading...</span>
                  )}
                </div>
              </div>
            );
          })}
          {!matchedOptions.length && !filteredFno.length && (
            <div className="p-8 text-center text-gray-500 text-xs font-serif italic">No results found.</div>
          )}
        </div>
      </div>
    );
  }

  // Cash Equity Segment Mode (STOCKS EQ)
  const filteredInstruments = instruments.filter((inst) => {
    // Only cash equity segment
    if (inst.derivative_type !== "STOCK") return false;

    const matchesSearch =
      inst.stock_name.toUpperCase().includes(searchQuery.toUpperCase()) ||
      inst.asset.toUpperCase().includes(searchQuery.toUpperCase());

    return matchesSearch;
  });

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg flex flex-col h-[650px] overflow-hidden shadow-2xl">
      {/* Search and Filters Header */}
      <div className="p-4 border-b border-brand-border bg-black/20 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-indigo-400" />
            <h2 className="font-serif italic text-sm text-gray-400">Cash Equity Spot</h2>
          </div>
          <button
            onClick={onRefreshQuotes}
            disabled={isLoading}
            className="p-1.5 bg-black hover:bg-white/5 disabled:opacity-50 text-gray-300 rounded border border-brand-border transition-colors cursor-pointer"
            title="Refresh Quotes"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search stock ticker..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-1.5 bg-black border border-brand-border rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/20 font-sans"
          />
        </div>
      </div>

      {/* Screener list */}
      <div className="flex-1 overflow-y-auto divide-y divide-brand-border bg-black/10 p-2 space-y-1">
        {filteredInstruments.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-xs font-serif italic">
            No equity instruments found.
          </div>
        ) : (
          filteredInstruments.map((inst) => {
            const quote = quotes[inst.ref_id];
            const isSelected = selectedInstrument?.ref_id === inst.ref_id;
            const price = quote?.price ?? (inst.underlying_prev_close > 0 ? inst.underlying_prev_close / 100 : undefined);
            const change = quote?.change ?? 0;

            return (
              <div
                key={inst.ref_id}
                onClick={() => onSelectInstrument(inst)}
                className={`p-3 rounded transition-all duration-150 flex items-center justify-between cursor-pointer ${
                  isSelected
                    ? "bg-indigo-500/10 border border-indigo-500/40 text-white"
                    : "hover:bg-white/[0.02] text-gray-300 border border-transparent"
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-white tracking-tight">
                      {inst.stock_name}
                    </span>
                    <span className="text-[9px] px-1 bg-black border border-brand-border text-gray-400 rounded font-mono">
                      {inst.exchange}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 font-mono">
                      Equity Segment
                    </span>
                    {isSelected && (
                      <span className="text-[9px] px-1 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded font-semibold animate-fade-in">
                        Selected
                      </span>
                    )}
                  </div>
                </div>

                {/* Price indicators */}
                <div className="text-right space-y-0.5">
                  {price != null ? (
                    <span className="block font-mono text-xs font-bold text-white">
                      ₹{price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  ) : (
                    <span className="text-[9px] text-slate-500">Loading...</span>
                  )}
                  <div className={`flex items-center justify-end text-[10px] font-semibold font-mono ${
                    change >= 0 ? "text-brand-green" : "text-brand-red"
                  }`}>
                    {change >= 0 ? "+" : ""}
                    {(change * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
