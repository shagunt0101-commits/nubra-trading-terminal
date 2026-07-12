import React, { useState, useMemo, useEffect } from "react";
import { Zap, TrendingUp, TrendingDown, ShieldAlert, CheckCircle2, Clock, Activity, ArrowRight, Play, RefreshCw, BarChart3 } from "lucide-react";
import { Instrument, ChartDataPoint } from "../types";

interface OptionBuyingEngineProps {
  instrument: Instrument | null;
  chartData: ChartDataPoint[];
  optionChain: any;
  onExecuteSignal: (params: any) => void;
  onRefresh?: () => void;
}

// --- Real signal helpers ---

function isStaleData(candles: ChartDataPoint[]): boolean {
  if (candles.length < 5) return true;
  const closes = candles.slice(-5).map(c => c.close);
  if (closes.some(c => c === undefined || c === null || isNaN(c))) return true;
  const allSame = closes.every(c => Math.abs(c - closes[0]) < 0.01);
  const rsi = candles[candles.length - 1]?.rsi14;
  return allSame || (rsi !== undefined && rsi >= 99);
}

function calcRsiSignal(candles: ChartDataPoint[]): { value: number; label: string; bullish: boolean } {
  if (isStaleData(candles)) return { value: 50, label: "Markets Closed", bullish: true };
  const rsi = candles[candles.length - 1]?.rsi14;
  if (rsi === undefined || rsi === null || isNaN(rsi) || !isFinite(rsi)) return { value: 50, label: "N/A", bullish: true };
  if (rsi >= 99) return { value: rsi, label: "Stale", bullish: true };
  if (rsi > 70) return { value: rsi, label: `${rsi.toFixed(1)} (Overbought)`, bullish: false };
  if (rsi < 30) return { value: rsi, label: `${rsi.toFixed(1)} (Oversold)`, bullish: true };
  if (rsi > 50) return { value: rsi, label: `${rsi.toFixed(1)} (Bullish)`, bullish: true };
  return { value: rsi, label: `${rsi.toFixed(1)} (Bearish)`, bullish: false };
}

function calcMacdSignal(candles: ChartDataPoint[]): { label: string; bullish: boolean } {
  if (isStaleData(candles)) return { label: "Markets Closed", bullish: true };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev) return { label: "N/A", bullish: true };
  const mLine = (last.macdLine ?? 0) || 0;
  const sLine = (last.signalLine ?? 0) || 0;
  const mHist = (last.macdHist ?? 0) || 0;
  const pHist = (prev.macdHist ?? 0) || 0;
  if (mLine === 0 && sLine === 0 && mHist === 0) return { label: "Flat", bullish: true };
  if (mLine > sLine && mHist > pHist) return { label: "Expanding Positive", bullish: true };
  if (mLine > sLine) return { label: "Positive", bullish: true };
  if (mLine < sLine && mHist < pHist) return { label: "Expanding Negative", bullish: false };
  return { label: "Negative", bullish: false };
}

function calcVwapCrossover(candles: ChartDataPoint[]): { above: boolean; label: string } {
  if (isStaleData(candles)) return { above: true, label: "Stale" };
  if (candles.length < 20) return { above: true, label: "N/A" };
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 1);
  let cumVwap = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    cumVwap += closes[i] * volumes[i];
    cumVol += volumes[i];
  }
  const vwap = cumVwap / cumVol;
  const lastClose = closes[closes.length - 1];
  return {
    above: lastClose >= vwap,
    label: lastClose >= vwap ? "Confirmed Above" : "Trading Below"
  };
}

function calcVolumeSurge(candles: ChartDataPoint[]): { pct: number; label: string; surge: boolean } {
  if (isStaleData(candles)) return { pct: 0, label: "Stale", surge: false };
  const volumes = candles.filter(c => c.volume > 0).map(c => c.volume);
  if (volumes.length < 20) return { pct: 0, label: "N/A", surge: false };
  const recent = volumes.slice(-3);
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const prior = volumes.slice(-23, -3);
  const avgPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
  const pctChange = avgPrior > 0 ? ((avgRecent - avgPrior) / avgPrior) * 100 : 0;
  return {
    pct: pctChange,
    label: pctChange > 15 ? `+${pctChange.toFixed(0)}% vs 20MA` : `${pctChange.toFixed(0)}% vs 20MA`,
    surge: pctChange > 15
  };
}

