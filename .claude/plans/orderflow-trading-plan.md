# Nubra Terminal — Order-Flow Trading Build Plan

**Scope:** new files under `server/`, wiring into `auto-scalper.ts` and `indicators.ts`.
**Goal:** move from 15s REST polling to real depth-driven signals, using Nubra's actual
WebSocket market-data protocol (confirmed against their published docs — not guessed).
**Status:** design + protocol reference only. Nothing here has been run — no live Nubra
session or network access in the environment this plan was written in. Verify the exact
message framing against a real UAT connection before trusting any byte-level detail below.

---

## What Nubra's API actually gives you

Confirmed from `nubra.io/products/api/docs/rest-api/market-data/realtime-data.html`:

- **Endpoint:** `wss://api.nubra.io/apibatch/ws` (prod) / `wss://uatapi.nubra.io/apibatch/ws` (UAT)
- **Auth:** same REST session token your `nubraLogin()` already produces — no separate WS auth flow.
- **Envelope:** every message is `GenericData { string key; google.protobuf.Any data; }` — you
  branch on `key`, then unwrap the specific proto payload.
- **Relevant channel — `orderbook`:** up to 20 bid/ask levels, LTP, LTQ, volume, per instrument.
  Subscribe with a plain text command (not JSON-RPC, not a REST call):
  ```
  batch_subscribe [token] orderbook {"instruments":[1120031,73009]}
  ```
  Instruments are numeric `inst_id`s, not symbol strings — you'll need to resolve these once via
  `nubraApi.getInstruments()` and cache the mapping.
- **Depth control:** `batch_subscribe [token] orderbook_depth 4` limits to top-4 levels
  per side if you don't need all 20 (less bandwidth/parsing for a scalping use case).
- **Payload proto (`BatchWebSocketOrderbookMessage`):** per instrument — `bids[]`/`asks[]`
  arrays of `{price, quantity, orders}`, plus `ltp`, `ltq`, `volume`, `ref_id`. `bids[0]`/`asks[0]`
  are best bid/ask.
- **Other channels available the same way:** `index` (index/instrument ticks), `index_bucket`
  (streamed OHLCV — could eventually replace your 15s candle polling entirely), `greeks`,
  `option` (full option-chain push).
- **Rate/interval control:** `socket_interval` per channel — `1s`/`5s`/`10s`/`30s` are
  rate-limited, `1m`/`5m`/`10m` are unlimited. For genuine order-flow signals you need the
  tick-level default (no interval set) or at most `1s` on `orderbook`; `1m` defeats the purpose.

This is a **binary protobuf WebSocket protocol with a plain-text subscribe command syntax** —
not REST-shaped, not JSON. That's the main integration cost: you need a `.proto` schema file
and a protobuf JS/TS runtime (`protobufjs` or `@bufbuild/protobuf`), not just `fetch()`.

---

## Stage 1 — `server/nubra-ws.ts`: connection + orderbook stream only

**Scope:** one new file. Don't touch `auto-scalper.ts` yet — get the raw stream working and
logging first.

1. Add `.proto` definitions for `GenericData`, `BatchWebSocketOrderbookMessage`,
   `WebSocketMsgOrderBook`, `OrderBookLevel` (schema given above — confirm field numbers
   against a live connection before shipping, docs can drift from the wire).
2. Install `protobufjs` (or the project's preferred proto runtime — check nothing already
   pulled in for `.proto` handling before adding a second one).
