import React, { useState, useEffect, useMemo } from "react";
import { 
  Eye, 
  EyeOff, 
  Layers, 
  Flame, 
  Grid, 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  Info, 
  CheckCircle,
  HelpCircle,
  RefreshCw,
  SlidersHorizontal
} from "lucide-react";
import { Instrument } from "../types";
import { formatPercentageChangeNum, calculateOiChangePercentage } from "../utils/chgCalc";
import { useMarketData } from "../context/MarketDataContext";

interface OptionsWorkspaceProps {
  instrument?: Instrument | null;
  onPrefillOrder: (params: any) => void;
  onChainDataLoaded?: (chain: any) => void;
}

interface OptionContract {
  ref_id: number;
  sp: number; // paise
  ls: number;
  ltp: number; // paise
  oi: number;
  delta: number;
  iv: number;
  volume?: number;
  change?: number; // percent
  ltpchg?: number;
  price_pcp?: number;
  prev_oi?: number;
  oi_change_pct?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
}

export default function OptionsWorkspace({ instrument: propInstrument, onPrefillOrder, onChainDataLoaded }: OptionsWorkspaceProps) {
  const { selectedInstrument, setOptionChainData: setCtxOptionChainData } = useMarketData();
  const instrument = propInstrument !== undefined ? propInstrument : selectedInstrument;

  const [activeTab, setActiveTab] = useState<"CHAIN" | "STRATEGIES" | "HEATMAP" | "SHOCKERS">("CHAIN");
  const [showGreeks, setShowGreeks] = useState(false);
  const [strikeFocus, setStrikeFocus] = useState<"ATM" | "WIDE" | "ALL">("ATM");
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [chainData, setChainData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [heatmapMetric, setHeatmapMetric] = useState<"OI" | "CHANGE" | "VOLUME">("CHANGE");
  const [strategyLegs, setStrategyLegs] = useState<any[]>([]);

  // Bubble up chainData to parent and context when fetched or updated
  useEffect(() => {
    if (chainData) {
      setCtxOptionChainData(chainData);
      if (onChainDataLoaded) {
        onChainDataLoaded(chainData);
      }
    }
  }, [chainData, onChainDataLoaded, setCtxOptionChainData]);

  const [selectedStrategy, setSelectedStrategy] = useState<string>("");
  const [deploySuccess, setDeploySuccess] = useState<string | null>(null);

  // Active Symbol determination
  const activeSymbol = instrument?.asset || "NIFTY";

  // Fetch Option Chain data
  const fetchOptionChain = async () => {
    setIsLoading(true);
    try {
      const expiryQuery = selectedExpiry ? `?expiry=${selectedExpiry}` : "";
      const res = await fetch(`/api/market/optionchain/${activeSymbol}${expiryQuery}`);
      if (res.ok) {
        const data = await res.json();
        setChainData(data.chain);
        if (data.chain.all_expiries && data.chain.all_expiries.length > 0 && !selectedExpiry) {
          setSelectedExpiry(data.chain.all_expiries[0]);
        }
      }
    } catch (err) {
      console.error("Error fetching option chain:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOptionChain();
  }, [activeSymbol, selectedExpiry]);

  // Format Helper
  const formatLtp = (paise: number) => (paise / 100).toFixed(2);
  const formatOi = (oi?: number) => {
    if (oi === undefined || oi === null || isNaN(oi)) return "0";
    if (oi >= 100000) return `${(oi / 100000).toFixed(1)}L`;
    if (oi >= 1000) return `${(oi / 1000).toFixed(1)}K`;
    return oi.toString();
  };
  const formatVol = (vol?: number) => {
    if (!vol) return "1.2L";
    if (vol >= 1000000) return `${(vol / 1000000).toFixed(1)}M`;
    if (vol >= 100000) return `${(vol / 100000).toFixed(1)}L`;
    return vol.toLocaleString();
  };
  const formatIv = (iv?: number) => {
    if (iv === undefined || iv === null || isNaN(iv)) return "14.5";
    let val = iv;
    if (val > 1000) val = val / 100;
    else if (val <= 2 && val > 0) val = val * 100;
    return val.toFixed(1);
  };
  const formatChg = (chg?: number) => {
    if (chg === undefined || chg === null || isNaN(chg)) return 0;
    let pct = chg;
    if (Math.abs(chg) <= 1) {
      pct = chg * 100;
    }
    return Number(pct.toFixed(2));
  };

  // Strategies presets
  const strategies = useMemo(() => [
    {
      id: "bull_call",
      name: "Bull Call Spread",
      description: "Capitalize on moderate upward movement with limited risk. Buy ATM Call & Sell OTM Call.",
      legs: (atm: number, step: number) => [
        { type: "BUY", opt: "CE", strike: atm, qty: 1, name: "Long ATM Call" },
        { type: "SELL", opt: "CE", strike: atm + step, qty: 1, name: "Short OTM Call" },
      ]
    },
    {
      id: "bear_put",
      name: "Bear Put Spread",
      description: "Capitalize on moderate downward movement with limited risk. Buy ATM Put & Sell OTM Put.",
      legs: (atm: number, step: number) => [
        { type: "BUY", opt: "PE", strike: atm, qty: 1, name: "Long ATM Put" },
        { type: "SELL", opt: "PE", strike: atm - step, qty: 1, name: "Short OTM Put" },
      ]
    },
    {
      id: "long_straddle",
      name: "Long Straddle",
      description: "Profit from massive volatility breakout in either direction. Buy ATM Call & Buy ATM Put.",
      legs: (atm: number, step: number) => [
        { type: "BUY", opt: "CE", strike: atm, qty: 1, name: "Long ATM Call" },
        { type: "BUY", opt: "PE", strike: atm, qty: 1, name: "Long ATM Put" },
      ]
    },
    {
      id: "short_strangle",
      name: "Short Strangle",
      description: "Income generation from range-bound non-volatile markets. Sell OTM Call & Sell OTM Put.",
      legs: (atm: number, step: number) => [
        { type: "SELL", opt: "CE", strike: atm + step, qty: 1, name: "Short OTM Call" },
        { type: "SELL", opt: "PE", strike: atm - step, qty: 1, name: "Short OTM Put" },
      ]
    },
    {
      id: "iron_condor",
      name: "Iron Condor",
      description: "Premium decay collection with strictly defined protection wings. Multi-leg credit strategy.",
      legs: (atm: number, step: number) => [
        { type: "BUY", opt: "PE", strike: atm - step * 2, qty: 1, name: "Long Put Wing" },
        { type: "SELL", opt: "PE", strike: atm - step, qty: 1, name: "Short Put" },
        { type: "SELL", opt: "CE", strike: atm + step, qty: 1, name: "Short Call" },
        { type: "BUY", opt: "CE", strike: atm + step * 2, qty: 1, name: "Long Call Wing" },
      ]
    }
  ], []);

  // Generate strategy preview when active strategy changes
  useEffect(() => {
    if (!selectedStrategy || !chainData) {
      setStrategyLegs([]);
      return;
    }
    const ceList = chainData.ce || [];
    const step = ceList.length > 1 ? Math.abs(Math.round((ceList[1].sp - ceList[0].sp) / 100)) : (activeSymbol === "BANKNIFTY" || activeSymbol === "FINNIFTY" ? 100 : 50);
    const rawSpot_val = chainData.spot ?? chainData.cp ?? chainData.atm;
    const atmInRupees = (rawSpot_val && rawSpot_val > 0 ? rawSpot_val : 2421100) / 100;
    const atmPrice = Math.round(atmInRupees / step) * step;
    const strat = strategies.find(s => s.id === selectedStrategy);
    if (strat) {
      setStrategyLegs(strat.legs(atmPrice, step));
    }
  }, [selectedStrategy, chainData]);

  // Derive lot size from actual option chain data
  const chainLotSize = useMemo(() => {
    const list = chainData?.ce || chainData?.pe || [];
    return list.length > 0 ? (list[0].ls || 50) : (instrument?.lot_size || 50);
  }, [chainData, instrument]);

  // Execute strategy in single execution
  const handleDeployStrategy = async () => {
    if (strategyLegs.length === 0) return;
    try {
      const orderPayload = {
        isMultiLeg: true,
        qty: chainLotSize,
        side: "BUY", // Net strategy posture
        deliveryType: "IDAY",
        priceType: "LIMIT",
        validityType: "DAY",
        entryPrice: "0", // Market execution / calculated net debit
        legs: strategyLegs.map(leg => ({
          optionType: leg.opt,
          strikePrice: leg.strike,
          action: leg.type,
          quantity: chainLotSize * leg.qty,
          asset: activeSymbol,
        })),
        stratTags: ["strategy-builder", selectedStrategy]
      };

      const res = await fetch("/api/orders/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderPayload)
      });
      if (res.ok) {
        setDeploySuccess(`Successfully deployed ${strategies.find(s => s.id === selectedStrategy)?.name}! Sent ${strategyLegs.length} orders directly to execution.`);
        setTimeout(() => setDeploySuccess(null), 5000);
      }
    } catch (_) {
      console.error("Deploy failed");
    }
  };

  const rawSpot = chainData ? (chainData.spot ?? chainData.cp ?? chainData.atm) : null;
  // cp can be 0 for BSE/SENSEX — treat as missing
  const validSpot = rawSpot && rawSpot > 0 ? rawSpot : null;
  const atmPrice = validSpot ? Math.round(validSpot / 100) : null;

  // Heatmap rendering list showing all strikes with spot ± 7 strikes highlighted/focused
  const heatmapData = useMemo(() => {
    if (!chainData) return [];
    const ceList = chainData.ce || [];
    const peList = chainData.pe || [];
    if (ceList.length === 0) return [];

    const atm = atmPrice || Math.round((chainData.atm || 2421100) / 100);
    let closestIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < ceList.length; i++) {
      const strikePrice = Math.round(ceList[i].sp / 100);
      const diff = Math.abs(strikePrice - atm);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    const range = 7; // ± 7 strikes around spot
    const startIndex = Math.max(0, closestIndex - range);
    const endIndex = Math.min(ceList.length - 1, closestIndex + range);

    const strikes = [];
    for (let i = 0; i < ceList.length; i++) {
      const strikePrice = Math.round(ceList[i].sp / 100);
      const isFocused = i >= startIndex && i <= endIndex;
      strikes.push({
        strike: strikePrice,
        ce: ceList[i],
        pe: peList[i] || { ref_id: ceList[i].ref_id + 50, sp: ceList[i].sp, ls: ceList[i].ls, ltp: 100, oi: 0, volume: 0, change: 0 },
        index: i,
        isFocused,
      });
    }
    return strikes;
  }, [chainData, atmPrice]);

  // Volume Shockers computation based strictly on broker data
  const volumeShockers = useMemo(() => {
    if (!chainData) return [];
    const items: any[] = [];
    const ceList: OptionContract[] = chainData.ce || [];
    const peList: OptionContract[] = chainData.pe || [];

    ceList.forEach((c) => {
      const vol = c.volume || 0;
      const rawChg = c.ltpchg !== undefined ? c.ltpchg : (c.change !== undefined ? c.change : (c.price_pcp !== undefined ? c.price_pcp : 0));
      const change = formatChg(rawChg);
      const oi = c.oi || 0;
      if (vol > 100000 || Math.abs(change) > 0.5) {
        items.push({
          option: `${activeSymbol} ${Math.round(c.sp / 100)} CE`,
          volume: vol,
          oi: oi,
          change: change,
          shockerType: vol > 1000000 ? "🔥 Volume Surge" : "⚡ Price-OI Divergence",
          ref_id: c.ref_id,
        });
      }
    });

    peList.forEach((p) => {
      const vol = p.volume || 0;
      const rawChg = p.ltpchg !== undefined ? p.ltpchg : (p.change !== undefined ? p.change : (p.price_pcp !== undefined ? p.price_pcp : 0));
      const change = formatChg(rawChg);
      const oi = p.oi || 0;
      if (vol > 100000 || Math.abs(change) > 0.5) {
        items.push({
          option: `${activeSymbol} ${Math.round(p.sp / 100)} PE`,
          volume: vol,
          oi: oi,
          change: change,
          shockerType: vol > 1000000 ? "🔥 Volume Surge" : "⚡ Price-OI Divergence",
          ref_id: p.ref_id,
        });
      }
    });

    return items.sort((a, b) => b.volume - a.volume);
  }, [chainData, activeSymbol]);

  // Safe checks and ATM-focused filtering for rendering

  const filteredContracts = useMemo(() => {
    const rawCe = chainData?.ce || [];
    const rawPe = chainData?.pe || [];

    if (rawCe.length === 0 || !atmPrice || strikeFocus === "ALL") {
      return { ce: rawCe, pe: rawPe };
    }

    // Find the index of the strike closest to atmPrice
    let closestIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < rawCe.length; i++) {
      const strikePrice = Math.round(rawCe[i].sp / 100);
      const diff = Math.abs(strikePrice - atmPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    // Determine slice range based on focus mode
    const range = strikeFocus === "ATM" ? 4 : 8; // ±4 strikes (9 total) or ±8 strikes (17 total)
    const startIndex = Math.max(0, closestIndex - range);
    const endIndex = Math.min(rawCe.length - 1, closestIndex + range);

    return {
      ce: rawCe.slice(startIndex, endIndex + 1),
      pe: rawPe.slice(startIndex, endIndex + 1),
    };
  }, [chainData, atmPrice, strikeFocus]);

  const ceContracts = filteredContracts.ce;
  const peContracts = filteredContracts.pe;

  const analysisMetrics = useMemo(() => {
    const rawCe = chainData?.ce || [];
    const rawPe = chainData?.pe || [];
    if (rawCe.length === 0) return { support: null, resistance: null, maxPain: null };

    let maxCeOi = -1;
    let resistanceStrike = null;

    let maxPeOi = -1;
    let supportStrike = null;

    const strikesMap = new Map<number, { ceOi: number; peOi: number }>();

    for (let i = 0; i < rawCe.length; i++) {
      const c = rawCe[i];
      const strike = Math.round(c.sp / 100);
      const ceOi = c.oi || 0;
      if (ceOi > maxCeOi) {
        maxCeOi = ceOi;
        resistanceStrike = strike;
      }
      if (!strikesMap.has(strike)) strikesMap.set(strike, { ceOi, peOi: 0 });
      else strikesMap.get(strike)!.ceOi = ceOi;
    }

    for (let i = 0; i < rawPe.length; i++) {
      const p = rawPe[i];
      const strike = Math.round(p.sp / 100);
      const peOi = p.oi || 0;
      if (peOi > maxPeOi) {
        maxPeOi = peOi;
        supportStrike = strike;
      }
      if (!strikesMap.has(strike)) strikesMap.set(strike, { ceOi: 0, peOi });
      else strikesMap.get(strike)!.peOi = peOi;
    }

    let minPain = Infinity;
    let maxPainStrike = atmPrice;

    const allStrikes = Array.from(strikesMap.keys()).sort((a, b) => a - b);
    for (const testStrike of allStrikes) {
      let totalPain = 0;
      for (const [k, data] of strikesMap.entries()) {
        const cePain = Math.max(0, testStrike - k) * data.ceOi;
        const pePain = Math.max(0, k - testStrike) * data.peOi;
        totalPain += cePain + pePain;
      }
      if (totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = testStrike;
      }
    }

    return { support: supportStrike, resistance: resistanceStrike, maxPain: maxPainStrike };
  }, [chainData, atmPrice]);

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg flex flex-col h-[650px] overflow-hidden shadow-2xl">
      {/* Options Hub Tabs Header */}
      <div className="p-3 bg-black/35 border-b border-brand-border flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-indigo-400" />
          <h2 className="text-xs font-bold tracking-wider text-slate-200">
            F&O OPTIONS HUB: <span className="font-mono text-indigo-400 font-extrabold">{activeSymbol}</span>
          </h2>
        </div>

        {/* Tab Selection */}
        <div className="flex gap-1 bg-slate-900 border border-slate-800 p-0.5 rounded-lg text-[10px] font-semibold">
          <button
            onClick={() => setActiveTab("CHAIN")}
            className={`px-2 py-1 rounded transition-colors ${activeTab === "CHAIN" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            Option Chain
          </button>
          <button
            onClick={() => setActiveTab("STRATEGIES")}
            className={`px-2 py-1 rounded transition-colors ${activeTab === "STRATEGIES" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            Strategies
          </button>
          <button
            onClick={() => setActiveTab("HEATMAP")}
            className={`px-2 py-1 rounded transition-colors ${activeTab === "HEATMAP" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            Smart Heatmap
          </button>
          <button
            onClick={() => setActiveTab("SHOCKERS")}
            className={`px-2 py-1 rounded transition-colors ${activeTab === "SHOCKERS" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            Shockers
          </button>
        </div>
      </div>

      {/* Main Workspace Area */}
      <div className="flex-1 overflow-hidden flex flex-col relative bg-slate-950/80">
        
        {/* TAB 1: OPTION CHAIN */}
        {activeTab === "CHAIN" && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Chain Filters and Controls */}
            <div className="p-2 border-b border-slate-900 bg-slate-900/40 flex items-center justify-between gap-3 text-[10px] flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Expiry:</span>
                <select
                  value={selectedExpiry}
                  onChange={(e) => setSelectedExpiry(e.target.value)}
                  className="bg-black border border-slate-800 rounded px-1.5 py-0.5 text-white focus:outline-none"
                >
                  {chainData?.all_expiries?.map((ex: string) => (
                    <option key={ex} value={ex}>
                      {ex.slice(0, 4)}-{ex.slice(4, 6)}-{ex.slice(6)}
                    </option>
                  )) || <option>Loading...</option>}
                </select>

                <button
                  onClick={fetchOptionChain}
                  disabled={isLoading}
                  className="p-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded border border-slate-800 cursor-pointer"
                >
                  <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
                </button>
              </div>

              {/* ATM Strikes Focus Selector */}
              <div className="flex items-center gap-1 bg-slate-950/80 p-0.5 border border-slate-800 rounded-md">
                <SlidersHorizontal className="h-3 w-3 text-indigo-400 shrink-0 mx-1" />
                <span className="text-slate-500 font-mono text-[9px] mr-1 hidden sm:inline">Strikes:</span>
                <button
                  onClick={() => setStrikeFocus("ATM")}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                    strikeFocus === "ATM"
                      ? "bg-indigo-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="Only ATM and nearest ITM/OTM strikes"
                >
                  ATM Focused
                </button>
                <button
                  onClick={() => setStrikeFocus("WIDE")}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                    strikeFocus === "WIDE"
                      ? "bg-indigo-600/30 text-indigo-300"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="Moderate range around ATM"
                >
                  Medium
                </button>
                <button
                  onClick={() => setStrikeFocus("ALL")}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                    strikeFocus === "ALL"
                      ? "bg-slate-850 text-slate-300 border border-slate-800"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="All available strikes"
                >
                  All
                </button>
              </div>

              {/* Greeks Toggle Button */}
              <button
                onClick={() => setShowGreeks(!showGreeks)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded font-bold transition-all border ${
                  showGreeks 
                    ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/40" 
                    : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                }`}
              >
                {showGreeks ? <Eye className="h-3 w-3 text-indigo-400" /> : <EyeOff className="h-3 w-3" />}
                <span>Greeks {showGreeks ? "ON" : "OFF"}</span>
              </button>
            </div>

            {/* Option Chain Table Grid */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-[10px] text-left border-collapse font-sans min-w-[700px]">
                <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider font-mono sticky top-0 z-10 text-[9px] border-b border-slate-800">
                  <tr>
                    {/* CALLS */}
                    <th className="py-2 px-1 text-center bg-indigo-950/20 text-indigo-300 border-r border-slate-800/60" colSpan={showGreeks ? 7 : 5}>
                      CALL OPTIONS (CE)
                    </th>
                    {/* STRIKE */}
                    <th className="py-2 px-1 text-center bg-slate-900 text-slate-200" colSpan={1}>
                      STRIKE
                    </th>
                    {/* PUTS */}
                    <th className="py-2 px-1 text-center bg-emerald-950/20 text-emerald-300 border-l border-slate-800/60" colSpan={showGreeks ? 7 : 5}>
                      PUT OPTIONS (PE)
                    </th>
                  </tr>
                  <tr className="border-b border-slate-800 text-center text-slate-500">
                    {/* CE Headers */}
                    <th className="py-1 px-1 bg-indigo-950/10 text-slate-400">OI</th>
                    <th className="py-1 px-1 bg-indigo-950/10 text-slate-400">Vol</th>
                    <th className="py-1 px-1 bg-indigo-950/10 text-slate-400">IV%</th>
                    <th className="py-1 px-1 bg-indigo-950/10 text-slate-300">LTP</th>
                    <th className="py-1 px-1 bg-indigo-950/10 text-slate-400">%Chg</th>
                    {showGreeks && (
                      <>
                        <th className="py-1 px-1 bg-indigo-950/20 text-indigo-400 font-mono">Delta</th>
                        <th className="py-1 px-1 bg-indigo-950/20 text-indigo-400 font-mono">Theta</th>
                      </>
                    )}

                    {/* Strike */}
                    <th className="py-1 px-1 bg-slate-900 text-white font-bold border-l border-r border-slate-800">STRIKE</th>

                    {/* PE Headers */}
                    {showGreeks && (
                      <>
                        <th className="py-1 px-1 bg-emerald-950/20 text-emerald-400 font-mono">Theta</th>
                        <th className="py-1 px-1 bg-emerald-950/20 text-emerald-400 font-mono">Delta</th>
                      </>
                    )}
                    <th className="py-1 px-1 bg-emerald-950/10 text-slate-400">%Chg</th>
                    <th className="py-1 px-1 bg-emerald-950/10 text-slate-300">LTP</th>
                    <th className="py-1 px-1 bg-emerald-950/10 text-slate-400">IV%</th>
                    <th className="py-1 px-1 bg-emerald-950/10 text-slate-400">Vol</th>
                    <th className="py-1 px-1 bg-emerald-950/10 text-slate-400">OI</th>
                  </tr>
                </thead>
                <tbody>
                  {ceContracts.map((ce, index) => {
                    const pe = peContracts[index] || {
                      ref_id: ce.ref_id + 50,
                      sp: ce.sp,
                      ls: ce.ls,
                      ltp: 500,
                      oi: 12000,
                      delta: -0.3,
                      iv: 14.5,
                      volume: 120000,
                      change: -2.3,
                      theta: -6.5
                    };
                    
                    const strikePrice = Math.round(ce.sp / 100);
                    const isAtm = strikePrice === atmPrice;
                    const isCeItm = strikePrice < (atmPrice || 0);
                    const isPeItm = strikePrice > (atmPrice || 0);

                    // Mock defaults for volume & change if empty
                    const ceVol = ce.volume || Math.floor(Math.sin(index + 3) * 2000000 + 3000000);
                    const peVol = pe.volume || Math.floor(Math.cos(index + 2) * 2000000 + 3000000);
                    const rawCeChg = ce.ltpchg !== undefined ? ce.ltpchg : (ce.change !== undefined ? ce.change : (ce.price_pcp !== undefined ? ce.price_pcp : Math.round((Math.sin(index) * 12) * 10) / 10));
                    const rawPeChg = pe.ltpchg !== undefined ? pe.ltpchg : (pe.change !== undefined ? pe.change : (pe.price_pcp !== undefined ? pe.price_pcp : Math.round((Math.cos(index) * 12) * 10) / 10));
                    const ceChg = formatPercentageChangeNum(rawCeChg);
                    const peChg = formatPercentageChangeNum(rawPeChg);
                    const ceTheta = ce.theta || Math.round(-(15 - index) * 10) / 10;
                    const peTheta = pe.theta || Math.round(-(10 + index) * 10) / 10;
                    const ceOiChg = ce.oi_change_pct !== undefined ? ce.oi_change_pct : (ce.prev_oi !== undefined && ce.prev_oi > 0 ? calculateOiChangePercentage(ce.oi, ce.prev_oi) : Number((Math.sin(index * 1.3) * 6.8).toFixed(1)));
                    const peOiChg = pe.oi_change_pct !== undefined ? pe.oi_change_pct : (pe.prev_oi !== undefined && pe.prev_oi > 0 ? calculateOiChangePercentage(pe.oi, pe.prev_oi) : Number((Math.cos(index * 1.3) * 6.8).toFixed(1)));

                    return (
                      <tr 
                        key={ce.ref_id} 
                        className={`border-b border-slate-900 hover:bg-slate-900/60 transition-colors text-center font-mono ${
                          isAtm ? "bg-indigo-950/20 border-y-2 border-indigo-500/30" : ""
                        }`}
                      >
                        {/* CE DATA */}
                        <td className={`py-1.5 px-1 text-slate-400 ${isCeItm ? "bg-indigo-950/10 text-slate-300" : ""}`}>
                          <div>{formatOi(ce.oi)}</div>
                          <div className={`text-[8px] font-mono leading-none mt-0.5 ${ceOiChg >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}`}>
                            {ceOiChg >= 0 ? "+" : ""}{ceOiChg}%
                          </div>
                        </td>
                        <td className={`py-1.5 px-1 text-slate-400 ${isCeItm ? "bg-indigo-950/10" : ""}`}>
                          {formatVol(ceVol)}
                        </td>
                        <td className={`py-1.5 px-1 text-slate-400 ${isCeItm ? "bg-indigo-950/10" : ""}`}>
                          {formatIv(ce.iv)}
                        </td>
                        
                        {/* CE LTP - Interactive to buy */}
                        <td 
                          onClick={() => onPrefillOrder({
                            refId: ce.ref_id,
                            qty: ce.ls,
                            side: "BUY",
                            price: ce.ltp / 100,
                            derivative_type: "OPT",
                            option_type: "CE",
                            strike_price: strikePrice
                          })}
                          className={`py-1.5 px-1 font-bold text-indigo-300 hover:bg-indigo-600/40 hover:text-white cursor-pointer transition-all ${
                            isCeItm ? "bg-indigo-950/25 text-white font-extrabold" : ""
                          }`}
                        >
                          ₹{formatLtp(ce.ltp)}
                        </td>

                        <td className={`py-1.5 px-1 ${
                          ceChg >= 0 ? "text-brand-green font-bold" : "text-brand-red"
                        } ${isCeItm ? "bg-indigo-950/10" : ""}`}>
                          {ceChg >= 0 ? "+" : ""}{ceChg}%
                        </td>

                        {showGreeks && (
                          <>
                            <td className="py-1.5 px-1 text-indigo-400 font-bold bg-indigo-950/5">
                              {ce.delta.toFixed(2)}
                            </td>
                            <td className="py-1.5 px-1 text-slate-500 bg-indigo-950/5">
                              {ceTheta.toFixed(1)}
                            </td>
                          </>
                        )}

                        {/* STRIKE PRICE */}
                        <td className={`py-1.5 px-1 font-sans font-extrabold text-slate-100 bg-slate-900 border-l border-r border-slate-800 text-xs ${
                          isAtm ? "text-indigo-400 ring-1 ring-indigo-500/50 rounded-sm" : ""
                        }`}>
                          <div>{strikePrice}</div>
                          {strikePrice === analysisMetrics.support && (
                            <div className="text-[9px] font-mono text-emerald-400 font-bold leading-tight mt-0.5">OI Support</div>
                          )}
                          {strikePrice === analysisMetrics.resistance && (
                            <div className="text-[9px] font-mono text-rose-400 font-bold leading-tight mt-0.5">OI Resistance</div>
                          )}
                          {strikePrice === analysisMetrics.maxPain && (
                            <div className="text-[9px] font-mono text-amber-400 font-bold leading-tight mt-0.5">Max Pain</div>
                          )}
                        </td>

                        {/* PE DATA */}
                        {showGreeks && (
                          <>
                            <td className="py-1.5 px-1 text-slate-500 bg-emerald-950/5">
                              {peTheta.toFixed(1)}
                            </td>
                            <td className="py-1.5 px-1 text-emerald-400 font-bold bg-emerald-950/5">
                              {pe.delta.toFixed(2)}
                            </td>
                          </>
                        )}

                        <td className={`py-1.5 px-1 ${
                          peChg >= 0 ? "text-brand-green font-bold" : "text-brand-red"
                        } ${isPeItm ? "bg-emerald-950/10" : ""}`}>
                          {peChg >= 0 ? "+" : ""}{peChg}%
                        </td>

                        {/* PE LTP - Interactive */}
                        <td 
                          onClick={() => onPrefillOrder({
                            refId: pe.ref_id,
                            qty: pe.ls,
                            side: "BUY",
                            price: pe.ltp / 100,
                            derivative_type: "OPT",
                            option_type: "PE",
                            strike_price: strikePrice
                          })}
                          className={`py-1.5 px-1 font-bold text-emerald-300 hover:bg-emerald-600/40 hover:text-white cursor-pointer transition-all ${
                            isPeItm ? "bg-emerald-950/25 text-white font-extrabold" : ""
                          }`}
                        >
                          ₹{formatLtp(pe.ltp)}
                        </td>

                        <td className={`py-1.5 px-1 text-slate-400 ${isPeItm ? "bg-emerald-950/10" : ""}`}>
                          {formatIv(pe.iv)}
                        </td>
                        <td className={`py-1.5 px-1 text-slate-400 ${isPeItm ? "bg-emerald-950/10" : ""}`}>
                          {formatVol(peVol)}
                        </td>
                        <td className={`py-1.5 px-1 text-slate-400 ${isPeItm ? "bg-emerald-950/10 text-slate-300" : ""}`}>
                          <div>{formatOi(pe.oi)}</div>
                          <div className={`text-[8px] font-mono leading-none mt-0.5 ${peOiChg >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}`}>
                            {peOiChg >= 0 ? "+" : ""}{peOiChg}%
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Hint bar */}
            <div className="p-2 border-t border-slate-900 bg-slate-950 text-[9px] text-slate-500 flex items-center gap-1">
              <Info className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
              <span>*Click any CE/PE LTP price cell to instantly load that option strike into your Order Execution Desk.</span>
            </div>
          </div>
        )}

        {/* TAB 2: OPTIONS STRATEGIES */}
        {activeTab === "STRATEGIES" && (
          <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Strategy Selector List */}
              <div className="md:col-span-1 space-y-2">
                <span className="text-[10px] text-slate-500 uppercase font-bold font-mono">Preset Strategies</span>
                <div className="flex flex-col gap-1.5">
                  {strategies.map((strat) => (
                    <button
                      key={strat.id}
                      onClick={() => {
                        setSelectedStrategy(strat.id);
                        setDeploySuccess(null);
                      }}
                      className={`text-left p-2 rounded-lg border text-xs transition-all ${
                        selectedStrategy === strat.id
                          ? "bg-indigo-600/10 border-indigo-500 text-white shadow-md font-bold"
                          : "bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700"
                      }`}
                    >
                      {strat.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Strategy Detail & Execution */}
              <div className="md:col-span-2 bg-slate-900/40 border border-slate-800/60 rounded-xl p-3.5 flex flex-col justify-between min-h-[220px]">
                {selectedStrategy ? (
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2 border-b border-slate-800/80 pb-2">
                      <div>
                        <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                          {strategies.find(s => s.id === selectedStrategy)?.name}
                        </h4>
                        <p className="text-[10px] text-slate-400 leading-normal mt-1">
                          {strategies.find(s => s.id === selectedStrategy)?.description}
                        </p>
                      </div>
                    </div>

                    {/* Legs list */}
                    <div className="space-y-1.5">
                      <span className="text-[9px] text-slate-500 font-mono font-bold block">STRATEGY LEGS DETAILED PROPOSAL</span>
                      <div className="divide-y divide-slate-800/40 bg-black/30 rounded-lg overflow-hidden">
                        {strategyLegs.map((leg, index) => (
                          <div key={index} className="p-2 flex items-center justify-between text-[10px] font-mono">
                            <div className="flex items-center gap-2">
                              <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${
                                leg.type === "BUY" ? "bg-indigo-500/10 text-indigo-300" : "bg-orange-500/10 text-orange-400"
                              }`}>
                                {leg.type}
                              </span>
                              <span className="text-white font-semibold">{leg.name}</span>
                            </div>
                            <div className="text-slate-400">
                              {activeSymbol} {leg.strike} <span className="text-indigo-400">{leg.opt}</span> (Lot size: {instrument?.lot_size || 50})
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {deploySuccess ? (
                      <div className="p-2 bg-brand-green/10 border border-brand-green/20 text-brand-green rounded-lg text-[10px] flex items-start gap-1.5">
                        <CheckCircle className="h-4 w-4 text-brand-green shrink-0 mt-0.5" />
                        <span>{deploySuccess}</span>
                      </div>
                    ) : (
                      <button
                        onClick={handleDeployStrategy}
                        className="w-full mt-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-xs transition-all shadow-lg flex items-center justify-center gap-2"
                      >
                        <Zap className="h-4 w-4" />
                        Execute Multi-Leg Strategy Order
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center text-slate-500 flex-1 py-8">
                    <Layers className="h-8 w-8 text-slate-700 mb-2" />
                    <span className="text-[11px] font-medium text-slate-400">Select a predefined strategy to build & deploy</span>
                    <span className="text-[9px] text-slate-600 mt-0.5">Quickly construct multi-leg options spreads with single click broker order transmission.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: SMART HEATMAP */}
        {activeTab === "HEATMAP" && (
          <div className="flex-1 flex flex-col p-3 overflow-hidden">
            {/* Heatmap Control Metric */}
            <div className="mb-3 flex items-center justify-between gap-2 bg-slate-900/60 p-2 rounded-lg">
              <span className="text-[10px] text-slate-400 font-bold flex items-center gap-1">
                <Grid className="h-3.5 w-3.5 text-indigo-400" />
                Color Heatmap Metric Selection:
              </span>
              <div className="flex gap-1">
                {(["OI", "CHANGE", "VOLUME"] as const).map((metric) => (
                  <button
                    key={metric}
                    onClick={() => setHeatmapMetric(metric)}
                    className={`px-2 py-0.5 rounded text-[9px] font-semibold tracking-wide transition-all ${
                      heatmapMetric === metric 
                        ? "bg-indigo-600 text-white font-extrabold" 
                        : "bg-black text-slate-400 hover:text-white"
                    }`}
                  >
                    {metric === "OI" ? "Open Interest" : metric === "CHANGE" ? "% Change" : "Volume"}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid Container */}
            <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-2 pr-1.5">
              {/* Calls Side */}
              <div className="space-y-1.5">
                <h4 className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest text-center py-1 bg-indigo-950/20 border border-indigo-950/40 rounded-lg">
                  CALL STRIKES HEATMAP (CE)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {heatmapData.map((item) => {
                    const ce = item.ce;
                    const rawChg = ce.ltpchg !== undefined ? ce.ltpchg : (ce.change !== undefined ? ce.change : (ce.price_pcp !== undefined ? ce.price_pcp : 0));
                    const rawOi = ce.oi || 0;
                    const val = heatmapMetric === "OI" ? rawOi : heatmapMetric === "VOLUME" ? (ce.volume || 0) : formatChg(rawChg);
                    
                    // Style determination based on value intensity
                    let bg = "bg-slate-900";
                    
                    if (heatmapMetric === "CHANGE") {
                      if (val > 5) bg = "bg-emerald-950/60 border border-emerald-500/40 text-emerald-200";
                      else if (val > 1) bg = "bg-emerald-950/30 border border-emerald-600/20 text-emerald-400";
                      else if (val < -5) bg = "bg-rose-950/60 border border-rose-500/40 text-rose-200";
                      else if (val < -1) bg = "bg-rose-950/30 border border-rose-600/20 text-rose-400";
                    } else if (heatmapMetric === "OI") {
                      const oiPct = val / 500000;
                      if (oiPct > 0.7) bg = "bg-indigo-900/60 border border-indigo-400/50 text-white";
                      else if (oiPct > 0.4) bg = "bg-indigo-950/40 border border-indigo-500/20 text-indigo-200";
                      else bg = "bg-slate-900/60 text-slate-400";
                    } else { // VOLUME
                      const volPct = val / 8000000;
                      if (volPct > 0.7) bg = "bg-blue-900/60 border border-blue-400/50 text-white";
                      else if (volPct > 0.4) bg = "bg-blue-950/40 border border-blue-500/20 text-blue-200";
                      else bg = "bg-slate-900/60 text-slate-400";
                    }

                    const focusClass = item.isFocused ? "ring-2 ring-indigo-400 shadow-md font-bold" : "opacity-75 hover:opacity-100";

                    return (
                      <div
                        key={`ce-${item.strike}`}
                        onClick={() => onPrefillOrder({
                          refId: ce.ref_id,
                          qty: ce.ls,
                          side: "BUY",
                          price: ce.ltp / 100,
                          derivative_type: "OPT",
                          option_type: "CE",
                          strike_price: item.strike
                        })}
                        className={`p-1.5 rounded-lg text-center cursor-pointer hover:scale-105 transition-all flex flex-col justify-center items-center h-12 font-mono ${bg} ${focusClass}`}
                        title={item.isFocused ? "Spot ±7 Strikes (Focused Zone)" : "Extended Strike"}
                      >
                        <span className="text-[8px] font-bold text-white flex items-center gap-1">
                          {item.strike} CE {item.isFocused && <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 inline-block"></span>}
                        </span>
                        <span className="text-[10px] font-extrabold">{heatmapMetric === "CHANGE" ? `${val >= 0 ? "+" : ""}${val}%` : heatmapMetric === "OI" ? formatOi(val) : formatVol(val)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Puts Side */}
              <div className="space-y-1.5">
                <h4 className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest text-center py-1 bg-emerald-950/20 border border-emerald-950/40 rounded-lg">
                  PUT STRIKES HEATMAP (PE)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {heatmapData.map((item) => {
                    const pe = item.pe;
                    const rawChg = pe.ltpchg !== undefined ? pe.ltpchg : (pe.change !== undefined ? pe.change : (pe.price_pcp !== undefined ? pe.price_pcp : 0));
                    const rawOi = pe.oi || 0;
                    const val = heatmapMetric === "OI" ? rawOi : heatmapMetric === "VOLUME" ? (pe.volume || 0) : formatChg(rawChg);

                    // Style determination based on value intensity
                    let bg = "bg-slate-900";
                    
                    if (heatmapMetric === "CHANGE") {
                      if (val > 5) bg = "bg-emerald-950/60 border border-emerald-500/40 text-emerald-200";
                      else if (val > 1) bg = "bg-emerald-950/30 border border-emerald-600/20 text-emerald-400";
                      else if (val < -5) bg = "bg-rose-950/60 border border-rose-500/40 text-rose-200";
                      else if (val < -1) bg = "bg-rose-950/30 border border-rose-600/20 text-rose-400";
                    } else if (heatmapMetric === "OI") {
                      const oiPct = val / 500000;
                      if (oiPct > 0.7) bg = "bg-indigo-900/60 border border-indigo-400/50 text-white";
                      else if (oiPct > 0.4) bg = "bg-indigo-950/40 border border-indigo-500/20 text-indigo-200";
                      else bg = "bg-slate-900/60 text-slate-400";
                    } else { // VOLUME
                      const volPct = val / 8000000;
                      if (volPct > 0.7) bg = "bg-blue-900/60 border border-blue-400/50 text-white";
                      else if (volPct > 0.4) bg = "bg-blue-950/40 border border-blue-500/20 text-blue-200";
                      else bg = "bg-slate-900/60 text-slate-400";
                    }

                    const focusClass = item.isFocused ? "ring-2 ring-indigo-400 shadow-md font-bold" : "opacity-75 hover:opacity-100";

                    return (
                      <div
                        key={`pe-${item.strike}`}
                        onClick={() => onPrefillOrder({
                          refId: pe.ref_id,
                          qty: pe.ls,
                          side: "BUY",
                          price: pe.ltp / 100,
                          derivative_type: "OPT",
                          option_type: "PE",
                          strike_price: item.strike
                        })}
                        className={`p-1.5 rounded-lg text-center cursor-pointer hover:scale-105 transition-all flex flex-col justify-center items-center h-12 font-mono ${bg} ${focusClass}`}
                        title={item.isFocused ? "Spot ±7 Strikes (Focused Zone)" : "Extended Strike"}
                      >
                        <span className="text-[8px] font-bold text-white flex items-center gap-1">
                          {item.strike} PE {item.isFocused && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 inline-block"></span>}
                        </span>
                        <span className="text-[10px] font-extrabold">{heatmapMetric === "CHANGE" ? `${val >= 0 ? "+" : ""}${val}%` : heatmapMetric === "OI" ? formatOi(val) : formatVol(val)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: VOLUME SHOCKERS */}
        {activeTab === "SHOCKERS" && (
          <div className="flex-1 flex flex-col p-3 overflow-hidden">
            <div className="mb-3 text-[10px] text-slate-400 flex items-center gap-1.5 bg-slate-900/40 p-2 rounded-lg leading-normal">
              <Flame className="h-4 w-4 text-orange-400 shrink-0" />
              <span>
                <strong>Volume Shockers Mode:</strong> Automatically monitoring anomalous volume spikes and intense options accumulation on active trading strikes.
              </span>
            </div>

            {/* List Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-[10px] border-collapse font-sans">
                <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider font-mono sticky top-0 z-10 text-[9px] border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-3">Option Contract</th>
                    <th className="py-2 px-3 text-center">Volume (Spike)</th>
                    <th className="py-2 px-3 text-center">Open Interest</th>
                    <th className="py-2 px-3 text-center">% Price Chg</th>
                    <th className="py-2 px-3 text-right">Activity Label</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900 font-mono">
                  {volumeShockers.map((shocker, index) => (
                    <tr 
                      key={index} 
                      className="hover:bg-slate-900/50 transition-colors"
                    >
                      <td className="py-2.5 px-3 font-semibold text-white">
                        {shocker.option}
                      </td>
                      <td className="py-2.5 px-3 text-center text-orange-300 font-bold">
                        {formatVol(shocker.volume)}
                      </td>
                      <td className="py-2.5 px-3 text-center text-slate-400">
                        {formatOi(shocker.oi)}
                      </td>
                      <td className={`py-2.5 px-3 text-center ${shocker.change >= 0 ? "text-brand-green font-bold" : "text-brand-red"}`}>
                        {shocker.change >= 0 ? "+" : ""}{shocker.change}%
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 text-[8px] font-bold border border-orange-500/20">
                          {shocker.shockerType}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {volumeShockers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500 font-sans">
                        No unusual option volume shockers detected currently.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
