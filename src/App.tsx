import React, { useState, useEffect } from "react";
import { LineChart, Sparkles, Landmark, RefreshCw, AlertCircle, Play, BarChart2, Layers, Zap, PanelRightClose, PanelRightOpen, Globe } from "lucide-react";
import TerminalHeader from "./components/TerminalHeader";
import Screener from "./components/Screener";
import MarketChart from "./components/MarketChart";
import OptionsWorkspace from "./components/OptionsWorkspace";
import AiAnalysis from "./components/AiAnalysis";
import OptionBuyingEngine from "./components/OptionBuyingEngine";
import OrderDesk from "./components/OrderDesk";
import OrderBook from "./components/OrderBook";
import Portfolio from "./components/Portfolio";
import Backtester from "./components/Backtester";
import GlobalSentiment from "./components/GlobalSentiment";
import { Instrument, Quote, Order, PortfolioSummary, ChartDataPoint } from "./types";
import { useMarketData } from "./context/MarketDataContext";

export default function App() {
  const {
    selectedInstrument,
    setSelectedInstrument,
    chartData,
    setChartData,
    optionChainData,
    setOptionChainData,
  } = useMarketData();

  // Login & auth
  const [loginState, setLoginState] = useState({
    status: "NOT_LOGGED_IN",
    error: "",
    phone: "",
    deviceId: "",
    env: "",
    baseUrl: "",
  });
  const [isRefreshingLogin, setIsRefreshingLogin] = useState(false);

  // Active state
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [quotes, setQuotes] = useState<Record<number, { price: number; prev_close: number; change: number }>>({});
  const [selectedInterval, setSelectedInterval] = useState("5m");
  const [tradingMode, setTradingMode] = useState<"EQ" | "FNO" | "NONE">("NONE");


  // Portfolio, Orders & Execution
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [orders, setOrders] = useState<any>(null);
  const [prefillParams, setPrefillParams] = useState<any>(null);

  // Layout Tab togglers
  const [mainRightTab, setMainRightTab] = useState<"ANALYSIS" | "BUYING_ENGINE" | "BACKTEST">("ANALYSIS");
  const [centerTab, setCenterTab] = useState<"CHART" | "OPTIONS">("CHART");
  const [showScreener, setShowScreener] = useState(true);
  const [showGlobalSentiment, setShowGlobalSentiment] = useState(false);

  // Loading states
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  const [isLoadingChart, setIsLoadingChart] = useState(false);

  // Fetch auth status
  const fetchAuthStatus = async () => {
    try {
      const res = await fetch("/api/auth/status");
      if (res.ok) {
        setLoginState(await res.json());
      }
    } catch (_) {}
  };

  // Perform manual login trigger
  const handleRefreshLogin = async () => {
    setIsRefreshingLogin(true);
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setLoginState(data.state);
        fetchPortfolio();
        fetchOrders();
      } else {
        setLoginState(data.state || { ...loginState, status: "FAILED", error: data.error });
      }
    } catch (err: any) {
      setLoginState({ ...loginState, status: "FAILED", error: err.message });
    } finally {
      setIsRefreshingLogin(false);
    }
  };

  // Fetch master instruments
  const fetchInstruments = async () => {
    try {
      const res = await fetch("/api/market/instruments");
      if (res.ok) {
        const data = await res.json();
        setInstruments(data);
        // Do not auto-select an instrument on startup, so no analysis or chart is loaded initially
      }
    } catch (_) {}
  };

  // Fetch portfolio summary
  const fetchPortfolio = async () => {
    try {
      const res = await fetch("/api/portfolio/summary");
      if (res.ok) {
        setPortfolio(await res.json());
      }
    } catch (_) {}
  };

  // Fetch orders lists
  const fetchOrders = async () => {
    try {
      const res = await fetch("/api/orders");
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setOrders(data.orders);
        }
      }
    } catch (_) {}
  };

  // Fetch quotes for all loaded instruments sequentially to prevent concurrent request spikes
  const fetchAllQuotes = async () => {
    if (instruments.length === 0) return;
    setIsLoadingQuotes(true);
    try {
      const updatedQuotes: Record<number, any> = {};
      const batch = instruments.slice(0, 15);
      for (const inst of batch) {
        try {
          const res = await fetch(`/api/market/quote/${inst.ref_id}`);
          if (res.ok) {
            const data = await res.json();
            updatedQuotes[inst.ref_id] = {
              price: data.price,
              prev_close: data.prev_close,
              change: data.change,
            };
          }
        } catch (_) {}
      }
      setQuotes((prev) => ({ ...prev, ...updatedQuotes }));
    } catch (_) {
    } finally {
      setIsLoadingQuotes(false);
    }
  };

  // Fetch option chain for active instrument
  const fetchOptionChain = async () => {
    if (!selectedInstrument) return;
    const activeSymbol = selectedInstrument.asset || "NIFTY";
    try {
      const res = await fetch(`/api/market/optionchain/${activeSymbol}`);
      if (res.ok) {
        const data = await res.json();
        setOptionChainData(data.chain);
      }
    } catch (_) {}
  };

  // Fetch historical charts for active instrument
  const fetchHistoricalChart = async () => {
    if (!selectedInstrument) return;
    setIsLoadingChart(true);
    try {
      const res = await fetch("/api/market/historical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedInstrument.stock_name,
          interval: selectedInterval,
          exchange: selectedInstrument.exchange,
          length: 120,
        }),
      });
      if (res.ok) {
        setChartData(await res.json());
      }
    } catch (_) {
    } finally {
      setIsLoadingChart(false);
    }
  };

  // Cancel selected order
  const handleCancelOrder = async (orderId: number) => {
    try {
      const res = await fetch("/api/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      if (res.ok) {
        fetchOrders();
        fetchPortfolio();
      }
    } catch (_) {}
  };

  // Load baseline on mount
  useEffect(() => {
    fetchAuthStatus();
    fetchInstruments();
    fetchPortfolio();
    fetchOrders();
  }, []);

  // Update quotes when instruments load
  useEffect(() => {
    if (instruments.length > 0) {
      fetchAllQuotes();
    }
  }, [instruments]);

  // Update historical chart and option chain sequentially on active instrument or interval shifts (Chart first, then Option Chain)
  useEffect(() => {
    fetchHistoricalChart();
    const timer = setTimeout(() => {
      fetchOptionChain();
    }, 800);
    return () => clearTimeout(timer);
  }, [selectedInstrument, selectedInterval]);

  // Polling loop for live quote updates (every 10 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchAllQuotes();
      fetchPortfolio();
      fetchOrders();
    }, 10000);
    return () => clearInterval(interval);
  }, [instruments]);

  // Pre-fill parameters passed from AI signals to Order Desk
  const handleExecuteSignal = (params: any) => {
    setPrefillParams(params);
  };

  if (tradingMode === "NONE") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased select-none">
        {/* Dynamic Header */}
        <TerminalHeader
          loginState={loginState}
          portfolio={portfolio}
          onRefreshLogin={handleRefreshLogin}
          isRefreshingLogin={isRefreshingLogin}
        />

        {/* Workspace selector container */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 max-w-4xl mx-auto w-full">
          <div className="text-center space-y-3 mb-10 max-w-2xl">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 rounded-full font-mono text-[10px] uppercase tracking-wider">
              <Layers className="h-3 w-3 animate-pulse" />
              OMS v3 Gateway Active
            </div>
            <h2 className="font-serif italic text-4xl text-white font-bold tracking-tight">
              Choose Your Execution Workspace
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Select a segment to initialize the specialized trading dashboard. You can switch between equity and derivatives segments anytime from the workspace header.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
            {/* Stocks EQ Card */}
            <button
              onClick={() => {
                setTradingMode("EQ");
                const firstStock = instruments.find((i) => i.derivative_type === "STOCK");
                if (firstStock) {
                  setSelectedInstrument(firstStock);
                }
                setCenterTab("CHART");
              }}
              className="group relative bg-slate-900 border border-slate-800 hover:border-indigo-500/50 hover:shadow-[0_0_24px_rgba(99,102,241,0.15)] p-8 rounded-2xl text-left transition-all duration-300 flex flex-col justify-between h-[340px] cursor-pointer"
            >
              <div className="space-y-4">
                <div className="h-12 w-12 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300">
                  <LineChart className="h-6 w-6" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    STOCKS EQ
                    <span className="text-[10px] px-2 py-0.5 bg-black border border-slate-800 text-indigo-400 font-mono rounded">
                      Spot Shares
                    </span>
                  </h3>
                  <p className="text-slate-400 text-xs leading-relaxed">
                    Trade cash equity segments on liquid shares. Features advanced real-time technical charts, multi-interval price trends, automated indicator screening (RSI, SMA, EMA), and high-performance order execution desks.
                  </p>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-800/60 flex items-center justify-between">
                <span className="text-indigo-400 font-mono text-xs font-bold tracking-wide uppercase group-hover:translate-x-1 transition-transform">
                  Launch Cash Equity Workspace &rarr;
                </span>
                <span className="text-[10px] text-slate-500 font-mono">6 active counters</span>
              </div>
            </button>

            {/* Future & Options Card */}
            <button
              onClick={() => {
                setTradingMode("FNO");
                const niftyInst = instruments.find((i) => i.asset === "NIFTY" && i.derivative_type !== "OPT") || {
                  ref_id: 1497712,
                  token: 1497712,
                  stock_name: "NIFTY",
                  asset: "NIFTY",
                  option_type: "N/A",
                  strike_price: 0,
                  lot_size: 75,
                  exchange: "NSE",
                  derivative_type: "STOCK",
                  tick_size: 5,
                  underlying_prev_close: 2421100,
                  expiry: 0,
                };
                setSelectedInstrument(niftyInst);
                setCenterTab("OPTIONS");
              }}
              className="group relative bg-slate-900 border border-slate-800 hover:border-emerald-500/50 hover:shadow-[0_0_24px_rgba(16,185,129,0.15)] p-8 rounded-2xl text-left transition-all duration-300 flex flex-col justify-between h-[340px] cursor-pointer"
            >
              <div className="space-y-4">
                <div className="h-12 w-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:bg-emerald-500 group-hover:text-black transition-all duration-300">
                  <Layers className="h-6 w-6" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    FUTURE & OPTIONS (F&O)
                    <span className="text-[10px] px-2 py-0.5 bg-black border border-slate-800 text-emerald-400 font-mono rounded">
                      Derivatives
                    </span>
                  </h3>
                  <p className="text-slate-400 text-xs leading-relaxed">
                    Access rich option chain hubs for key market indices and individual stocks. Build preset multi-leg option strategies (Spreads, Condors, Straddles), visualize Delta/Theta greeks, and query Gemini AI for complex option chain insights.
                  </p>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-800/60 flex items-center justify-between">
                <span className="text-emerald-400 font-mono text-xs font-bold tracking-wide uppercase group-hover:translate-x-1 transition-transform">
                  Launch Option Chain & Greeks Hub &rarr;
                </span>
                <span className="text-[10px] text-slate-500 font-mono">Index & Stocks Chains</span>
              </div>
            </button>
          </div>
        </div>

        <footer className="bg-slate-950 border-t border-slate-900 py-3 text-center text-[10px] text-slate-600 font-mono">
          OMS V3 Integration Session: NQ001 • PROD Gateways Ready • UAT Fallbacks Loaded
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased select-none">
      {/* Dynamic Header */}
      <TerminalHeader
        loginState={loginState}
        portfolio={portfolio}
        onRefreshLogin={handleRefreshLogin}
        isRefreshingLogin={isRefreshingLogin}
      />

      {/* Main Terminal Workspace */}
      <main className="flex-1 w-full mx-auto p-3 space-y-3 overflow-x-hidden">
        {/* Workspace Mode Persistent Banner / Toggle */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 bg-slate-900/80 border border-slate-800 rounded-2xl backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${
              tradingMode === "EQ" 
                ? "bg-indigo-600/10 text-indigo-400 border border-indigo-500/20" 
                : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
            }`}>
              {tradingMode === "EQ" ? <LineChart className="h-5 w-5" /> : <Layers className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-white tracking-tight text-sm sm:text-base">
                  {tradingMode === "EQ" ? "Cash Equity Workspace" : "Derivatives Option Chain Hub"}
                </h2>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                  tradingMode === "EQ" ? "bg-indigo-600/10 text-indigo-400 border border-indigo-500/15" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/15"
                }`}>
                  {tradingMode === "EQ" ? "EQ SEGMENT" : "F&O SEGMENT"}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {tradingMode === "EQ" 
                  ? "Trading direct cash stocks. Monitoring SMA/EMA crossovers, Bollinger reversals and volume breakouts." 
                  : `Active Option Chain & Greeks for ${selectedInstrument?.asset || "NIFTY"}. Monitoring spot LTP and strike open interest.`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => {
                setTradingMode("EQ");
                const firstStock = instruments.find((i) => i.derivative_type === "STOCK");
                if (firstStock) {
                  setSelectedInstrument(firstStock);
                }
                setCenterTab("CHART");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono tracking-wide uppercase transition-all duration-150 cursor-pointer ${
                tradingMode === "EQ"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <LineChart className="h-3.5 w-3.5" />
              Stocks EQ
            </button>
            <button
              onClick={() => {
                setTradingMode("FNO");
                const niftyInst = instruments.find((i) => i.asset === "NIFTY" && i.derivative_type !== "OPT") || {
                  ref_id: 1497712,
                  token: 1497712,
                  stock_name: "NIFTY",
                  asset: "NIFTY",
                  option_type: "N/A",
                  strike_price: 0,
                  lot_size: 75,
                  exchange: "NSE",
                  derivative_type: "STOCK",
                  tick_size: 5,
                  underlying_prev_close: 2421100,
                  expiry: 0,
                };
                setSelectedInstrument(niftyInst);
                setCenterTab("OPTIONS");
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono tracking-wide uppercase transition-all duration-150 cursor-pointer ${
                tradingMode === "FNO"
                  ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              Future & Options
            </button>
            <button
              onClick={() => setShowGlobalSentiment(!showGlobalSentiment)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono tracking-wide uppercase transition-all duration-150 cursor-pointer ${
                showGlobalSentiment
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              Global
            </button>
          </div>
        </div>

        {showGlobalSentiment && <GlobalSentiment />}

        {/* Upper Bento Grid */}
        <div className="flex gap-3 items-start">
          {/* Left Rail - Screener Collapsible */}
          {showScreener ? (
            <div className="w-[260px] shrink-0">
              <div className="flex items-center justify-end mb-1">
                <button onClick={() => setShowScreener(false)} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white cursor-pointer" title="Hide Screener">
                  <PanelRightClose className="h-3.5 w-3.5" />
                </button>
              </div>
              <Screener
                instruments={instruments}
                selectedInstrument={selectedInstrument}
                onSelectInstrument={(inst) => {
                  setSelectedInstrument(inst);
                  setCenterTab("CHART");
                  if (tradingMode === "FNO") {
                    setTimeout(() => setCenterTab("OPTIONS"), 1200);
                  }
                }}
                quotes={quotes}
                onRefreshQuotes={fetchAllQuotes}
                isLoading={isLoadingQuotes}
                tradingMode={tradingMode}
              />
            </div>
          ) : (
            <button onClick={() => setShowScreener(true)} className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-white shrink-0 mt-1 cursor-pointer" title="Show Screener">
              <PanelRightOpen className="h-4 w-4" />
            </button>
          )}

          {/* Center Space - Charting Engine or Options Hub */}
          <div className="flex-[2] flex flex-col gap-3 min-w-0 max-w-[55%]">
            {/* Center Tab Swappers */}
            <div className="flex gap-1.5 bg-slate-900 border border-slate-800 p-1 rounded-xl">
              <button
                onClick={() => setCenterTab("CHART")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  centerTab === "CHART"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <LineChart className="h-3.5 w-3.5" />
                Technical Chart
              </button>
              <button
                onClick={() => setCenterTab("OPTIONS")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  centerTab === "OPTIONS"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                Options Hub & Greeks
              </button>
            </div>

            {centerTab === "CHART" ? (
              <MarketChart
                chartData={chartData}
                instrument={selectedInstrument}
                selectedInterval={selectedInterval}
                onChangeInterval={setSelectedInterval}
              />
            ) : (
              <OptionsWorkspace
                instrument={selectedInstrument}
                onPrefillOrder={handleExecuteSignal}
                onChainDataLoaded={(chain) => setOptionChainData(chain)}
              />
            )}
          </div>

          {/* Right Space - AI & Backtester Workspace */}
          <div className="w-[380px] min-w-[340px] flex-1 flex flex-col gap-3">
            {/* Tab Swappers */}
            <div className="grid grid-cols-3 gap-0.5 bg-slate-900 border border-slate-800 p-1 rounded-xl">
              <button
                onClick={() => setMainRightTab("ANALYSIS")}
                className={`flex items-center justify-center gap-1 py-1.5 text-[11px] font-bold rounded-lg transition-all ${
                  mainRightTab === "ANALYSIS"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Sparkles className="h-3 w-3" />
                AI Signals
              </button>
              <button
                onClick={() => setMainRightTab("BUYING_ENGINE")}
                className={`flex items-center justify-center gap-1 py-1.5 text-[11px] font-bold rounded-lg transition-all ${
                  mainRightTab === "BUYING_ENGINE"
                    ? "bg-emerald-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Zap className="h-3 w-3" />
                Option Buying
              </button>
              <button
                onClick={() => setMainRightTab("BACKTEST")}
                className={`flex items-center justify-center gap-1 py-1.5 text-[11px] font-bold rounded-lg transition-all ${
                  mainRightTab === "BACKTEST"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <BarChart2 className="h-3 w-3" />
                Backtester
              </button>
            </div>

            {mainRightTab === "ANALYSIS" ? (
              <AiAnalysis
                instrument={selectedInstrument}
                chartData={chartData}
                portfolio={portfolio}
                onExecuteSignal={handleExecuteSignal}
                optionChain={tradingMode === "FNO" ? optionChainData : null}
                tradingMode={tradingMode}
              />
            ) : mainRightTab === "BUYING_ENGINE" ? (
              <OptionBuyingEngine
                instrument={selectedInstrument}
                chartData={chartData}
                optionChain={optionChainData}
                onExecuteSignal={handleExecuteSignal}
                onRefresh={() => { fetchOptionChain(); fetchHistoricalChart(); }}
              />
            ) : (
              <Backtester selectedInstrument={selectedInstrument} selectedInterval={selectedInterval} />
            )}
          </div>
        </div>

        {/* Lower Bento Grid - Order Management & Account Positions */}
        <div className="flex gap-3">
          {/* Order Desk */}
          <div className="flex-1 min-w-0">
            <OrderDesk
              selectedInstrument={selectedInstrument}
              instruments={instruments}
              onOrderPlaced={() => {
                fetchOrders();
                fetchPortfolio();
                setPrefillParams(null); // reset pre-fill state
              }}
              prefillParams={prefillParams}
            />
          </div>

          {/* Active Ledger / Order Book */}
          <div className="flex-1 min-w-0">
            <OrderBook orders={orders} onCancelOrder={handleCancelOrder} isLoading={false} />
          </div>

          {/* Live Portfolio Positions & Holdings */}
          <div className="flex-1 min-w-0">
            <Portfolio portfolio={portfolio} />
          </div>
        </div>
      </main>

      {/* Footer Meta Credits */}
      <footer className="bg-slate-950 border-t border-slate-900 py-3 text-center text-[10px] text-slate-600 font-mono">
        OMS V3 Integration Session: NQ001 • PROD Gateways Ready • UAT Fallbacks Loaded
      </footer>
    </div>
  );
}
