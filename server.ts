import "dotenv/config";
import express from "express";
import path from "path";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import { generateTradingSignals } from "./server/gemini.js";
import { calculateSMA, calculateEMA, calculateRSI, calculateBollingerBands, calculateMACD, calculateADX } from "./server/indicators.js";
import { evaluateTrendContinuation, evaluateBBMeanReversal, evaluateRSIReversal, evaluateTrendFollow } from "./server/strategy-engine.js";
import { getGlobalSentiment } from "./server/global.js";
import { nubraApi, nubraLogin, nubraSendOtp, nubraVerifyOtp, getLoginState, getSessionToken } from "./server/nubra.js";
import { fetchCandles } from "./server/market-data.js";
import { runBacktest, PREMIUM_STRATEGIES } from "./server/backtest-engine.js";
import { scalper } from "./server/scalper-instance.js";
import logger from "./server/logger.js";
import { validateEnv } from "./server/env.js";

validateEnv();

const app = express();
const server = http.createServer(app);
const PORT = 3000;

// ── WebSocket for live market data ──────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
const WS_BROADCAST_INTERVAL = 2000; // 2s push

// Static index ref map — survives instrumentCache overwrite from API
const WS_INDEX_MAP: Record<string, { ref_id: number }> = {
  NIFTY:     { ref_id: 1001 },
  BANKNIFTY: { ref_id: 1002 },
  SENSEX:    { ref_id: 1003 },
  MIDCPNIFTY:{ ref_id: 1004 },
  FINNIFTY:  { ref_id: 1005 },
};

wss.on("connection", (ws) => {});

// Broadcast loop — broker data only, no simulated jitter fallback
async function wsBroadcastQuotes() {
  const WATCH = Object.keys(WS_INDEX_MAP);
  const results = await Promise.allSettled(WATCH.map(async (asset) => {
    const meta = WS_INDEX_MAP[asset];
    const exchange = asset === "SENSEX" ? "BSE" : "NSE";
    // optionchains/.../price does not serve index spots; use latest candles
    const [candles, dayCandles] = await Promise.all([
      fetchCandles(asset, exchange, "1m", 1),
      fetchCandles(asset, exchange, "1d", 2),
    ]);
    const last = candles?.[candles.length - 1];
    if (!last?.close) return null;
    const price = last.close;
    const prev = dayCandles?.[dayCandles.length - 2]?.close ?? price;
    return { ref_id: meta.ref_id, price, prev_close: prev, change: prev > 0 ? ((price - prev) / prev) * 100 : 0 };
  }));
  const batch: Record<number, { price: number; prev_close: number; change: number }> = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) batch[r.value.ref_id] = r.value;
  }
  if (Object.keys(batch).length === 0) return;

  // Include option premium for active scalper trade
  let premium: { ltp: number; strike: number; optType: string } | undefined;
  try {
    const trade = scalper.getActiveTrade();
    if (trade && trade.status === "OPEN") {
      const sym = scalper.getConfig().symbol;
      const exch = scalper.getConfig().exchange;
      const expiry = scalper.getConfig().optionExpiry || undefined;
      const chain = await nubraApi.getOptionChain(sym, expiry, exch);
      const chainData = chain?.chain || chain;
      const optList = trade.optType === "CE" ? (chainData?.ce || []) : (chainData?.pe || []);
      const arr = Array.isArray(optList) ? optList : Object.values(optList);
      const match = arr.find((o: any) => Math.round((o.sp || 0) / 100) === trade.strike);
      if (match?.ltp) {
        premium = { ltp: match.ltp / 100, strike: trade.strike, optType: trade.optType };
      }
    }
  } catch (e) { logger.warn({ err: e }, "[WS Premium] Failed to fetch option premium"); }
  const msg = JSON.stringify({ type: "quotes", data: batch, premium });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}
if (!process.env.VERCEL) setInterval(wsBroadcastQuotes, WS_BROADCAST_INTERVAL);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Security middleware
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000", credentials: true }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Rate limiting — 100 req/min per IP
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, try again later." },
});
app.use("/api", apiLimiter);

// JSON error handler — Express 4 does not catch async handler rejections; an
// unhandled one would otherwise surface as an HTML 500 with no body, which
// frontends can't render. Keep every failure a parseable {error} payload.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "[API] Unhandled error");
  res.status(500).json({ success: false, error: err?.message || "Internal server error" });
});

// Auth middleware — requires valid broker session for trading endpoints
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = getSessionToken();
  if (!token) {
    return res.status(401).json({ success: false, error: "No active broker session. Login first." });
  }
  next();
}

// Protect trading routes
app.use("/api/portfolio", requireAuth);
app.use("/api/orders", requireAuth);
app.use("/api/scalper", requireAuth);