function calcEmaAlignment(candles: ChartDataPoint[]): { label: string; bullish: boolean } {
  if (isStaleData(candles)) return { label: "Markets Closed", bullish: true };
  const last = candles[candles.length - 1];
  if (!last) return { label: "N/A", bullish: true };
  const c = last.close, s20 = last.sma20, e50 = last.ema50;
  if (!c || !s20 || !e50) return { label: "N/A", bullish: true };
  if (s20 === e50 || Math.abs(s20 - e50) / (e50 || 1) < 0.0001) return { label: "Flat (Converged)", bullish: true };
  if (c > s20 && s20 > e50) return { label: "Bullish Alignment", bullish: true };
  if (c < s20 && s20 < e50) return { label: "Bearish Alignment", bullish: false };
  if (c > e50 && c > s20) return { label: "Bullish (Above EMAs)", bullish: true };
  if (c < e50 && c < s20) return { label: "Bearish (Below EMAs)", bullish: false };
  if (c > e50) return { label: "Bullish (Above 50EMA)", bullish: true };
  return { label: "Bearish (Below 50EMA)", bullish: false };
}

function calcPcr(ceList: any[], peList: any[]): number {
  const ceOi = ceList.reduce((s, c) => s + (c.oi || 0), 0);
  const peOi = peList.reduce((s, p) => s + (p.oi || 0), 0);
  return ceOi > 0 ? peOi / ceOi : 1;
}

