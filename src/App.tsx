import React, { useState, useEffect, useCallback, useMemo, useRef, Component, ErrorInfo, ReactNode } from "react";
import { LineChart, Sparkles, Landmark, RefreshCw, AlertCircle, Play, BarChart2, Layers, Zap, PanelLeftOpen, PanelLeftClose, Globe, Activity } from "lucide-react";
import TerminalHeader from "./components/TerminalHeader";
import SpotOHLCTracker from "./components/SpotOHLCTracker";
import Screener from "./components/Screener";
import MarketChart from "./components/MarketChart";
import OptionsWorkspace from "./components/OptionsWorkspace";
import AiAnalysis from "./components/AiAnalysis";
import OptionBuyingEngine from "./components/OptionBuyingEngine";
import OrderDesk from "./components/OrderDesk";
import OrderBook from "./components/OrderBook";
import Portfolio from "./components/Portfolio";
import Backtester from "./components/Backtester";
import ScalperDashboard from "./components/ScalperDashboard";
import GlobalSentiment from "./components/GlobalSentiment";
import { Instrument, Quote, Order, PortfolioSummary, ChartDataPoint, OptionChainData } from "./types";
import { useMarketData } from "./context/MarketDataContext";
import PanelResizer from "./components/PanelResizer";
import { useWebSocketQuotes } from "./context/useWebSocketQuotes";
import { useDragReorder } from "./hooks/useDragReorder";

// ErrorBoundary: keeps the app alive when a child panel crashes
class PanelErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PanelErrorBoundary]", error.message, info.componentStack);
  }
  render() {
    if (this.state.hasError) return this.props.fallback || (
      <div className="p-4 text-center text-slate-500 text-xs font-mono">
        <span className="text-red-400 block mb-1">⚠ Panel crashed</span>
        <button onClick={() => this.setState({ hasError: false })}
          className="text-indigo-400 hover:text-indigo-300 underline cursor-pointer">Retry</button>
      </div>
    );
    return this.props.children;
  }
}

const LandingPage = ({
  instruments,
  persistTradingMode,
  setSelectedInstrument,
  setCenterTab
}: {
  instruments: Instrument[];
  persistTradingMode: (mode: "EQ" | "FNO" | "NONE") => void;
  setSelectedInstrument: (inst: Instrument) => void;
  setCenterTab: (tab: "CHART" | "OPTIONS") => void;
}) => (
  <div className="min-h-screen bg-[#0a0a14] text-slate-100 flex flex-col font-sans antialiased select-none">
    <TerminalHeader loginState={{ status: "NOT_LOGGED_IN", error: "", phone: "", deviceId: "", env: "", baseUrl: "" }} portfolio={null} onRefreshLogin={() => {}} isRefreshingLogin={false} />
    <div className="flex-1 flex flex-col items-center justify-center p-6 max-w-5xl mx-auto w-full">
      <div className="text-center space-y-4 mb-12 max-w-2xl">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 rounded-full font-mono text-[10px] uppercase tracking-wider">
          <Layers className="h-3 w-3" />
          OMS v3 Gateway Active
        </div>
        <h2 className="font-serif italic text-5xl text-white font-bold tracking-tight leading-tight">Choose Your Execution Workspace</h2>
        <p className="text-slate-400 text-sm leading-relaxed">Select a segment to initialize the specialized trading dashboard. You can switch between equity and derivatives segments anytime from the workspace header.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
        <button
          onClick={() => {
            persistTradingMode("EQ");
            const firstStock = instruments.find((i) => i.derivative_type === "STOCK");
            if (firstStock) setSelectedInstrument(firstStock);
            setCenterTab("CHART");
          }}
          className="group relative glass-surface glass-hover p-8 rounded-2xl text-left transition-all duration-300 flex flex-col justify-between h-[340px] cursor-pointer hover:shadow-[0_0_32px_rgba(99,102,241,0.20)]"
        >
          <div className="space-y-4">
            <div className="h-12 w-12 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300">
              <LineChart className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                STOCKS EQ
                <span className="text-[10px] px-2 py-0.5 bg-black/40 border border-white/6 text-indigo-400 font-mono rounded">Spot Shares</span>
              </h3>
              <p className="text-slate-400 text-sm leading-relaxed">Trade cash equity segments on liquid shares. Features advanced real-time technical charts, multi-interval price trends, automated indicator screening (RSI, SMA, EMA), and high-performance order execution desks.</p>
            </div>
          </div>
          <div className="pt-6 border-t border-white/6 flex items-center justify-between">
            <span className="text-indigo-400 font-mono text-xs font-bold tracking-wide uppercase group-hover:translate-x-1 transition-transform">Launch Cash Equity Workspace &rarr;</span>
            <span className="text-[10px] text-slate-500 font-mono">6 active counters</span>
          </div>
        </button>
        <button
          onClick={() => {
            persistTradingMode("FNO");
            const niftyInst = instruments.find((i) => i.asset === "NIFTY" && i.derivative_type !== "OPT") || {
              ref_id: 1497712, token: 1497712, stock_name: "NIFTY", asset: "NIFTY", option_type: "N/A",
              strike_price: 0, lot_size: 75, exchange: "NSE", derivative_type: "STOCK", tick_size: 5,
              underlying_prev_close: 2421100, expiry: 0,
            };
            setSelectedInstrument(niftyInst);
            setCenterTab("OPTIONS");
          }}
          className="group relative glass-surface glass-hover p-8 rounded-2xl text-left transition-all duration-300 flex flex-col justify-between h-[340px] cursor-pointer hover:shadow-[0_0_32px_rgba(16,185,129,0.20)]"
        >
          <div className="space-y-4">
            <div className="h-12 w-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:bg-emerald-500 group-hover:text-black transition-all duration-300">
              <Layers className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                FUTURE & OPTIONS (F&O)
                <span className="text-[10px] px-2 py-0.5 bg-black/40 border border-white/6 text-emerald-400 font-mono rounded">Derivatives</span>
              </h3>
              <p className="text-slate-400 text-sm leading-relaxed">Access rich option chain hubs for key market indices and individual stocks. Build preset multi-leg option strategies (Spreads, Condors, Straddles), visualize Delta/Theta greeks, and query Gemini AI for complex option chain insights.</p>
            </div>
          </div>
          <div className="pt-6 border-t border-white/6 flex items-center justify-between">
            <span className="text-emerald-400 font-mono text-xs font-bold tracking-wide uppercase group-hover:translate-x-1 transition-transform">Launch Option Chain & Greeks Hub &rarr;</span>
            <span className="text-[10px] text-slate-500 font-mono">Index & Stocks Chains</span>
          </div>
        </button>
      </div>
    </div>
    <footer className="glass-base border-t border-white/6 py-3 text-center text-[10px] text-slate-600 font-mono">
      OMS V3 Integration Session: NQ001 • PROD Gateways Ready • UAT Fallbacks Loaded
    </footer>
  </div>
);

