# Runbook & Operations

## Running the terminal
- **Dev**: `npm run dev` → `tsx server.ts` (auto-reloads on file change). Serves Express + Vite at `http://localhost:3000`; WS server on port 24678.
- **Prod build**: `npm start` → `node dist/server.cjs` (Vercel target).
- **Tests**: `npx vitest run` — 82 tests / 8 files. **Type check**: `npx tsc --noEmit`.

## Monday 09:15 IST live-verification ritual (order-flow probe)
1. From the worktree root run:
   `NUBRA_ENV=UAT npx tsx server/nubra-ws-probe.ts 30 NIFTY`
2. Watch console for:
   - `[PARITY] WS ltp=... | REST ltp=... (diff ...)` — WS vs REST must agree.
   - Frame decode errors (a few non-fatal are fine; a storm means protocol drift).
3. Data lands in `orderflow-NIFTY-<date>.jsonl` (append mode, one JSON line per frame).
4. Analyzing that file feeds Stage 2 lead-lag validation (order flow vs price) → gates Stage 3 (orderFlowFilter in AutoScalper).

## Common failure modes (verified fixes)
- **Broker rate limiting (~3 req/s sustained)**: parallel bursts 429 every route for 30s+. Pacing: ≥600ms gap between spot fetches (~1.6/s). Server-side 10s caches (spotCache, candleCache) absorb screener bursts. Never parallelize unfettered.
- **Login storm**: one failed login used to make EVERY request re-login → rate limit → waves of 404/401. Fixed with 60s cooldown; old token reused during cooldown.
- **Weekend market-closed**: broker returns NO 1m/3m/5m candles for weekend windows but DOES return 1d candles. Spot route falls back to 1d candles (fetch 20, ≥10 required) for EMA9/ADX(14), flags `analyticsSource: "1d"`.
- **Session expiry**: 440/401 handled in nubraRequest (clear + TOTP relogin once, respecting cooldown). Genuine 401 (non-expiry body) surfaces broker message.
- **Custom AI endpoint dead**: /api/ai/analyze with `aiProvider: "custom"` and an unreachable endpoint (e.g. stale cloudflare tunnel → 530) now falls back to Gemini instead of 500. Config errors (no key, http:// URL) still throw.

## Secrets hygiene
- Broker credentials ONLY in `.env` (NUBRA_PHONE, NUBRA_MPIN, NUBRA_TOTP_SECRET, NUBRA_DEVICE_ID); never commit; session token `.nubra_session` never sent to browser.
- AI: env `GEMINI_API_KEY` for default; client-supplied custom key only allowed against client-supplied URL (no forwarding env key to foreign URL — key-exfiltration channel).
- pino redacts Authorization headers, body.pin, body.totp in logs.

## Order safety invariants (do not regress)
- No synthetic/mock data in broker flow; signals blocked on synthetic candle data.
- placeEntry is idempotent (no double orders on retry).
- Exit failure must not mark position closed while still open (restore-EXIT on restart, no phantom SELL).
- Enter/exit state persisted atomically; WS heartbeat; graceful shutdown handlers.

## Git worktree workflow
- Work happens in worktrees under `.claude/worktrees/`; main branch `main`; feature branch pattern `claude/<name>` pushed to `github.com/shagunt0101-commits/nubra-trading-terminal`.
- Other worktrees must `git fetch && git reset --hard` after a force-push of rewritten history, or removed secrets reappear.

## Deployment caveats
- WS broadcast server, JSON-file state, and .nubra_session persistence mean full functionality runs locally; Vercel serverless lacks persistent disk (save/clearSession skipped when process.env.VERCEL).
- Env validation does NOT exit on missing vars (would kill all serverless endpoints) — routes are individually guarded instead.
