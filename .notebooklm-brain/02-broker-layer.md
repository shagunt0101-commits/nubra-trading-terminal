# Broker & Data Layer (Nubra API)

## Auth (server/nubra.ts)
- BASE_URL: `NUBRA_ENV === "PROD" ? "https://api.nubra.io" : "https://uatapi.nubra.io"` (NUBRA_ENV defaults PROD).
- Env: NUBRA_PHONE, NUBRA_MPIN, NUBRA_TOTP_SECRET, NUBRA_DEVICE_ID (default "NQ001").
- **TOTP login flow** (`nubraLogin()`):
  1. POST `/totp/login` with headers `Content-Type: application/json` + `x-device-id`; body `{phone, totp, otp: ""}` → `auth_token`.
  2. POST `/verifypin` with `Authorization: Bearer ${authToken}`; body `{pin: NUBRA_MPIN}` → `session_token`.
  3. Token saved to `.nubra_session` file (SESSION_FILE = `path.join(NUBRA_SESSION_DIR || cwd, ".nubra_session")`); skipped when `process.env.VERCEL`.
- **Single-flight**: concurrent `nubraLogin()` calls share one in-flight promise (`loginInFlight`).
- **Cooldown**: after a failed login, `loginCooldownUntil = now + 60s`; during cooldown `nubraRequest` reuses the old (likely still valid) token instead of re-hammering `/totp/login`. `loginRetryCooldownMs()` exposes remaining time.
- **OTP fallback**: `nubraSendOtp` POST `/sendphoneotp` (body `{phone, skip_totp: false}`) → `x-temp-token`; `nubraVerifyOtp` POST `/verifyphoneotp` with `x-temp-token` header → `auth_token`, then same `/verifypin` step.
- **nubraRequest** injects `Authorization: Bearer ${sessionToken}`, `Content-Type: application/json`, `x-device-id`. Auto-login if no token, or status FAILED and cooldown elapsed.
- **440/401 recovery**: body signals expiry if status 440 OR body contains "session expired" / "session has expired" / "resendmsg". Then clears token, respects cooldown (throws "Retry in Xs" if within), re-logins, retries request once. Non-expiry 401 → clears and surfaces broker message. Genuine 401 after retry → "Session expired. Please login again via OTP."
- **20s fetch timeout** (`fetchWithTimeout` AbortController) — Vercel function budget is 30s.
- TOTP: base32 decode (alphabet A–Z, 2–7), HMAC-SHA1, 30s step, RFC 4226 dynamic truncation, 6 digits.

## Broker API methods (nubraApi)
| Method | Endpoint |
|---|---|
| getHoldings | GET `sentinel/portfolio/holdings` |
| getPositions | GET `sentinel/portfolio/positions` |
| getFunds | GET `sentinel/portfolio/user_funds_and_margin` |
| getInstruments(date, exchange) | GET `refdata/refdata/${date}?exchange=` |
| getCurrentPrice(instrument, exchange) | GET `optionchains/${instrument}/price?exchange=` |
| getOptionChain(instrument, expiry?, exchange) | GET `optionchains/${instrument}?exchange=&expiry=` |
| getHistoricalData(query) | POST `charts/timeseries` |
| getMarginRequired(query) | POST `sentinel/orders/funds_required` |
| createOrder(orders[]) | POST `sentinel/orders/create` body `{orders}` |
| modifyOrder(orders[]) | POST `sentinel/orders/modify` |
| cancelOrder(orders[]) | POST `sentinel/orders/cancel` |
| getOrders(intentOrderId?, stratTags?) | GET `sentinel/orders` |