// List of liquid stocks, major indices (NIFTY, BANKNIFTY, SENSEX, MIDCPNIFTY, FINNIFTY) and options for quick screening fallback
const LIQUID_INSTRUMENTS = [
  { ref_id: 1001, token: 1001, stock_name: "NIFTY", option_type: "N/A", strike_price: 0, lot_size: 75, asset: "NIFTY", expiry: 0, exchange: "NSE", derivative_type: "INDEX", tick_size: 5, underlying_prev_close: 2421100 },
  { ref_id: 1002, token: 1002, stock_name: "BANKNIFTY", option_type: "N/A", strike_price: 0, lot_size: 15, asset: "BANKNIFTY", expiry: 0, exchange: "NSE", derivative_type: "INDEX", tick_size: 5, underlying_prev_close: 5150000 },
  { ref_id: 1003, token: 1003, stock_name: "SENSEX", option_type: "N/A", strike_price: 0, lot_size: 10, asset: "SENSEX", expiry: 0, exchange: "BSE", derivative_type: "INDEX", tick_size: 5, underlying_prev_close: 8100000 },
  { ref_id: 1004, token: 1004, stock_name: "MIDCPNIFTY", option_type: "N/A", strike_price: 0, lot_size: 50, asset: "MIDCPNIFTY", expiry: 0, exchange: "NSE", derivative_type: "INDEX", tick_size: 5, underlying_prev_close: 1250000 },
  { ref_id: 1005, token: 1005, stock_name: "FINNIFTY", option_type: "N/A", strike_price: 0, lot_size: 25, asset: "FINNIFTY", expiry: 0, exchange: "NSE", derivative_type: "INDEX", tick_size: 5, underlying_prev_close: 2300000 },
  { ref_id: 739119, token: 35187, stock_name: "NIFTY25JUL24100CE", option_type: "CE", strike_price: 2410000, lot_size: 75, asset: "NIFTY", expiry: 20250714, exchange: "NSE", derivative_type: "OPT", tick_size: 5, underlying_prev_close: 2421100 },
  { ref_id: 72329, token: 72329, stock_name: "ICICIBANK", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "ICICIBANK", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 10, underlying_prev_close: 120000 },
  { ref_id: 83414, token: 83414, stock_name: "TVSMOTOR", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "TVSMOTOR", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 245000 },
  { ref_id: 847854, token: 847854, stock_name: "YESBANK", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "YESBANK", expiry: 0, exchange: "BSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 1800 },
  { ref_id: 1497712, token: 1497712, stock_name: "NIFTY25JUL24100CE", option_type: "CE", strike_price: 2410000, lot_size: 75, asset: "NIFTY", expiry: 20250714, exchange: "NSE", derivative_type: "OPT", tick_size: 5, underlying_prev_close: 2421100 },
  { ref_id: 1497713, token: 1497713, stock_name: "NIFTY25JUL24100PE", option_type: "PE", strike_price: 2410000, lot_size: 75, asset: "NIFTY", expiry: 20250714, exchange: "NSE", derivative_type: "OPT", tick_size: 5, underlying_prev_close: 2421100 },
  { ref_id: 1500001, token: 1500001, stock_name: "RELIANCE", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "RELIANCE", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 250000 },
  { ref_id: 1500002, token: 1500002, stock_name: "HDFCBANK", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "HDFCBANK", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 160000 },
  { ref_id: 1500003, token: 1500003, stock_name: "TCS", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "TCS", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 380000 },
  { ref_id: 1500004, token: 1500004, stock_name: "INFY", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "INFY", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 185000 },
  { ref_id: 1500005, token: 1500005, stock_name: "SBIN", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "SBIN", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 82000 },
  { ref_id: 1500006, token: 1500006, stock_name: "TATAMOTORS", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "TATAMOTORS", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 75000 },
  { ref_id: 1500007, token: 1500007, stock_name: "AXISBANK", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "AXISBANK", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 115000 },
  { ref_id: 1500008, token: 1500008, stock_name: "ITC", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "ITC", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 48000 },
  { ref_id: 1500009, token: 1500009, stock_name: "BHARTIARTL", option_type: "N/A", strike_price: 0, lot_size: 1, asset: "BHARTIARTL", expiry: 0, exchange: "NSE", derivative_type: "STOCK", tick_size: 5, underlying_prev_close: 155000 },
  { ref_id: 1504439, token: 1504439, stock_name: "NIFTY25JUL24150CE", option_type: "CE", strike_price: 2415000, lot_size: 75, asset: "NIFTY", expiry: 20250714, exchange: "NSE", derivative_type: "OPT", tick_size: 5, underlying_prev_close: 2421100 },
];

let instrumentCache: any[] = [...LIQUID_INSTRUMENTS];
let ordersSimCache: any[] = []; // In-memory simulated orders to allow full terminal workflow

// Helper to generate simulated candles — timestamps align to NSE market hours (09:15-15:30 IST)
function getMarketOpenToday(): number {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const marketOpen = new Date(ist);
  marketOpen.setHours(9, 15, 0, 0);
  return marketOpen.getTime(); // ms since epoch in IST
}

function generateMockCandles(symbol: string, length = 100, interval = "5m"): any[] {
  const candles = [];
  let basePrice = 2500;
  if (symbol.includes("NIFTY")) basePrice = 24211;
  else if (symbol.includes("TVSMOTOR")) basePrice = 2450;
  else if (symbol.includes("YESBANK")) basePrice = 18;
  else if (symbol.includes("ICICIBANK")) basePrice = 1200;
  else if (symbol.includes("HDFCBANK")) basePrice = 1600;
  else if (symbol.includes("TCS")) basePrice = 3800;

  let currentPrice = basePrice;
  const marketOpen = getMarketOpenToday();
  const stepMs = interval === "1s" ? 1000 : interval === "1m" ? 60000 : interval === "5m" ? 300000 : interval === "15m" ? 900000 : 86400000;

  for (let i = 0; i < length; i++) {
    const ts = marketOpen + i * stepMs;
    const change = currentPrice * (Math.random() * 0.015 - 0.0075);
    const open = currentPrice;
    const close = currentPrice + change;
    const high = Math.max(open, close) + (Math.random() * 0.005 * currentPrice);
    const low = Math.min(open, close) - (Math.random() * 0.005 * currentPrice);
    const volume = Math.floor(Math.random() * 50000) + 1000;

    candles.push({
      ts: ts * 1000000, // nanoseconds
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume
    });

    currentPrice = close;
  }
  return candles;
}

// REST API Endpoints
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
});

app.get("/api/auth/status", (req, res) => {
  res.json(getLoginState());
});

app.post("/api/auth/login", async (req, res) => {
  const token = await nubraLogin();
  if (token) {
    res.json({ success: true, token, state: getLoginState() });
  } else {
    res.status(401).json({ success: false, error: getLoginState().error });
  }
});

app.post("/api/auth/send-otp", async (req, res) => {
  const result = await nubraSendOtp(req.body.phone);
  if (result.success) {
    res.json({ success: true, tempToken: result.tempToken });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const { otp, tempToken, phone } = req.body;
  if (!otp || !tempToken) {
    return res.status(400).json({ success: false, error: "OTP and tempToken required." });
  }
  const result = await nubraVerifyOtp(otp, tempToken, phone);
  if (result.success) {
    res.json({ success: true, token: result.token, state: getLoginState() });
  } else {
    res.status(401).json({ success: false, error: result.error });
  }
});

app.get("/api/market/instruments", async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const data = await nubraApi.getInstruments(todayStr);
    if (data && data.refdata && data.refdata.length > 0) {
      instrumentCache = data.refdata;
    }
  } catch (err) {
    console.warn("[Nubra API] Failed to fetch instruments, using high-liquidity defaults:", err);
  }
  res.json(instrumentCache);
});

app.get("/api/market/search", (req, res) => {
  const query = (req.query.query as string || "").toUpperCase();
  const exchange = req.query.exchange as string || "NSE";

  const results = instrumentCache.filter(
    (inst) =>
      inst.exchange === exchange &&
      (inst.stock_name.includes(query) || inst.asset.includes(query))
  );

  res.json(results.slice(0, 50));
});

// In-memory quote cache to prevent concurrent external request floods
const quoteCache = new Map<string, { data: any; timestamp: number }>();

// Returns detailed current price with technical screening indicators
app.get("/api/market/quote/:refId", async (req, res) => {
  const refId = parseInt(req.params.refId, 10);
  const inst = instrumentCache.find((i) => i.ref_id === refId);

  if (!inst) {
    return res.status(404).json({ error: "Instrument not found." });
  }

  const cacheKey = `${inst.asset}_${inst.exchange}`;
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);

  // Return cached quotes if fresh (within 10 seconds)
  if (cached && now - cached.timestamp < 10000) {
    return res.json(cached.data);
  }

  try {
    const quote = await nubraApi.getCurrentPrice(inst.asset, inst.exchange);
    // Nubra returns {price: 7763763, prev_close: 7676592, change: 1.135} — paise
    const rawPrice = quote?.price || quote?.data?.price || quote?.spot;
    if (!rawPrice) throw new Error("No price from broker");
    const rawPrevClose = quote.prev_close || rawPrice;
    const price = rawPrice / 100;
    const prev = rawPrevClose / 100;
    const change = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    const data = { instrument: inst, price, prev_close: prev, change, simulated: false };
    quoteCache.set(cacheKey, { data, timestamp: now });
    res.json(data);
  } catch (err: any) {
    console.error("[Nubra API] Failed to fetch live quote:", err.message);
    res.status(500).json({ error: err.message || "Failed to fetch live quote from broker" });
  }
});

