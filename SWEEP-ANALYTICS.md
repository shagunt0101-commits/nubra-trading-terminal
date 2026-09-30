# Comprehensive Tick-by-Tick Backtest Sweep — Analytics Report

**Date:** 2026-08-01 | **Engine:** `server/backtest-engine.ts` | **Sweep:** `sweep.ts`

## Method

- **Data:** 45 days of real Nubra candles — 5 instruments (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) × 7 TFs (1m 3m 5m 15m 1h 4h 1d)
- **Runs:** 180 (15 fetch errors on 1h/4h/1d — broker returns <200 candles there; those cells skipped)
- **Tick-by-tick exits:** intra-bar SL/TP via candle high/low (not close-only), signal at bar *i* → entry at open of bar *i+1* (zero lookahead)
- **9 strategies:** s2_scalper, option_rsi_mr, trend_continuation, bb_mean_reversion, rsi_reversal, sma_ema_trend, sma_ema_cross, rsi_overbought_oversold, bollinger_band_reversal
- **Two families:** SPOT strategies trade real index prices (trustworthy). PREMIUM strategies trade a modeled option premium (entry + 0.5×spot-move, theta 1%/day) — see limitations.

## Strategy Ranking (45-day, all instruments/TFs pooled)

| Strategy | Trades | Sum PnL% | WR% | PF | Verdict |
|---|---|---|---|---|---|
| rsi_overbought_oversold | 71 | **+18.6** | 46.5 | ~1.7 (not 16) | Only positive edge — fragile, small n |
| sma_ema_cross | 60 | +3.5 | 43.3 | ~1.5 | Marginal, mid-TF only |
| bollinger_band_reversal | 81 | +0.2 | 39.5 | ~1.2 | Break-even at best |
| s2_scalper | 40 | **−32.4** | 20.0 | 0.40 | Structurally broken risk asymmetry |
| option_rsi_mr | 745 | n/a* | n/a | n/a | Model artifact — un-evaluable |
| trend_continuation | 2103 | n/a* | n/a | n/a | Model artifact |
| bb_mean_reversion | 887 | n/a* | n/a | n/a | Model artifact |
| rsi_reversal | 663 | n/a* | n/a | n/a | Model artifact |
| sma_ema_trend | 1244 | n/a* | n/a | n/a | Model artifact |

\* Premium strategies: absolute PnL is a modeling artifact (see Limitations). Only relative signal density is meaningful — and it is *not* edge (all 5 cluster 60–63% of signals on 1m, which is pure bar-count arithmetic: more bars → more crossings).

## Timeframe Structure (verified, all instruments pooled)

- **TF ranking for rsi_overbought_oversold:** 3m +12.7% > 5m +9.6% > 1m +2.8% > **15m −6.4% (negative on ALL 5 instruments)** — the 15m penalty is the one consistent cross-instrument signal.
- **Instrument split (rsi_oo):** BANKNIFTY +17.0% + MIDCPNIFTY +17.8% (the two highest-vol indices) vs NIFTY −8.1%, FINNIFTY −2.3%, SENSEX −5.9%. Concentration correlates with volatility regime → test an **ATR-percentile filter**, not an instrument whitelist (whitelisting post-hoc is overfit).
- **1h/4h/1d unusable:** broker fetch returns <200 candles → 15 cells skipped (5 instruments × 3 TFs, zero 1h/4h/1d cells exist), survivors have 1–2 trades; engine warmup of 50 bars means 1d (45 bars) can structurally never trade. No conclusions.
- **Best cells are noise-grade:** rsi_oo MIDCPNIFTY 5m +9.9% WR 100% (n=4) — P(any cell hits 4/4 wins at 33% base across 80 comparisons) ≈ 60%. Expected luck, not evidence.

## Confirmed Findings (13, all adversarial-verified against code + data)

