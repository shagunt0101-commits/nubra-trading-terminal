# AI Signal Engine & Frontend

## AI analysis (server/gemini.ts)
- `generateTradingSignals(marketContext)` → markdown report with 7 sections: 1 Trend & Sentiment, 2 ATM Strike & CE/PE analysis, 3 Key Liquidity Zones & S/R, 4 Strategy Alignment, 5 Actionable Trading Signals (bias/instrument/entry/target/SL), 6 Options Strategy Execution, 7 Risk Management Filters.
- System instruction: expert quant hedge-fund analyst + derivatives strategist + risk officer; strict formatting, temperature 0.2.
- **Provider routing**: `marketContext.aiProvider === "custom"` → OpenAI-compatible `/chat/completions` POST with `Authorization: Bearer <key>`.
  - Security rule: a client-supplied key may ONLY be used against a client-supplied URL (it's the client's own key); the env key (operator secret) must NEVER be forwarded to a client-supplied URL (key-exfiltration channel). URL resolved strictly from env when the env key is in play.
  - Requires key (client or env CUSTOM_AI_API_KEY) + URL (client or env CUSTOM_AI_BASE_URL, must be https); model = customModel || CUSTOM_AI_MODEL || "ag1"; URL normalized to `/chat/completions`.
  - Parses non-streaming JSON or SSE `data:` lines (choices[0].delta/message/text). Empty text → error.
  - **Fallback (2026-08 fix)**: custom endpoint failure (dead tunnel → 530, provider outage, bad key) logs + falls through to the Gemini flow instead of a hard 500. Config errors (no key at all, http:// URL) still throw. If Gemini also fails, the original custom error surfaces.
- Default Gemini flow: modelsToTry = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.1-pro-preview"]; on all-fail returns "### AI Analysis Error" + generateFallbackAnalysis (local quantitative engine).

## Route /api/ai/analyze (server.ts)
- POST body: `{symbol, strategy, priceData, optionChain, technicalIndicators, positions, funds, aiProvider, customApiKey, customBaseUrl, customModel, atmAnalysis}` → `{success:true, report}` or `500 {error}`.

## Frontend (src/)
- **AiAnalysis.tsx**: provider toggle Gemini/Custom (default CUSTOM — dead URL was hardcoded `https://r3uxl5j.abc-tunnel.us/v1`; fixed server-side fallback), per-symbol+strategy report cache in localStorage (key "ai-report-cache-v1"), error banner "Analysis Refused" on failure, auto-fill order params from report regexes, structured/markdown view modes.
- **TerminalHeader.tsx**: spot tracker (price, prevClose, change%, 9EMA, EMAΔ, ADX 3m/5m), available capital, blocked margin, day realized P&L, brokerage, WS connection state (CONNECTED/RECONNECT), alerts.
- **Screener.tsx**: F&O underlyings derived from instruments with FUT/OPT derivative_type + 5 forced indices; WS index quotes (refs 1001–1005) > option LTP > paced spot fallback (600ms gap queue, failed fetches retry on state change); cash equity mode lists STOCK-type.
- **OptionsWorkspace.tsx**: option chain with Greeks, OI analytics cards, support/resistance/max pain markers on strikes.
- **App.tsx**: layout, workspace modes (EQ/FNO/NONE), drag-reorder panels, ErrorBoundary.
- **ScalperDashboard.tsx / OrderBook.tsx / Portfolio.tsx / Backtester.tsx**: scalper state + controls, orders list, positions/funds, backtest config + results.
- **MarketDataContext.tsx**: shared WS quote state, reconnect logic.

## WS live feed
- Server broadcasts `{type:"quotes", data:batch, premium}` every 2s; indices under synthetic refs 1001–1005; weekend/holiday fallback = last 1d close; premium = active scalper trade premium when OPEN.
- Client (MarketDataContext) consumes; Screener/TerminalHeader render from it.
