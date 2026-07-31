// S2 backtest sweep — 1m, 3m, 5m — full report
// Usage: npx tsx server/backtest-s2.ts

import { calculateRSI, calculateMACD, calculateBollingerBands } from "./indicators";

interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number; }

interface BTConfig {
  confidenceThreshold: number;
  premiumTargetPct: number;
  stopLossPct: number;
}

interface BTTrade {
  entryTime: number; exitTime: number;
  direction: "CE" | "PE";
  entrySpot: number; exitSpot: number;
  premium: number; pnl: number; pnlPct: number;
  result: "WIN" | "LOSS";
  confidence: number; reasons: string[];
  signalType: string; // what triggered it
  durationBars: number;
}

function simPremium(spot: number): number { return spot * 0.006; }

function simExitPremium(entryPremium: number, entrySpot: number, exitSpot: number, isCE: boolean): number {
  const spotMove = exitSpot - entrySpot;
  const dir = isCE ? 1 : -1;
  const delta = Math.max(0.15, Math.min(0.85, 0.5 + dir * spotMove / entrySpot * 10));
  return Math.max(entryPremium * 0.05, entryPremium + entryPremium * delta * (spotMove / entrySpot) * 100);
}

async function fetchCandles(symbol: string, exchange: string, interval: string, count: number): Promise<Candle[]> {
  const res = await fetch(`http://localhost:3000/api/market/historical`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, exchange, interval, length: count }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().then(j => Array.isArray(j) ? j.map((c: any) => ({
    ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
  })) : []);
}

function runS2(candles: Candle[], cfg: BTConfig): BTTrade[] {
  const trades: BTTrade[] = [];
  if (candles.length < 40) return trades;
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  let openTrade: BTTrade | null = null;

  for (let i = 30; i < candles.length; i++) {
    const spot = candles[i].close;
    const rsiVal = rsi[i];
    const macdLine = macd.macdLine[i];
    const signalLine = macd.signalLine[i];
    const macdHist = macd.histogram[i];
    const prevMacdHist = macd.histogram[i - 1];

    if (openTrade) {
      const exitPremium = simExitPremium(openTrade.premium, openTrade.entrySpot, spot, openTrade.direction === "CE");
      const pnlPct = (exitPremium - openTrade.premium) / openTrade.premium * 100;
      const hitTarget = pnlPct >= cfg.premiumTargetPct;
      const hitSL = pnlPct <= -cfg.stopLossPct;
      if (hitTarget || hitSL || i === candles.length - 1) {
        openTrade.exitTime = candles[i].ts;
        openTrade.exitSpot = spot;
        const exitP = hitSL ? openTrade.premium * (1 - cfg.stopLossPct / 100)
                      : hitTarget ? openTrade.premium * (1 + cfg.premiumTargetPct / 100)
                      : exitPremium;
        openTrade.pnl = exitP - openTrade.premium;
        openTrade.pnlPct = (exitP - openTrade.premium) / openTrade.premium * 100;
        openTrade.result = openTrade.pnl >= 0 ? "WIN" : "LOSS";
        openTrade.durationBars = i - (candles.findIndex(c => c.ts === openTrade!.entryTime));
        trades.push(openTrade);
        openTrade = null;
      }
      continue;
    }

    let bullScore = 0, bearScore = 0;
    const reasons: string[] = [];

    if (rsiVal < 30) { bullScore += 2; reasons.push(`RSI${rsiVal.toFixed(0)}`); }
    else if (rsiVal > 70) { bearScore += 2; reasons.push(`RSI${rsiVal.toFixed(0)}`); }
    else if (rsiVal > 50) bullScore += 1;
    else bearScore += 1;

    const expanding = macdLine > signalLine && macdHist > prevMacdHist;
    const contracting = macdLine < signalLine && macdHist < prevMacdHist;
    if (expanding) { bullScore += 2; reasons.push("MACDexp"); }
    else if (contracting) { bearScore += 2; reasons.push("MACDcon"); }
    else if (macdLine > signalLine) bullScore += 1;
    else bearScore += 1;

    const bb = calculateBollingerBands(closes.slice(0, i+1), 20, 2);
    const bbMid = bb.middle[bb.middle.length-1];
    const bbWidth = bbMid > 0 ? ((bb.upper[bb.upper.length-1] - bb.lower[bb.lower.length-1]) / bbMid) * 100 : 0;
    const batch = candles.slice(Math.max(0, i-19), i+1);
    const sumVol = batch.reduce((a, c) => a + (c.volume||0), 0);
    const vwap = sumVol > 0 ? batch.reduce((a, c) => a + c.close * (c.volume||0), 0) / sumVol : spot;
    const vols = batch.map(c => c.volume||0);
    const volAvg = vols.reduce((a, b) => a + b, 0) / vols.length;
    const volStd = Math.sqrt(vols.reduce((a, b) => a + (b - volAvg)**2, 0) / vols.length);
    const volZ = volStd > 0 ? (vols[vols.length-1] - volAvg) / volStd : 0;

    if (spot > vwap) { bullScore += 1; reasons.push("VWAP↑"); } else { bearScore += 1; reasons.push("VWAP↓"); }
    if (bbWidth < 0.5) reasons.push(`BBsqz${bbWidth.toFixed(2)}`);
    if (volZ > 2) { if (bullScore >= bearScore) { bullScore += 1; reasons.push(`Vol${volZ.toFixed(1)}σ`); } else { bearScore += 1; reasons.push(`Vol${volZ.toFixed(1)}σ`); } }

    const totalScore = bullScore + bearScore;
    const confidence = totalScore > 0 ? Math.round(Math.max(bullScore, bearScore) / totalScore * 100) : 50;
    const isBull = bullScore > bearScore;
    const hasStrong = rsiVal < 30 || rsiVal > 70 || expanding || contracting;
    if (!hasStrong || confidence < cfg.confidenceThreshold || totalScore < 3) continue;

    let signalType = "";
    if (rsiVal < 30 || rsiVal > 70) signalType += "RSI";
    if (expanding || contracting) signalType += signalType ? "+MACD" : "MACD";
    if (volZ > 2) signalType += signalType ? "+VOL" : "VOL";
    if (!signalType) signalType = "MIXED";

    const premium = simPremium(spot);
    openTrade = {
      entryTime: candles[i].ts, exitTime: 0,
      direction: isBull ? "CE" : "PE", entrySpot: spot, exitSpot: 0,
      premium, pnl: 0, pnlPct: 0, result: "LOSS", confidence, reasons,
      signalType, durationBars: 0,
    };
  }
  return trades;
}

