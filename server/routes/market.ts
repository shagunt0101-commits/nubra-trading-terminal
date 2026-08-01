import logger from "../logger.js";
import { Router } from "express";
import { nubraApi, getSessionToken } from "../nubra.js";
import { validate, historicalSchema } from "../validation.js";
import { fetchCandles, fetchOptionCandles } from "../market-data.js";
import { calculateSMA, calculateEMA, calculateRSI, calculateBollingerBands, calculateMACD } from "../indicators.js";

// Indices must be queried with type "INDEX" — "STOCK" returns "ticker not found"
const INDEXES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);

const router = Router();

let instrumentCache: any[] = [];
const quoteCache = new Map<string, { data: any; timestamp: number }>();

router.get("/instruments", async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const data = await nubraApi.getInstruments(todayStr);
    if (data && data.refdata && data.refdata.length > 0) {
      instrumentCache = data.refdata;
      return res.json(instrumentCache);
    }
    return res.status(502).json({ error: "Instruments data unavailable from broker" });
  } catch (err: any) {
    return res.status(502).json({ error: `Failed to fetch instruments: ${err.message}` });
  }
});

router.get("/search", (req, res) => {
  const query = (req.query.query as string || "").toUpperCase();
  const exchange = req.query.exchange as string || "NSE";
  const results = instrumentCache.filter(
    (inst) =>
      inst.exchange === exchange &&
      (inst.stock_name.includes(query) || inst.asset.includes(query))
  );
  res.json(results.slice(0, 50));
});

router.get("/quote/:refId", async (req, res) => {
  const refId = parseInt(req.params.refId, 10);
  let inst = instrumentCache.find((i) => i.ref_id === refId);

  // Fallback: if cache empty (instruments fetch failed/slow at boot), fetch fresh
  if (!inst && instrumentCache.length === 0) {
    try {
      const todayStr = new Date().toISOString().split("T")[0];
      const data = await nubraApi.getInstruments(todayStr);
      if (data && data.refdata && data.refdata.length > 0) {
        instrumentCache = data.refdata;
        inst = instrumentCache.find((i) => i.ref_id === refId);
      }
    } catch (_) {}
  }
  if (!inst) return res.status(404).json({ error: "Instrument not found." });

  const cacheKey = `${inst.asset}_${inst.exchange}`;
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.timestamp < 10000) return res.json(cached.data);

  try {
    let rawPrice: number;
    let rawPrevClose: number;
    let ohlc: { open: number; high: number; low: number } | undefined;

    // optionchains/.../price serves only F&O — for both index AND cash-equity
    // spots use candles (charts/timeseries works for stocks too).
    const candles = await fetchCandles(inst.asset, inst.exchange, "1m", 1);
    if (!candles || candles.length === 0) throw new Error("No price from broker");
    const last = candles[candles.length - 1];
    rawPrice = last.close * 100;
    rawPrevClose = inst.prev_close || inst.underlying_prev_close || null;
    // Day OHLC from 1d candles (last = today, prev = yesterday's close)
    const dayCandles = await fetchCandles(inst.asset, inst.exchange, "1d", 2);
    const today = dayCandles[dayCandles.length - 1];
    if (today) {
      ohlc = { open: today.open, high: today.high, low: today.low };
      const yesterday = dayCandles[dayCandles.length - 2];
      if (yesterday) rawPrevClose = yesterday.close * 100;
    }

    const price = rawPrice / 100;
    const prev = rawPrevClose / 100;
    const change = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    const data = {
      instrument: inst,
      price,
      prev_close: prev,
      change,
      open: ohlc?.open ?? price,
      high: ohlc?.high ?? price,
      low: ohlc?.low ?? price,
    };
    quoteCache.set(cacheKey, { data, timestamp: now });
    res.json(data);
  } catch (err: any) {
    logger.error({ err }, "[Nubra API] Live quote fetch failed");
    res.status(500).json({ error: err.message || "Failed to fetch live quote from broker" });
  }
});

router.get("/optionchain/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  let exchange = (req.query.exchange as string) || (symbol === "SENSEX" ? "BSE" : "NSE");
  const expiry = req.query.expiry as string || "";

  for (const exch of [exchange, exchange === "NSE" ? "BSE" : "NSE"]) {
    try {
      const chainData = await nubraApi.getOptionChain(symbol, expiry, exch);
      if (chainData && chainData.chain) {
        const chain = chainData.chain;
        if (chain.cp && !chain.spot) chain.spot = chain.cp;
        if (!chain.spot) {
          try {
            const quote = await nubraApi.getCurrentPrice(symbol, exch);
            if (quote?.price) chain.spot = typeof quote.price === 'number' ? quote.price : parseInt(quote.price, 10);
          } catch (_) {}
        }
        return res.json(chainData);
      }
    } catch (_) { /* try next exchange */ }
  }
  res.status(502).json({ error: `Option chain unavailable for ${symbol} from broker` });
});

router.post("/historical", validate(historicalSchema), async (req, res) => {
  const { symbol, interval, length = 150, exchange = "NSE" } = req.body;
  try {
    let candles = await fetchCandles(symbol, exchange, interval, length);
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

router.get("/spot/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const exchange = (req.query.exchange as string) || (symbol === "SENSEX" ? "BSE" : "NSE");
  try {
    let price: number;
    let prevClose: number;
    let ohlc: { open: number; high: number; low: number } | undefined;

    // Candles work for both index and cash-equity; getCurrentPrice serves only F&O.
    {
      const candles = await fetchCandles(symbol, exchange, "1m", 1);
      if (!candles || candles.length === 0) throw new Error("No price from broker");
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
    }

    const pointChange = price - prevClose;
    const changePct = prevClose > 0 ? (pointChange / prevClose) * 100 : 0;
    return res.json({
      symbol, price, prevClose, pointChange, changePct, exchange, source: "broker",
      open: ohlc?.open ?? price, high: ohlc?.high ?? price, low: ohlc?.low ?? price,
    });
  } catch (err: any) { logger.warn({ err: err.message, symbol }, "[Spot Price] Broker API failed, returning 404"); }
  res.status(404).json({ error: "Symbol not found — broker returned no data." });
});

export default router;