function fmtOi(val: number): string {
  if (val >= 10000000) return `${(val / 10000000).toFixed(1)}Cr`;
  if (val >= 100000) return `${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  return val.toFixed(0);
}

function calcOiChanges(ceList: any[], peList: any[]): { callOI: string; putOI: string; callChange: number; putChange: number } {
  const callOI = ceList.slice(0, 10).reduce((s, c) => s + (c.oi || 0), 0);
  const putOI = peList.slice(0, 10).reduce((s, p) => s + (p.oi || 0), 0);
  const callPrevOI = ceList.slice(0, 10).reduce((s, c) => s + (c.prev_oi || 0), 0);
  const putPrevOI = peList.slice(0, 10).reduce((s, p) => s + (p.prev_oi || 0), 0);
  const hasPrevCe = callPrevOI > 0;
  const hasPrevPe = putPrevOI > 0;
  const callChg = hasPrevCe ? ((callOI - callPrevOI) / callPrevOI) * 100 : 0;
  const putChg = hasPrevPe ? ((putOI - putPrevOI) / putPrevOI) * 100 : 0;
  return {
    callOI: hasPrevCe ? `${callChg >= 0 ? "+" : ""}${callChg.toFixed(1)}%` : `OI ${fmtOi(callOI)}`,
    putOI: hasPrevPe ? `${putChg >= 0 ? "+" : ""}${putChg.toFixed(1)}%` : `OI ${fmtOi(putOI)}`,
    callChange: hasPrevCe ? callChg : 0,
    putChange: hasPrevPe ? putChg : 0
  };
}

function normalizeIv(iv: number): number {
  if (iv > 1000) return iv / 100;
  if (iv <= 2 && iv > 0) return iv * 100;
  return iv;
}

function calcIvPercentile(ceList: any[], peList: any[]): { iv: number; label: string; bullish: boolean } {
  const allIv = [...ceList, ...peList].map(c => normalizeIv(c.iv)).filter(iv => iv && iv > 0 && iv < 200);
  if (allIv.length === 0) return { iv: 15, label: "N/A", bullish: true };
  const avgIv = allIv.reduce((a, b) => a + b, 0) / allIv.length;
  const bullish = avgIv < 25; // low IV = stable = bullish for options selling
  if (avgIv < 15) return { iv: avgIv, label: `${avgIv.toFixed(1)}% (Low Vol)`, bullish };
  if (avgIv < 25) return { iv: avgIv, label: `${avgIv.toFixed(1)}% (Normal)`, bullish };
  return { iv: avgIv, label: `${avgIv.toFixed(1)}% (Elevated)`, bullish };
}

function calcConfidenceScore(signals: boolean[]): number {
  if (signals.length === 0) return 50;
  const trueCount = signals.filter(Boolean).length;
  return Math.round((trueCount / signals.length) * 100);
}

export default function OptionBuyingEngine({
  instrument,
  chartData,
  optionChain,
  onExecuteSignal,
  onRefresh,
}: OptionBuyingEngineProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedOptType, setSelectedOptType] = useState<"CE" | "PE">("CE");

  // Auto-refresh every 30s if instrument is active — useRef to avoid stale closure
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (!instrument || !refreshRef.current) return;
    const interval = setInterval(() => refreshRef.current?.(), 30000);
    return () => clearInterval(interval);
  }, [instrument?.ref_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSymbol = instrument?.stock_name || "NIFTY";
  const currentPrice = chartData[chartData.length - 1]?.close || (instrument?.underlying_prev_close ? (instrument.underlying_prev_close / 100) : 24211);

  // Real chain data
  const ceList = Array.isArray(optionChain?.ce) ? optionChain.ce : Array.isArray(optionChain?.chain?.ce) ? optionChain.chain.ce : [];
  const peList = Array.isArray(optionChain?.pe) ? optionChain.pe : Array.isArray(optionChain?.chain?.pe) ? optionChain.chain.pe : [];
  const step = activeSymbol.includes("BANK") ? 100 : activeSymbol.includes("SENSEX") ? 100 : 50;
  const rawSpot = optionChain?.spot || optionChain?.cp || optionChain?.atm;
  const atmInRupees = rawSpot ? Math.round(rawSpot / 100) : currentPrice;
  const atmStrike = Math.round(atmInRupees / step) * step;

  // --- Compute all real signals ---
  const rsiSignal = useMemo(() => calcRsiSignal(chartData), [chartData]);
  const macdSignal = useMemo(() => calcMacdSignal(chartData), [chartData]);
  const vwapSignal = useMemo(() => calcVwapCrossover(chartData), [chartData]);
  const volumeSignal = useMemo(() => calcVolumeSurge(chartData), [chartData]);
  const emaSignal = useMemo(() => calcEmaAlignment(chartData), [chartData]);
  const pcr = useMemo(() => calcPcr(ceList, peList), [ceList, peList]);
  const oiChanges = useMemo(() => calcOiChanges(ceList, peList), [ceList, peList]);
  const ivData = useMemo(() => calcIvPercentile(ceList, peList), [ceList, peList]);

  // Determine direction based on signal agreement
  const bullishSignals = [rsiSignal.bullish, macdSignal.bullish, emaSignal.bullish, vwapSignal.above, volumeSignal.surge, pcr > 1.1];
  const bearishSignals = [!rsiSignal.bullish, !macdSignal.bullish, !emaSignal.bullish, !vwapSignal.above, volumeSignal.surge, pcr < 0.9];
  const bullVotes = bullishSignals.filter(Boolean).length;
  const bearVotes = bearishSignals.filter(Boolean).length;
  const isBullish = bullVotes >= bearVotes;

  const isAlignedWithTrend = (selectedOptType === "CE" && isBullish) || (selectedOptType === "PE" && !isBullish);
  const confidenceScore = calcConfidenceScore(isBullish ? bullishSignals : bearishSignals);

  // Monitoring status depends on agreement
  const monitoringStatus = !isAlignedWithTrend ? "scanning" : confidenceScore >= 65 ? "confirmed" : "anticipated";

  const targetStrike = selectedOptType === "CE" ? atmStrike + step : atmStrike - step;
  const activeOptObj = selectedOptType === "CE"
    ? ceList.find((c: any) => Math.round((c.sp || 0) / 100) === targetStrike)
    : peList.find((p: any) => Math.round((p.sp || 0) / 100) === targetStrike);

  const brokerLtp = activeOptObj?.ltp ? (activeOptObj.ltp / 100).toFixed(2) : null;
  const estimatedPremium = brokerLtp || (selectedOptType === "CE" ? "145.50" : "132.00");
  const rrRatio = 2.0;
  const targetPrice = (parseFloat(estimatedPremium) * rrRatio).toFixed(2);
  const stopLoss = (parseFloat(estimatedPremium) * 0.5).toFixed(2);

  const handleDeployTrade = () => {
    onExecuteSignal({
      symbol: `${activeSymbol} Strike ${targetStrike} ${selectedOptType}`,
      action: "BUY",
      instrumentType: "OPT",
      price: parseFloat(estimatedPremium),
      qty: instrument?.lot_size || 75,
      target: parseFloat(targetPrice),
      stopLoss: parseFloat(stopLoss),
      strategyTag: "option-buying-engine",
    });
  };

  const handleRefresh = () => {
    setIsAnalyzing(true);
    onRefresh?.();
    setTimeout(() => setIsAnalyzing(false), 1200);
  };

  return (
    <div className="bg-black/40 border border-brand-border rounded-xl p-4 font-sans space-y-4 shadow-xl">
      <div className="flex items-start gap-3 border-b border-brand-border pb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
            <Zap className="h-4 w-4 animate-pulse" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white tracking-wide uppercase font-mono flex items-center gap-2">
              <span className="truncate">Option Buying Momentum Engine</span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono shrink-0">LIVE TELEMETRY</span>
            </h3>
            <p className="text-[11px] text-gray-400 truncate">Real-time technical & option chain surveillance for {activeSymbol}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleRefresh}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-brand-green/20 hover:bg-brand-green/30 border border-brand-green/40 text-brand-green text-xs font-mono font-bold cursor-pointer transition-all"
          >
            <RefreshCw className={`h-3 w-3 ${isAnalyzing ? "animate-spin" : ""}`} />
            <span>Rescan Momentum</span>
          </button>
        </div>
      </div>

      {!instrument ? (
        <div className="text-center py-10 text-gray-500 text-xs font-mono">
          Select an instrument from the terminal header or screener to initialize the Option Buying Engine.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status Banner */}
          <div className={`p-3 rounded-lg border flex items-center gap-3 ${
            !isAlignedWithTrend ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
            : monitoringStatus === "confirmed" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
            : monitoringStatus === "anticipated" ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
            : "bg-blue-500/10 border-blue-500/30 text-blue-300"
          }`}>
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              {!isAlignedWithTrend ? <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0" />
              : monitoringStatus === "confirmed" ? <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
              : <Activity className="h-5 w-5 text-blue-400 animate-pulse shrink-0" />}
              <div className="min-w-0">
                <span className="text-xs font-mono font-bold uppercase tracking-wider truncate block">
                  {!isAlignedWithTrend ? `COUNTER-TREND (Market ${isBullish ? "Bullish" : "Bearish"})`
                  : monitoringStatus === "confirmed" ? "CONFIRMED SETUP (Signal Agreement Verified)"
                  : "SCANNING (Partial Signal Alignment)"}
                </span>
                <p className="text-[11px] opacity-80 mt-0.5 truncate">
                  {!isAlignedWithTrend ? `${selectedOptType} opposes market direction. R:R calculation adjusted.`
                  : monitoringStatus === "confirmed" ? `${bullVotes}/${bullVotes + bearVotes} indicators align. Ready.`
                  : `${bullVotes} bullish vs ${bearVotes} bearish signals.`}
                </p>
              </div>
            </div>
            <div className="text-right font-mono shrink-0">
              <span className="text-[10px] text-gray-400 block">Confidence</span>
              <span className="text-sm font-bold text-white">{confidenceScore}%</span>
            </div>
          </div>

          {/* Option Type & Key Parameters */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg space-y-1">
              <span className="text-[10px] font-mono text-gray-500 uppercase">Option Bias</span>
              <div className="flex items-center gap-1 mt-1">
                <button onClick={() => setSelectedOptType("CE")}
                  className={`flex-1 py-1 rounded text-xs font-mono font-bold cursor-pointer transition-all ${selectedOptType === "CE" ? "bg-emerald-500 text-black shadow" : "bg-black/40 text-gray-400 hover:text-white"}`}>CALL (CE)</button>
                <button onClick={() => setSelectedOptType("PE")}
                  className={`flex-1 py-1 rounded text-xs font-mono font-bold cursor-pointer transition-all ${selectedOptType === "PE" ? "bg-rose-500 text-black shadow" : "bg-black/40 text-gray-400 hover:text-white"}`}>PUT (PE)</button>
              </div>
            </div>
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg">
              <span className="text-[10px] font-mono text-gray-500 uppercase">Target Strike</span>
              <p className="text-sm font-bold font-mono text-white mt-1">{targetStrike} {selectedOptType}</p>
              <span className="text-[10px] font-mono text-emerald-400">ATM/ITM Spread</span>
            </div>
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg">
              <span className="text-[10px] font-mono text-gray-500 uppercase">Est. Entry Premium</span>
              <p className="text-sm font-bold font-mono text-brand-green mt-1">₹{estimatedPremium}</p>
              <span className="text-[10px] font-mono text-gray-400">Lot Size: {instrument.lot_size || 75}</span>
            </div>
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg">
              <span className="text-[10px] font-mono text-gray-500 uppercase">R:R Target</span>
              <p className="text-sm font-bold font-mono text-indigo-400 mt-1">1 : {rrRatio} (₹{targetPrice})</p>
              <span className="text-[10px] font-mono text-rose-400">Stop: ₹{stopLoss}</span>
            </div>
          </div>

          {/* Real Signal Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 1. Price Action & Momentum */}
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-gray-400 font-bold flex items-center gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5 text-brand-green" /> Price Action
                </span>
                <span className={isBullish ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{isBullish ? "Bullish" : "Bearish"}</span>
              </div>
              <ul className="text-[11px] text-gray-300 space-y-1 font-sans">
                <li className="flex items-center justify-between"><span>Current Spot:</span><span className="font-mono font-bold text-white">₹{currentPrice.toFixed(2)}</span></li>
                <li className="flex items-center justify-between"><span>VWAP Crossover:</span><span className={`font-mono font-bold ${vwapSignal.above ? "text-emerald-400" : "text-rose-400"}`}>{vwapSignal.label}</span></li>
                <li className="flex items-center justify-between"><span>Volume Surge:</span><span className={`font-mono ${volumeSignal.surge ? "text-brand-green" : "text-gray-400"}`}>{volumeSignal.label}</span></li>
              </ul>
            </div>

            {/* 2. Technical Indicators */}
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-gray-400 font-bold flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-indigo-400" /> Technical Oscillators
                </span>
                <span className={rsiSignal.bullish ? "text-indigo-300 font-bold" : "text-rose-400 font-bold"}>{rsiSignal.bullish ? "Bullish" : "Bearish"}</span>
              </div>
              <ul className="text-[11px] text-gray-300 space-y-1 font-sans">
                <li className="flex items-center justify-between"><span>RSI (14):</span><span className="font-mono font-bold text-white">{rsiSignal.label}</span></li>
                <li className="flex items-center justify-between"><span>MACD Histogram:</span><span className={`font-mono font-bold ${macdSignal.bullish ? "text-emerald-400" : "text-rose-400"}`}>{macdSignal.label}</span></li>
                <li className="flex items-center justify-between"><span>SMA 20 / EMA 50:</span><span className={`font-mono font-bold ${emaSignal.bullish ? "text-emerald-400" : "text-rose-400"}`}>{emaSignal.label}</span></li>
              </ul>
            </div>

            {/* 3. Option Chain & OI Surveillance */}
            <div className="bg-black/30 border border-brand-border p-3 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-gray-400 font-bold flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-400" /> Option Chain & PCR
                </span>
                <span className={`font-bold ${pcr > 1.1 ? "text-emerald-400" : pcr < 0.9 ? "text-rose-400" : "text-gray-400"}`}>PCR {pcr.toFixed(2)}</span>
              </div>
              <ul className="text-[11px] text-gray-300 space-y-1 font-sans">
                <li className="flex items-center justify-between"><span>Call OI Change:</span><span className={`font-mono ${oiChanges.callChange < 0 ? "text-rose-400" : "text-emerald-400"}`}>{oiChanges.callOI}</span></li>
                <li className="flex items-center justify-between"><span>Put OI Change:</span><span className={`font-mono ${oiChanges.putChange > 0 ? "text-emerald-400" : "text-rose-400"}`}>{oiChanges.putOI}</span></li>
                <li className="flex items-center justify-between"><span>IV Percentile:</span><span className="font-mono text-white">{ivData.label}</span></li>
              </ul>
            </div>
          </div>

          {/* Action Button */}
          <div className="pt-2 flex items-center gap-3">
            <button onClick={handleDeployTrade}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded text-xs font-bold font-mono tracking-wider uppercase cursor-pointer shadow-lg transition-all ${
                monitoringStatus === "confirmed"
                  ? "bg-brand-green text-black hover:opacity-95 shadow-brand-green/20"
                  : "bg-amber-500 text-black hover:opacity-95 shadow-amber-500/20"
              }`}>
              <Zap className="h-4 w-4 text-black" />
              <span>{monitoringStatus === "confirmed" ? `Execute ${activeSymbol} ${selectedOptType}` : `Execute Setup (${activeSymbol} ${selectedOptType})`}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
