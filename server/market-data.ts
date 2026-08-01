import logger from "./logger.js";
import * as nb from "./nubra.js";

export const BROKER_INTERVALS = new Set(["1s","1m","2m","3m","5m","15m","30m","1h","1d","1w","1mt"]);

// Indices must be queried with type "INDEX" — "STOCK" returns "ticker not found"
const INDEXES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);

function resolveAssetType(symbol: string): string {
  return INDEXES.has(symbol.toUpperCase()) ? "INDEX" : "STOCK";
}

// Trading-day window for `count` bars at `stepMin` minutes: bars cover
// 6.25h sessions, so calendar days = bars*step / (6.25h) * 7/5 (weekends)
// * 1.15 (holiday margin). Shared by fetchCandles and fetchCandlesInternal —
// the old *2 formula over-covered and cut 45d runs to ~18.6 trading days.
export function daysBackFor(count: number, stepMin: number): number {
  // Broker returns 0 candles for a 1-day window (verified 2026-08): the session
  // mapping needs at least 2 calendar days of history. Floor at 2.
  return Math.max(2, Math.ceil(((stepMin * count * 60) / (6.25 * 3600)) * (7 / 5) * 1.15));
}

// Broker returns cumulative_volume (monotone running total) — diff to per-bar
// volume for s2 volZ/VWAP. If any diff is negative the broker gave per-bar
// semantics; keep raw then.
export function toPerBarVolume(cv: number[]): number[] {
  let sawNegative = false;
  const diffs: number[] = [];
  for (let i = 0; i < cv.length; i++) {
    const raw = cv[i];
    const v = i === 0 ? raw : Math.max(0, raw - cv[i - 1]);
    if (i > 0 && raw < cv[i - 1]) sawNegative = true;
    diffs.push(v);
  }
  return sawNegative ? cv : diffs;
}

// 10s TTL cache — WS broadcast (2s), quote and spot routes all call fetchCandles;
// without it every poll hits the broker, saturating the API and slowing page load
const candleCache = new Map<string, { data: any[]; ts: number }>();
const CANDLE_TTL = 10_000;

export async function fetchCandles(symbol: string, exchange: string, interval: string, count: number): Promise<any[]> {
  logger.debug({ symbol, exchange, interval, count }, "[fetchCandles] Params");
  const key = `${symbol}|${exchange}|${interval}|${count}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.ts < CANDLE_TTL) return hit.data;

  const brokerInterval = BROKER_INTERVALS.has(interval) ? interval : "1m";
  const stepMins: Record<string, number> = { "1s": 1/60, "1m": 1, "2m": 2, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1d": 1440, "1w": 10080, "1mt": 43200 };
  const step = stepMins[interval] || 5;
  const today = new Date();
  const daysBack = daysBackFor(count, step);
  const startDate = new Date(today.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const endDate = today.toISOString();

  const query = { query: [{ exchange, type: resolveAssetType(symbol), values: [symbol], fields: ["open", "high", "low", "close", "cumulative_volume"], startDate, endDate, interval: brokerInterval, intraDay: false, realTime: false }] };
  let candles: any[] = [];
  try {
    const data = await nb.nubraApi.getHistoricalData(query);
    if (data?.result?.[0]) {
      const symData = data.result[0].values[0][symbol];
      if (symData?.close) {
        const times = symData.close.map((p: any) => p.ts);
        const volume = toPerBarVolume(symData.cumulative_volume.map((p: any) => p.v));
        candles = times.map((ts: number, idx: number) => ({ ts, open: symData.open[idx].v / 100, high: symData.high[idx].v / 100, low: symData.low[idx].v / 100, close: symData.close[idx].v / 100, volume: volume[idx] }));
      }
    }
  } catch (e: any) {
    logger.error({ err: e, symbol }, "[fetchCandles] Nubra API error");
  }
  if (candles.length > count) candles = candles.slice(candles.length - count);
  candleCache.set(key, { data: candles, ts: Date.now() });
  return candles;
}

export async function fetchOptionSymbol(symbol: string, strike: number, optType: string, exchange = "NSE"): Promise<string | null> {
  try {
    const chain = await nb.nubraApi.getOptionChain(symbol, undefined, exchange);
    const entries = chain?.chain?.[optType.toLowerCase()];
    if (!entries) return null;
    const arr = Object.values(entries) as any[];
    const match = arr.find((o: any) => Math.round(o.sp / 100) === strike);
    return match?.symbol || null;
  } catch (e: any) { logger.warn({ err: e }, "[Option Symbol] Failed to fetch option symbol"); return null; }
}

export async function fetchOptionCandles(symbol: string, strike: number, optType: string, exchange: string, interval: string, count: number): Promise<any[]> {
  const optSym = await fetchOptionSymbol(symbol, strike, optType, exchange);
  if (!optSym) return [];
  return fetchCandles(optSym, exchange, interval, count);
}
