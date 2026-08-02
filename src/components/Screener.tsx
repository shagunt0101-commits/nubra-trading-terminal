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
  // WS broadcasts indices under synthetic refs 1001-1005 (server WS_INDEX_MAP)
  const WS_INDEX_REFS: Record<string, number> = { NIFTY: 1001, BANKNIFTY: 1002, SENSEX: 1003, MIDCPNIFTY: 1004, FINNIFTY: 1005 };
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

  // On-demand price cache for F&O assets still showing as 0. Paced single-flight
  // queue (2 req/s, 600ms min gap): the broker rate-limits ~3/s sustained —
  // anything faster 429s every route for 30s+ (verified). Failed fetches stay
  // unmarked and retry on a later effect run. Queue lives in a ref so state
  // updates never rebuild/duplicate it.
  const [fallbackPrices, setFallbackPrices] = React.useState<Record<string, number>>({});
  const fetchedRef = React.useRef<Set<string>>(new Set());
  const queueRef = React.useRef<string[]>([]);
  const runningRef = React.useRef(false);
  const lastFetchRef = React.useRef(0);
  const pumpRef = React.useRef<() => void>(() => {});
  pumpRef.current = () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const next = () => {
      if (queueRef.current.length === 0) { runningRef.current = false; return; }
      const wait = Math.max(0, lastFetchRef.current + 600 - Date.now());
      setTimeout(() => {
        const item = queueRef.current.shift()!;
        lastFetchRef.current = Date.now();
        fetch(`/api/market/spot/${item}?exchange=NSE`)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.price) setFallbackPrices(p => ({ ...p, [item]: d.price })); })
          .catch(() => {})
          .finally(() => { setTimeout(next, 600); });
      }, wait);
    };
    next();
  };
  React.useEffect(() => {
    if (tradingMode !== "FNO") return;
    for (const item of fnoUnderlyings) {
      if (fetchedRef.current.has(item.asset)) continue;
      if (fallbackPrices[item.asset] != null) continue;
      if (INDEX_ASSETS.includes(item.asset) && quotes[WS_INDEX_REFS[item.asset]]) continue; // index broadcast live
      fetchedRef.current.add(item.asset);
      if (!queueRef.current.includes(item.asset)) queueRef.current.push(item.asset);
    }
    pumpRef.current();
  }, [tradingMode, instruments, isLoading, fallbackPrices]); // re-run when instruments arrive / fallback completes

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
      <div className="glass-surface border border-brand-border rounded-xl flex flex-col h-[650px] overflow-hidden shadow-2xl glass-enter">
        <div className="p-3 border-b border-brand-border glass-base/50 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Layers className="h-4.5 w-4.5 text-emerald-400" />
              <h2 className="font-serif italic text-base text-gray-200 tracking-tight">F&O Screener</h2>
            </div>
            <div className="flex gap-1 glass-base rounded-lg p-0.5 border border-brand-border">
              {(["ALL","INDEX","FUT","OPT"] as const).map(f => (
                <button key={f} onClick={() => setFnoFilter(f)}
                  className={`px-3 py-1.5 rounded text-xs font-bold font-mono cursor-pointer transition-all ${fnoFilter === f ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20" : "text-gray-400 hover:text-white hover:bg-white/5"}`}
                >{f}</button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              placeholder={fnoFilter === "OPT" ? 'Search e.g. "NIFTY 24250 CE"...' : "Search ticker..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 bg-black/60 border border-brand-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/30 focus:bg-black/80 font-sans transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-brand-border bg-black/5 p-3 space-y-2">
          {matchedOptions.length > 0 ? matchedOptions.map((opt) => {
            const isSelected = selectedInstrument?.ref_id === opt.ref_id;
            const strike = Math.round((opt.strike_price || 0) / 100);
            return (
              <div className={`p-3 rounded-lg transition-all duration-150 flex items-center justify-between cursor-pointer glass-surface-sm ${isSelected ? "bg-emerald-500/10 border border-emerald-500/40 text-white" : "hover:bg-white/[0.03] text-gray-300 border border-transparent"}`}>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white tracking-tight">{opt.asset}</span>
                    <span className="text-xs px-1.5 bg-black border border-brand-border rounded font-mono">{opt.option_type}</span>
                    <span className="text-xs px-1.5 bg-black border border-brand-border rounded font-mono">{strike}</span>
                  </div>
                  <span className="text-xs text-gray-500 font-mono">
                    Exp: {opt.expiry?.toString().slice(0,4)}-{opt.expiry?.toString().slice(4,6)}-{opt.expiry?.toString().slice(6)} | Lot: {opt.lot_size}
                  </span>
                </div>
              </div>
            );
          }) : filteredFno.map((item) => {
            const isSelected = selectedInstrument?.asset === item.asset;
            const wsQuote = WS_INDEX_REFS[item.asset] ? (quotes[WS_INDEX_REFS[item.asset]] || null) : null;
            // FUT/OPT assets use their option contract's LTP (units = premium) only
            // when it's genuinely the option stream; stocks (no broadcast) resolve
            // via fallbackPrices fetched from the spot route (units = rupees).
            const optInst = instruments.find((i) => i.asset === item.asset && i.derivative_type === "OPT");
            const optQuote = wsQuote ? null : (optInst ? (quotes[optInst.ref_id] || null) : null);
            const quote = wsQuote || optQuote;
            const price = (quote && quote.price > 0) ? quote.price : fallbackPrices[item.asset];
            const change = quote?.change ?? 0;

            return (
              <div
                key={item.asset}
                onClick={() => handleSelectFnoAsset(item.asset)}
                className={`p-3 rounded-lg transition-all duration-150 flex items-center justify-between cursor-pointer glass-surface-sm ${
                  isSelected
                    ? "bg-emerald-500/10 border border-emerald-500/40 text-white"
                    : "hover:bg-white/[0.03] text-gray-300 border border-transparent"
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white tracking-tight">{item.asset}</span>
                    <span className="text-xs px-2 bg-black/40 border border-brand-border text-gray-400 rounded font-mono">F&O</span>
                  </div>
                </div>
                <div className="text-right space-y-0.5">
                  {price != null ? (
                    <>
                      <span className="block font-mono text-sm font-bold text-white">
                        ₹{price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      {change !== 0 && (
                        <div className={`flex items-center justify-end text-xs font-semibold font-mono ${change >= 0 ? "text-brand-green" : "text-brand-red"}`}>
                          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">N/A</span>
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
    <div className="glass-surface border border-brand-border rounded-xl flex flex-col h-[650px] overflow-hidden shadow-2xl glass-enter">
      {/* Search and Filters Header */}
      <div className="p-3 border-b border-brand-border glass-base/50 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BookOpen className="h-4.5 w-4.5 text-indigo-400" />
            <h2 className="font-serif italic text-base text-gray-200 tracking-tight">Cash Equity Spot</h2>
          </div>
          <button
            onClick={onRefreshQuotes}
            disabled={isLoading}
            className="p-2 bg-black/60 hover:bg-white/5 disabled:opacity-50 text-gray-300 rounded-lg border border-brand-border transition-colors cursor-pointer"
            title="Refresh Quotes"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search stock ticker..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-black/60 border border-brand-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/30 focus:bg-black/80 font-sans transition-all"
          />
        </div>
      </div>

      {/* Screener list */}
      <div className="flex-1 overflow-y-auto divide-y divide-brand-border bg-black/5 p-3 space-y-2">
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
                className={`p-3 rounded-lg transition-all duration-150 flex items-center justify-between cursor-pointer glass-surface-sm ${
                  isSelected
                    ? "bg-indigo-500/10 border border-indigo-500/40 text-white"
                    : "hover:bg-white/[0.03] text-gray-300 border border-transparent"
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white tracking-tight">
                      {inst.stock_name}
                    </span>
                    <span className="text-xs px-2 bg-black/40 border border-brand-border text-gray-400 rounded font-mono">
                      {inst.exchange}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 font-mono">
                      Equity Segment
                    </span>
                    {isSelected && (
                      <span className="text-xs px-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded font-semibold animate-fade-in">
                        Selected
                      </span>
                    )}
                  </div>
                </div>

                {/* Price indicators */}
                <div className="text-right space-y-0.5">
                  {price != null ? (
                    <span className="block font-mono text-sm font-bold text-white">
                      ₹{price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">N/A</span>
                  )}
                  <div className={`flex items-center justify-end text-xs font-semibold font-mono ${
                    change >= 0 ? "text-brand-green" : "text-brand-red"
                  }`}>
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(2)}%
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
