# PGHO — Pooled-Grid Holdout Optimizer (Recommended Design)

**Date:** 2026-08-01 | **Derivation:** 5 competing designs + 3 adversarial critics + synthesis (9 agents, verified against repo code and sweep-results.json)

**One-line answer:** coarse full grid on pooled train data, cluster-bootstrap CI as the objective, plateau selection, once-only holdout promotion, explicit "NO TRADABLE CONFIG" outcome. No walk-forward, no evolution, no Bayesian — 45 days of data can't support them.

## Why this shape (the binding constraints)

- Data: ~18–45 fetchable days/instrument; rsi_overbought_oversold = 71 trades/45d pooled = ~53 on a 75% train split. That is the statistical budget.
- Multiple-testing trap measured in SWEEP-ANALYTICS: 80 cell comparisons → P(any 4/4-win cell) ≈ 60%. An optimizer with adaptive search makes it worse, not better.
- Engine is O(n²)–O(n³) per backtest (`signal()` re-slices per bar); the 3 mean-reversion strategies are HARDCODED (RSI14, BB 20-2, SMA20/EMA50) — no param plumbing exists. Stage-0 work is mandatory before any grid is meaningful.
- No cost model in engine. Net edge measured at +0.26%/trade — costs can halve it. Raw-PnL optimization would promote ghosts.

## Objective (code-precision)

```
costPct(class) = 2*slippage + stt + fees          // constants in server/costs.ts
  premium: slippage=0.30, stt=0.0625, fees=0.05   → 0.7125 % of entryPremium
  spot:    slippage=0.02, stt=0.01,  fees=0.03    → 0.08   % of entryPrice
net_t = pnlPct_t − costPct(class(t))              // per trade from BTTrade.pnlPct
meanNet(cfg) = mean over pooled train trades (all instruments)
q05(cfg) = 5th percentile over B=1000 cluster bootstrap resamples
           (resample INSTRUMENT with replacement, keep all its trades;
            cross-instrument correlation is the only non-independence — covered;
            fixed seed)
OBJ(cfg) = q05(cfg)                                // MAXIMIZE
tiebreak = higher nTrades(train) among configs within 0.05 net%/trade of argmax (plateau)
```

q05 as objective means a sharp peak with tiny n cannot outrank a plateau — bootstrap already penalizes σ/√n.

## Split protocol (once-only holdout, code-enforced)

- One fetch per (instrument, tf) over full window; split in memory by ts.
- TRAIN = first 75% of candles, cut on a session boundary (threshold day = start of last ceil(0.25 × tradingDays) trading days).
- HOLDOUT = last 25%, touched ONLY by `promote()` — never by search, never by any score function.
- Enforced in code, not prose: `optimizer.ts` imports no holdout data; `promote.ts` owns the holdout and asserts `min(holdout.ts) > max(train.ts)` + day-boundary alignment.
- No validation split — on 45d, a val split burns the scarcest resource to do what a train bootstrap CI already does.
- Report prints ACTUAL train/holdout day counts (fetch may return ~18.5 days, not 45).

## Search: one coarse full grid, single pass

Params shared across instruments; evaluation pools all 5. Grids restricted to the engine's ACTUAL parameter surface after stage-0:

| Strategy | Grid | Configs |
|---|---|---|
| rsi_overbought_oversold | rsiPeriod {5,9,14,21} × ob {65,70,75} × os {25,30,35} × SL {1.0,1.5,2.0} × TP {2.0,3.0,4.0} | 324 |
| bollinger_band_reversal | bbPeriod {10,20,30} × bbStdDev {1.5,2.0,2.5} × SL × TP | 81 |
| sma_ema_cross | smaPeriod {10,20} × emaPeriod {30,50} × SL × TP | 72 |
| s2_scalper | confidenceThreshold {50,55,60} × SL {0.8,1.2,1.5} × TP {1.5,2.0,3.0} | 27 |
| option_rsi_mr | optRsiPeriod {9,14,21} × optRsiThreshold {30,40,50} × maxEntryPremium {300,600} × premiumTargetPct {20,30} × premiumStopLossPct {30,40} × thetaPctPerDay {1.0,1.5} | 72 |
| **Total** | | **576** |

- TF: **15m only** — every TF that fetched in the sweep; 1m/5m repeat the same signal at higher noise with 7× compute and add nothing on 45d.
- Compute after stage-0: ~10ms/backtest → 576×5 ≈ 2900 backtests ≈ 1 min + fetch. No parallelism needed.

## Promotion gates (numbered; G1–G5 on TRAIN, G6 on HOLDOUT once)

1. **G-DATA:** ≥ 200 candles on train per instrument, else that instrument excluded (count reported).
2. **G-TRADES:** pooled nTrades(train) ≥ 30. Reachable: rsi_oo ≈ 53 ✓; s2_scalper ≈ 30 — borderline, correctly so.
3. **G-MEAN:** pooled meanNet(train) > 0 (cost-adjusted).
4. **G-Q05:** q05(train) > 0 (bootstrap lower bound above zero — needs meanNet ≳ +0.45 net%/trade at n=30; honestly conservative).
5. **G-CONSISTENCY:** ≥ 3/5 instruments with per-instrument meanNet > 0 (majority; strict 60% is coin-flip noise at ~14 trades/instrument — report per-instrument numbers).
6. **G-HOLDOUT** (top-1 config per strategy by q05): pooled nTrades(holdout) ≥ 10 AND meanNet(holdout) > 0. **Failure = NO TRADABLE CONFIG** for that strategy, printed prominently. A failed holdout does NOT restart the search.

