# Nubra Trading Terminal — Project Overview

A real-money NIFTY/BANKNIFTY options scalping terminal for the Indian market. It automates index options (F&O) scalping through the Nubra broker API, with live market data, an AI signal engine, backtesting, and an order-execution dashboard.

## Stack
- **Frontend**: React + TypeScript + Vite, glassmorphism dark UI (App.tsx + components/).
- **Backend**: Express + TypeScript, run via `tsx server.ts` (dev). Modules under server/.
- **Broker**: Nubra API. PROD base `https://api.nubra.io`, UAT `https://uatapi.nubra.io` (selected by `NUBRA_ENV` env var).
- **Database**: none — state persisted to JSON files on disk (trades, config, session token).
- **AI**: Google Gemini (default) via `@google/genai`; optional OpenAI-compatible custom provider.
- **Tests**: Vitest, 82 tests across 8 files.
- **Deploy**: Vercel target; WS server and local state mean full features run locally.

## Repo layout
- `server.ts` — Express app entry, WS broadcast server, spot route, auth middleware, graceful shutdown.
- `server/` — modules: nubra.ts (broker auth + API), market-data.ts (candles), auto-scalper.ts (signal engine + execution), strategy-engine.ts (strategy evaluators), backtest-engine.ts / backtest-s2.ts / backtest-strategy.ts (backtests), optimizer.ts (PGHO optimizer), indicators.ts (TA indicators), gemini.ts (AI analysis), nubra-ws.ts (order-flow WS client), nubra-ws-probe.ts (probe script), routes/ (per-domain route modules: ai, auth, backtest, global, market, orders, portfolio, scalper), costs.ts, risk-metrics.ts, validation.ts, scalper-instance.ts, promote.ts, env.ts, logger.ts.
- `src/` — React components: App.tsx, TerminalHeader, Screener, OptionsWorkspace, AiAnalysis, ScalperDashboard, OrderBook, Portfolio, Backtester, MarketDataContext, etc.

## What the terminal does
1. Streams live spot prices (WebSocket broadcast, 2s cadence) for NIFTY, BANKNIFTY, SENSEX, MIDCPNIFTY, FINNIFTY.
2. Auto-scalper engine scans 1m candles for signals across multiple strategies, places BUY/SELL orders via the broker API with configurable risk controls.
3. AI Signal Engine (/api/ai/analyze) produces a 7-section trading report via Gemini (or a custom OpenAI-compatible endpoint).
4. F&O Screener lists underlyings with live prices; options chain with Greeks.
5. Backtester + optimizer evaluate strategies over historical data (tick-by-tick engine, PGHO optimizer).
6. Order execution panel, portfolio/positions/funds, trade journal export.

## Key trading concepts
- ATM = at-the-money strike. CE = call option, PE = put option. OI = open interest. IV = implied volatility.
- Strategies: scalping, day_trading, swing_trading, btst (buy today sell tomorrow), stbt (sell today buy tomorrow).
- Session: Indian market hours 09:15–15:30 IST, Mon–Fri.

## Security posture
- Broker credentials live only in `.env` (NUBRA_PHONE, NUBRA_MPIN, NUBRA_TOTP_SECRET, NUBRA_DEVICE_ID); session token persisted to `.nubra_session` file, never sent to the browser.
- AI keys: env `GEMINI_API_KEY`; custom AI key from the client is only allowed against a client-supplied URL (never forwarded to a different URL).
- Orders endpoints are auth-gated; input validation on all POST endpoints; CORS + helmet + rate limiting.
