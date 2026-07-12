const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SYMBOLS = [
  { key: "NIFTY",    ticker: "^NSEI",      category: "indices",     name: "NIFTY 50" },
  { key: "SENSEX",   ticker: "^BSESN",     category: "indices",     name: "SENSEX" },
  { key: "DJI",      ticker: "^DJI",       category: "indices",     name: "Dow Jones" },
  { key: "SPX",      ticker: "^GSPC",      category: "indices",     name: "S&P 500" },
  { key: "IXIC",     ticker: "^IXIC",      category: "indices",     name: "NASDAQ" },
  { key: "HSI",      ticker: "^HSI",       category: "indices",     name: "Hang Seng" },
  { key: "N225",     ticker: "^N225",      category: "indices",     name: "Nikkei 225" },
  { key: "FTSE",     ticker: "^FTSE",      category: "indices",     name: "FTSE 100" },
  { key: "GDAXI",    ticker: "^GDAXI",     category: "indices",     name: "DAX" },
  { key: "VIX",      ticker: "^VIX",       category: "indices",     name: "VIX" },
  { key: "GOLD",     ticker: "GC=F",       category: "commodities", name: "Gold" },
  { key: "SILVER",   ticker: "SI=F",       category: "commodities", name: "Silver" },
  { key: "CRUDE",    ticker: "CL=F",       category: "commodities", name: "Crude Oil" },
  { key: "NGAS",     ticker: "NG=F",       category: "commodities", name: "Natural Gas" },
  { key: "WHEAT",    ticker: "ZW=F",       category: "commodities", name: "Wheat" },
  { key: "BTC",      ticker: "BTC-USD",    category: "crypto",      name: "Bitcoin" },
  { key: "ETH",      ticker: "ETH-USD",    category: "crypto",      name: "Ethereum" },
  { key: "SOL",      ticker: "SOL-USD",    category: "crypto",      name: "Solana" },
  { key: "XRP",      ticker: "XRP-USD",    category: "crypto",      name: "XRP" },
];

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 120_000; // 2 min

async function fetchQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const quotes = result.indicators?.quote?.[0] || {};
  const closes = quotes.close || [];

  const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
  const prevClose = meta.previousClose ?? price ?? 0;
  const dayHigh = meta.regularMarketDayHigh ?? (closes.length > 0 ? Math.max(...closes.filter(c => c !== null)) : null);
  const dayLow = meta.regularMarketDayLow ?? (closes.length > 0 ? Math.min(...closes.filter(c => c !== null)) : null);

  return { price, prevClose, dayHigh, dayLow };
}

export async function getGlobalSentiment() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) return cache.data;

  const results = [];
  for (const sym of SYMBOLS) {
    try {
      const q = await fetchQuote(sym.ticker);
      if (!q || q.price === null || q.price === undefined) continue;

      const change = q.price - q.prevClose;
      const changePct = q.prevClose > 0 ? (change / q.prevClose) * 100 : 0;
      const range = (q.dayHigh ?? q.price) - (q.dayLow ?? q.price);
      const position = range > 0 ? ((q.price - (q.dayLow ?? q.price)) / range) * 100 : 50;

      let sentiment = position;
      if (change > 0) sentiment = Math.min(100, sentiment + 10);
      else sentiment = Math.max(0, sentiment - 10);

      const trend = sentiment > 60 ? "bullish" : sentiment < 40 ? "bearish" : "neutral";

      results.push({
        key: sym.key,
        name: sym.name,
        category: sym.category,
        price: Math.round(q.price * 100) / 100,
        change: Math.round(change * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        sentiment: Math.round(sentiment),
        trend,
        dayHigh: q.dayHigh ? Math.round(q.dayHigh * 100) / 100 : null,
        dayLow: q.dayLow ? Math.round(q.dayLow * 100) / 100 : null,
      });
    } catch (_) { /* skip silently */ }
  }

  const groups = { indices: [], commodities: [], crypto: [] };
  for (const r of results) {
    if (groups[r.category]) groups[r.category].push(r);
  }

  const overall = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.sentiment, 0) / results.length)
    : 50;

  cache = { data: { overall, groups, updatedAt: new Date().toISOString() }, timestamp: now };
  return cache.data;
}