function analyze(trades: BTTrade[], label: string) {
  if (trades.length < 3) { console.log(`\n=== ${label} ===\n  Too few trades (${trades.length}) for analysis\n`); return; }

  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const wr = wins.length / trades.length * 100;
  const cumulativePnl = trades.reduce((a, t) => a + t.pnl, 0);
  let peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const avgConf = trades.reduce((a, t) => a + t.confidence, 0) / trades.length;
  const avgDur = trades.reduce((a, t) => a + t.durationBars, 0) / trades.length;
  const expectancy = (wr / 100) * avgWin + (1 - wr / 100) * avgLoss;

  // Direction breakdown
  const ceTrades = trades.filter(t => t.direction === "CE");
  const peTrades = trades.filter(t => t.direction === "PE");
  const ceWR = ceTrades.length >= 3 ? ceTrades.filter(t => t.result === "WIN").length / ceTrades.length * 100 : 0;
  const peWR = peTrades.length >= 3 ? peTrades.filter(t => t.result === "WIN").length / peTrades.length * 100 : 0;

  // Signal type breakdown
  const bySignal: Record<string, BTTrade[]> = {};
  for (const t of trades) {
    const key = t.signalType.split("+")[0]; // primary trigger
    (bySignal[key] = bySignal[key] || []).push(t);
  }

  // Consecutive wins/losses (max streak)
  let maxWinStreak = 0, maxLossStreak = 0, cur = 0, prevResult = "";
  for (const t of trades) {
    if (t.result === prevResult) cur++;
    else { cur = 1; prevResult = t.result; }
    if (t.result === "WIN") maxWinStreak = Math.max(maxWinStreak, cur);
    else maxLossStreak = Math.max(maxLossStreak, cur);
  }

  // Profit factor
  const grossProfit = wins.reduce((a, t) => a + Math.abs(t.pnl), 0);
  const grossLoss = losses.reduce((a, t) => a + Math.abs(t.pnl), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Sharpe-like (PnL / std(PnL))
  const meanPnl = trades.reduce((a, t) => a + t.pnl, 0) / trades.length;
  const varPnl = trades.reduce((a, t) => a + (t.pnl - meanPnl)**2, 0) / trades.length;
  const sharpe = Math.sqrt(varPnl) > 0 ? meanPnl / Math.sqrt(varPnl) * Math.sqrt(trades.length) : 0;

  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"━".repeat(60)}`);

  console.log(`\n  ┌─ SUMMARY`);
  console.log(`  │ Trades:     ${trades.length}`);
  console.log(`  │ Win rate:   ${wr.toFixed(1)}%`);
  console.log(`  │ Net P&L:    ${cumulativePnl >= 0 ? "+" : ""}${cumulativePnl.toFixed(1)} pts`);
  console.log(`  │ Max DD:     ${maxDD.toFixed(1)} pts`);
  console.log(`  │ Avg win:    ${avgWin.toFixed(1)}%`);
  console.log(`  │ Avg loss:   ${avgLoss.toFixed(1)}%`);
  console.log(`  │ Expectancy: ${expectancy.toFixed(2)}%`);
  console.log(`  │ Profit F:   ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
  console.log(`  │ Sharpe:     ${sharpe.toFixed(2)}`);
  console.log(`  │ Avg conf:   ${avgConf.toFixed(0)}%`);
  console.log(`  │ Avg hold:   ${avgDur.toFixed(1)} bars`);

  console.log(`\n  ┌─ STREAKS`);
  console.log(`  │ Max win streak:  ${maxWinStreak}`);
  console.log(`  │ Max loss streak: ${maxLossStreak}`);

  console.log(`\n  ┌─ DIRECTION BREAKDOWN`);
  console.log(`  │ CE: ${ceTrades.length} trades, ${ceWR.toFixed(1)}% WR, avg ${ceTrades.length ? ceTrades.reduce((a,t) => a + t.pnlPct, 0) / ceTrades.length : 0}%`);
  console.log(`  │ PE: ${peTrades.length} trades, ${peWR.toFixed(1)}% WR, avg ${peTrades.length ? peTrades.reduce((a,t) => a + t.pnlPct, 0) / peTrades.length : 0}%`);

  console.log(`\n  ┌─ SIGNAL TYPE BREAKDOWN`);
  for (const [key, list] of Object.entries(bySignal).sort((a, b) => b[1].length - a[1].length)) {
    const swr = list.filter(t => t.result === "WIN").length / list.length * 100;
    console.log(`  │ ${key.padEnd(8)} ${list.length} trades, ${swr.toFixed(1)}% WR`);
  }

  // Time bucket analysis
  const buckets: Record<string, BTTrade[]> = { Open: [], Mid: [], Close: [] };
  for (const t of trades) {
    const d = new Date(t.entryTime / 1000000);
    const h = d.getHours(), m = d.getMinutes();
    const mins = h * 60 + m - 9 * 60 - 15; // mins since 9:15
    if (mins < 30) buckets.Open.push(t);
    else if (mins < 14 * 60 + 30 - 9 * 60 - 15) buckets.Mid.push(t);
    else buckets.Close.push(t);
  }
  console.log(`\n  ┌─ TIME-OF-DAY BREAKDOWN`);
  for (const [bk, list] of Object.entries(buckets)) {
    if (list.length < 2) continue;
    const swr = list.filter(t => t.result === "WIN").length / list.length * 100;
    const avg = list.reduce((a, t) => a + t.pnlPct, 0) / list.length;
    console.log(`  │ ${bk.padEnd(8)} ${list.length} trades, ${swr.toFixed(1)}% WR, avg ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%`);
  }

  // Equity curve snapshot
  console.log(`\n  ┌─ EQUITY CURVE (every 5 trades)`);
  let runCum = 0;
  for (let i = 0; i < trades.length; i += 5) {
    runCum += trades.slice(i, i + 5).reduce((a, t) => a + t.pnl, 0);
    console.log(`  │ T${Math.min(i+5, trades.length).toString().padStart(3)}: ${runCum.toFixed(1)}`);
  }
  console.log(`  │ FINAL: ${cumulativePnl.toFixed(1)}`);

  // Top 5 best / worst trades
  const sorted = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);
  console.log(`\n  ┌─ TOP 5 WINNERS`);
  sorted.slice(0, 5).forEach((t, i) => {
    console.log(`  │ ${i+1}. ${t.direction} ${t.signalType} conf${t.confidence} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`);
  });
  console.log(`  ┌─ TOP 5 LOSERS`);
  sorted.slice(-5).reverse().forEach((t, i) => {
    console.log(`  │ ${i+1}. ${t.direction} ${t.signalType} conf${t.confidence} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`);
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       S2 MULTI-TIMEFRAME BACKTEST REPORT             ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const configs = [
    { interval: "1m", length: 375, label: "TIMEFRAME: 1-MINUTE" },
    { interval: "3m", length: 200, label: "TIMEFRAME: 3-MINUTE" },
    { interval: "5m", length: 150, label: "TIMEFRAME: 5-MINUTE" },
    { interval: "15m", length: 75, label: "TIMEFRAME: 15-MINUTE" },
  ];

  // Sweep configs — scalper (CT, PT, SL)
  const sweeps: BTConfig[] = [];
  for (const ct of [50, 55, 60, 65]) {
    for (const pt of [25, 30, 35]) {
      for (const sl of [15, 20, 25]) {
        sweeps.push({ confidenceThreshold: ct, premiumTargetPct: pt, stopLossPct: sl });
      }
    }
  }

  // Swing mode configs — wider targets, stops, across multiple sessions
  const swingSweeps: BTConfig[] = [];
  for (const ct of [50, 55, 60, 65]) {
    for (const pt of [40, 60, 80]) {
      for (const sl of [20, 25, 30]) {
        swingSweeps.push({ confidenceThreshold: ct, premiumTargetPct: pt, stopLossPct: sl });
      }
    }
  }

  for (const conf of configs) {
    console.log(`\n\n📡 Fetching ${conf.interval} candles (${conf.length})...`);
    const candles = await fetchCandles("NIFTY", "NSE", conf.interval, conf.length);
    if (candles.length < 40) { console.log(`  ⚠ Only ${candles.length} candles, skipping`); continue; }
    const spotStart = candles[0].close;
    const spotEnd = candles[candles.length - 1].close;
    console.log(`  ${candles.length} candles | Spot: ${spotStart.toFixed(1)} → ${spotEnd.toFixed(1)} (${((spotEnd - spotStart) / spotStart * 100).toFixed(2)}%)`);

    // Table sweep
    const results: { cfg: BTConfig; trades: BTTrade[]; wr: number; avgPnlPct: number; maxDD: number; score: number }[] = [];
    for (const cfg of sweeps) {
      const trades = runS2(candles, cfg);
      if (trades.length < 3) continue;
      const wins = trades.filter(t => t.result === "WIN").length;
      const wr = wins / trades.length * 100;
      const avgPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
      let peak = 0, maxDD = 0, cum = 0;
      for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
      const score = wr * Math.max(0, avgPnlPct) / Math.max(maxDD, 1);
      results.push({ cfg, trades, wr, avgPnlPct, maxDD, score });
    }

    results.sort((a, b) => b.score - a.score);
    const bestOverall = results[0];

    console.log(`\n  ┌─ PARAMETER SWEEP (sorted by score)`);
    console.log(`  │ CT  PT  SL  Trades  WR%   Avg%   MaxDD  Score`);
    console.log(`  │ ${"─".repeat(48)}`);
    results.slice(0, 15).forEach(r => {
      console.log(`  │ ${String(r.cfg.confidenceThreshold).padStart(2)}  ${String(r.cfg.premiumTargetPct).padStart(2)}  ${String(r.cfg.stopLossPct).padStart(2)}  ${String(r.trades.length).padStart(5)}  ${r.wr.toFixed(1).padStart(4)}  ${r.avgPnlPct.toFixed(1).padStart(5)}  ${r.maxDD.toFixed(0).padStart(5)}  ${r.score.toFixed(1).padStart(6)}`);
    });

    // Full analysis on best overall config
    if (bestOverall) {
      analyze(bestOverall.trades, conf.label);
    }
  }

  // Cross-TF comparison table
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("  CROSS-TIMEFRAME COMPARISON (best config: CT=55 PT=30 SL=15)");
  console.log(`${"═".repeat(60)}`);
  console.log("  TF  Trades  WR%   Avg%  MaxDD Score  NetP&L");
  console.log(`  ${"─".repeat(50)}`);

  for (const conf of configs) {
    const candles = await fetchCandles("NIFTY", "NSE", conf.interval, conf.length);
    const trades = runS2(candles, { confidenceThreshold: 55, premiumTargetPct: 30, stopLossPct: 15 });
    if (trades.length < 3) { console.log(`  ${conf.interval.padEnd(4)} ${String(trades.length).padStart(5)} — insufficient data`); continue; }
    const wins = trades.filter(t => t.result === "WIN").length;
    const wr = wins / trades.length * 100;
    const avgPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
    const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
    let peak = 0, maxDD = 0, cum = 0;
    for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
    const score = wr * Math.max(0, avgPnlPct) / Math.max(maxDD, 1);
    console.log(`  ${conf.interval.padEnd(4)} ${String(trades.length).padStart(5)}  ${wr.toFixed(1).padStart(4)}  ${avgPnlPct.toFixed(1).padStart(4)} ${maxDD.toFixed(0).padStart(5)} ${score.toFixed(1).padStart(5)}  ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(0)}`);
  }

  // ── 15m SWING MODE ANALYSIS ──
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("  15-MINUTE SWING MODE ANALYSIS");
  console.log(`${"═".repeat(60)}`);
  console.log("  Wider targets & stops, higher confidence threshold, multi-session holds.\n");

  const swingCandles = await fetchCandles("NIFTY", "NSE", "15m", 2000);
  if (swingCandles.length >= 40) {
    const swingResults: { cfg: BTConfig; trades: BTTrade[]; wr: number; avgPnlPct: number; maxDD: number; score: number }[] = [];
    for (const cfg of swingSweeps) {
      const trades = runS2(swingCandles, cfg);
      if (trades.length < 2) continue;
      const wins = trades.filter(t => t.result === "WIN").length;
      const wr = wins / trades.length * 100;
      const avgPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
      let peak = 0, maxDD = 0, cum = 0;
      for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
      const score = wr * Math.max(0, avgPnlPct) / Math.max(maxDD, 1);
      swingResults.push({ cfg, trades, wr, avgPnlPct, maxDD, score });
    }

    swingResults.sort((a, b) => b.score - a.score);

    console.log("  ┌─ SWING PARAMETER SWEEP (CT=60-75, PT=40-100%, SL=20-35%)");
    console.log("  │ CT  PT   SL   Trades  WR%    Avg%   MaxDD  Score");
    console.log(`  │ ${"─".repeat(54)}`);
    swingResults.slice(0, 15).forEach(r => {
      console.log(`  │ ${String(r.cfg.confidenceThreshold).padStart(2)}  ${String(r.cfg.premiumTargetPct).padStart(3)}  ${String(r.cfg.stopLossPct).padStart(2)}  ${String(r.trades.length).padStart(5)}  ${r.wr.toFixed(1).padStart(5)}  ${r.avgPnlPct.toFixed(1).padStart(5)}  ${r.maxDD.toFixed(0).padStart(5)}  ${r.score.toFixed(1).padStart(6)}`);
    });

    const bestSwing = swingResults[0];
    if (bestSwing && bestSwing.trades.length >= 2) {
      analyze(bestSwing.trades, "15M SWING MODE (best config)");

      const scalperTrades = runS2(swingCandles, { confidenceThreshold: 55, premiumTargetPct: 30, stopLossPct: 15 });
      if (scalperTrades.length >= 2) {
        const sWins = scalperTrades.filter(t => t.result === "WIN").length;
        const sWR = sWins / scalperTrades.length * 100;
        const sAvg = scalperTrades.reduce((a, t) => a + t.pnlPct, 0) / scalperTrades.length;
        const sNet = scalperTrades.reduce((a, t) => a + t.pnl, 0);
        console.log(`\n  ┌─ SCALPER vs SWING (15m)`);
        console.log(`  │             Trades  WR%    Avg%   NetP&L`);
        console.log(`  │ ${"─".repeat(40)}`);
        console.log(`  │ Scalper      ${String(scalperTrades.length).padStart(4)}  ${sWR.toFixed(1).padStart(4)}  ${sAvg.toFixed(1).padStart(5)}  ${sNet >= 0 ? "+" : ""}${sNet.toFixed(0)}`);
        console.log(`  │ Swing        ${String(bestSwing.trades.length).padStart(4)}  ${bestSwing.wr.toFixed(1).padStart(4)}  ${bestSwing.avgPnlPct.toFixed(1).padStart(5)}  ${bestSwing.trades.reduce((a,t) => a + t.pnl, 0) >= 0 ? "+" : ""}${bestSwing.trades.reduce((a,t) => a + t.pnl, 0).toFixed(0)}`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