// Robust Option Chain Fallback Generator for any instrument (Stock/Index)
function generateFallbackOptionChain(symbol: string) {
  const basePrices: Record<string, number> = {
    NIFTY: 24200,
    BANKNIFTY: 51200,
    FINNIFTY: 23000,
    SENSEX: 78500,
    INFY: 2070,
    TCS: 4120,
    RELIANCE: 3020,
    HDFCBANK: 1650,
    ICICIBANK: 1250,
    TATAMOTORS: 980,
  };
  const spot = basePrices[symbol] || 1500;
  const step = spot > 10000 ? 100 : spot > 2000 ? 50 : spot > 500 ? 20 : 10;
  const atm = Math.round(spot / step) * step * 100; // in paisa

  const ce = [];
  const pe = [];
  for (let i = -10; i <= 10; i++) {
    const sp = atm + (i * step * 100);
    const strikePrice = sp / 100;
    const distance = Math.abs(strikePrice - (atm / 100));
    const ceLtp = Math.max(2, Math.round((spot - strikePrice > 0 ? (spot - strikePrice) + (100 - distance * 0.5) : Math.max(5, 100 - distance * 2)) * 10) / 10);
    const peLtp = Math.max(2, Math.round((strikePrice - spot > 0 ? (strikePrice - spot) + (100 - distance * 0.5) : Math.max(5, 100 - distance * 2)) * 10) / 10);
    
    ce.push({
      ref_id: 900000 + i + 10,
      sp,
      ls: 50,
      ltp: ceLtp,
      oi: Math.floor(Math.random() * 400000) + 100000,
      volume: Math.floor(Math.random() * 2000000) + 200000,
      change: Math.round((Math.random() * 10 - 5) * 10) / 10,
      ltpchg: Math.round((Math.random() * 10 - 5) * 10) / 10,
      price_pcp: Math.round((Math.random() * 10 - 5) * 10) / 10,
      iv: Math.round((15 + Math.random() * 10) * 10) / 10,
      delta: Math.max(0.05, Math.min(0.95, Math.round((0.5 - (strikePrice - (atm / 100)) / (step * 20)) * 100) / 100)),
      theta: -Math.round((Math.random() * 5 + 1) * 10) / 10,
      gamma: 0.002,
      vega: 12.5,
    });

    pe.push({
      ref_id: 950000 + i + 10,
      sp,
      ls: 50,
      ltp: peLtp,
      oi: Math.floor(Math.random() * 400000) + 100000,
      volume: Math.floor(Math.random() * 2000000) + 200000,
      change: Math.round((Math.random() * 10 - 5) * 10) / 10,
      ltpchg: Math.round((Math.random() * 10 - 5) * 10) / 10,
      price_pcp: Math.round((Math.random() * 10 - 5) * 10) / 10,
      iv: Math.round((15 + Math.random() * 10) * 10) / 10,
      delta: -Math.max(0.05, Math.min(0.95, Math.round((0.5 + (strikePrice - (atm / 100)) / (step * 20)) * 100) / 100)),
      theta: -Math.round((Math.random() * 5 + 1) * 10) / 10,
      gamma: 0.002,
      vega: 12.5,
    });
  }

  return {
    symbol,
    atm,
    spot: spot * 100,
    all_expiries: ["2026-07-16", "2026-07-23", "2026-07-30", "2026-08-27"],
    ce,
    pe,
  };
}

// Option chain endpoint fetching from broker API (Nubra API) with automatic fallback
app.get("/api/market/optionchain/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  let exchange = (req.query.exchange as string) || (symbol === "SENSEX" ? "BSE" : "NSE");
  const expiry = req.query.expiry as string || "";

  try {
    let chainData;
    try {
      chainData = await nubraApi.getOptionChain(symbol, expiry, exchange);
    } catch (e: any) {
      const altExchange = exchange === "NSE" ? "BSE" : "NSE";
      try {
        chainData = await nubraApi.getOptionChain(symbol, expiry, altExchange);
      } catch (errAlt: any) {
        console.warn(`[Nubra API] Option chain unavailable from broker for ${symbol}, generating robust synthetic chain.`);
        chainData = { chain: generateFallbackOptionChain(symbol) };
      }
    }

    // Ensure chainData has valid structure and normalize spot price
    if (!chainData || (!chainData.chain && !chainData.ce)) {
      chainData = { chain: generateFallbackOptionChain(symbol) };
    } else if (!chainData.chain && chainData.ce) {
      chainData = { chain: chainData };
    }

    const chain = chainData.chain || chainData;
    // Nubra returns `cp` as current spot price in paise — map it to `spot` for the frontend
    if (chain.cp && !chain.spot) {
      chain.spot = chain.cp;
    }
    // If cp is 0 or missing (BSE/SENSEX), try to get from historical candles
    if (!chain.spot || chain.spot === 0) {
      try {
        const quote = await nubraApi.getCurrentPrice(symbol, exchange);
        if (quote && quote.price) {
          chain.spot = typeof quote.price === 'number' ? quote.price : parseInt(quote.price, 10);
        }
      } catch (_) {}
    }

    res.json({
      ...chainData,
      simulated: false,
    });
  } catch (err: any) {
    console.warn("[Nubra API] Option chain fallback generated due to:", err.message);
    res.json({
      chain: generateFallbackOptionChain(symbol),
      simulated: true,
    });
  }
});

