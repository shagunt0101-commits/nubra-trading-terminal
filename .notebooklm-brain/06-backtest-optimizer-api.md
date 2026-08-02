# Backtest, Optimizer & Server API

## Server entry (server.ts, ~1374 lines)
- Express + http, PORT 3000, 0.0.0.0, validateEnv() at boot.
- Middleware: json/urlencoded 50mb, cors (CORS_ORIGIN or http://localhost:3000), helmet (CSP off, COEP off), rate limit `/api` 300/min, JSON error handler → `500 {success:false, error}`.
- WS: WebSocketServer path /ws, broadcast every 2s (`WS_BROADCAST_INTERVAL = 2000`), heartbeat ping/pong 30s, weekend/holiday fallback = last 1d close. Message `{type:"quotes", data:batch, premium}`; premium = active scalper trade premium if OPEN.
- WS_INDEX_MAP (static, survives instrumentCache overwrite): NIFTY 1001, BANKNIFTY 1002, SENSEX 1003, MIDCPNIFTY 1004, FINNIFTY 1005 (SENSEX→BSE, rest NSE).
- requireAuth (server-side broker session; token never sent to client): protects /api/portfolio, /api/orders, /api/scalper; 401 "No active broker session. Login first."
- Endpoints (all inline): /api/health; /api/auth/status, /login (nubraLogin), /send-otp, /verify-otp; /api/market/instruments (cached, fallback LIQUID_INSTRUMENTS 18 hardcoded incl. ref_ids 1001–1005), /search (slice 50), /quote/:refId (quoteCache 10s, paise→₹, simulated:false), /optionchain/:symbol (broker → alt exchange → synthetic fallback 21 strikes ref_ids 900000+); /api/portfolio/summary (funds/holdings/positions with high-fidelity fallbacks, simulated flag); /api/market/historical (interval whitelist, length 10..5000, enriches SMA20/EMA50/RSI14/BB(20,2)/MACD, ts ns→ms); /api/backtest; /api/orders/place|cancel, /api/orders (merges sim orders, buckets open/executed/cancelled/rejected/gtt/expired); /api/ai/analyze (generateTradingSignals); /api/market/spot/:symbol (SPOT_INDEXES set, spotCache 10s for stocks, weekend 1d EMA9/ADX fallback with analyticsSource flag); /api/scalper/start|stop|reset|clear-old-trades|config|status; /api/global/sentiment (Yahoo).
- Start: dev → Vite middlewareMode; prod non-Vercel → static dist + SPA fallback; Vercel → static only. Boot warms broker session (skipped on Vercel).
- Shutdown: SIGTERM/SIGINT → wss.close → server.close → scalper.flushPersist → exit(0); forced exit(1) after 5s. unhandledRejection/uncaughtException → log + exit(1).
- NOTE: server.ts does NOT mount server/routes/* (parallel/legacy routers, mostly superseded).

## Backtest engine (server/backtest-engine.ts) — honest premium model
- Used for PREMIUM_STRATEGIES (all 9: option_rsi_mr, s2_scalper, sma_ema_cross, rsi_overbought_oversold, bollinger_band_reversal, trend_continuation, bb_mean_reversion, rsi_reversal, sma_ema_trend).
- Premium model `prem = spot*0.00385 + 0.6*(spot−atm)` (CE) / `−0.6*…` (PE); calibrated ATM premium ≈ 93–100 INR @ NIFTY 24350. ATM_STEP {NIFTY:50, BANKNIFTY:100, FINNIFTY:50, MIDCPNIFTY:25, SENSEX:100}. Index options only — stock option IVs make the model 2–5x off (WIPRO −38.8%/trade documented).
- Held premium = entry + 0.5×(model move), floor 0.15×entry; theta decay per bar `thetaMult = (1 − thetaPctPerBar/100)^bars`, thetaPctPerDay 1.0, barsPerDay = 6.25h/medianBarMs.
- Session-gap guard: gap > 4×barMs → force-flatten "SESSION" at prior close (no phantom SL through missing sessions).
- Entry: signal on closed bar i, execute at open of bar i+1 (no lookahead). Premium entry requires 0 < entryPremium ≤ maxEntryPremium (default 600); symmetric % TP/SL (premiumTargetPct 30 / premiumStopLossPct 40 default — points mode rejected as ~1:18 R:R garbage).
- Exits: sl_tp (SL first, same-bar SL wins) | phase (phase1 TP = entry×(1+phase1TargetPct/100) → SL breakeven → trail 80%) | TIME (maxHoldBars) | EOD (sessionCloseMin IST via UTC+5:30).
- precomputeSignals: O(n) causal indicators (needed for ~17000-bar 1m backtests × 1260 configs); legacy 4 strategies still O(n²).
- s2SignalAt: RSI<40 bull+1 />60 bear+1, macdHist ±1, close vs VWAP ±1, volZ>1.5 ±0.5; conf = max/4×100 (+10 if bbWidth>0.02); entry needs score ≥3.
- option_rsi_mr: rolling ATM per bar (fixed last-bar was lookahead-ish artifact), CE-RSI ≤ thr (40) & spotRSI(14)>50 & prem ≤ maxPrem → LONG conf 70.
- Costs: netPnlPct = pnlPct − costPct("premium"|"spot").
- Exports: runBacktest(candles, opts) → BTRun {trades, summary}, PREMIUM_STRATEGIES, precomputeSignals, s2Surface/s2SignalAt.

## Costs (server/costs.ts)
- COSTS = {premium: {slippage 0.5, stt 0.1, fees 0.15}, spot: {slippage 0.05, stt 0.02, fees 0.03}}.
- costPct(kind) = 2×slippage + stt + fees → premium round trip **1.25%**, spot **0.15%**. (Old 0.7125% was ~2× too cheap.)

## Risk metrics (server/risk-metrics.ts)
- computeRiskMetrics(trades): compounding equity curve from netPnlPct in exit-time order; sharpe (annualized by sqrt(tradesPerYear), null if n<15 or sd≤1e-6); maxDrawdownPct; maxDrawdownDurationDays; calmar; annualizedReturnPct (null if span<30 days); finalEquityPct; tradesPerYear.

## PGHO Optimizer (server/optimizer.ts + promote.ts) — anti-overfit pipeline
- Seeded mulberry32 (seed 42); clusterBootstrapQ05(perInstrument, rng, b=1000) — resamples INSTRUMENT with replacement, returns q05 of mean net%/trade.
- Cartesian GRIDS per strategy (5), restricted to engine's actual parameter surface: rsi_overbought_oversold (rsiPeriod 5/9/14/21 × ob 65/70/75 × os 25/30/35), bollinger_band_reversal (bbPeriod 10/20/30 × bbStdDev 1.5/2/2.5), sma_ema_cross (10/20 × 30/50), s2_scalper (CT 50/55/60), option_rsi_mr (rsiPeriod 9/14/21 × thr 30/40/50 × maxEntryPremium 300/600) — each × premiumTargetPct [15,25,40] × premiumStopLossPct [30,50] × THETA_GRID [0, 0.007, 0.015] (%/min) × EXIT_GRID (sl_tp | phase trailPct 80, phase1TargetPct 8). Points targets excluded (fixed-₹ TP on ₹100–300 premium is structurally negative).
- optimize(data, strategy): pooled TRAIN only, runBacktest per instrument maxGapMult 4, objective netPnlPct; gates G1–G5: G-DATA ≥200 candles/instrument, G-TRADES n≥30, G-MEAN meanNet>0, G-Q05 q05>0, G-CONSISTENCY ≥3/5 instruments meanNet>0.
- selectPlateau: among gated configs cluster within 0.05 net%/trade of argmax q05, max trade count wins (never promote the single sharp peak).
- promote.ts OWNS the holdout (asserted ts-disjoint from TRAIN via assertDisjoint; splitAtSessionBoundary(candles, 0.75) splits at session boundary nearest 75% of trading days). Gate G6 applied exactly once: candidate re-run on untouched holdout, pass = nTrades ≥ 10 && meanNet > 0 → PROMOTED | NO_TRADABLE_CONFIG | NO_CANDIDATE. Failed holdout never restarts the search.
- CLI sweep: `npx tsx server/backtest-s2.ts` (standalone, fetches candles from localhost:3000, sweeps 1m/3m/5m/15m × CT × PT × SL; uses OLD simPremium spot*0.006 model — results not comparable to honest engine).

## Validation (server/validation.ts)
- zod + validate() middleware → 400 {success:false, error:"Validation failed", details}.
- Defaults: historicalSchema (interval "5m", length 150, exchange NSE); backtestSchema (interval 5m, length 200, riskReward 2, stopLossPercent 1.5, targetPercent 3, confidenceThreshold 55, premiumTargetPct 30, stopLossPct 15, optionRsiThreshold 40, optionRsiPeriod 14, maxEntryPremium 200, premiumTargetPoints 4); orderPlaceSchema (side BUY/SELL, IDAY/LIMIT/DAY); scalperStartSchema, scalperConfigSchema, aiAnalyzeSchema, sendOtpSchema, verifyOtpSchema, orderCancelSchema.
