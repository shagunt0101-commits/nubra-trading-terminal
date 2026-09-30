import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { fetchCandles } from "./market-data.js";
import { nubraApi } from "./nubra.js";

// Live tick recorder — appends one JSONL row per poll with the exact data the
// scalper strategies consume: spot 1m candles + ATM option chain (LTP, OI, IV,
// delta). Written to %TEMP% (outside repo → no Vite reload loop). Replay the
// file through server/backtest-engine.ts for offline per-strategy testing.
const DIR = process.env.TMPDIR || process.env.TEMP || "/tmp";
const STAMP = () => {
  const d = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const [day, month, year] = d.split('/');
  return `${year}${month}${day}`;
};
const FILE = () => path.join(DIR, `mvf-tick-${STAMP()}.jsonl`);

let timer: ReturnType<typeof setInterval> | null = null;
let file = "";

export function tickRecorderPollIntervalMs() { return 15_000; }
export function currentTickFile() { return FILE(); }

export function startTickRecorder() {
  if (timer) return;
  file = FILE();
  logger.info({ file }, "[TickData] Recorder started");
  timer = setInterval(run, tickRecorderPollIntervalMs());
  run();
  timer.unref();
}

export function stopTickRecorder() {
  if (timer) { clearInterval(timer); timer = null; logger.info("[Tick] Recorder stopped"); }
}

async function run() {
  try {
    const symbol = "NIFTY";
    const exchange = "NSE";
    // Spot 1m candles — same call the scalper uses (10s cache shared).
    const candles = await fetchCandles(symbol, exchange, "1m", 60);
    if (!candles.length) return;

    // ATM option chain — LTP/OI/IV/delta the strategies read for strike/premium.
    let chain;
    try { chain = (await nubraApi.getOptionChain(symbol, undefined, exchange))?.chain; }
    catch { chain = null; }

    const last = candles[candles.length - 1];
    const row = {
      ts: Date.now(),
      ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      symbol,
      spot: last.close,
      candle: candles.slice(-5),           // small pre-roll window
      chain,
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch (e: any) {
    logger.warn({ err: e }, "[Tick] recorder error");
  }
}