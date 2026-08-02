# Architecture & Request Flow

## Process topology
- One Express process (`server.ts`) serves the API + Vite dev assets and hosts a WebSocket server (port 24678) that broadcasts live quotes to the browser every 2s.
- Browser client (React, `src/`) connects to the WS for spot quotes (NIFTY, BANKNIFTY, SENSEX, MIDCPNIFTY, FINNIFTY) under synthetic ref_ids 1001–1005 (WS_INDEX_MAP).
- Auto-scalper runs in-process (cron/scheduler loop), polling candles and placing broker orders via nubraApi.
- Server-side caches (10s TTL) protect the broker from burst storms: candleCache (fetchCandles) and spotCache (stock spot route). The broker rate-limits at ~3 req/s sustained; pacing every request ≥600ms is the safe floor.

## Main request paths
1. **Screener prices**: React calls GET `/api/market/spot/:symbol?exchange=NSE` per F&O underlying (paced single-flight queue, 600ms gap). Non-index symbols served from 10s spotCache; indices bypass.
2. **Spot tracker**: GET `/api/market/spot/NIFTY` etc. — broker quote → 1d-candle EMA9/ADX fallback on weekends (analyticsSource "1d").
3. **Live quotes**: WS push every 2s, synthetic refs 1001–1005; weekend-safe 1d-close fallback.
4. **AI report**: POST `/api/ai/analyze` — builds context payload (price, ATM CE/PE, indicators, funds, positions, option chain) → Gemini (or custom OpenAI-compatible endpoint) → 7-section markdown report.
5. **Orders/portfolio**: auth-gated GET `/api/orders`, `/api/portfolio/*`; POST order endpoints validate input.
6. **Backtest**: POST `/api/backtest/*` — tick-by-tick engine or S2 engine over historical candles, strategy + timeframe selectable.

## Route modules (server/routes/)
- `ai.ts` — /api/ai/analyze.
- `auth.ts` — login state, OTP flow.
- `backtest.ts` — backtest runs, parameter mapping (option_rsi_mr fix history).
- `global.ts` — global config/state.
- `market.ts` — historical candles, spot, quotes, option chain.
- `orders.ts` — order placement, status, journal export (CSV/JSON).
- `portfolio.ts` — holdings, positions, funds.
- `scalper.ts` — scalper config + status + trade history.

## Config & state persistence (disk, no DB)
- `.env` — secrets + env config (never committed).
- `.nubra_session` — broker session token.
- JSON files — scalper config, active trade, trade history, AI report cache (browser localStorage).
- Trade journal export: CSV/JSON.

## UI components (src/)
- App.tsx — layout, workspace modes (EQ / FNO / NONE), panel management (drag-reorder zones).
- TerminalHeader — spot tracker (price, EMA9, ADX), capital/margin/P&L, WS connection state.
- Screener — F&O underlyings list + cash equity screener; paced fallback prices.
- OptionsWorkspace — option chain with Greeks, OI analytics, support/resistance/max pain.
- AiAnalysis — AI Signal Engine: provider routing (Gemini / custom), report cache (localStorage per symbol+strategy), auto-fill order params.
- ScalperDashboard, OrderBook, Portfolio, Backtester — scalper state, orders, positions/funds, backtest UI.
- MarketDataContext — shared WS quote state.

## Error handling philosophy
- Broker failures never masquerade as success (500 with message; client surfaces and skips cache).
- One bad WS frame is non-fatal; a decode-error storm signals protocol drift.
- Uncaught exceptions exit (supervisor restarts); graceful shutdown handlers on SIGINT/SIGTERM.