1. **[high] PF 16.01 is a sentinel artifact — true PF ~1.7.** `backtest-engine.ts:254` returns 99 for zero-loss runs; sweep means per-run PFs → (3×99 + 23.17)/20 = 16.01 exactly (3 all-win runs inject 297). Trade-weighted reality: 33W/38L, +18.61%. Same inflation hits bollinger_band_reversal (6.26) and sma_ema_cross (6.28). Fix: aggregate gross-wins/gross-losses, sentinel 99 → null.
2. **[high] Edge is directionally real but fragile.** Aggregate WR 46.5% vs 33.3% breakeven at 2:1 R:R: z≈2.4, p≈0.01–0.02 — survives one test but is post-hoc (80 comparisons). Removing just 2 cells / 7 trades cuts +18.6% → +1.7% (WR 40.6%). Net edge +0.26%/trade; realistic slippage + STT ≈ 0.05–0.1%/side could halve it. Require n≥300 + half-split out-of-sample before trusting.
3. **[high] Not a scalper: multi-day holds, no gap/cost modeling.** avgBars on best cells: MIDCPNIFTY 5m 310 (=26h), BANKNIFTY 3m 726 (=36h), BANKNIFTY 1m 3419 (=57h, ~9 sessions). maxHold only set for trend_continuation/bb_mean_reversion (engine lines 128–129); EOD fires only at series end, not session close; overnight gaps through SL unmodeled. Signal density 0.08 trades/cell/day → live deployment trades ~once per 3 days per index. Label it swing mean-reversion, not scalping.
4. **[medium] Vol filter over instrument whitelist.** PnL concentration (BANKNIFTY + MIDCPNIFTY = +34.8% vs other three −16.2%) tracks the two highest-vol indices → test ATR-percentile filter (top X% of own 20-day range). If density is the binding constraint, sweep RSI thresholds 35/65 and 40/60 (each roughly doubles signal count).
5. **[high] s2 SL/TP sized wrong for scalping — trades ride for days.** Sweep passes spotSL 1.5%/TP 3%: on NIFTY ~24000 that's ~360/720 index points vs 1m bar range 15–40 pts — stops unreachable intra-bar. maxHold=0 for s2, EOD only at series end. Measured avgBars 1463 on 1m (~4 days). Every loser is exactly −1.5% (full SL): −32.4% is the signature of unbounded holding, not signal quality.
6. **[high] s2 score conflates contrarian and momentum regimes; confidence unbounded.** LONG needs RSI<40 (oversold) AND MACD hist>0 AND price>VWAP (momentum) — different regimes, rarely coexist: signal density 0.37% of bars on NIFTY 1m. volZ>1.5 adds +0.5 to BOTH scores (non-directional). Confidence = max/4*100+10 exceeds 100 (112.5 with PCR context). Gate fires at completion of a move, not its start.
7. **[medium] s2 sample too small to conclude.** n=40 across 20 runs, 0–4 per run; MIDCPNIFTY produced ZERO signals on all TFs. At 0.37% density, 45 days yields single-digit trades per cell — s2 cannot be validated or tuned on this window. −32.4% ≈ 8–9 full SL losses; remove the duration pathology and the remainder is noise. Loosen gate to 2-of-3 legs before judging.
8. **[high] 1m-heavy signal counts are bar-count arithmetic, not edge.** 1m holds 62.5% of all bars; observed 1m signal shares (60–63%) sit BELOW the uniform baseline — per-bar signal density on 1m is actually lower than on higher TFs. Raw counts over unequal denominators are uninterpretable; re-express per 1,000 bars. 1d (45 bars) can never trade after 50-bar warmup; 4h has ~20 signalable bars.
9. **[high] Model strike geometry manufactures the −99% loss rates.** `prem()` has a 67.7× delta discontinuity at ATM (0.006 OTM slope vs 0.406 ITM, halved by the 0.5-delta proxy). +30% TP is reachable only when spot crosses the strike; −40% SL nearly unreachable OTM-side. WR/PnL measure how often spot crossed the entry strike — a drift bet, not strategy skill. Theta 1%/day is a red herring (0.05% over a 20-bar 1m hold). Stop reading premium WR/PnL/PF entirely.
10. **[high] Honest evaluation path: score spot-direction first, then trade real premium data.** Discard premium PnL as model artifact; measure per-signal directional accuracy vs subsequent spot move over the hold window (legitimate, comparable to spot runs); use signal density per TF only as capacity/latency metric. To ever validate premium PnL: real per-strike LTP/IV history, explicit bid/ask spread (a typical 0.5% spot move on 1m is inside the premium spread — uncapturable at that horizon), expiry handling, overnight gaps.
11. **[high] s2 has no viable TF — broken risk asymmetry, not tuning.** Negative on every TF (1m −16.8, 3m −8.4, 5m −6.9, 15m −0.3), best cell +1.5% (FINNIFTY 5m). WR 20% with intra-bar SL/TP = stops hit by noise while winners cut at tiny targets. More TF runs will not fix PF 0.40. Stop running s2 until risk profile is rebalanced.
12. **[high] Premium strategies' 1m density is a modeling artifact.** 60–63% of premium-strategy signals on 1m for all 5 — confirmed the density claim, but the mechanism is wrong: 4 of 5 strategies signal on the raw spot series (premium enters only at PnL time); only option_rsi_mr uses the modeled premium series. Density = bar count. Anchor option signals to the underlying's 5m/15m regime instead.
13. **[medium] Higher-TF results untrustworthy on both sides.** 15 fetch errors (exactly 5 instruments × 1h/4h/1d, <200 candles each), surviving cells 1–2 trades over 45 days. Require ≥10 trades before ranking a cell; pool trades across instruments per TF rather than ranking single cells.

