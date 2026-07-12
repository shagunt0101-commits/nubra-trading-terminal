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
  derivative_type: "OPT" | "FUT" | "STOCK";
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
  }>;
}