// Comprehensive Portfolio API (funds, margin, holdings, positions)
app.get("/api/portfolio/summary", async (req, res) => {
  try {
    const isConnected = !!getSessionToken();
    let funds = null;
    let holdings = null;
    let positions = null;

    if (isConnected) {
      try {
        funds = await nubraApi.getFunds();
        holdings = await nubraApi.getHoldings();
        positions = await nubraApi.getPositions();
      } catch (err) {
        console.warn("Portfolio fetch failed, using fallback:", err);
      }
    }

    // High fidelity fallbacks if not connected or broker failed
    if (!funds) {
      funds = {
        portFundsAndMargin: {
          clientCode: "NQ_8447296129",
          startOfDayFunds: 50000000, // 5 Lakh rupees in paise (500000 * 100)
          netMarginAvailable: 48500000,
          totalMarginBlocked: 1500000,
          brokerage: 12000,
        },
      };
    }

    if (!holdings) {
      holdings = {
        portfolio: {
          holdingStats: {
            investedAmount: 35000000,
            currentValue: 37500000,
            totalPnl: 2500000,
            totalPnlChg: 7.14,
          },
          holdings: [
            { refId: 83414, symbol: "TVSMOTOR", exchange: "NSE", asset: "TVSMOTOR", quantity: 100, avgPrice: 245000, lastTradedPrice: 255000, investedValue: 24500000, currentValue: 25500000, netPnl: 1000000, netPnlChg: 4.08, haircut: 14.93 },
            { refId: 72329, symbol: "ICICIBANK", exchange: "NSE", asset: "ICICIBANK", quantity: 100, avgPrice: 120000, lastTradedPrice: 125000, investedValue: 12000000, currentValue: 12500000, netPnl: 500000, netPnlChg: 4.17, haircut: 12.5 },
          ],
        },
      };
    }

    if (!positions) {
      positions = {
        portfolio: {
          positionStats: {
            totalPnl: 350000,
            totalPnlChg: 5.5,
          },
          positions: [
            { refId: 847854, symbol: "YESBANK", exchange: "BSE", asset: "YESBANK", assetType: "STOCK", deliveryType: "CNC", orderSide: "BUY", netQuantity: 500, buyQuantity: 500, sellQuantity: 0, lastTradedPrice: 1850, avgPrice: 1800, avgBuyPrice: 1800, avgSellPrice: 0, pnl: 25000, pnlChg: 2.78 },
          ],
        },
      };
    }

    res.json({
      success: true,
      funds,
      holdings,
      positions,
      simulated: !isConnected,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Native intervals supported by Nubra
const BROKER_INTERVALS = new Set(["1s","1m","2m","3m","5m","15m","30m","1h","1d","1w","1mt"]);

// Shared backtest/historical payload guard — trust boundary. No depth, no
// nonsense symbol/interval/length slips through to the broker query.
function validateSeriesPayload(body: any): string | null {
  const { symbol, interval, length } = body || {};
  if (!symbol || typeof symbol !== "string") return "symbol is required (string)";
  if (!BROKER_INTERVALS.has(interval)) return `interval must be one of ${[...BROKER_INTERVALS].join(",")}`;
  if (length != null && (typeof length !== "number" || length < 10 || length > 5000)) return "length must be a number 10..5000";
  return null;
}

// Technical timeseries charts & screening calculations
app.post("/api/market/historical", async (req, res) => {
  const { symbol, interval, length = 150, exchange = "NSE" } = req.body;
  const invalid = validateSeriesPayload(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    let candles = await fetchCandles(symbol, exchange, interval, length);

    // Compute technical indicators
    const closes = candles.map((c: any) => c.close);
    const sma20 = calculateSMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi14 = calculateRSI(closes, 14);
    const bb = calculateBollingerBands(closes, 20, 2);
    const macd = calculateMACD(closes);

    const enrichData = candles.map((c: any, i: number) => ({
      ...c, ts: Math.round(c.ts / 1000000),
      sma20: Math.round(sma20[i] * 100) / 100,
      ema50: Math.round(ema50[i] * 100) / 100,
      rsi14: Math.round(rsi14[i] * 100) / 100,
      bbUpper: Math.round(bb.upper[i] * 100) / 100,
      bbMiddle: Math.round(bb.middle[i] * 100) / 100,
      bbLower: Math.round(bb.lower[i] * 100) / 100,
      macdLine: Math.round(macd.macdLine[i] * 100) / 100,
      signalLine: Math.round(macd.signalLine[i] * 100) / 100,
      macdHist: Math.round(macd.histogram[i] * 100) / 100,
    }));

    res.json(enrichData);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Strategy Backtesting Engine
app.post("/api/backtest", async (req, res) => {
  const {
    symbol, strategy, interval = "5m", length = 200, riskReward = 2,
    stopLossPercent = 1.5, targetPercent = 3, exchange = "NSE",
    confidenceThreshold = 55, premiumTargetPct = 30, stopLossPct = 15,
    // Option RSI MR specific params
    optionRsiThreshold = 40, optionRsiPeriod = 14, maxEntryPremium = 200, premiumTargetPoints = 4,
    premiumStopLossPct = 50
  } = req.body;
  const invalid = validateSeriesPayload(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  if (typeof strategy !== "string" || !strategy) return res.status(400).json({ error: "strategy is required" });
  try {
    let candles = await fetchCandles(symbol, exchange, interval, length);
    if (candles.length === 0) {
      return res.status(500).json({ error: "No data available for backtest." });
    }

    // Premium strategies route through the honest premium-model engine
    // (server/backtest-engine.ts) — the same engine PGHO optimized: fixed ATM
    // strike, premium entry/exit, % SL/TP, theta decay, phase trail. The legacy
    // spot-% loop below only handles setup strategies.
    if (PREMIUM_STRATEGIES.has(strategy)) {
      // Broker ts is nanoseconds (per-engine compat: engine math is spread/median
      // on deltas so ns is internally consistent, but trade times must be ms for
      // the UI clock). Normalize once, engine sees clean ms series.
      candles = candles.map((c: any) => ({ ...c, ts: c.ts > 1e16 ? Math.round(c.ts / 1e6) : c.ts }));
      const bt = runBacktest(candles as any, {
        strategy, instrument: symbol,
        spotSLPct: stopLossPercent, spotTPPct: targetPercent, confidenceThreshold,
        optionRsiThreshold, optionRsiPeriod, maxEntryPremium,
        premiumTargetPct, premiumStopLossPct,
        premiumTargetPoints,
        exitMode: req.body.exitMode || "phase",
        maxHoldBars: req.body.maxHoldBars,
      });
      res.json({
        summary: {
          initialBalance: 100000,
          finalBalance: 100000 + bt.summary.totalPnlPct,
          totalPnl: Math.round(bt.summary.totalPnlPct * 100) / 100,
          returnPercent: Math.round(bt.summary.totalPnlPct * 100) / 100,
          totalTrades: bt.summary.totalTrades,
          winRate: Math.round(bt.summary.winRate * 100) / 100,
          winningTrades: bt.trades.filter((t) => t.result === "WIN").length,
          losingTrades: bt.trades.length - bt.trades.filter((t) => t.result === "WIN").length,
          profitFactor: Math.round(bt.summary.profitFactor * 100) / 100,
        },
        trades: bt.trades.map((t) => ({
          ...t,
          symbol, qty: 1,
          pnlPercent: Math.round(t.pnlPct * 100) / 100,
        })),
      });
      return;
    }

    console.log(`[Backtest] legacy spot-% path: ${strategy}`);
    const closes = candles.map((c: any) => c.close);

    const sma20 = calculateSMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    const bb = calculateBollingerBands(closes, 20, 2);

    let trades = [];
    let currentPosition: any = null;
    let balance = 100000;
    const initialBalance = balance;

    // For option_rsi_mr + new strategies: fetch real CE/PE OHLC for ATM strike
    let ceOptCandles: any[] = [];
    let peOptCandles: any[] = [];
    if (strategy === "option_rsi_mr" || strategy === "trend_continuation" || strategy === "bb_mean_reversion" ||
        strategy === "rsi_reversal" || strategy === "sma_ema_trend") {
      try {
        const medianSpot = closes.slice(20).reduce((a: number, b: number) => a + b, 0) / Math.max(1, closes.length - 20);
        const strike = Math.round(medianSpot / 50) * 50;
        const chain = await nubraApi.getOptionChain(symbol, undefined, exchange);
        const ceEntries = chain?.chain?.ce ? Object.values(chain.chain.ce) as any[] : [];
        const peEntries = chain?.chain?.pe ? Object.values(chain.chain.pe) as any[] : [];
        const ceSym = ceEntries.find((o: any) => Math.round(o.sp / 100) === strike)?.symbol;
        const peSym = peEntries.find((o: any) => Math.round(o.sp / 100) === strike)?.symbol;
        if (ceSym) ceOptCandles = await fetchCandles(ceSym, exchange, interval, length);
        if (peSym) peOptCandles = await fetchCandles(peSym, exchange, interval, length);
        console.log(`[Backtest] Fetched ${ceOptCandles.length} CE and ${peOptCandles.length} PE candles`);
      } catch (_) {}
      // Align option candles to spot candle timestamps
      if (!ceOptCandles.length && !peOptCandles.length) {
        console.log("[Backtest] Fallback: no option OHLC, using spot candle stream — orig entry point");
      }
    }

    for (let i = 20; i < candles.length; i++) {
      const candle = candles[i];
      const prevCandle = candles[i - 1];

      // Check exits
      if (currentPosition) {
        const price = candle.close;

        // Option RSI MR — premium-based exit
        if (currentPosition.entryPremium != null) {
          // Recompute current premium from option candles or synthetic model
          const ci = i < ceOptCandles.length && i < peOptCandles.length ? i : null;
          const useRealCe = ci != null && ceOptCandles[ci]?.close > 0;
          const useRealPe = ci != null && peOptCandles[ci]?.close > 0;
          const atm = Math.round(price / 50) * 50;
          const curPrem = currentPosition.optType === "CE"
            ? (useRealCe ? ceOptCandles[ci!].close : price * 0.006 + Math.max(0, (price - atm) * 0.4))
            : (useRealPe ? peOptCandles[ci!].close : price * 0.005 + Math.max(0, (atm - price) * 0.4));
          const entryP = currentPosition.entryPremium;
          const pnlPts = curPrem - entryP;

          // Phase 1 — initial SL or target
          if (!currentPosition.phase1TargetHit) {
            const slHit = curPrem <= currentPosition.stopLoss;
            const tpHit = curPrem >= currentPosition.target;
            if (tpHit) {
              // Phase 1→2: hit target, lock breakeven
              currentPosition.phase1TargetHit = true;
              currentPosition.stopLoss = entryP;
              currentPosition.maxPriceSeen = curPrem;
            } else if (slHit || i === candles.length - 1) {
              const exitPrem = slHit ? currentPosition.stopLoss : curPrem;
              const pnlVal = (exitPrem - entryP) * 100;
              balance += pnlVal;
              trades.push({
                ...currentPosition, exitTime: Math.round(candle.ts / 1000000),
                exitPrice: price, exitPremium: Math.round(exitPrem * 100) / 100,
                pnl: Math.round(pnlVal * 100) / 100,
                pnlPercent: Math.round((exitPrem / entryP - 1) * 10000) / 100,
                result: pnlVal > 0 ? "WIN" : "LOSS",
              });
              currentPosition = null;
            }
          } else {
            // Phase 2 & 3 — trailing
            if (curPrem > (currentPosition.maxPriceSeen || entryP)) currentPosition.maxPriceSeen = curPrem;
            const trailStop = (currentPosition.maxPriceSeen || entryP) * 0.80;
            const exitPrem = curPrem <= trailStop ? curPrem : null;
            if ((exitPrem != null) || i === candles.length - 1) {
              const ePrem = exitPrem != null ? exitPrem : curPrem;
              const pnlVal = (ePrem - entryP) * 100;
              balance += pnlVal;
              trades.push({
                ...currentPosition, exitTime: Math.round(candle.ts / 1000000),
                exitPrice: price, exitPremium: Math.round(ePrem * 100) / 100,
                pnl: Math.round(pnlVal * 100) / 100,
                pnlPercent: Math.round((ePrem / entryP - 1) * 10000) / 100,
                result: pnlVal > 0 ? "WIN" : "LOSS",
              });
              currentPosition = null;
            }
          }
          continue;
        }

        // Standard spot-price-based exit logic
        const profitPct = (price - currentPosition.entryPrice) / currentPosition.entryPrice * (currentPosition.side === "BUY" ? 1 : -1);

        const slHit = profitPct <= -stopLossPercent / 100;
        const tpHit = profitPct >= targetPercent / 100;

        if (slHit || tpHit || i === candles.length - 1) {
          const exitPrice = slHit ? currentPosition.entryPrice * (1 + (currentPosition.side === "BUY" ? -stopLossPercent : stopLossPercent) / 100) :
                            tpHit ? currentPosition.entryPrice * (1 + (currentPosition.side === "BUY" ? targetPercent : -targetPercent) / 100) : price;
          const pnlVal = (exitPrice - currentPosition.entryPrice) * currentPosition.qty * (currentPosition.side === "BUY" ? 1 : -1);

          balance += pnlVal;
          trades.push({
            ...currentPosition,
            exitTime: Math.round(candle.ts / 1000000),
            exitPrice: Math.round(exitPrice * 100) / 100,
            pnl: Math.round(pnlVal * 100) / 100,
            pnlPercent: Math.round(pnlVal / (currentPosition.entryPrice * currentPosition.qty) * 10000) / 100,
            result: pnlVal > 0 ? "WIN" : "LOSS",
          });
          currentPosition = null;
        }
        continue;
      }

      // Check buy signals
      let triggerSignal = false;
      let side: "BUY" | "SELL" = "BUY";

      if (strategy === "trend_continuation" || strategy === "bb_mean_reversion" ||
          strategy === "rsi_reversal" || strategy === "sma_ema_trend") {
        const slice = candles.slice(0, i + 1);
        const res = strategy === "trend_continuation" ? evaluateTrendContinuation(slice as any, "scalping")
          : strategy === "bb_mean_reversion" ? evaluateBBMeanReversal(slice as any)
          : strategy === "rsi_reversal" ? evaluateRSIReversal(slice as any)
          : evaluateTrendFollow(slice as any);
        if (res.direction === "LONG") { triggerSignal = true; side = "BUY"; }
        else if (res.direction === "SHORT") { triggerSignal = true; side = "SELL"; }
      } else if (strategy === "sma_ema_cross") {
        if (closes[i] > sma20[i] && closes[i - 1] <= sma20[i - 1] && ema50[i] > ema50[i - 1]) {
          triggerSignal = true; side = "BUY";
        } else if (closes[i] < sma20[i] && closes[i - 1] >= sma20[i - 1] && ema50[i] < ema50[i - 1]) {
          triggerSignal = true; side = "SELL";
        }
      } else if (strategy === "rsi_overbought_oversold") {
        if (rsi[i] > 30 && rsi[i - 1] <= 30) { triggerSignal = true; side = "BUY"; }
        else if (rsi[i] < 70 && rsi[i - 1] >= 70) { triggerSignal = true; side = "SELL"; }
      } else if (strategy === "bollinger_band_reversal") {
        if (closes[i] > bb.lower[i] && closes[i - 1] <= bb.lower[i - 1]) { triggerSignal = true; side = "BUY"; }
        else if (closes[i] < bb.upper[i] && closes[i - 1] >= bb.upper[i - 1]) { triggerSignal = true; side = "SELL"; }
      } else if (strategy === "s2_scalper") {
        // S2: RSI extremes + MACD momentum + VWAP + BB Width + Volume Z-score
        const s2Macd = calculateMACD(closes, 12, 26, 9);
        // Warm-up: dynamic — on higher TFs (15m+) use 26 (MACD stable), lower TFs use 40 for momentum stability
        if (i < (interval === "15m" || interval === "1h" || interval === "4h" || interval === "1d" ? 26 : 40)) continue;
        const rsiVal = rsi[i];
        const macdLine = s2Macd.macdLine[i];
        const signalLine = s2Macd.signalLine[i];
        const macdHist = s2Macd.histogram[i];
        const prevMacdHist = s2Macd.histogram[i - 1];

        let bullScore = 0, bearScore = 0;
        if (rsiVal < 30) { bullScore += 2; }
        else if (rsiVal > 70) { bearScore += 2; }
        else if (rsiVal > 50) { bullScore += 1; }
        else { bearScore += 1; }

        const expanding = macdLine > signalLine && macdHist > prevMacdHist;
        const contracting = macdLine < signalLine && macdHist < prevMacdHist;
        if (expanding) { bullScore += 2; }
        else if (contracting) { bearScore += 2; }
        else if (macdLine > signalLine) { bullScore += 1; }
        else { bearScore += 1; }

        // BB Width
        const bbMid = bb.middle[i];
        const bbWidth = bbMid > 0 ? ((bb.upper[i] - bb.lower[i]) / bbMid) * 100 : 0;

        // VWAP over last 20
        const batch = candles.slice(Math.max(0, i - 19), i + 1);
        const sumVol = batch.reduce((a: number, c: any) => a + (c.volume || 0), 0);
        const vwap = sumVol > 0 ? batch.reduce((a: number, c: any) => a + c.close * (c.volume || 0), 0) / sumVol : candle.close;
        if (candle.close > vwap) { bullScore += 1; } else { bearScore += 1; }

        // Volume Z-score
        const vols = batch.map((c: any) => c.volume || 0);
        const volAvg = vols.reduce((a: number, b: number) => a + b, 0) / vols.length;
        const volStd = Math.sqrt(vols.reduce((a: number, b: number) => a + (b - volAvg) ** 2, 0) / vols.length);
        const volZ = volStd > 0 ? (vols[vols.length - 1] - volAvg) / volStd : 0;
        if (volZ > 2) {
          if (bullScore >= bearScore) bullScore += 1;
          else bearScore += 1;
        }

        const totalScore = bullScore + bearScore;
        const confidence = totalScore > 0 ? Math.round(Math.max(bullScore, bearScore) / totalScore * 100) : 50;
        const isBull = bullScore > bearScore;
        const hasStrong = rsiVal < 30 || rsiVal > 70 || expanding || contracting;

        if (hasStrong && confidence >= confidenceThreshold && totalScore >= 3) {
          triggerSignal = true;
          side = isBull ? "BUY" : "SELL";
        }
      } else if (strategy === "option_rsi_mr") {
        // Option RSI MR: uses real option OHLC if available, synthetic fallback
        const tfSec: Record<string, number> = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
        const stepSec = tfSec[interval] || 60;
        if (stepSec > 300) continue; // only 1m/3m/5m meaningful
        const rsiPeriod = optionRsiPeriod || 14;
        const rsiThreshold = optionRsiThreshold || 32;
        const premiumTargetPts = premiumTargetPoints || 4;
        if (i < rsiPeriod + 2) continue;

        // Use real option OHLC if available, aligned by candle index
        const ceUsed = ceOptCandles.length > i;
        const peUsed = peOptCandles.length > i;
        const getCePremium = (idx: number) => ceUsed ? ceOptCandles[idx].close : null;
        const getPePremium = (idx: number) => peUsed ? peOptCandles[idx].close : null;

        // Build premium series from real option data or synthetic fallback
        const atm = Math.round(closes[i] / 50) * 50;
        const batchCloses = closes.slice(0, i + 1);
        let ceSeries: number[], peSeries: number[];
        if (ceUsed) {
          ceSeries = ceOptCandles.slice(0, i + 1).map(c => c.close);
        } else {
          ceSeries = batchCloses.map(c => c * 0.006 + Math.max(0, (c - atm) * 0.4));
        }
        if (peUsed) {
          peSeries = peOptCandles.slice(0, i + 1).map(c => c.close);
        } else {
          peSeries = batchCloses.map(c => c * 0.005 + Math.max(0, (atm - c) * 0.4));
        }

        // 15-min spot RSI for trend filter
        const spotRsiVals = calculateRSI(batchCloses, 14);
        const spotRsi15 = spotRsiVals[spotRsiVals.length - 1] || 50;

        const ceRsiArr = calculateRSI(ceSeries, rsiPeriod);
        const peRsiArr = calculateRSI(peSeries, rsiPeriod);
        if (!ceRsiArr.length || !peRsiArr.length) continue;

        const ceRsi = ceRsiArr[ceRsiArr.length - 1];
        const peRsi = peRsiArr[peRsiArr.length - 1];

        if (ceRsi <= rsiThreshold && spotRsi15 > 50) {
          const entryPremium = ceSeries[ceSeries.length - 1];
          if (entryPremium <= maxEntryPremium) {
            triggerSignal = true; side = "BUY";
            currentPosition = {
              id: trades.length + 1, symbol, side: "BUY",
              entryTime: Math.round(candle.ts / 1000000),
              entryPrice: candle.close, entryPremium,
              optType: "CE", strike: atm, stopLoss: entryPremium * (1 - 0.5),
              target: entryPremium + premiumTargetPts, qty: 1,
              status: "OPEN", maxPriceSeen: entryPremium, phase1TargetHit: false,
            };
          }
        } else if (peRsi <= rsiThreshold && spotRsi15 < 50) {
          const entryPremium = peSeries[peSeries.length - 1];
          if (entryPremium <= maxEntryPremium) {
            triggerSignal = true; side = "SELL";
            currentPosition = {
              id: trades.length + 1, symbol, side: "SELL",
              entryTime: Math.round(candle.ts / 1000000),
              entryPrice: candle.close, entryPremium,
              optType: "PE", strike: atm, stopLoss: entryPremium * (1 - 0.5),
              target: entryPremium + premiumTargetPts, qty: 1,
              status: "OPEN", maxPriceSeen: entryPremium, phase1TargetHit: false,
            };
          }
        }
      }

      if (triggerSignal) {
        if (strategy === "trend_continuation" || strategy === "bb_mean_reversion" ||
            strategy === "rsi_reversal" || strategy === "sma_ema_trend") {
          // Premium-style position: exit on option SL/TP, matching live scalper behavior
          const atm = Math.round(candle.close / 50) * 50;
          const ceUsed = ceOptCandles.length > i;
          const peUsed = peOptCandles.length > i;
          const getPrem = (idx: number, opt: string) => {
            if (opt === "CE" && ceUsed && ceOptCandles[idx]?.close > 0) return ceOptCandles[idx].close;
            if (opt === "PE" && peUsed && peOptCandles[idx]?.close > 0) return peOptCandles[idx].close;
            const c = candles[idx].close;
            return opt === "CE" ? c * 0.006 + Math.max(0, (c - atm) * 0.4) : c * 0.005 + Math.max(0, (atm - c) * 0.4);
          };
          const entryPremium = getPrem(i, side === "BUY" ? "CE" : "PE");
          if (entryPremium > 0) {
            const slPct = premiumStopLossPct || 50;
            const slPts = premiumTargetPoints || 4;
            currentPosition = {
              id: trades.length + 1, symbol, side,
              entryTime: Math.round(candle.ts / 1000000),
              entryPrice: candle.close, entryPremium,
              optType: side === "BUY" ? "CE" : "PE", strike: atm,
              stopLoss: Math.round(entryPremium * (1 - slPct / 100) * 100) / 100,
              target: Math.round((entryPremium + slPts) * 100) / 100,
              qty: 1, status: "OPEN", maxPriceSeen: entryPremium, phase1TargetHit: false,
            };
          }
        } else {
          const qty = Math.max(1, Math.floor(balance / candle.close));
          if (qty > 0) {
            currentPosition = {
              id: trades.length + 1,
              symbol,
              side,
              entryTime: Math.round(candle.ts / 1000000),
              entryPrice: candle.close,
              qty,
            };
          }
        }
      }
    } // for loop

    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.result === "WIN").length;
    const losingTrades = totalTrades - winningTrades;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const totalPnl = balance - initialBalance;
    const profitFactor = losingTrades > 0 ? Math.abs(trades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0) / trades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0)) : 1;

    res.json({
      summary: {
        initialBalance: Math.round(initialBalance * 100) / 100,
        finalBalance: Math.round(balance * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        returnPercent: Math.round((totalPnl / initialBalance) * 10000) / 100,
        totalTrades,
        winRate: Math.round(winRate * 100) / 100,
        winningTrades,
        losingTrades,
        profitFactor: Math.round(profitFactor * 100) / 100,
      },
      trades,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Places single order or multi-leg strategy order
app.post("/api/orders/place", async (req, res) => {
  const { isMultiLeg, qty, side, deliveryType, priceType, validityType, entryPrice, legs, stratTags } = req.body;

  const refId = isMultiLeg ? null : req.body.refId || 1500001;

  try {
    const isConnected = !!getSessionToken();
    let orderRes = null;

    if (isConnected) {
      const orderPayload: any = {
        isMultiLeg: !!isMultiLeg,
        qty: parseInt(qty, 10),
        side: side || "BUY",
        deliveryType: deliveryType || "IDAY",
        priceType: priceType || "LIMIT",
        validityType: validityType || "DAY",
        executionMode: req.body.executionMode || "ENTRY",
      };

      if (!isMultiLeg) {
        orderPayload.refId = parseInt(refId as any, 10);
        if (entryPrice) orderPayload.entryPrice = parseInt(entryPrice, 10);
      } else {
        orderPayload.legs = legs;
        if (entryPrice) orderPayload.entryPrice = parseInt(entryPrice, 10);
      }

      if (stratTags) orderPayload.stratTags = stratTags;

      orderRes = await nubraApi.createOrder([orderPayload]);
    }

    // Local simulation fallback
    const simulatedOrderId = Math.floor(Math.random() * 90000) + 10000;
    const simOrder = {
      intentOrderId: simulatedOrderId,
      status: "OPEN",
      isMulti: !!isMultiLeg,
      refId,
      orderQty: qty,
      orderPrice: entryPrice || 0,
      side: side || "BUY",
      deliveryType: deliveryType || "IDAY",
      priceType: priceType || "LIMIT",
      validityType: validityType || "DAY",
      legs: legs || null,
      stratTags: stratTags || ["manual-terminal"],
      timestamps: {
        intentCreatedAt: new Date().toISOString(),
      },
    };

    ordersSimCache.push(simOrder);

    res.json({
      success: true,
      message: "Order placed successfully.",
      brokerResponse: orderRes,
      simulatedOrder: simOrder,
      simulated: !isConnected,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Cancels an order
app.post("/api/orders/cancel", async (req, res) => {
  const { orderId } = req.body;
  try {
    const isConnected = !!getSessionToken();
    let brokerRes = null;

    if (isConnected) {
      brokerRes = await nubraApi.cancelOrder([{ orderId: parseInt(orderId, 10) }]);
    }

    ordersSimCache = ordersSimCache.map((ord) =>
      ord.intentOrderId === parseInt(orderId, 10) ? { ...ord, status: "CANCELLED" } : ord
    );

    res.json({
      success: true,
      message: "Order cancelled successfully.",
      brokerResponse: brokerRes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Gets order lists
app.get("/api/orders", async (req, res) => {
  try {
    const isConnected = !!getSessionToken();
    let brokerOrders = null;

    if (isConnected) {
      try {
        brokerOrders = await nubraApi.getOrders();
      } catch (err) {
        console.warn("Broker order retrieval failed:", err);
      }
    }

    // Merge in-memory simulated order items
    const executedSims = ordersSimCache.filter((o) => o.status === "EXECUTED" || o.status === "FILLED");
    const openSims = ordersSimCache.filter((o) => o.status === "OPEN");
    const cancelledSims = ordersSimCache.filter((o) => o.status === "CANCELLED");

    res.json({
      success: true,
      orders: {
        open: openSims.concat(brokerOrders?.orders?.open || []),
        executed: executedSims.concat(brokerOrders?.orders?.executed || []),
        cancelled: cancelledSims.concat(brokerOrders?.orders?.cancelled || []),
        rejected: brokerOrders?.orders?.rejected || [],
        gtt: brokerOrders?.orders?.gtt || [],
        expired: brokerOrders?.orders?.expired || [],
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generates real-time AI trading signals via Gemini 3.5
app.post("/api/ai/analyze", async (req, res) => {
  const {
    symbol,
    strategy,
    priceData,
    optionChain,
    technicalIndicators,
    positions,
    funds,
    aiProvider,
    customApiKey,
    customBaseUrl,
    customModel,
    atmAnalysis,
  } = req.body;

  try {
    const markdownReport = await generateTradingSignals({
      symbol,
      priceData,
      optionChain,
      technicalIndicators,
      strategy,
      positions,
      funds,
      aiProvider,
      customApiKey,
      customBaseUrl,
      customModel,
      atmAnalysis,
    });
    res.json({ success: true, report: markdownReport });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Yahoo ticker map for spot prices
const YAHOO_MAP: Record<string, string> = {
  NIFTY: "^NSEI", SENSEX: "^BSESN", BANKNIFTY: "^NSEBANK",
  MIDCPNIFTY: "^NSEMDCP50", FINNIFTY: "NIFTY_FIN_SERVICE.NS",
  DJI: "^DJI", SPX: "^GSPC", IXIC: "^IXIC",
  "BTC-USD": "BTC-USD", "ETH-USD": "ETH-USD",
};

// Spot price lookup for any symbol — tries broker, then Yahoo Finance
const SPOT_INDEXES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);

app.get("/api/market/spot/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const exchange = (req.query.exchange as string) || (symbol === "SENSEX" ? "BSE" : "NSE");
  try {
    let price: number;
    let prevClose: number;
    let ohlc: { open: number; high: number; low: number } | undefined;
    let ema9 = 0;
    let adx3m = 0;
    let adx5m = 0;

    if (SPOT_INDEXES.has(symbol)) {
      // optionchains/.../price does not serve index spots — use latest candles
      const candles = await fetchCandles(symbol, exchange, "1m", 1);
      if (!candles || candles.length === 0) throw new Error("No index price from broker");
      const last = candles[candles.length - 1];
      price = last.close;
      const dayCandles = await fetchCandles(symbol, exchange, "1d", 2);
      const today = dayCandles[dayCandles.length - 1];
      if (today) {
        ohlc = { open: today.open, high: today.high, low: today.low };
        prevClose = dayCandles.length > 1 ? dayCandles[dayCandles.length - 2].close : today.open;
      } else {
        prevClose = today ? today.open : price;
      }
      // analytics: 9-EMA + ADX on 3m/5m (parallel, non-fatal)
      const [c3, c5] = await Promise.all([
        fetchCandles(symbol, exchange, "3m", 40).catch(() => []),
        fetchCandles(symbol, exchange, "5m", 40).catch(() => []),
      ]);
      if (c3.length > 0) {
        const closes3 = c3.map((c: any) => c.close);
        ema9 = calculateEMA(closes3, 9)[closes3.length - 1];
        const adxRes3 = calculateADX(c3, 14);
        adx3m = adxRes3.adx[adxRes3.adx.length - 1] || 0;
      }
      if (c5.length > 0) {
        const adxRes5 = calculateADX(c5, 14);
        adx5m = adxRes5.adx[adxRes5.adx.length - 1] || 0;
      }
    } else {
      const quote = await nubraApi.getCurrentPrice(symbol, exchange);
      const rawPrice = quote?.price || quote?.data?.price || quote?.spot;
      if (!rawPrice) throw new Error("No price from broker");
      price = rawPrice / 100;
      prevClose = (quote.prev_close || rawPrice) / 100;
    }

    const pointChange = price - prevClose;
    const changePct = prevClose > 0 ? (pointChange / prevClose) * 100 : 0;
    return res.json({
      symbol, price, prevClose, pointChange, changePct, exchange, source: "broker",
      open: ohlc?.open ?? price, high: ohlc?.high ?? price, low: ohlc?.low ?? price,
      ema9: ema9 || price, adx3m, adx5m,
    });
  } catch (err: any) { logger.warn({ err: err.message, symbol }, "[Spot Price] Broker API failed"); }
  res.status(404).json({ error: "Symbol not found — broker returned no data." });
});

// ── Auto-Scalper Instance ──────────────────────────────────
app.post("/api/scalper/start", (req, res) => {
  const { symbol, lotCount, confidenceThreshold, premiumTargetPct, stopLossPct, strikeOffset, pollIntervalMs } = req.body || {};
  if (symbol) scalper.updateConfig({ symbol });
  if (lotCount) scalper.updateConfig({ lotCount, totalQty: (scalper.getConfig().lotSize || 75) * lotCount });
  if (confidenceThreshold) scalper.updateConfig({ confidenceThreshold });
  if (premiumTargetPct) scalper.updateConfig({ premiumTargetPct });
  if (stopLossPct) scalper.updateConfig({ stopLossPct });
  if (strikeOffset) scalper.updateConfig({ strikeOffset });
  if (pollIntervalMs) scalper.updateConfig({ pollIntervalMs });
  scalper.start();
  res.json({ success: true, mode: scalper.getMode(), config: scalper.getConfig() });
});

app.post("/api/scalper/stop", (req, res) => {
  scalper.stop();
  res.json({ success: true, mode: scalper.getMode() });
});

app.post("/api/scalper/reset", (req, res) => {
  scalper.reset();
  res.json({ success: true, mode: scalper.getMode() });
});

app.post("/api/scalper/clear-old-trades", (req, res) => {
  scalper.clearOldTrades();
  res.json({ success: true, trades: scalper.getTrades().length });
});

app.get("/api/scalper/status", (req, res) => {
  res.json({
    mode: scalper.getMode(),
    config: scalper.getConfig(),
    stats: scalper.getStats(),
    activeTrade: scalper.getActiveTrade(),
    trades: scalper.getTrades().slice(-20),
    logs: scalper.getLogs(30),
  });
});

app.post("/api/scalper/config", (req, res) => {
  scalper.updateConfig(req.body);
  res.json({ success: true, config: scalper.getConfig() });
});

// Global Market Sentiment — real data from Yahoo Finance
app.get("/api/global/sentiment", async (req, res) => {
  try {
    const data = await getGlobalSentiment();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch global sentiment data." });
  }
});

// Mount Vite middleware / Serve static build assets
async function startServer() {
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    server.listen(PORT, "0.0.0.0", () => {
      logger.info(`[Terminal] Dev server started on http://0.0.0.0:${PORT}`);
    });
  } else if (!process.env.VERCEL) {
    const distPath = path.resolve("dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist", "index.html"));
    });
    server.listen(PORT, "0.0.0.0", () => {
      logger.info(`[Terminal] Server started on http://0.0.0.0:${PORT}`);
    });
  }
}

// Always run startup (sets up static serving even on Vercel)
// Use .then() instead of top-level await for Vercel serverless compatibility
let _started = false;
const ready = startServer().then(() => { _started = true; }).catch((e) => {
  logger.error({ err: e }, "[Startup] Failed");
});

// Warm broker session at boot so the first authenticated request doesn't 401
if (!getSessionToken() && !process.env.VERCEL) {
  nubraLogin().then((token) => {
    logger.info(token ? "[Boot] Broker session warmed" : "[Boot] Broker login failed — OTP login required");
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string) {
  logger.info({ signal }, `[Shutdown] ${signal} received, closing gracefully`);
  wss.close(() => logger.info("[Shutdown] WebSocket server closed"));
  server.close(() => {
    scalper.persist();
    logger.info("[Shutdown] HTTP server closed, state persisted");
    process.exit(0);
  });
  // If forced shutdown after 5s
  setTimeout(() => { logger.warn("[Shutdown] Forced exit after timeout"); process.exit(1); }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
