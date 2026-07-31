import { calculateRSI } from "./indicators.ts";

interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number; }

interface TradeLogEntry {
  entryTime: string;
  exitTime: string;
  side: "CE" | "PE";
  entryPremium: number;
  exitPremium: number;
  pnl: number;
  pnlPts: number;
  exitReason: string;
  entryRsi1m: number;
  spotRsi15m: number;
}

const ATM_STRIKE = 24000;
const TARGET_PTS = 4;
const SL_PCT = 0.5;
const COOLDOWN_MS = 5 * 60 * 1000;
const FORCED_EXIT_INDEX = 370; // candle index for 15:25 IST (09:15 + 370min)

function noise(i: number): number {
  const h1 = ((i * 2654435761) & 0x7fffffff) / 0x7fffffff;
  return 1 + (h1 - 0.5) * 0.04;
}

function simCEPremium(spot: number, idx: number): number {
  const base = spot * 0.006 + Math.max(0, (spot - ATM_STRIKE) * 0.4);
  return base * noise(idx);
}
function simPEPremium(spot: number, idx: number): number {
  const base = spot * 0.005 + Math.max(0, (ATM_STRIKE - spot) * 0.4);
  return base * noise(idx + 10000);
}

function build15mCloses(candles: Candle[]): number[] {
  const closes: number[] = [];
  for (let i = 14; i < candles.length; i += 15) closes.push(candles[i].close);
  return closes;
}

function tsToTimeStr(ts: number): string {
  const d = new Date(ts);
  let h = d.getUTCHours() + 5, m = d.getUTCMinutes() + 30;
  if (m >= 60) { h++; m -= 60; }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fmt(n: number): number { return Math.round(n * 100) / 100; }

async function main() {
  const errors: string[] = [];
  let candles: Candle[];

  try {
    const res = await fetch("http://localhost:3000/api/market/historical", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "NIFTY", exchange: "NSE", interval: "1m", length: 400 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    candles = await res.json();
    if (!Array.isArray(candles) || candles.length === 0) throw new Error("Empty array");
  } catch (e: any) {
    errors.push(`Data fetch: ${e.message}`);
    const result = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, winRate: 0, tradeLog: [], errors };
    process.stdout.write(JSON.stringify(result));
    return;
  }

  candles = candles.slice(0, FORCED_EXIT_INDEX + 1);
  if (candles.length < 30) {
    const result = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, winRate: 0, tradeLog: [], errors };
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Premium series with ±2% noise
  const cePremiums = candles.map((c, i) => simCEPremium(c.close, i));
  const pePremiums = candles.map((c, i) => simPEPremium(c.close, i));

  // 1-min RSI(14) of premium series
  const ceRsi1m = calculateRSI(cePremiums, 14);
  const peRsi1m = calculateRSI(pePremiums, 14);

  // 15-min spot RSI(14)
  const closes15m = build15mCloses(candles);
  const rsi15m = calculateRSI(closes15m, 14);

  let inTrade = false;
  let activeSide: "CE" | "PE" = "CE";
  let entryPremium = 0;
  let entryTime = 0;
  let lastExitTime = 0;
  const trades: TradeLogEntry[] = [];

  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i].ts;
    const close = candles[i].close;
    const bucket15 = Math.floor(i / 15);
    const spotRsi15 = bucket15 < rsi15m.length ? rsi15m[bucket15] : rsi15m[rsi15m.length - 1];
    const ceRsi = ceRsi1m[i];
    const peRsi = peRsi1m[i];
    const isEOD = i >= FORCED_EXIT_INDEX;

    if (inTrade) {
      const currPremium = activeSide === "CE" ? simCEPremium(close, i) : simPEPremium(close, i);
      const pnl = currPremium - entryPremium;
      const hitTarget = pnl >= TARGET_PTS;
      const hitSL = pnl <= -(entryPremium * SL_PCT);
      const hitEOD = isEOD;

      if (hitTarget || hitSL || hitEOD) {
        trades.push({
          entryTime: tsToTimeStr(entryTime),
          exitTime: tsToTimeStr(ts),
          side: activeSide,
          entryPremium: fmt(entryPremium),
          exitPremium: fmt(currPremium),
          pnl: fmt(pnl),
          pnlPts: fmt(pnl),
          exitReason: hitTarget ? "TARGET" : hitSL ? "STOP_LOSS" : "EOD",
          entryRsi1m: fmt(activeSide === "CE" ? ceRsi : peRsi),
          spotRsi15m: fmt(spotRsi15),
        });
        inTrade = false;
        lastExitTime = ts;
        if (hitEOD) break;
      }
      continue;
    }

    if (ts - lastExitTime < COOLDOWN_MS) continue;

    // CE entry: 1-min CE RSI <= 28 AND 15-min spot RSI > 50
    if (ceRsi <= 28 && spotRsi15 > 50) {
      activeSide = "CE";
      entryPremium = simCEPremium(close, i);
      entryTime = ts;
      inTrade = true;
    }
    // PE entry: 1-min PE RSI <= 28 AND 15-min spot RSI < 50
    else if (peRsi <= 28 && spotRsi15 < 50) {
      activeSide = "PE";
      entryPremium = simPEPremium(close, i);
      entryTime = ts;
      inTrade = true;
    }
  }

  const totalTrades = trades.length;
  const winsT = trades.filter(t => t.pnl > 0);
  const lossesT = trades.filter(t => t.pnl <= 0);
  const wins = winsT.length;
  const losses = totalTrades - wins;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const avgWin = winsT.length > 0 ? winsT.reduce((a, t) => a + t.pnl, 0) / winsT.length : 0;
  const avgLoss = lossesT.length > 0 ? lossesT.reduce((a, t) => a + t.pnl, 0) / lossesT.length : 0;
  const maxWin_ = winsT.length > 0 ? Math.max(...winsT.map(t => t.pnl)) : 0;
  const maxLoss_ = lossesT.length > 0 ? Math.min(...lossesT.map(t => t.pnl)) : 0;

  const result = {
    totalTrades, wins, losses,
    totalPnl: fmt(totalPnl),
    avgWin: fmt(avgWin),
    avgLoss: fmt(avgLoss),
    maxWin: fmt(maxWin_),
    maxLoss: fmt(maxLoss_),
    winRate: fmt(winRate),
    tradeLog: trades,
    errors,
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch(e => {
  const result = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, winRate: 0, tradeLog: [], errors: [e.stack || e.message] };
  process.stdout.write(JSON.stringify(result));
});