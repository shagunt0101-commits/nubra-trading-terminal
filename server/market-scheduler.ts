import { startTickRecorder, stopTickRecorder } from "./tick-data.js";
import { NubraWsClient } from "./nubra-ws.js";
import { getSessionToken, nubraApi } from "./nubra.js";
import logger from "./logger.js";

let ofClient: NubraWsClient | null = null;
let ofRefIds: number[] = [];
let ofFile: string | null = null;
let ofError: string | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let startedToday = false;

const MARKET_OPEN_MIN = 9 * 60 + 15;   // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 40; // 15:40 IST (CAS)

function isMarketHours(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const day = ist.getDay();
  return day >= 1 && day <= 5 && mins >= MARKET_OPEN_MIN && mins <= MARKET_CLOSE_MIN;
}

function getIsoDate(): string {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist.toISOString().slice(0, 10);
}

async function resolveRefIdsForNifty(): Promise<number[]> {
  try {
    const token = getSessionToken();
    if (!token) {
      ofError = "No broker session — login from UI first";
      return [];
    }
    const px = await nubraApi.getCurrentPrice("NIFTY", "NSE");
    const raw = px?.ltp ?? px?.price ?? px?.current_price ?? px?.data?.ltp;
    if (!raw) {
      ofError = "Spot price missing from broker response";
      return [];
    }
    const spot = Number(raw) / 100;
    const tmpClient = new NubraWsClient();
    const ids = await tmpClient.resolveRefIds("NIFTY", spot, 3);
    if (!ids.length) ofError = "resolveRefIds returned empty";
    return ids;
  } catch (e: any) {
    ofError = e?.message || String(e);
    return [];
  }
}

export async function startOrderflowRecorder() {
  if (ofClient) return;
  ofRefIds = await resolveRefIdsForNifty();
  if (!ofRefIds.length) {
    logger.warn({ err: ofError }, "[MarketScheduler] No refIds resolved for orderflow");
    return;
  }
  ofError = null;
  const outFile = `orderflow-NIFTY-${getIsoDate()}.jsonl`;
  ofFile = outFile;
  const fs = await import("fs");
  const out = fs.createWriteStream(outFile, { flags: "a" });
  ofClient = new NubraWsClient();
  ofClient.start(ofRefIds, (snap) => {
    const bidQty = snap.bids.reduce((s, b) => s + b.quantity, 0);
    const askQty = snap.asks.reduce((s, a) => s + a.quantity, 0);
    const imb = bidQty + askQty === 0 ? 0 : (bidQty - askQty) / (bidQty + askQty);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      refId: snap.refId,
      ltp: snap.ltp,
      imb: Math.round(imb * 1000) / 1000,
      bid1: snap.bids[0] ? { p: snap.bids[0].price, q: snap.bids[0].quantity } : null,
      ask1: snap.asks[0] ? { p: snap.asks[0].price, q: snap.asks[0].quantity } : null,
      bidSum: bidQty,
      askSum: askQty,
    });
    out.write(line + "\n");
  });
  logger.info({ refIds: ofRefIds, file: outFile }, "[MarketScheduler] Orderflow recorder started");
}

export function stopOrderflowRecorder() {
  if (ofClient) {
    ofClient.stop();
    ofClient = null;
    logger.info("[MarketScheduler] Orderflow recorder stopped");
  }
}

export function getOrderflowRecorderStatus() {
  return { running: !!ofClient, refIds: ofRefIds, file: ofFile, error: ofError };
}

export function startMarketScheduler() {
  if (schedulerTimer) return;
  logger.info("[MarketScheduler] Started — checking every 30s");
  schedulerTimer = setInterval(async () => {
    const open = isMarketHours();
    const date = getIsoDate();
    if (open && !startedToday) {
      startedToday = true;
      startTickRecorder();
      await startOrderflowRecorder();
      logger.info({ date }, "[MarketScheduler] Market OPEN — tick + orderflow started");
    } else if (!open && startedToday) {
      startedToday = false;
      stopTickRecorder();
      stopOrderflowRecorder();
      logger.info({ date }, "[MarketScheduler] Market CLOSED — tick + orderflow stopped");
    }
  }, 30_000);
  schedulerTimer.unref();
  // Initial check
  if (isMarketHours()) {
    startedToday = true;
    startTickRecorder();
    startOrderflowRecorder().catch(() => {});
    logger.info("[MarketScheduler] Initial: market OPEN — started both");
  }
}

export function stopMarketScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  stopTickRecorder();
  stopOrderflowRecorder();
}