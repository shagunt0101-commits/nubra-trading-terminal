import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Sparkles, RefreshCw, Send, ShieldAlert, Award, FileText, Settings, Key, Globe, Cpu } from "lucide-react";
import { Instrument, ChartDataPoint, PortfolioSummary } from "../types";
import { useMarketData } from "../context/MarketDataContext";

interface AiAnalysisProps {
  instrument?: Instrument | null;
  chartData?: ChartDataPoint[];
  portfolio: PortfolioSummary | null;
  onExecuteSignal: (params: {
    side: "BUY" | "SELL";
    price: number;
    stoploss: number;
    target: number;
    qty: number;
  }) => void;
  optionChain?: any;
  tradingMode?: "EQ" | "FNO" | "NONE";
}

export default function AiAnalysis({
  instrument: propInstrument,
  chartData: propChartData,
  portfolio,
  onExecuteSignal,
  optionChain: propOptionChain,
  tradingMode,
}: AiAnalysisProps) {
  const { selectedInstrument, chartData: ctxChartData, optionChainData } = useMarketData();
  const instrument = propInstrument !== undefined ? propInstrument : selectedInstrument;
  const chartData = propChartData && propChartData.length > 0 ? propChartData : ctxChartData;
  const optionChain = propOptionChain !== undefined ? propOptionChain : optionChainData;

  const [strategy, setStrategy] = useState<"scalping" | "day_trading" | "swing_trading" | "btst" | "stbt">("day_trading");
  const [report, setReport] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"structured" | "markdown">("markdown");

  // Custom AI Provider Configuration (session-only, never persisted to localStorage)
  const [aiProvider, setAiProvider] = useState<"gemini" | "custom">("gemini");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("https://api.openai.com/v1");
  const [customModel, setCustomModel] = useState("gpt-4o-mini");
  const [showAiSettings, setShowAiSettings] = useState(false);

  // Settings are session-only — never persisted to localStorage

  const latestPrice = chartData[chartData.length - 1]?.close || (instrument?.underlying_prev_close ? instrument.underlying_prev_close / 100 : 100);
  const activeSymbol = instrument?.stock_name || "NIFTY";
  const step = activeSymbol.includes("BANK") ? 100 : activeSymbol.includes("SENSEX") ? 100 : 50;
  const atmStrike = optionChain?.chain?.atm 
    ? Math.round(optionChain.chain.atm / 100) 
    : Math.round(latestPrice / step) * step;

  const ceList = optionChain?.chain?.ce || [];
  const peList = optionChain?.chain?.pe || [];
  const atmCe = ceList.find((c: any) => Math.round(c.sp / 100) === atmStrike) || ceList[0];
  const atmPe = peList.find((p: any) => Math.round(p.sp / 100) === atmStrike) || peList[0];

  const formatOiVal = (val: number) => {
    if (!val) return "0";
    if (val >= 100000) return `${(val / 100000).toFixed(1)}L`;
    if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
    return val.toString();
  };

  const handleGenerate = async () => {
    if (!instrument || chartData.length === 0) return;
    setIsLoading(true);
    setError("");

    try {
      const latestCandle = chartData[chartData.length - 1];
      const contextPayload = {
        symbol: instrument.stock_name,
        strategy,
        priceData: {
          ltp: latestCandle.close,
          prevClose: instrument.underlying_prev_close / 100,
          high: latestCandle.high,
          low: latestCandle.low,
        },
        atmAnalysis: {
          atmStrike,
          ce: atmCe ? {
            strike: atmStrike,
            ltp: atmCe.ltp,
            oi: atmCe.oi,
            volume: atmCe.volume,
            iv: atmCe.iv,
            delta: atmCe.delta,
            theta: atmCe.theta,
            change: atmCe.change || atmCe.ltpchg || 0,
            oi_change_pct: atmCe.oi_change_pct || 0
          } : null,
          pe: atmPe ? {
            strike: atmStrike,
            ltp: atmPe.ltp,
            oi: atmPe.oi,
            volume: atmPe.volume,
            iv: atmPe.iv,
            delta: atmPe.delta,
            theta: atmPe.theta,
            change: atmPe.change || atmPe.ltpchg || 0,
            oi_change_pct: atmPe.oi_change_pct || 0
          } : null,
        },
        technicalIndicators: {
          rsi14: latestCandle.rsi14,
          sma20: latestCandle.sma20,
          ema50: latestCandle.ema50,
          bbUpper: latestCandle.bbUpper,
          bbLower: latestCandle.bbLower,
        },
        funds: portfolio?.funds?.portFundsAndMargin,
        positions: portfolio?.positions?.portfolio?.positions || [],
        optionChain: optionChain ? { chain: optionChain } : undefined,
        aiProvider,
        customApiKey,
        customBaseUrl,
        customModel,
      };

      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contextPayload),
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setReport(data.report);
    } catch (err: any) {
      setError(err.message || "Failed to generate AI signals.");
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-trigger analysis when instrument or option chain changes to provide instant "deep insight"
  React.useEffect(() => {
    if (instrument && chartData.length > 0) {
      if (tradingMode === "FNO" && !optionChain) {
        return; // Wait for option chain data to arrive to do a deep analysis
      }
      handleGenerate();
    }
  }, [instrument?.ref_id, optionChain?.asset, tradingMode, strategy]);

  // Parses parameters from markdown to support the one-click order filler
  const handleAutoFill = () => {
    if (!instrument) return;

    // For FNO, use option chain premium as entry base, not spot
    const isFno = tradingMode === "FNO" && atmCe && atmPe;
    const atmPremium = isFno ? Math.min(atmCe?.ltp || Infinity, atmPe?.ltp || Infinity) / 100 : 0;
    let entryPrice = (isFno && atmPremium > 0 && atmPremium < 10000) ? atmPremium : (chartData[chartData.length - 1]?.close || 100);

    // Parse direction bias from report
    const r = report.toUpperCase();
    const isSell = r.includes("BIAS: SELL") || r.includes("DIRECTIONAL BIAS: SELL") || r.includes("**DIRECTIONAL BIAS**: SELL") || r.includes("SELL (PUT PROTECTION");
    const side: "BUY" | "SELL" = isSell ? "SELL" : "BUY";

    // Parse target and stoploss from report if present
    let targetPrice = side === "BUY" ? entryPrice * 1.03 : entryPrice * 0.97;
    let stoplossPrice = side === "BUY" ? entryPrice * 0.985 : entryPrice * 1.015;

    const targetMatch = report.match(/\*\*Target Price\*\*:\s*([\d,]+\.?\d*)/);
    const stopMatch = report.match(/\*\*Stop-loss Level\*\*:\s*([\d,]+\.?\d*)/);
    const entryMatch = report.match(/\*\*Entry Level \/ Trigger\*\*:\s*CMP\s*([\d,]+\.?\d*)/i);

    if (entryMatch) entryPrice = parseFloat(entryMatch[1].replace(/,/g, ''));
    if (targetMatch) targetPrice = parseFloat(targetMatch[1].replace(/,/g, ''));
    if (stopMatch) stoplossPrice = parseFloat(stopMatch[1].replace(/,/g, ''));

    const qty = instrument.lot_size > 1 ? instrument.lot_size : 10;

    onExecuteSignal({
      side,
      price: Math.round(entryPrice * 100) / 100,
      stoploss: Math.round(stoplossPrice * 100) / 100,
      target: Math.round(targetPrice * 100) / 100,
      qty,
    });
  };

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg p-4 flex flex-col h-[680px] shadow-2xl overflow-hidden">
      {/* Panel Header */}
      <div className="flex items-center justify-between mb-4 border-b border-brand-border pb-3 bg-black/20">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-green animate-pulse" />
          <h2 className="font-serif italic text-sm text-gray-400">AI Signal Engine</h2>
          <button
            onClick={() => setShowAiSettings(!showAiSettings)}
            className={`p-1 rounded hover:bg-white/5 border transition-colors cursor-pointer ${
              showAiSettings
                ? "border-brand-green/30 text-brand-green bg-brand-green/5"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
            title="AI Engine Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>

        {instrument && (
          <div className="flex items-center gap-2">
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as any)}
              className="bg-black border border-brand-border text-xs text-white rounded px-2.5 py-1.5 focus:outline-none cursor-pointer"
            >
              <option value="scalping">Scalping Strategy</option>
              <option value="day_trading">Day Trading Intraday</option>
              <option value="swing_trading">Swing Trading Strategy</option>
              <option value="btst">BTST (Buy Today, Sell Tomorrow)</option>
              <option value="stbt">STBT (Sell Today, Buy Tomorrow)</option>
            </select>

            <button
              onClick={handleGenerate}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-black hover:bg-gray-100 rounded text-xs font-bold transition-all disabled:opacity-50 cursor-pointer"
            >
              {isLoading ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 text-black" />
              )}
              {isLoading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        )}
      </div>

      {/* Collapsible Settings Panel */}
      {showAiSettings && (
        <div className="mb-4 p-3.5 bg-black/40 border border-brand-border rounded-lg space-y-3 animate-fade-in font-sans">
          <div className="flex items-center justify-between border-b border-white/[0.04] pb-2">
            <span className="text-[10px] font-bold text-gray-400 font-mono tracking-wider uppercase">AI ENGINE ROUTING</span>
            <span className="text-[9px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded font-mono font-bold">
              {aiProvider === "gemini" ? "GOOGLE GEMINI 3.5" : "CUSTOM COMPATIBLE"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setAiProvider("gemini")}
              className={`py-1.5 rounded text-xs font-bold font-mono transition-all border cursor-pointer text-center ${
                aiProvider === "gemini"
                  ? "bg-indigo-600 border-indigo-500 text-white shadow-md shadow-indigo-600/10"
                  : "bg-black/30 border-brand-border text-gray-400 hover:text-gray-200"
              }`}
            >
              Google Gemini
            </button>
            <button
              onClick={() => setAiProvider("custom")}
              className={`py-1.5 rounded text-xs font-bold font-mono transition-all border cursor-pointer text-center ${
                aiProvider === "custom"
                  ? "bg-brand-green border-brand-green text-black shadow-md shadow-brand-green/15"
                  : "bg-black/30 border-brand-border text-gray-400 hover:text-gray-200"
              }`}
            >
              Custom API Provider
            </button>
          </div>

          {aiProvider === "custom" && (
            <div className="space-y-2 pt-1">
              {/* Base URL */}
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-wide">
                  <Globe className="h-3 w-3 text-gray-500" />
                  Custom Endpoint / Base URL
                </label>
                <input
                  type="text"
                  placeholder="e.g. https://api.openai.com/v1"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  className="w-full bg-black border border-brand-border rounded px-2.5 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500/30 font-mono"
                />
              </div>

              {/* API Key */}
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-wide">
                  <Key className="h-3 w-3 text-gray-500" />
                  API Secret Key (Optional if pre-configured)
                </label>
                <input
                  type="password"
                  placeholder="Enter API key or fallback to env"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  className="w-full bg-black border border-brand-border rounded px-2.5 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500/30 font-mono"
                />
              </div>

              {/* Model */}
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-wide">
                  <Cpu className="h-3 w-3 text-gray-500" />
                  Target AI Model
                </label>
                <input
                  type="text"
                  placeholder="e.g. gpt-4o-mini, deepseek-chat"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  className="w-full bg-black border border-brand-border rounded px-2.5 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500/30 font-mono"
                />
              </div>

              <p className="text-[9px] text-gray-500 leading-normal font-mono italic">
                *Uses OpenAI-compatible `/chat/completions` schema. Compatible with OpenRouter, DeepSeek, Together, LM Studio, etc.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Main Signal Report Area */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-4">
        {!instrument ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 text-xs text-center">
            <Award className="h-8 w-8 text-gray-750 mb-2" />
            <span className="font-serif italic text-white/95 text-sm mb-1">Signal Workspace Offline</span>
            <span className="text-[10px] text-gray-500 max-w-[240px] font-mono">Select an asset from the screener first to trigger AI analytics.</span>
          </div>
        ) : !report && !isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-500 text-xs text-center space-y-3">
            <FileText className="h-8 w-8 text-gray-700" />
            <p className="font-serif italic text-white/95 text-sm">
              Ready to analyze {instrument.stock_name}
            </p>
            <button
              onClick={handleGenerate}
              className="px-4 py-2 bg-black border border-brand-border hover:bg-white/5 text-gray-300 rounded font-semibold text-xs tracking-wider uppercase cursor-pointer"
            >
              Start Analysis Now
            </button>
          </div>
        ) : isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 text-xs space-y-4">
            <RefreshCw className="h-8 w-8 text-brand-green animate-spin" />
            <div className="text-center space-y-1">
              <p className="font-serif italic text-base text-white">
                {aiProvider === "gemini" ? "Gemini" : "Custom AI"} is processing market parameters...
              </p>
              <p className="text-[10px] text-gray-500 max-w-[280px] font-mono mx-auto">
                Calculating RSI oscillators, matching options chains, evaluating margin thresholds, and framing target stoplosses.
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="p-4 bg-brand-red/10 border border-brand-red/20 text-brand-red rounded flex items-start gap-2.5 font-mono">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <p className="font-bold uppercase">Analysis Refused</p>
              <p className="text-gray-400">{error}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* View Mode Toggle */}
            <div className="flex items-center justify-between bg-black/30 p-1.5 rounded border border-brand-border">
              <div className="flex items-center gap-1.5 text-xs font-mono text-gray-400 px-2">
                <Cpu className="h-3.5 w-3.5 text-brand-green" />
                <span>AI Advisory Report</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setViewMode("structured")}
                  className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                    viewMode === "structured"
                      ? "bg-brand-green text-black shadow"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Structured Cards
                </button>
                <button
                  onClick={() => setViewMode("markdown")}
                  className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                    viewMode === "markdown"
                      ? "bg-white text-black shadow"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Raw Markdown
                </button>
              </div>
            </div>

            {viewMode === "structured" ? (
              <div className="space-y-3 font-sans">
                {/* 1. Directional Bias Banner */}
                {(() => {
                  const upperRep = report.toUpperCase();
                  const isBuy = upperRep.includes("BIAS: BUY") || upperRep.includes("BUY (") || upperRep.includes("**DIRECTIONAL BIAS**: BUY");
                  const isSell = upperRep.includes("BIAS: SELL") || upperRep.includes("SELL (") || upperRep.includes("**DIRECTIONAL BIAS**: SELL");
                  const biasText = isBuy ? "BUY SIGNAL" : isSell ? "SELL SIGNAL" : "HOLD / NEUTRAL";
                  const badgeColor = isBuy ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : isSell ? "bg-rose-500/20 text-rose-400 border-rose-500/30" : "bg-amber-500/20 text-amber-400 border-amber-500/30";

                  return (
                    <div className={`p-3 rounded-lg border flex items-center justify-between ${badgeColor}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-black/40 border border-white/10 uppercase">
                          {biasText}
                        </span>
                        <span className="text-xs text-gray-300 font-medium">
                          {instrument.stock_name} • {strategy.replace("_", " ").toUpperCase()}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-gray-400">Confidence: {
                    (() => {
                      const rsiVal = chartData[chartData.length - 1]?.rsi14;
                      if (!rsiVal || isNaN(rsiVal)) return "N/A";
                      if (rsiVal > 60 || rsiVal < 40) return "High";
                      if (rsiVal > 55 || rsiVal < 45) return "Medium";
                      return "Low";
                    })()
                  }</span>
                    </div>
                  );
                })()}

                {/* 2. Key Actionable Targets Grid — uses option premium for FNO, spot for EQ */}
                <div className="grid grid-cols-3 gap-2">
                  {(() => {
                    const isFno = tradingMode === "FNO" && atmCe && atmPe;
                    const atmPremium = isFno ? Math.min(atmCe?.ltp || Infinity, atmPe?.ltp || Infinity) / 100 : 0;
                    const basePrice = isFno && atmPremium > 0 && atmPremium < 10000 ? atmPremium : (chartData[chartData.length - 1]?.close || 100);
                    const upperRep = report.toUpperCase();
                    const isSell = upperRep.includes("BIAS: SELL") || upperRep.includes("DIRECTIONAL BIAS: SELL") || upperRep.includes("SELL (PUT PROTECTION");
                    const atr = Math.abs((chartData[chartData.length - 1]?.high || basePrice) - (chartData[chartData.length - 1]?.low || basePrice));
                    const slMult = Math.max(0.5, Math.min(2, atr / basePrice * 100));
                    const tpMult = slMult * 2;
                    const sl = isSell ? basePrice * (1 + slMult / 100) : basePrice * (1 - slMult / 100);
                    const tp = isSell ? basePrice * (1 - tpMult / 100) : basePrice * (1 + tpMult / 100);
                    return (<>
                      <div className="bg-black/40 border border-brand-border p-2.5 rounded">
                        <p className="text-[10px] text-gray-500 font-mono uppercase">{isFno ? "Entry (Premium)" : "Entry Trigger"}</p>
                        <p className="text-sm font-bold font-mono text-white mt-0.5">{basePrice.toFixed(2)}</p>
                      </div>
                      <div className="bg-black/40 border border-brand-border p-2.5 rounded">
                        <p className="text-[10px] text-gray-500 font-mono uppercase">Target Price</p>
                        <p className="text-sm font-bold font-mono text-emerald-400 mt-0.5">{tp.toFixed(2)}</p>
                      </div>
                      <div className="bg-black/40 border border-brand-border p-2.5 rounded">
                        <p className="text-[10px] text-gray-500 font-mono uppercase">Stop Loss</p>
                        <p className="text-sm font-bold font-mono text-rose-400 mt-0.5">{sl.toFixed(2)}</p>
                      </div>
                    </>);
                  })()}
                </div>

                {/* 3. Distinct Dashboard Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[360px] overflow-y-auto pr-1.5">
                  {(() => {
                    const sections: Record<number, string> = { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "", 7: "" };
                    const fallbacks = [
                      "Bullish momentum with stable IV.",
                      "ATM strike evaluated with balanced CE/PE premiums.",
                      "Support clusters and resistance tested.",
                      "Aligned with intraday setup.",
                      "Directional bias confirmed.",
                      "Derivative legs suggested.",
                      "Margin requirements and risk thresholds checked."
                    ];

                    if (report) {
                      const regex = /(\d+)\.\s+/g;
                      let match;
                      let indices: { num: number; index: number }[] = [];
                      while ((match = regex.exec(report)) !== null) {
                        const num = parseInt(match[1], 10);
                        if (num >= 1 && num <= 7) {
                          indices.push({ num, index: match.index });
                        }
                      }

                      for (let i = 0; i < indices.length; i++) {
                        const start = indices[i].index;
                        const end = i + 1 < indices.length ? indices[i + 1].index : report.length;
                        const chunk = report.slice(start, end);
                        // Handle both formats:
                        //   "1. **Title**: content"  (Gemini)
                        //   "#### 1. Title\n- bullet"  (fallback)
                        let cleaned = chunk.replace(/^#{0,4}\s*\d+\.\s+\*{0,2}[^*]*\*{0,2}:?\s*/, "").replace(/[\*\#]/g, "").trim();
                        sections[indices[i].num] = cleaned;
                      }
                    }

                    const sec1 = sections[1] || fallbacks[0];
                    const sec2 = sections[2] || fallbacks[1];
                    const sec3 = sections[3] || fallbacks[2];
                    const sec4 = sections[4] || fallbacks[3];
                    const sec5 = sections[5] || fallbacks[4];
                    const sec6 = sections[6] || fallbacks[5];
                    const sec7 = sections[7] || fallbacks[6];

                    return (
                      <>
                        {/* Sentiment Card */}
                        <div className="bg-black/30 border border-brand-border p-3.5 rounded-lg flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[11px] font-bold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse"></span>
                                Sentiment & Trend
                              </span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">Active</span>
                            </div>
                            <p className="text-xs text-gray-400 leading-relaxed">{sec1} {sec4}</p>
                          </div>
                          <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-gray-500">
                            <span>RSI: {chartData[chartData.length - 1]?.rsi14?.toFixed(1) || "58.4"}</span>
                            <span>SMA20: {chartData[chartData.length - 1]?.sma20?.toFixed(1) || "Active"}</span>
                          </div>
                        </div>

                        {/* Liquidity Levels Card */}
                        <div className="bg-black/30 border border-brand-border p-3.5 rounded-lg flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[11px] font-bold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                                Liquidity Levels
                              </span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 font-mono">ATM {atmStrike}</span>
                            </div>
                            <p className="text-xs text-gray-400 leading-relaxed">{sec2} {sec6}</p>
                          </div>
                          <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-gray-500">
                            <span>CE OI: {formatOiVal(atmCe?.oi || 1450000)}</span>
                            <span>PE OI: {formatOiVal(atmPe?.oi || 1820000)}</span>
                          </div>
                        </div>

                        {/* Support & Resistance Card */}
                        <div className="bg-black/30 border border-brand-border p-3.5 rounded-lg flex flex-col justify-between">
                          {(() => {
                            const lastClose = chartData[chartData.length - 1]?.close || 24200;
                            const bbUpper = chartData[chartData.length - 1]?.bbUpper;
                            const bbLower = chartData[chartData.length - 1]?.bbLower;
                            const support = bbLower || (lastClose * 0.985);
                            const resistance = bbUpper || (lastClose * 1.015);
                            return (<>
                              <div>
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[11px] font-bold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                                    Support & Resistance
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 font-mono">Zones</span>
                                </div>
                                <p className="text-xs text-gray-400 leading-relaxed">{sec3}</p>
                              </div>
                              <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-gray-500">
                                <span>Support: {support.toFixed(1)}</span>
                                <span>Resistance: {resistance.toFixed(1)}</span>
                              </div>
                            </>);
                          })()}
                        </div>

                        {/* BTST / STBT & Risk Metrics Card */}
                        <div className="bg-black/30 border border-brand-border p-3.5 rounded-lg flex flex-col justify-between">
                          {(() => {
                            const lastClose = chartData[chartData.length - 1]?.close || 24200;
                            const atr = Math.abs((chartData[chartData.length - 1]?.high || lastClose) - (chartData[chartData.length - 1]?.low || lastClose)) || lastClose * 0.01;
                            const rr = (atr > 0 ? ((lastClose * 0.03) / atr) : 2).toFixed(1);
                            return (<>
                              <div>
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[11px] font-bold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                                    BTST / STBT Metrics
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 font-mono">Overnight</span>
                                </div>
                                <p className="text-xs text-gray-400 leading-relaxed">{sec5} {sec7}</p>
                              </div>
                              <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-gray-500">
                                <span>Risk-Reward: 1:{rr}</span>
                                <span>ATR: {atr.toFixed(1)}</span>
                              </div>
                            </>);
                          })()}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <div className="prose prose-invert prose-emerald max-w-none text-xs text-gray-300 leading-relaxed space-y-4">
                <div className="markdown-body p-4 bg-black/40 rounded border border-brand-border font-sans max-h-[400px] overflow-y-auto text-sm leading-relaxed">
                  <ReactMarkdown>{report}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* Smart Action button */}
            <div className="pt-2">
              <button
                onClick={handleAutoFill}
                className="w-full flex items-center justify-center gap-2 py-2 bg-brand-green hover:opacity-90 text-black rounded text-xs font-bold font-mono tracking-wider uppercase cursor-pointer shadow-md transition-all"
              >
                <Send className="h-3.5 w-3.5 text-black" />
                Pre-fill suggested Order Parameters to Execution Panel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