## Rejected by adversarial cross-check (3)

- **"No predictive edge at execution (next-bar WR 50.0%)"** — overreach: n=4 signals, 95% CI [7%, 93%]; a genuine 60%-edge shows ≤50% on 4 draws 52% of the time. Not evidence.
- **"option_rsi_mr's premium RSI ≈ spot RSI"** — core thesis correct (4/5 strategies signal on raw spot; premium enters only at PnL time) but the "≈" claim is false: the modeled premium is a nonlinear transform, its RSI does not track spot RSI. Signal-on-spot stands; the equivalence claim dropped.
- **"Mean-reversion family clusters 5m–15m; 1m is untested"** — premise false: 1m WAS run for all spot strategies (bb_reversal 16 trades, rsi_oo 16, sma_ema 15, s2 16). The verified TF structure (finding 3) replaces this: 3m/5m positive, 15m negative on all 5 instruments.

## Honest Recommendations

1. **Trade only spot strategies** on real prices. rsi_overbought_oversold on 3m/5m is the only candidate with positive expectancy — but it's a swing mean-reversion hold, not a scalper: validate on ≥300 trades, half-split out-of-sample, with ATR-based SL/TP and session-close flattening before trusting anything.
2. **Stop running s2_scalper** until fixed: one regime per signal path (momentum OR mean-reversion, not both), directional volZ, confidence capped at 100, ATR-sized SL/TP, hard maxHold (1 session), 2-of-3 gate to restore density.
3. **Premium strategies: score spot-direction first, paper-trade real premium data.** The model cannot produce trustworthy premium PnL — stop reading its WR/PnL/PF.
4. **Fix sweep aggregation:** trade-weighted PF (sentinel 99 → null), ≥10 trades/cell before ranking, signal counts per 1,000 bars.
5. **Fetch fix for 1h/4h/1d** needed before any longer-TF conclusions.

## Files
- `server/backtest-engine.ts` — tick-by-tick engine (intra-bar SL/TP, no lookahead, premium model w/ delta 0.5 + theta)
- `sweep.ts` — runner; `sweep-results.json` (180 runs), `sweep-results.csv`
- `server/__tests__/backtest-engine.test.ts`, `server/__tests__/strategy-engine.test.ts` — 22 tests, all pass; `tsc --noEmit` clean
- Analysis: 4 analyst agents + 16 adversarial verifiers (wf_cca4a39e-de4), 1.09M subagent tokens, 13 confirmed / 3 rejected findings
