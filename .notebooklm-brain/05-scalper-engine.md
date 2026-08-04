# Auto-Scalper Engine (server/auto-scalper.ts, ~1400 lines)

Auto-scalper for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX option premium scalping. Poll loop → signal computation (strategy-branched) → broker entry → monitored exit. Paper/live modes. State persisted to disk, survives restarts.

## Modes & key types
- `ScalperMode`: "SCANNING" | "ENTRY" | "EXIT" | "IDLE" | "STOPPED" | "ERROR"
- `OptSide`: "CE" | "PE"; `OrderSide`: "BUY" | "SELL"
- `ScalperSignal`: `{timestamp, direction: "BUY_CE"|"BUY_PE"|"NEUTRAL", confidence, reasons[], rsi, macd, vwapAbove, bbWidth, volumeZscore, pcr, ivPercentile, atmStrike, targetStrike, premium, spot, optType, targetPremium?, stopLossPremium?}`
- `TradeRecord`: `{id, entryTime, entryPrice, entrySpot, qty, side, optType, strike, expiry, entryPremium, stopLoss, target, exitTime?, exitPrice?, exitPremium?, exitReason?, pnl?, pnlPct?, status "OPEN"|"CLOSED"|"STOPPED", phase1TargetHit?, maxPriceSeen?, currentPremium?}`

## ScalperConfig fields
`symbol, exchange, assetType, lotSize, lotCount, totalQty, pollIntervalMs, confidenceThreshold, premiumTargetPct, stopLossPct, maxSpreadPct, strikeOffset, strikeStep, consecutiveLossLimit, minPremiumThreshold, optionExpiry, strategy, paperMode, optionRsiThreshold, optionRsiPeriod, premiumTargetPoints, premiumStopLossPct, targetMode ("points"|"percent"), minDelta, maxEntryPremium, expiryFilterCE, expiryFilterAll, exitStrategy, exitMode ("sl_tp"|"phase"), trailPct, phase1TargetPct, maxConcurrentTrades, maxDailyLoss, maxPositionSizePct, smaPeriod, emaPeriod, bbPeriod, bbStdDev, trendGateAdx (0=off), srEnabled (bool), srTimeframe ("15m"|"1h"), srZonePct (0.15)`

## Defaults
- DEFAULT_CONFIG: symbol NIFTY, lotSize 65, lotCount 2, totalQty 130, pollIntervalMs 15_000, confidenceThreshold 55, premiumTargetPct 30, stopLossPct 20, maxSpreadPct 5, strikeOffset 1, strikeStep 50, consecutiveLossLimit 3, minPremiumThreshold 0.5, strategy "s2_scalper", paperMode true, optionRsiThreshold 40, optionRsiPeriod 14, premiumTargetPoints 4, premiumStopLossPct 50, targetMode "points", minDelta 0.45, maxEntryPremium 600, entryCutoff "15:30" (SEBI CAS; was 15:20), expiryFilterCE "12:30", expiryFilterAll "13:30", exitMode "sl_tp", trailPct 80, maxConcurrentTrades 1, maxDailyLoss 50, maxPositionSizePct 20, smaPeriod 10, emaPeriod 30, bbPeriod 20, bbStdDev 2.
- INSTRUMENT_DEFAULTS (merged over DEFAULT_CONFIG, then user cfg): NIFTY 65/2/130, minPrem 0.5, maxPrem 600, TP 4pts; BANKNIFTY 35/2/70, minPrem 1.0, maxPrem 900, TP 6pts, step 100; FINNIFTY 65/2/130, minPrem 0.5, maxPrem 500, TP 3pts; MIDCPNIFTY 140/1/140, minPrem 0.5, maxPrem 500, TP 3pts; SENSEX 20/2/40, minPrem 1.0, maxPrem 1000, TP 6pts, step 100.
- Merge order: `{...DEFAULT_CONFIG, ...INSTRUMENT_DEFAULTS[symbol], ...cfg}`.

## Poll loop (15s)
1. Broker session ensure (`nubraLogin()` if no token).
2. Market-hours gate: IST 09:15–15:40 else IDLE (index derivatives extended to 15:40 by SEBI CAS 2026-08-03; cash still 15:30).
3. Spot via `nubraApi.getCurrentPrice(symbol, exchange)`, `spot = quote.price / 100` (paise→₹). Auth-expired → clearSession + re-login. `consecutiveErrors > 5` → ERROR + stop.
4. If activeTrade OPEN → `checkExit(spot)`, return.
5. SCANNING → `computeSignal(spot)`; skip if NEUTRAL or confidence < threshold.

## Entry guards
- Loss streak ≥ consecutiveLossLimit → SKIP.
- premium < minPremiumThreshold → SKIP.
- dailyPnl ≤ −maxDailyLoss → SKIP + stop() (reset on ISO date change).

