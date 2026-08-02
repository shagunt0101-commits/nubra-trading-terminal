import logger from "../logger.js";
import { Router } from "express";
import { nubraApi } from "../nubra.js";
import { validate, backtestSchema } from "../validation.js";
import { fetchCandles, fetchOptionCandles } from "../market-data.js";
import { calculateSMA, calculateEMA, calculateRSI, calculateBollingerBands, calculateMACD } from "../indicators.js";
import { evaluateTrendContinuation, evaluateBBMeanReversal, evaluateRSIReversal, evaluateTrendFollow } from "../strategy-engine.js";

const router = Router();

router.post("/", validate(backtestSchema), async (req, res) => {
  const {
    symbol, strategy, interval = "5m", length = 200, riskReward = 2,
    stopLossPercent = 1.5, targetPercent = 3, exchange = "NSE",
    confidenceThreshold = 55, premiumTargetPct = 30, stopLossPct = 15,
    optionRsiThreshold = 40, optionRsiPeriod = 14, maxEntryPremium = 200, premiumTargetPoints = 4
  } = req.body;

  try {
    let candles = await fetchCandles(symbol, exchange, interval, length);
    if (candles.length === 0) {
      return res.status(500).json({ error: "No data available for backtest." });
    }

    const closes = candles.map((c: any) => c.close);
    const sma20 = calculateSMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    const bb = calculateBollingerBands(closes, 20, 2);

    let trades: any[] = [];
    let currentPosition: any = null;
    let balance = 100000;
    const initialBalance = balance;

    let ceOptCandles: any[] = [];
    let peOptCandles: any[] = [];
    if (strategy === "option_rsi_mr") {
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
        logger.info({ ce: ceOptCandles.length, pe: peOptCandles.length }, "[Backtest] Option candles");
      } catch (_) { logger.warn({ symbol }, "[Backtest] Failed to fetch real option OHLC, using spot stream"); }
      if (!ceOptCandles.length && !peOptCandles.length) {
        logger.info("[Backtest] No option OHLC, using spot candle stream (orig entry)");
      }
    }

    for (let i = 20; i < candles.length; i++) {
      const candle = candles[i];
      if (currentPosition) {
        const price = candle.close;

        if (currentPosition.entryPremium != null) {
          const ci = i < ceOptCandles.length && i < peOptCandles.length ? i : null;
          const useRealCe = ci != null && ceOptCandles[ci]?.close > 0;
          const useRealPe = ci != null && peOptCandles[ci]?.close > 0;
          const atm = Math.round(price / 50) * 50;
          const curPrem = currentPosition.optType === "CE"
            ? (useRealCe ? ceOptCandles[ci!].close : price * 0.006 + Math.max(0, (price - atm) * 0.4))
            : (useRealPe ? peOptCandles[ci!].close : price * 0.005 + Math.max(0, (atm - price) * 0.4));
          const entryP = currentPosition.entryPremium;
          const pnlPts = curPrem - entryP;

          if (!currentPosition.phase1TargetHit) {
            const slHit = curPrem <= currentPosition.stopLoss;
            const tpHit = curPrem >= currentPosition.target;
            if (tpHit) {
              currentPosition.phase1TargetHit = true;
              currentPosition.stopLoss = entryP;
              currentPosition.maxPriceSeen = curPrem;
            } else if (slHit || i === candles.length - 1) {
              const exitPrem = slHit ? currentPosition.stopLoss : curPrem;
              const pnlVal = (exitPrem - entryP) * 100;
              balance += pnlVal;
              trades.push({ ...currentPosition, exitTime: Math.round(candle.ts / 1000000), exitPrice: price, exitPremium: Math.round(exitPrem * 100) / 100, pnl: Math.round(pnlVal * 100) / 100, pnlPercent: Math.round((exitPrem / entryP - 1) * 10000) / 100, result: pnlVal > 0 ? "WIN" : "LOSS" });
              currentPosition = null;
            }
          } else {
            if (curPrem > (currentPosition.maxPriceSeen || entryP)) currentPosition.maxPriceSeen = curPrem;
            const trailStop = (currentPosition.maxPriceSeen || entryP) * 0.80;
            const exitPrem = curPrem <= trailStop ? curPrem : null;
            if ((exitPrem != null) || i === candles.length - 1) {
              const ePrem = exitPrem != null ? exitPrem : curPrem;
              const pnlVal = (ePrem - entryP) * 100;
              balance += pnlVal;
              trades.push({ ...currentPosition, exitTime: Math.round(candle.ts / 1000000), exitPrice: price, exitPremium: Math.round(ePrem * 100) / 100, pnl: Math.round(pnlVal * 100) / 100, pnlPercent: Math.round((ePrem / entryP - 1) * 10000) / 100, result: pnlVal > 0 ? "WIN" : "LOSS" });
              currentPosition = null;
            }
          }
          continue;
        }

        const profitPct = (price - currentPosition.entryPrice) / currentPosition.entryPrice * (currentPosition.side === "BUY" ? 1 : -1);
        const slHit = profitPct <= -stopLossPercent / 100;
        const tpHit = profitPct >= targetPercent / 100;

        if (slHit || tpHit || i === candles.length - 1) {
          const exitPrice = slHit ? currentPosition.entryPrice * (1 + (currentPosition.side === "BUY" ? -stopLossPercent : stopLossPercent) / 100) :
                            tpHit ? currentPosition.entryPrice * (1 + (currentPosition.side === "BUY" ? targetPercent : -targetPercent) / 100) : price;
          const pnlVal = (exitPrice - currentPosition.entryPrice) * currentPosition.qty * (currentPosition.side === "BUY" ? 1 : -1);
          balance += pnlVal;
          trades.push({ ...currentPosition, exitTime: Math.round(candle.ts / 1000000), exitPrice: Math.round(exitPrice * 100) / 100, pnl: Math.round(pnlVal * 100) / 100, pnlPercent: Math.round(pnlVal / (currentPosition.entryPrice * currentPosition.qty) * 10000) / 100, result: pnlVal > 0 ? "WIN" : "LOSS" });
          currentPosition = null;
        }
        continue;
      }

      let triggerSignal = false;
      let side: "BUY" | "SELL" = "BUY";

      if (strategy === "trend_continuation" || strategy === "bb_mean_reversion" ||
          strategy === "rsi_reversal" || strategy === "sma_ema_trend") {
        const slice = candles.slice(0, i + 1);
        const res = strategy === "trend_continuation" ? evaluateTrendContinuation(slice, "scalping")
          : strategy === "bb_mean_reversion" ? evaluateBBMeanReversal(slice)
          : strategy === "rsi_reversal" ? evaluateRSIReversal(slice)
          : evaluateTrendFollow(slice);
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
        const s2Macd = calculateMACD(closes, 12, 26, 9);
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

        const bbMid = bb.middle[i];
        const bbWidth = bbMid > 0 ? ((bb.upper[i] - bb.lower[i]) / bbMid) * 100 : 0;
        const batch = candles.slice(Math.max(0, i - 19), i + 1);
        const sumVol = batch.reduce((a: number, c: any) => a + (c.volume || 0), 0);
        const vwap = sumVol > 0 ? batch.reduce((a: number, c: any) => a + c.close * (c.volume || 0), 0) / sumVol : candle.close;
        if (candle.close > vwap) { bullScore += 1; } else { bearScore += 1; }

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
        const tfSec: Record<string, number> = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
        const stepSec = tfSec[interval] || 60;
        if (stepSec > 300) continue;
        const rsiPeriod = optionRsiPeriod || 14;
        const rsiThreshold = optionRsiThreshold || 32;
        const maxEntryPremiumVal = maxEntryPremium || 80;
        const premiumTargetPts = premiumTargetPoints || 4;
        if (i < rsiPeriod + 2) continue;

        const ceUsed = ceOptCandles.length > i;
        const peUsed = peOptCandles.length > i;
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

        const spotRsiVals = calculateRSI(batchCloses, 14);
        const spotRsi15 = spotRsiVals[spotRsiVals.length - 1] || 50;
        const ceRsiArr = calculateRSI(ceSeries, rsiPeriod);
        const peRsiArr = calculateRSI(peSeries, rsiPeriod);
        if (!ceRsiArr.length || !peRsiArr.length) continue;

        const ceRsi = ceRsiArr[ceRsiArr.length - 1];
        const peRsi = peRsiArr[peRsiArr.length - 1];

        if (ceRsi <= rsiThreshold && spotRsi15 > 50) {
          const entryPremium = ceSeries[ceSeries.length - 1];
          if (entryPremium <= maxEntryPremiumVal) {
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
          if (entryPremium <= maxEntryPremiumVal) {
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
        const qty = Math.max(1, Math.floor(balance / candle.close));
        if (qty > 0) {
          currentPosition = { id: trades.length + 1, symbol, side, entryTime: Math.round(candle.ts / 1000000), entryPrice: candle.close, qty };
        }
      }
    }

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

export default router;
