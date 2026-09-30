# Plan: Fix Layout + OI Analytics + Mobile + Scalper-Order Sync + Live LTP

## Context

Multiple issues reported after glass UI revamp:

1. **Layout congestion**: Right panel (AI/OptionBuying/Backtest/Scalper) shares vertical space with chart/options in a `flex-col` stack. Chart at 650px leaves ~50-100px for right panel.
2. **Option chain small**: Same root cause — right panel takes leftover vertical space.
3. **Missing OI analytics**: `analysisMetrics` computes support/resistance/max pain but only shown inline in strike column cells. No summary bar.
4. **Mobile**: Fixed desktop layout, no responsive breakpoints.
5. **Scalper trades not in Order Book**: AutoScalper trades tracked internally, not visible in `/api/orders` endpoint → OrderBook component shows empty.
6. **Live PnL in scalper**: Already partially implemented (WebSocket premium → `livePnl`) but display too small.
7. **Current LTP in trade log**: Trade log table has no column showing current option premium.

---

## Changes (8 files)

### 1. App.tsx — Layout restructure + responsive breakpoints (5 edits)

**1a. 3-column row container** (line 168):
```
h-[calc(100vh-200px)] min-h-[400px]
→
flex-col lg:flex-row h-auto lg:h-[calc(100vh-180px)] lg:min-h-[600px]
```

**1b. Left panel** (line 169): add `w-full lg:w-auto`

**1c. Center div** (line 174): add `overflow-y-auto` for when chart content scrolls

**1d. Right panel** (line 183):
```
min-w-[280px] flex-1 flex flex-col gap-3
→
w-full lg:w-auto lg:min-w-[280px] lg:flex-1 flex flex-col gap-3 overflow-y-auto max-h-[500px] lg:max-h-none
```

**1e. Bottom row** (line 204):
```
flex gap-3
→
flex flex-col lg:flex-row gap-3
```

**1f. PanelResizer** (lines 173, 182): wrap in `hidden lg:block`

**1g. Tab buttons** (line 185-188): add `min-h-[40px]` for mobile touch targets

---

### 2. TerminalHeader.tsx — Mobile header (1-2 edits)

Metrics bar (`glass-surface`): add `overflow-x-auto flex-nowrap` so it scrolls horizontally instead of stacking

Header wrapper: `p-2 lg:p-4 gap-2 lg:gap-4`

---

### 3. AiAnalysis.tsx — Remove fixed height (2 edits)

Line 193: `h-[680px] overflow-hidden` → `flex-1 flex flex-col overflow-hidden min-h-0`

Cards grid (line 467): `max-h-[360px]` → `max-h-[240px] lg:max-h-[360px]`

---

### 4. Backtester.tsx — Remove fixed height (1 edit)

Line 92: `h-[650px] overflow-hidden` → `flex-1 flex flex-col overflow-hidden min-h-0`

---

### 5. OptionsWorkspace.tsx — Remove fixed height + add OI analytics bar (2 edits)

Line 437: `h-[650px] overflow-hidden` → `flex-1 flex flex-col overflow-hidden min-h-0`

**New OI analytics bar** — inserted between filter bar (line 496) and chain table (line 574):
- Compact horizontal row of chips using existing `analysisMetrics` + inline PCR + OI change computation
- `glass-base/30 p-1.5 rounded-lg flex flex-wrap gap-1.5 text-[9px] font-mono`
- Chips: OI Support, OI Resistance, Max Pain, PCR, Call OI Δ, Put OI Δ
- Add `useMemo` for pcr and oiChanges in component body (reuse pattern from OptionBuyingEngine's `calcPcr` / `calcOiChanges`)

---

### 6. OptionBuyingEngine.tsx — Add height control (2 edits)

Line 236 outer div: add `flex-1 flex flex-col overflow-hidden min-h-0`

Wrap inner content (line 267 `space-y-4`) in a `flex-1 overflow-y-auto` container

---

### 7. AutoScalper — Live PnL + LTP column (1 file: ScalperDashboard.tsx)

**Live PnL** (already partially done):
- `livePnl` computed at line 145 from `effectivePremium` (WS premium data)
- Display at lines 243-245 — already rendered
- **Enhancement**: Show live PnL both as ₹ value AND percentage of capital
- Add "P&L (Live)" label to make clear it's live WebSocket data

**Current LTP column in trade log** (table at line 296):
- Add `<th>LTP</th>` after the TP header column
- Add `<td>` in each row showing current premium for that strike+optType tier from live WS data
- For active trade: show `wsPremium` or `s.activeTrade?.currentPremium`
- For historical trades: show last known exit premium or "—"
- New column width: compact, monospace

---

### 8. Scalper → Order Book sync (2 files: server + OrderBook)

**Approach**: Add a `/api/scalper/trades` endpoint that returns completed trades in order-book-compatible format. Modify OrderBook to fetch and merge scalper trades.

**Server** — new endpoint in scalper routes (server/scalper-routes.ts or wherever POST routes are):
```
GET /api/scalper/trades
→ Returns status?.trades array mapped to { id, symbol, side, qty, entryPrice, exitPrice, pnl, status, exitReason, timestamps }
```

**OrderBook.tsx** — add optional scalper trades display:
- New prop `scalperTrades?: any[]`
- On mount, fetch from `/api/scalper/trades` (if component not receiving via props)
- Add a toggle/tab: "Exchange Orders" | "Scalper Trades"
- "Scalper Trades" shows the same table format with scalper data
- Override with styles matching existing OrderBook look

**App.tsx** — pass scalper trades to OrderBook (or let OrderBook self-fetch):
- Simplest: OrderBook self-fetches on mount + 10s interval
- No new props needed in App.tsx

---

## Execution Order

| # | File | Change |
|---|------|--------|
| 1 | App.tsx | 7 edits: layout, responsive, mobile touch, bottom wrap |
| 2 | TerminalHeader.tsx | overflow-x-auto on metrics |
| 3 | AiAnalysis.tsx | flex-1, responsive max-heights |
| 4 | Backtester.tsx | flex-1 |
| 5 | OptionsWorkspace.tsx | flex-1 + OI analytics bar |
| 6 | OptionBuyingEngine.tsx | flex-1 + overflow |
| 7 | ScalperDashboard.tsx | LTP column in trade log + enhance live PnL display |
| 8 | server (scalper routes) | GET /api/scalper/trades endpoint |
| 9 | OrderBook.tsx | Scalper trades tab, self-fetch from above endpoint |

## Verification

1. `npx tsc --noEmit` — zero errors
2. `npm run dev` — server starts
3. Desktop: 3-column layout, right panel fills height, scrolls if needed
4. Each right tab: full visible, no clip
5. Mobile (DevTools 375px): vertical stack, touch targets ≥40px, no overflow
6. Options chain tab: OI analytics bar visible above table
7. Scalper trade log: LTP column visible with live premium for active trade
8. Scalper → Order Book: completed scalper trades appear in Order Book's "Scalper Trades" tab
9. Live PnL updates: active trade shows real-time P&L from WS data
