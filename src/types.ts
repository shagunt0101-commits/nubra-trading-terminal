export interface Instrument {
  ref_id: number;
  token: number;
  stock_name: string;
  option_type: "CE" | "PE" | "N/A";
  strike_price: number;
  lot_size: number;
  asset: string;
  expiry: number;
  exchange: string;
  derivative_type: "OPT" | "FUT" | "STOCK" | "INDEX";
  tick_size: number;
  underlying_prev_close: number;
}

export interface Quote {
  instrument: Instrument;
  price: number;
  prev_close: number;
  change: number;
  simulated?: boolean;
}

export interface Order {
  intentOrderId: number;
  status: "OPEN" | "EXECUTED" | "FILLED" | "CANCELLED" | "REJECTED" | "GTE";
  isMulti: boolean;
  refId?: number | null;
  orderQty: number;
  orderPrice: number;
  side: "BUY" | "SELL";
  deliveryType: string;
  priceType: string;
  validityType: string;
  legs?: any[] | null;
  stratTags?: string[];
  timestamps?: {
    intentCreatedAt: string;
  };
}

export interface Position {
  refId: number;
  symbol: string;
  exchange: string;
  asset: string;
  assetType: string;
  deliveryType: string;
  orderSide: "BUY" | "SELL";
  netQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  lastTradedPrice: number;
  avgPrice: number;
  pnl: number;
  pnlChg: number;
}

export interface Holding {
  refId: number;
  symbol: string;
  exchange: string;
  asset: string;
  quantity: number;
  avgPrice: number;
  lastTradedPrice: number;
  investedValue: number;
  currentValue: number;
  netPnl: number;
  netPnlChg: number;
}

export interface PortfolioSummary {
  funds: {
    portFundsAndMargin: {
      clientCode: string;
      startOfDayFunds: number;
      netMarginAvailable: number;
      totalMarginBlocked: number;
      brokerage: number;
    };
  };
  holdings: {
    portfolio: {
      holdingStats: {
        investedAmount: number;
        currentValue: number;
        totalPnl: number;
        totalPnlChg: number;
      };
      holdings: Holding[];
    };
  };
  positions: {
    portfolio: {
      positionStats: {
        totalPnl: number;
        totalPnlChg: number;
      };
      positions: Position[];
    };
  };
  simulated: boolean;
}

export interface OptionLeg {
  sp: number;
  ltp: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  theta: number;
  change?: number;
  ltpchg?: number;
  oi_change_pct?: number;
}

export interface OptionChain {
  atm: number;
  ce: OptionLeg[];
  pe: OptionLeg[];
}

export interface OptionChainData {
  asset: string;
  chain: OptionChain;
}

export interface ChartDataPoint {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sma20: number;
  ema50: number;
  rsi14: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  macdLine: number;
  signalLine: number;
  macdHist: number;
}

export interface QuoteData {
  price: number;
  prev_close: number;
  change: number;
}

export interface PremiumData {
  ltp: number;
  strike: number;
  optType: string;
}

export interface ScalperTrade {
  intentOrderId: number;
  timestamps?: {
    intentCreatedAt: string;
  };
  pnl: number;
  optType: string;
  strike?: number;
  entryPremium: number;
  exitReason?: string;
  status?: string;
  orderQty: number;
  qty?: number;
  exitPremium?: number;
}

export interface OptionGreeks {
  sp: number;
  ltp: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  theta: number;
  change?: number;
  oi_change_pct?: number;
  ltpchg?: number;
}

export interface OptionChain {
  ce: OptionGreeks[];
  pe: OptionGreeks[];
  atm: number;
}

export interface OptionChainData {
  asset: string;
  expiry: number;
  chain: OptionChain;
  timestamp?: number;
}

export interface BacktestResult {
  summary: {
    initialBalance: number;
    finalBalance: number;
    totalPnl: number;
    returnPercent: number;
    totalTrades: number;
    winRate: number;
    winningTrades: number;
    losingTrades: number;
    profitFactor: number;
    // Present only for premium-model strategies; null when <15 trades
    // (not enough samples for a meaningful Sharpe/Calmar).
    sharpe?: number | null;
    maxDrawdownPct?: number;
    maxDrawdownDurationDays?: number | null;
    calmar?: number | null;
    annualizedReturnPct?: number | null;
  };
  trades: Array<{
    id: number;
    symbol: string;
    side: "BUY" | "SELL";
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    qty: number;
    pnl: number;
    pnlPercent: number;
    result: "WIN" | "LOSS";
    // premium-engine fields (s2_scalper + option strategies)
    optType?: "CE" | "PE";
    strike?: number;
    entryPremium?: number;
    exitPremium?: number;
    exitReason?: string;
  }>;
}

export interface LoginState {
  status: "LOGGED_IN" | "PENDING" | "FAILED" | "NOT_LOGGED_IN";
  error: string;
  phone: string;
  deviceId: string;
  env: "UAT" | "PROD" | "";
  baseUrl: string;
}