## computeSignal
- Requires ≥30 candles; flat-candle guard (`new Set(closes).size <= 1` → "Synthetic/flat candle data detected").
- Engine strategies first (switch): trend_continuation → evaluateTrendContinuation(candles, "scalping"); bb_mean_reversion → evaluateBBMeanReversal; rsi_reversal → evaluateRSIReversal; sma_ema_trend → evaluateTrendFollow. Engine LONG → BUY_CE.
- Internal strategies: sma_ema_cross → computeSmaEma; rsi_overbought_oversold → computeRsi; bollinger_band_reversal → computeBB; option_rsi_mr → computeOptionRsiMR; s2_scalper/default → computeS2.
- **computeS2**: RSI(14) bands ±2, MACD(12,26,9) expand/contract ±2, BB(20,2) width (squeeze <0.5% −15 conf, wide >1.5% +10 if strong), 20-bar VWAP, volume z-score(20) >2, PCR (pcr>1.2 bear +1, <0.8 bull +1), ATM IV percentile `clamp(atmIV/25*100, 0, 100)`. confidence = round(max(bull,bear)/(bull+bear)*100) or 50. Gate: hasStrongSignal (rsi<30 || rsi>70 || macdExpanding || macdContracting) && confidence ≥ threshold && (bull+bear) ≥ 3, else NEUTRAL.
- **Trend-confirmation gate (2026-08-04)**: `trendGateAdx` config (0=off, default off). After the raw-signal gate, `trendDirection(candles)` computes ADX(14)/+DI/−DI on the same 1m candles. ADX ≥ trendGateAdx confirms trend; signal fighting it (+DI>−DI up-trend blocks BUY_PE; −DI>+DI down-trend blocks BUY_CE) → hard NEUTRAL before strike resolution. Fixes S2 mean-reverting into strong trends (fade losses). Aligned signals pass; reasons get `trend <dir> ADX <x>`.
- **Higher-TF S/R zone gate (2026-08-04)**: `srEnabled`/`srTimeframe` ("15m" default, 400 candles ≈ 7 days; "1h" 130)/`srZonePct` (0.15). `srLevels()` — fractal pivots (2 neighbors each side) on higher-TF candles, ATR(14)×0.5 noise filter, cluster pivots within zoneHalf = zonePct% of last close into levels, ≥2 pivots per cluster confirms, kind = majority pivot type (highs→R, lows→S), level price quantized to strike step, react filter (≥1 candle high/low within 0.5×ATR), 60s cache (`srFetchCandles` seam for tests). `srGate(spot, isBull, reasons)` — zoneHalf + half strike step tolerance; BUY_CE into resistance OR BUY_PE into support → hard NEUTRAL (fading INTO a capped level is where scalps die); BUY_CE at support / BUY_PE at resistance → reversal candidate, confidence +10, reason `S/R: reversal at <level>`.
- **computeOptionRsiMR**: 15-min spot RSI(14) trend filter; real option OHLC for ATM±offset strikes via fetchOptionSymbol + fetchCandlesInternal (parallel); synthetic premium fallback CE `c*0.006 + max(0,(c-atm)*0.4)`, PE `c*0.005 + max(0,(atm-c)*0.4)`. Entry: ceRsi ≤ threshold && spotRsiVal > 50 → BUY_CE; peRsi ≤ threshold && spotRsiVal < 50 → BUY_PE. Live mode requires real last-bar premium; PE blocked expiry day after expiryFilterCE; expiryFilterAll skips all. Confidence 80. SL: min(finalPrem*slPct/100, 15), slPct 35 expiry day else 50; target = finalPrem + premiumTargetPoints.

## Strike resolution (resolveStrikePremium)
- atmAround(spot) = round(spot/step)*step (50 NIFTY, 100 BANKNIFTY/SENSEX).
- targetStrike = atm ± step*strikeOffset; delta check: |delta| < minDelta (0.45) → walk one step toward ATM. Premium from chain ltp/100 when available.
- Default premium model: CE `spot*0.006`, PE `spot*0.005`. Live gate: !paperMode && !targetOpt.ltp → NEUTRAL.

## placeEntry
- Single active trade guard (regardless of maxConcurrentTrades).
- Position size: estMargin = premium*qty*0.25 vs available 500000 hardcoded; fail if > maxPositionSizePct (bypass if pct ≥ 100). [ponytail: simplified SPAN estimate]
- SL/TP: signal overrides; else points mode → premium ± premiumTargetPoints; percent → premium*(1∓stopLossPct/100), premium*(1+premiumTargetPct/100).
- Paper: build TradeRecord, mode EXIT, no broker call.
- Live: refId from chain match (fallbacks 1497712 CE / 1497713 PE); payload `{isMultiLeg: false, refId, qty, side:"BUY", deliveryType:"IDAY", priceType:"LIMIT", validityType:"DAY", entryPrice (paise), executionMode:"ENTRY", stratTags:["auto-scalper", "conf-<confidence>"]}`.
- **Idempotency**: createOrder failure → findPendingOrder (getOrders, match Number(refId) + Number(orderQty)); if found first LIMIT landed → no double-place; else retry once as MARKET.