const MainWorkspace = ({
  tradingMode, persistTradingMode, setSelectedInstrument, setCenterTab, setShowScreener, setShowGlobalSentiment,
  selectedInstrument, instruments, setInstruments, quotes, setQuotes, premium, setPremium,
  selectedInterval, setSelectedInterval, chartData, setChartData, optionChainData, setOptionChainData,
  loginState, setLoginState, isRefreshingLogin, setIsRefreshingLogin, portfolio, setPortfolio,
  orders, setOrders, prefillParams, setPrefillParams, mainRightTab, setMainRightTab,
  centerTab, showScreener, showGlobalSentiment, leftPanelWidth, setLeftPanelWidth,
  rightPanelWidth, setRightPanelWidth, panelMin, panelMax, fnoIndexInstruments,
  handleSelectOptionInstrument, fetchAuthStatus, handleRefreshLogin, fetchInstruments,
  fetchPortfolio, fetchOrders, fetchAllQuotes, fetchOptionChain, fetchHistoricalChart,
  handleCancelOrder, handleExecuteSignal, isLoadingQuotes
}: any) => {
  const [rightPanelOrder, rp, rpReset] = useDragReorder("right-tabs", ["ANALYSIS", "BUYING_ENGINE", "BACKTEST", "SCALPER"] as const);
  const [bottomPanelOrder, bp, bpReset] = useDragReorder("bottom-panels", ["ORDERDESK", "ORDERBOOK", "PORTFOLIO"] as const);

  const RTAB: Record<string, { label: string; icon: React.ReactNode }> = {
    ANALYSIS: { label: "AI Signals", icon: <Sparkles className="h-3 w-3" /> },
    BUYING_ENGINE: { label: "Option Buying", icon: <Zap className="h-3 w-3" /> },
    BACKTEST: { label: "Backtester", icon: <BarChart2 className="h-3 w-3" /> },
    SCALPER: { label: "Scalper", icon: <Activity className="h-3 w-3" /> },
  };
  const renderTab = (key: string) => {
    switch (key) {
      case "ANALYSIS": return <AiAnalysis instrument={selectedInstrument} chartData={chartData} portfolio={portfolio} onExecuteSignal={handleExecuteSignal} optionChain={tradingMode === "FNO" ? optionChainData : null} tradingMode={tradingMode} />;
      case "BUYING_ENGINE": return <OptionBuyingEngine instrument={selectedInstrument} chartData={chartData} optionChain={optionChainData} onExecuteSignal={handleExecuteSignal} onRefresh={() => { fetchOptionChain(); fetchHistoricalChart(); }} />;
      case "BACKTEST": return <Backtester selectedInstrument={selectedInstrument} selectedInterval={selectedInterval} onIntervalChange={setSelectedInterval} />;
      case "SCALPER": return <ScalperDashboard quotes={quotes} premium={premium} fnoInstruments={fnoIndexInstruments} />;
      default: return null;
    }
  };
  const BPANEL: Record<string, React.ReactNode> = {
    ORDERDESK: <OrderDesk selectedInstrument={selectedInstrument} instruments={instruments} onOrderPlaced={() => { fetchOrders(); fetchPortfolio(); setPrefillParams(null); }} prefillParams={prefillParams} />,
    ORDERBOOK: <OrderBook orders={orders} onCancelOrder={handleCancelOrder} isLoading={false} />,
    PORTFOLIO: <Portfolio portfolio={portfolio} />,
  };
  return (
  <div className="min-h-screen bg-[#0a0a14] text-slate-100 flex flex-col font-sans antialiased select-none">
    <TerminalHeader loginState={loginState} portfolio={portfolio} onRefreshLogin={handleRefreshLogin} isRefreshingLogin={isRefreshingLogin} />
    <SpotOHLCTracker selectedInstrument={selectedInstrument} onSelectInstrument={(inst) => handleSelectOptionInstrument(inst.asset)} />
    <main className="flex-1 w-full mx-auto p-3 space-y-3 overflow-x-hidden">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 glass-surface rounded-2xl">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowScreener(!showScreener)}
            className={`p-2 rounded-lg transition-all cursor-pointer ${
              showScreener
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
            }`}
            title={showScreener ? "Collapse Screener" : "Expand Screener"}
          >
            {showScreener ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
          </button>
          <div className={`p-2 rounded-lg ${tradingMode === "EQ" ? "bg-indigo-600/10 text-indigo-400 border border-indigo-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"}`}>
            {tradingMode === "EQ" ? <LineChart className="h-5 w-5" /> : <Layers className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-white tracking-tight text-sm sm:text-base">{tradingMode === "EQ" ? "Cash Equity Workspace" : "Derivatives Option Chain Hub"}</h2>
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${tradingMode === "EQ" ? "bg-indigo-600/10 text-indigo-400 border border-indigo-500/15" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/15"}`}>
                {tradingMode === "EQ" ? "EQ SEGMENT" : "F&O SEGMENT"}
              </span>
            </div>
            <p className="text-xs text-slate-400">{tradingMode === "EQ" ? "Trading direct cash stocks. Monitoring SMA/EMA crossovers, Bollinger reversals and volume breakouts." : `Active Option Chain & Greeks for ${selectedInstrument?.asset || "NIFTY"}. Monitoring spot LTP and strike open interest.`}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-black/40 p-1 rounded-xl border border-white/6">
          <button onClick={() => { persistTradingMode("EQ"); const firstStock = instruments.find((i) => i.derivative_type === "STOCK"); if (firstStock) setSelectedInstrument(firstStock); setCenterTab("CHART"); }} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono tracking-wide uppercase transition-all duration-150 cursor-pointer ${tradingMode === "EQ" ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20" : "text-slate-400 hover:text-slate-200"}`}><LineChart className="h-3.5 w-3.5" /> Stocks EQ</button>
          <button onClick={() => { persistTradingMode("FNO"); const niftyInst = instruments.find((i) => i.asset === "NIFTY" && i.derivative_type !== "OPT") || { ref_id: 1497712, token: 1497712, stock_name: "NIFTY", asset: "NIFTY", option_type: "N/A", strike_price: 0, lot_size: 75, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 2421100, expiry: 0 }; setSelectedInstrument(niftyInst); setCenterTab("OPTIONS"); }} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono tracking-wide uppercase transition-all duration-150 cursor-pointer ${tradingMode === "FNO" ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20" : "text-slate-400 hover:text-slate-200"}`}><Layers className="h-3.5 w-3.5" /> Future & Options</button>
          {/* Link to /scalper removed per 41 revert */}
        </div>
      </div>

      <div className="flex-1 flex flex-row gap-3 h-auto lg:h-[calc(100vh-180px)] lg:min-h-[600px]">
        {/* Screener Sidebar - collapsible */}
        {showScreener && (
          <div style={{ width: leftPanelWidth }} className="w-full lg:w-auto flex-1 min-w-0 max-w-[400px] flex flex-col gap-3 relative">
            <Screener instruments={instruments} quotes={quotes} onSelectInstrument={setSelectedInstrument} selectedInstrument={selectedInstrument} onRefreshQuotes={fetchAllQuotes} isLoading={isLoadingQuotes} tradingMode={tradingMode} />
            {showGlobalSentiment && <GlobalSentiment />}
          </div>
        )}
        {/* Collapsed sidebar toggle */}
        {!showScreener && (
          <div className="absolute left-3 top-20 z-10">
            <button
              onClick={() => setShowScreener(true)}
              className="glass-surface border border-brand-border rounded-r-lg p-2 lg:hidden"
              title="Expand Screener"
            >
              <PanelLeftOpen className="h-5 w-5 text-emerald-400" />
            </button>
          </div>
        )}
        <span className="hidden lg:inline"><PanelResizer side="left" minW={panelMin.left} maxW={panelMax.left} leftPanelWidth={leftPanelWidth} rightPanelWidth={rightPanelWidth} onResizeLeft={setLeftPanelWidth} onResizeRight={setRightPanelWidth} /></span>
        <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-y-auto max-w-[650px]">
          <PanelErrorBoundary>
            {centerTab === "CHART" ? (
              <MarketChart chartData={chartData} instrument={selectedInstrument} selectedInterval={selectedInterval} onChangeInterval={setSelectedInterval} />
            ) : (
              <OptionsWorkspace instrument={selectedInstrument} onPrefillOrder={handleExecuteSignal} onChainDataLoaded={(chain) => setOptionChainData(chain)} fnoInstruments={fnoIndexInstruments} onSelectInstrument={handleSelectOptionInstrument} />
            )}
          </PanelErrorBoundary>
        </div>
        <span className="hidden lg:inline"><PanelResizer side="right" minW={panelMin.right} maxW={panelMax.right} leftPanelWidth={leftPanelWidth} rightPanelWidth={rightPanelWidth} onResizeLeft={setLeftPanelWidth} onResizeRight={setRightPanelWidth} /></span>
        <div style={{ width: rightPanelWidth }} className="w-full lg:w-auto lg:min-w-[280px] lg:flex-1 flex flex-col gap-3 overflow-y-auto">
          <div className="flex items-center gap-1">
            <div className="grid grid-cols-4 gap-0.5 glass-surface-sm p-1 rounded-xl flex-1">
              {rightPanelOrder.map((key, i) => (
                <button key={key}
                  draggable
                  onDragStart={rp.onDragStart(i)}
                  onDragOver={rp.onDragOver(i)}
                  onDragEnd={rp.onDragEnd}
                  onClick={() => setMainRightTab(key as any)}
                  className={`flex items-center justify-center gap-1 py-2 text-[10px] lg:text-[11px] min-h-[40px] font-bold rounded-lg transition-all cursor-grab active:cursor-grabbing ${mainRightTab === key ? "bg-indigo-600 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}>
                  {RTAB[key].icon} {RTAB[key].label}
                </button>
              ))}
            </div>
            <button onClick={rpReset} className="text-[10px] text-slate-600 hover:text-slate-400 p-1 shrink-0" title="Reset tab order">↺</button>
          </div>
          <PanelErrorBoundary key={mainRightTab}>
            {renderTab(mainRightTab)}
          </PanelErrorBoundary>
        </div>
      </div>
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="flex items-center gap-1 self-start">
          <button onClick={bpReset} className="text-[10px] text-slate-600 hover:text-slate-400 p-1 shrink-0" title="Reset panel order">↺</button>
          <span className="text-[9px] text-slate-600 font-mono">drag panels</span>
        </div>
        {bottomPanelOrder.map((key, i) => (
          <div key={key} className="flex-1 min-w-0"
            draggable
            onDragStart={bp.onDragStart(i)}
            onDragOver={bp.onDragOver(i)}
            onDragEnd={bp.onDragEnd}
          >
            {BPANEL[key]}
          </div>
        ))}
      </div>
    </main>
    <footer className="glass-base border-t border-white/6 py-3 text-center text-[10px] text-slate-600 font-mono">OMS V3 Integration Session: NQ001 • PROD Gateways Ready • UAT Fallbacks Loaded</footer>
  </div>
);
}

export default function App() {
  const { selectedInstrument, setSelectedInstrument, chartData, setChartData, optionChainData, setOptionChainData, initializeDefaultInstrument } = useMarketData();

  const [loginState, setLoginState] = useState({ status: "LOGGED_IN", error: "", env: "UAT", phone: "", deviceId: "", baseUrl: "" });
  const [isRefreshingLogin, setIsRefreshingLogin] = useState(false);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [quotes, setQuotes] = useState<Record<number, { price: number; prev_close: number; change: number }>>({});
  const [premium, setPremium] = useState<{ ltp: number; strike: number; optType: string } | null>(null);
  const [selectedInterval, setSelectedInterval] = useState("5m");
  const [tradingMode, setTradingMode] = useState<"EQ" | "FNO" | "NONE">(() => (localStorage.getItem("tradingMode") as any) || "NONE");
  const persistTradingMode = useCallback((mode: "EQ" | "FNO" | "NONE") => { localStorage.setItem("tradingMode", mode); setTradingMode(mode); }, []);

  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [prefillParams, setPrefillParams] = useState<{
    side: "BUY" | "SELL";
    price: number;
    stoploss: number;
    target: number;
    qty: number;
  } | null>(null);
  const [mainRightTab, setMainRightTab] = useState<"ANALYSIS" | "BUYING_ENGINE" | "BACKTEST" | "SCALPER">("ANALYSIS");
  const [centerTab, setCenterTab] = useState<"CHART" | "OPTIONS">(() => (localStorage.getItem("tradingMode") === "FNO" ? "OPTIONS" : "CHART"));
  const [showScreener, setShowScreener] = useState(true);
  const [showGlobalSentiment, setShowGlobalSentiment] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(260);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const panelMin = { left: 160, right: 280 };
  const panelMax = { left: 400, right: 600 };
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  const [isLoadingChart, setIsLoadingChart] = useState(false);

  const fnoIndexInstruments = useMemo(() => instruments.filter((inst) => (inst.derivative_type === "STOCK" || inst.derivative_type === "INDEX") && ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"].includes(inst.asset)), [instruments]);

  const handleSelectOptionInstrument = useCallback((asset: string) => {
    const newInstrument = instruments.find((i) => i.asset === asset && i.derivative_type !== "OPT");
    if (newInstrument) setSelectedInstrument(newInstrument);
    else setSelectedInstrument({ asset, stock_name: asset, exchange: asset === "SENSEX" ? "BSE" : "NSE", derivative_type: "INDEX" } as any);
  }, [instruments, setSelectedInstrument]);

  const fetchAuthStatus = async () => { try { const res = await fetch("/api/auth/status"); if (res.ok) setLoginState(await res.json()); } catch (_) {} };
  const handleRefreshLogin = async () => { setIsRefreshingLogin(true); try { const res = await fetch("/api/auth/login", { method: "POST" }); const data = await res.json(); if (data.success) { setLoginState(data.state); fetchPortfolio(); fetchOrders(); } else setLoginState(data.state || { ...loginState, status: "FAILED", error: data.error }); } catch (err: any) { setLoginState({ ...loginState, status: "FAILED", error: err.message }); } finally { setIsRefreshingLogin(false); } };
  const fetchInstruments = async () => { try { const res = await fetch("/api/market/instruments"); if (res.ok) setInstruments(await res.json()); } catch (_) {} };
  const fetchPortfolio = async () => { try { const res = await fetch("/api/portfolio/summary"); if (res.ok) setPortfolio(await res.json()); } catch (_) {} };
  const fetchOrders = async () => { try { const res = await fetch("/api/orders"); if (res.ok) { const data = await res.json(); if (data.success) setOrders(data.orders); } } catch (_) {} };
  const fetchAllQuotes = async () => { if (instruments.length === 0) return; setIsLoadingQuotes(true); try { const updatedQuotes: Record<number, any> = {}; const batch = instruments.slice(0, 15); // parallel — serial was ~15 × broker RTT (seconds of dead time)
    await Promise.all(batch.map(async (inst) => { try { const res = await fetch(`/api/market/quote/${inst.ref_id}`); if (res.ok) { const data = await res.json(); updatedQuotes[inst.ref_id] = { price: data.price, prev_close: data.prev_close, change: data.change }; } } catch (_) {} })); setQuotes((prev) => ({ ...prev, ...updatedQuotes })); } catch (_) {} finally { setIsLoadingQuotes(false); } };
  const fetchOptionChain = async () => { if (!selectedInstrument) return; const activeSymbol = selectedInstrument.asset || "NIFTY"; try { const res = await fetch(`/api/market/optionchain/${activeSymbol}`); if (res.ok) { const data = await res.json(); setOptionChainData(data.chain); } } catch (_) {} };
  const fetchHistoricalChart = async () => { if (!selectedInstrument) return; setIsLoadingChart(true); try { const res = await fetch("/api/market/historical", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: selectedInstrument.stock_name, interval: selectedInterval, exchange: selectedInstrument.exchange, length: 120 }) }); if (res.ok) setChartData(await res.json()); } catch (_) {} finally { setIsLoadingChart(false); } };
  const handleCancelOrder = async (orderId: number) => { try { const res = await fetch("/api/orders/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }) }); if (res.ok) { fetchOrders(); fetchPortfolio(); } } catch (_) {} };
  const handleExecuteSignal = (params: {
    side: "BUY" | "SELL";
    price: number;
    stoploss: number;
    target: number;
    qty: number;
  }) => setPrefillParams(params);

  useEffect(() => { fetchAuthStatus(); fetchInstruments(); fetchPortfolio(); fetchOrders(); }, []);
  useEffect(() => { if (instruments.length > 0) { fetchAllQuotes(); initializeDefaultInstrument(instruments); } }, [instruments]);
  useEffect(() => { fetchHistoricalChart(); const timer = setTimeout(() => fetchOptionChain(), 800); return () => clearTimeout(timer); }, [selectedInstrument, selectedInterval]);
  useEffect(() => { if (!selectedInstrument) return; const interval = setInterval(fetchOptionChain, 3000); return () => clearInterval(interval); }, [selectedInstrument]);
  useEffect(() => { const interval = setInterval(() => { fetchPortfolio(); fetchOrders(); }, 10000); return () => clearInterval(interval); }, [instruments]);
  useWebSocketQuotes((data) => setQuotes((prev) => ({ ...prev, ...data })), setPremium);

  if (tradingMode === "NONE") {
    return <LandingPage instruments={instruments} persistTradingMode={persistTradingMode} setSelectedInstrument={setSelectedInstrument} setCenterTab={setCenterTab} />;
  }

  return (
    <MainWorkspace
      tradingMode={tradingMode} persistTradingMode={persistTradingMode} setSelectedInstrument={setSelectedInstrument} setCenterTab={setCenterTab} setShowScreener={setShowScreener} setShowGlobalSentiment={setShowGlobalSentiment}
      selectedInstrument={selectedInstrument} instruments={instruments} setInstruments={setInstruments} quotes={quotes} setQuotes={setQuotes} premium={premium} setPremium={setPremium}
      selectedInterval={selectedInterval} setSelectedInterval={setSelectedInterval} chartData={chartData} setChartData={setChartData} optionChainData={optionChainData} setOptionChainData={setOptionChainData}
      loginState={loginState} setLoginState={setLoginState} isRefreshingLogin={isRefreshingLogin} setIsRefreshingLogin={setIsRefreshingLogin}
      portfolio={portfolio} setPortfolio={setPortfolio} orders={orders} setOrders={setOrders} prefillParams={prefillParams} setPrefillParams={setPrefillParams}
      mainRightTab={mainRightTab} setMainRightTab={setMainRightTab}
      showScreener={showScreener} showGlobalSentiment={showGlobalSentiment} leftPanelWidth={leftPanelWidth} setLeftPanelWidth={setLeftPanelWidth}
      rightPanelWidth={rightPanelWidth} setRightPanelWidth={setRightPanelWidth} panelMin={panelMin} panelMax={panelMax}
      fnoIndexInstruments={fnoIndexInstruments} handleSelectOptionInstrument={handleSelectOptionInstrument}
      fetchAuthStatus={fetchAuthStatus} handleRefreshLogin={handleRefreshLogin} fetchInstruments={fetchInstruments}
      fetchPortfolio={fetchPortfolio} fetchOrders={fetchOrders} fetchAllQuotes={fetchAllQuotes} fetchOptionChain={fetchOptionChain}
      fetchHistoricalChart={fetchHistoricalChart} handleCancelOrder={handleCancelOrder} handleExecuteSignal={handleExecuteSignal} isLoadingQuotes={isLoadingQuotes}
    />
  );
}