## Candle fetching (server/market-data.ts)
- BROKER_INTERVALS: `1s, 1m, 2m, 3m, 5m, 15m, 30m, 1h, 1d, 1w, 1mt`; unmapped → `1m`.
- INDEXES: `NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX` → query `type: "INDEX"`; anything else `"STOCK"` (STOCK for an index returns "ticker not found").
- Query shape: `{query: [{exchange, type, values: [symbol], fields: ["open","high","low","close","cumulative_volume"], startDate, endDate, interval, intraDay: false, realTime: false}]}`.
- Response: `data.result[0].values[0][symbol]` — each field an array of `{ts, v}`. OHLC values divided by 100 (broker sends paise). Timestamps are nanoseconds.
- `toPerBarVolume`: diffs the cumulative volume array (first element raw); if any diff negative (broker gave per-bar), returns raw unchanged.
- `daysBackFor(count, stepMin)`: `max(2, ceil(((stepMin*count*60) / (6.25*3600)) * 7/5 * 1.15))` — 6.25h sessions, weekend ×7/5, holiday margin ×1.15, floor 2 (broker returns 0 candles for a 1-day window).
- `fetchCandles` cache: key `${symbol}|${exchange}|${interval}|${count}`, TTL 10s (WS broadcast 2s + quote/spot routes share it).
- Option symbols: `fetchOptionSymbol` matches `Math.round(sp/100) === strike` in chain; `fetchOptionCandles` → cached fetchCandles.

## Order-flow WebSocket (server/nubra-ws.ts)
- Endpoint: PROD `wss://api2.nubra.io/apibatch/ws` (NOT api.nubra.io); UAT `wss://uatapi.nubra.io/apibatch/ws`. Protocol verified against `nubra-sdk==0.5.0` wheel (2026-08-02).
- Envelope is Any-of-Any: outer Any's `value` holds a second Any; dispatch on inner `type_url` suffix.
- Subscribe is plain text (not JSON-RPC): `batch_subscribe ${token} orderbook {"instruments":[instIds...]}` and `batch_subscribe ${token} orderbook_depth 4`.
- Message schema (protobufjs, no .proto compile): `google.protobuf.Any`, `OrderBookLevel {price int64, quantity int64, orders int64}`, `WebSocketMsgOrderBook {inst_id, timestamp, bids[], asks[], ltp, ltq, volume, ref_id}`, `BatchWebSocketOrderbookMessage {timestamp, instruments[]}`. Decode via `toObject({longs: String, defaults: true})`.
- Only frames whose inner type_url ends with "BatchWebSocketOrderbookMessage" are processed; others dropped silently. Bad frame logged non-fatal.
- Reconnect: 1s base, doubles to 30s max, reset on open; guarded against double timers.
- `resolveRefIds(symbol, spot, count=3)`: getInstruments(date, "NSE") → filter stock_name === symbol && asset === "OPTION" && |strike - spot| <= 200 → map ref_id, slice count.
- Singleton `nubraWs`.

## Probe script (server/nubra-ws-probe.ts)
- Read-only, places no orders. Usage: `NUBRA_ENV=UAT npx tsx server/nubra-ws-probe.ts [minutes] [symbol] [spot]` (defaults 30 min NIFTY, spot auto-resolved from REST ltp/100).
- Flow: TOTP login → resolve spot → resolveRefIds(symbol, spot, 3) → start client with callback.
- Output: `orderflow-<SYMBOL>-<date>.jsonl` (append), one JSON line per frame: `{ts ISO, refId, ltp, imb, bid1, ask1, bidSum, askSum}`.
- `imb` = top-of-book imbalance `(bidQty - askQty)/(bidQty + askQty)`, rounded 3dp.
- Parity check every 60s vs REST `getCurrentPrice` → `[PARITY] WS ltp vs REST ltp (diff)`.

## Env validation (server/env.ts) & logging (server/logger.ts)
- REQUIRED: NUBRA_PHONE, NUBRA_MPIN, NUBRA_TOTP_SECRET. OPTIONAL: NUBRA_ENV (PROD), NUBRA_DEVICE_ID (NQ001), LOG_LEVEL, GEMINI_API_KEY, CORS_ORIGIN (http://localhost:3000).
- Does NOT exit on missing vars (Vercel serverless exit kills all endpoints); logs loudly, trading routes guarded by requireAuth.
- pino: level = LOG_LEVEL || (production ? "info" : "debug"); redacts headers.Authorization, body.pin, body.totp.