**Expected honest outcome on 45d:** premium strategies (0/20 positive runs at defaults, 0.71% cost) and s2_scalper (2/20) report NO TRADABLE CONFIG. Possibly 1–2 spot strategies promote. That output is correct if the edge isn't there — do not tune gates to force a pass.

## Anti-overfit guardrails

1. Once-only holdout, module-isolated + ts-disjoint assert.
2. Multiple-testing disclosure: report m = configs tested per strategy; print "expected false promotions at 95% ≈ 0.05×m".
3. No adaptive reuse: single-pass grid, no re-run after seeing holdout, no early stopping on holdout.
4. Plateau selection (top-10 cluster within 0.05 net%/trade, max-trade-count wins) — never the single sharp peak.
5. Min-trade gate sized so everything fails on 45d when there's no edge.
6. Overfit diagnosis: report Δ = best q05 − median q05; Δ small → "no distinguishable edge" line.
7. Cost model mandatory, fills adversarial (gap/SL fill rules), never raw PnL.
8. Cluster bootstrap at instrument level (trades are non-independent across instruments).
9. Determinism: fixed seed, pure runBacktest, report seed + window + actual day counts.

## Stage-0 engine prereqs (blocking — no optimization before these)

1. **Indicator precompute:** full-series arrays once per (instrument, tf, strategy), walk bars referencing array[i] — replaces per-bar `candles.slice(0, i+1)` (O(n²) → O(n), identical values, no lookahead). Without it the 576-config grid is hours, not minutes.
2. **Parameterize inline strategies:** rsiPeriod/overbought/oversold; bbPeriod/bbStdDev; smaPeriod/emaPeriod — currently hardcoded 14 / 20-2 / 20-50. Grid must not lie about what it tunes.
3. **Cost model:** `netPnlPct` on BTTrade; constants in `server/costs.ts`, shared with sweep.ts.
4. **Session/gap handling:** barMs via median ts-delta (not candles[1]−candles[0]); gap > 4×median → force-flatten at prior close (gaps currently become giant bars that phantom-SL).
5. **Gap fill:** SL/TP fill at slPrice/tpPrice even when exit-bar open gaps THROUGH the level — fill at open when open is worse (no free fills).
6. **PF sentinel:** 99-on-no-losses and 0/0 NaN — don't gate on raw PF; PF_trade = grossWin/grossLoss pooled, NaN fails gate.
7. Seeded PRNG for bootstrap; keep runBacktest pure.

## File structure

- `server/costs.ts` — slippage/STT/fees constants per class
- `server/optimizer.ts` — grids, runBacktest wrapper, seeded cluster bootstrap, gates G1–G5, plateau selection, report builder. No holdout access.
- `server/promote.ts` — owns holdout, asserts ts-disjoint, applies G6 once
- `optimize.ts` — CLI (`npx tsx optimize.ts [daysBack]`): fetch → split → optimizer + promote → `optimize-results.json` + printed report (n, CIs, per-instrument table, NO_TRADABLE_CONFIG lines)
- `server/__tests__/optimizer.test.ts` — gate arithmetic on synthetic 200-candle series (known-good passes G1–G4, known-bad fails), bootstrap determinism (same seed → same q05), no-lookahead invariance under precompute
- Housekeeping: delete ~40 junk files + `(null)` in repo root (broken redirection artifacts); gitignore `.scalper-state.json`, `server/scalper-state.json`, `sweep-results.*`

## Implementation order

1. Stage-0 engine: median-barMs + session-flatten + gap fill + parameterize inline strategies. Re-run sweep.ts, diff vs sweep-results.json — expect small count changes, no strategy flips to positive.
2. Stage-0 costs: `server/costs.ts` + `netPnlPct` on BTTrade + summary exposure.
3. Indicator precompute refactor; assert-identical results on one instrument/TF fixture.
4. `server/optimizer.ts`: 576-config grids, seeded cluster bootstrap, G1–G5, plateau pick. Self-check on sweep-cached data.
5. `server/promote.ts` + ts-disjoint assert.
6. `optimize.ts` CLI.
7. `server/__tests__/optimizer.test.ts`.
8. Run `npx tsx optimize.ts 45`. Honest expected result: premium + s2 → NO TRADABLE CONFIG; maybe 1–2 spot strategies promote.
9. Delete junk files, gitignore runtime artifacts, commit.
10. Only with a real promoted config: paper-trade via auto-scalper.ts before live capital.

## Rejected approaches (one line each)

- **Evolutionary/Bayesian** — multi-round adaptivity invites adaptive reuse of scarce data; coarse grid is exhaustive on the real param surface and costs minutes.
- **Walk-forward / rolling folds** — on ~18–45 fetchable days, folds are single-digit-day noise samples; pooled-train + once-only holdout is the honest budget.
- **SURVIVAL-GRID 70/15/15 train/val/test** — val split burns 15% of the scarcest resource to do what a train bootstrap CI already does.
- **Full Pareto-frontier promotion** — on 45d every frontier point is statistically indistinguishable; holdout budget confirms ONE config — promote one per strategy.
- **iid bootstrap on trades** — non-independent across instruments; cluster by instrument instead.
- **Per-instrument 60% consistency gate** — coin-flip noise at ~14 trades/instrument; majority (3/5) + table instead.
- **Premium-points TP mode** — 1:18 reward:risk garbage; %-based TP/SL only.
- **1m/5m grids** — same signal, 7× compute, correlated repeats, no new information on 45d; 15m only.