3. Implement:
   - `connect()`: opens the WS to `BASE_URL`-equivalent (`wss://api.nubra.io/apibatch/ws` or
     UAT), reusing the existing session token from `nubra.ts` (`getSessionToken()`).
   - `subscribeOrderbook(instIds: number[], depth?: number)`: sends the
     `batch_subscribe [token] orderbook {...}` text command; optionally sends
     `orderbook_depth N` first if you don't need all 20 levels.
   - `onOrderbook(cb: (msg: WebSocketMsgOrderBook) => void)`: decodes incoming binary frames
     via the `GenericData` envelope, filters on `key === "orderbook"` (confirm exact key
     string against a live message — docs show the channel name but not necessarily the
     literal `key` value used in practice), decodes the inner `Any`, calls `cb` per instrument.
   - Reconnect-with-backoff on close/error — this is a persistent connection for a
     scanning/scalping loop, not a one-shot fetch; a silent disconnect must not fail silent.
   - Resolve `inst_id` ↔ symbol once via a small lookup built from `nubraApi.getInstruments()`,
     cached in memory (don't re-fetch per message).
4. **Test on UAT first**, not PROD — log raw decoded messages to console for a few minutes
   during market hours and manually sanity-check bid/ask levels against the REST
   `getOptionChain`/`getCurrentPrice` snapshot for the same instrument before trusting the feed.

**Acceptance criteria:**
- Connects, authenticates, subscribes, and logs decoded `WebSocketMsgOrderBook` messages for
  at least one instrument for a sustained multi-minute run without crashing.
- Reconnects automatically after a forced disconnect (kill the connection manually to test).
- Decoded bid/ask prices are sane (roughly match REST snapshot within a few ticks).

---

## Stage 2 — first order-flow signal: bid/ask imbalance

**Scope:** new function in `server/indicators.ts` (or a new `server/orderflow-indicators.ts` if
`indicators.ts` is getting crowded — check current file size/organization before deciding).

Simplest, most defensible order-flow signal to start with: **top-of-book imbalance ratio**.

```
imbalance = (sum(bidQty[0..depth]) - sum(askQty[0..depth])) / (sum(bidQty[0..depth]) + sum(askQty[0..depth]))
```

Ranges -1 (all offer-side pressure) to +1 (all bid-side pressure). This is the standard
starting point in order-flow literature before anything fancier (cumulative delta, absorption,
footprint) — it's cheap to compute, easy to sanity-check, and easy to backtest against your
existing engine's trade outcomes once you're logging it.

1. Compute imbalance on every `orderbook` message, using a configurable depth (start with
   top-5, not all 20 — deeper levels are noisier and more prone to spoofing/iceberg orders).
2. **Don't wire this into live order placement yet.** First: log `(timestamp, instrument,
   imbalance, ltp)` to a file for a full session or more, purely as an observational dataset —
   the same discipline that produced `SWEEP-ANALYTICS.md` for your candle strategies. You need
   to see whether imbalance actually leads price before building anything on top of it.
3. Once you have that log, a simple validation pass: does a strong imbalance (e.g. |imbalance|
   > 0.5) in the 10-30 seconds *before* a favorable price move show up more often than chance?
   This is the same kind of adversarial check your existing analytics report did — don't skip it
   just because order flow "feels" more legitimate than candle indicators.

**Acceptance criteria:**
- Imbalance computed and logged continuously for at least one live session.
- A written note (mirroring `SWEEP-ANALYTICS.md`'s format) on whether imbalance shows any
  lead-lag relationship with price before it's used for any entry decision.

---

## Stage 3 — only after Stage 2 validates: wire into `AutoScalper`

**Do not build this stage until Stage 2's validation note exists and shows something real.**
Building execution logic on an unvalidated signal is exactly the mistake `SWEEP-ANALYTICS.md`
flagged in `s2_scalper` — a strategy that looked plausible on paper but was structurally
unable to work once checked against real bar ranges.

If/when Stage 2 validates:
1. Add an `orderFlowFilter` config option to `AutoScalper` — an *additional gate* alongside
   existing entry conditions, not a replacement. E.g.: only take a candle-based long signal if
   imbalance was also positive at signal time.
2. Keep the 15s candle poll as the primary signal source initially; use the WS orderbook stream
   as a confirmation filter, not the sole trigger — this de-risks the integration (worst case,
   it just makes the existing strategy pickier, not fundamentally different).
3. Only after that's proven out, consider a fully depth-driven entry trigger independent of the
   candle poll.

**Out of scope for all of the above:**
- `index_bucket` replacing your candle-polling entirely — genuinely promising (removes the
  Stage-1-of-the-perf-plan cache problem at the source) but it's a separate, larger migration
  and shouldn't be bundled into an order-flow-signal build.
- `greeks` and `option` channels — same protocol, same integration pattern, but a separate
  scope; mentioned here only so you know they exist on the same connection.
- Cumulative volume delta / footprint charts — reasonable next step after top-of-book imbalance
  is validated, not before.

## Definition of done

- Stage 1: WS client connects, subscribes, decodes, reconnects — verified live against UAT.
- Stage 2: imbalance computed, logged, and validated with a written lead-lag note before any
  execution logic touches it.
- Stage 3 (conditional): imbalance used only as a confirmation filter on existing signals, not
  a replacement, until proven otherwise.