## Exit logic (checkExit)
- Premium source: paper → model `entryPremium + (CE ? 1 : -1)*0.6*spotChg`, floor entryPremium*0.15; live → chain LTP at trade.strike; LTP ≤ 0 or unchanged → delta-0.6 model. currentPremium stored.
- exitStrat = exitStrategy || strategy. option_rsi_mr → checkOptionRsiMrExit else checkStandardExit.
- **checkStandardExit**: phase mode → phase1 SL exit; on target hit → phase1TargetHit, SL to breakeven; phase 2 trail `trailStop = maxPriceSeen*trailPct/100` → TRAIL_SL_<pct>. sl_tp → SL_HIT / TARGET_HIT. Forced square-off IST ≥ 15:35 → MARKET_CLOSE (SEBI CAS 2026-08-03: derivatives trade to 15:40, square-off at 15:35; was 15:25/15:30).
- **checkOptionRsiMrExit** (3-phase): SL → SL_HIT; target (+points) → phase1TargetHit, SL breakeven; 80% trailing SL (hardcoded maxPriceSeen*0.80) → TRAIL_SL_80; option RSI ≥ 70 exit — real option candles anchored at HELD trade.strike (not live ATM; stale-SL artifact fix); synthetic fallback `c*0.00385 ± max(0,(c−strike)*0.6)`; market close 15:35 → MARKET_CLOSE.
- **forceClose(reason="MANUAL_CLOSE")** (2026-08-04): manual close from `POST /api/scalper/close-trade` (ScalperDashboard "Close Trade" button). Chain LTP exit premium at held strike (paper fallback: model premium = entry + (CE?+1:−1)×0.6×(spot−entrySpot), floor entry×0.15), same path as checkExit → exitPosition/closeTrade. No-op without active trade (`{closed:false}`). Caveat: calling during server boot races constructor `restore()` re-injecting the stale OPEN trade — orphan reconcile marks it CLOSED/STALE_RESTORE next boot.
- exitPosition live: SELL MARKET `{isMultiLeg:false, refId, qty, side:"SELL", deliveryType:"IDAY", priceType:"MARKET", validityType:"DAY", executionMode:"EXIT", stratTags:["auto-scalper", "exit-<reason>"]}`. **Failed EXIT never marks closed**: status STOPPED, activeTrade null, mode SCANNING, reconcile flagged.
- closeTrade: pnl = (exitPremium − entryPremium)*qty; CLOSED; updates totals; win → totalWins++, consecutiveLosses 0; loss → totalLosses++, consecutiveLosses++, lastSide.

## Persistence & restore
- STATE_DIR = TMPDIR || TEMP || "/tmp" (outside repo — file inside cwd triggers Vite full-page reload); STATE_FILE "mvf-scalper-state.json"; atomic write (tmp + rename), .bak backup; corrupt → log loudly, try .bak, else empty.
- Persist shape: `{trades (last 500), logs (last 500), activeTrade, stats, dailyPnl, mode}`; 150ms debounce; flushPersist on stop/close/shutdown.
- Restore: SCANNING → auto-resume; EXIT with activeTrade → STOPPED for operator reconcile (never blindly re-issue SELL).

## Current promotion (server/scalper-instance.ts)
Singleton: NIFTY, lotSize 65, lotCount 2, totalQty 130, poll 15s, strategy "bollinger_band_reversal", paperMode true, confidenceThreshold 55, premiumTargetPct 15, stopLossPct 50, targetMode "percent", bbPeriod 20, bbStdDev 2.5, exitMode "sl_tp", strikeOffset 1, maxConcurrentTrades 1 — PGHO 1m promotion 2026-08-01 (holdout n=160 meanNet +0.91 PASS; old sma_ema_cross died under honest 1.25% costs).

## Strategy engine (server/strategy-engine.ts)
- `StrategySignal {direction: "LONG"|"SHORT"|"NONE", confidence, reason?, metadata?}`.
- evaluateTrendContinuation(candles, timeframe): ADX(14) > threshold (25 scalping/20 intraday), price within 0.5% of EMA-21, +DI>−DI && %K>%D → LONG conf 70.
- evaluateBBMeanReversal(candles): BB(20,2) + RSI(14); prev≤lower && last>lower && RSI 30–50 → LONG conf 65; mirror SHORT.
- evaluateRSIReversal(candles): prevRsi≤30 && last>30 → LONG conf 60; mirror SHORT.
- evaluateTrendFollow(candles): price>SMA20 && EMA50 rising → LONG conf 55.
- evaluateS2Scalper(candles, context?): RSI + MACD + VWAP + BB + volZ; conf = (max/4)*100, +10 if bbWidth>0.02; signal if score ≥3.

## Indicators (server/indicators.ts)
- `Candle {ts (ns or ms), open, high, low, close, volume}`.
- calculateSMA(closes, period), calculateEMA(closes, period), calculateRSI(closes, period=14, Wilder, warmup 50), calculateBollingerBands(closes, 20, 2) → {upper, middle, lower} (population std), calculateMACD(closes, 12, 26, 9) → {macdLine, signalLine, histogram}, calculateADX(candles, 14) → {adx, plusDi, minusDi, atr} (Wilder 5-step EMA smoothing), calculateATR(candles, 14), calculateStochastic(candles, 14, 3, 3) → {k (slowed), d}, calculateVWAP(candles), calculateVolumeZScore(volumes, 20).
- All pure, same-length arrays with warmup fills.
