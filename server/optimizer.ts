// PGHO — Pooled-Grid Holdout Optimizer (search side).
// Coarse full grid on pooled TRAIN data, cluster-bootstrap q05 objective,
// plateau selection, gates G1–G5. NEVER touches holdout data — the holdout
// lives only in promote.ts and is asserted ts-disjoint by the CLI.
import { runBacktest, BTCandle, BTOpts } from "./backtest-engine.js";

export interface OptimizeCfg {
  instrument: string;
  candles: BTCandle[];
}

export interface GateResult { name: string; pass: boolean; detail: string }
export interface ConfigResult {
  cfg: Record<string, number>;
  nTrades: number;
  meanNet: number;
  q05: number;
  perInstrument: Record<string, { n: number; meanNet: number }>;
  gates: GateResult[];
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) so every run is reproducible.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Cluster bootstrap: resample INSTRUMENT with replacement, keep all its
// trades. Cross-instrument correlation is the only non-independence in the
// pooled sample (engine holds one position per instrument at a time), so
// resampling at instrument level is the honest CI.
// ---------------------------------------------------------------------------
export function clusterBootstrapQ05(
  perInstrument: Record<string, number[]>,
  rng: () => number,
  b = 1000
): { q05: number; meanNet: number } {
  const names = Object.keys(perInstrument);
  if (!names.length) return { q05: 0, meanNet: 0 };
  const all = names.flatMap(k => perInstrument[k]);
  const meanNet = all.reduce((a, v) => a + v, 0) / all.length;
  const qs: number[] = [];
  for (let r = 0; r < b; r++) {
    let sum = 0, n = 0;
    for (let j = 0; j < names.length; j++) {
      const name = names[Math.floor(rng() * names.length)];
      const trades = perInstrument[name];
      for (const v of trades) { sum += v; n++; }
    }
    qs.push(sum / n);
  }
  qs.sort((a, b) => a - b);
  return { q05: qs[Math.max(0, Math.floor(b * 0.05))], meanNet };
}

// ---------------------------------------------------------------------------
// Grids — restricted to the engine's ACTUAL parameter surface (the stage-0
// parameterization). No knob the engine can't apply.
// ---------------------------------------------------------------------------
// Theta grid is PER-MINUTE (engine converts to per-bar via barsPerDay):
// 15m-theta 0/1/2 per day ≈ 0/0.0067/0.0133 %/min; keep both scales so each TF
// has a comparable search space (0 = no decay, 0.007 = ~1.1%/day @1m, 0.015 ≈ 2.2%/day).
const THETA_GRID = [0, 0.007, 0.015];
// Exit-knob grid shared by all strategies (live parity: phase mode = option_rsi_mr's
// 3-phase exit; sl_tp = plain target/SL). trailPct/phase1TargetPct only apply in phase mode.
const EXIT_GRID: Record<string, any>[] = [
  { exitMode: "sl_tp" }, // plain SL/TP — legacy default
  { exitMode: "phase", trailPct: 80, phase1TargetPct: 8 }, // BE-lock + 80% trail (option_rsi_mr parity)
];

const GRIDS: Record<string, Record<string, number>[]> = {
  // All strategies trade option premiums live (auto-scalper resolveStrikePremium
  // buys CE/PE at LTP). Grids search premium exits: % target, % SL, theta decay.
  // Points targets (premiumTargetPoints) are excluded — fixed-₹ TP on a ₹100-300
  // premium is 1:1 R:R inside the bid-ask spread, structurally negative.
  rsi_overbought_oversold: product({
    rsiPeriod: [5, 9, 14, 21],
    overbought: [65, 70, 75],
    oversold: [25, 30, 35],
    premiumTargetPct: [15, 25, 40],
    premiumStopLossPct: [30, 50],
    thetaPctPerDay: THETA_GRID,
  }).flatMap(cfg => EXIT_GRID.map(e => ({ ...cfg, ...e }))),
  bollinger_band_reversal: product({
    bbPeriod: [10, 20, 30],
    bbStdDev: [1.5, 2.0, 2.5],
    premiumTargetPct: [15, 25, 40],
    premiumStopLossPct: [30, 50],
    thetaPctPerDay: THETA_GRID,
  }).flatMap(cfg => EXIT_GRID.map(e => ({ ...cfg, ...e }))),
  sma_ema_cross: product({
    smaPeriod: [10, 20],
    emaPeriod: [30, 50],
    premiumTargetPct: [15, 25, 40],
    premiumStopLossPct: [30, 50],
    thetaPctPerDay: THETA_GRID,
  }).flatMap(cfg => EXIT_GRID.map(e => ({ ...cfg, ...e }))),
  s2_scalper: product({
    confidenceThreshold: [50, 55, 60],
    premiumTargetPct: [15, 25, 40],
    premiumStopLossPct: [30, 50],
    thetaPctPerDay: THETA_GRID,
  }).flatMap(cfg => EXIT_GRID.map(e => ({ ...cfg, ...e }))),
  option_rsi_mr: product({
    optionRsiPeriod: [9, 14, 21],
    optionRsiThreshold: [30, 40, 50],
    maxEntryPremium: [300, 600],
    premiumTargetPct: [15, 25, 40],
    premiumStopLossPct: [30, 50],
    thetaPctPerDay: THETA_GRID,
  }).flatMap(cfg => EXIT_GRID.map(e => ({ ...cfg, ...e }))),
};

function product(spec: Record<string, number[]>): Record<string, number>[] {
  const keys = Object.keys(spec);
  let out: Record<string, number>[] = [{}];
  for (const k of keys) {
    const next: Record<string, number>[] = [];
    for (const o of out) for (const v of spec[k]) next.push({ ...o, [k]: v });
    out = next;
  }
  return out;
}

export function gridFor(strategy: string): Record<string, number>[] {
  return GRIDS[strategy] ?? [];
}

// ---------------------------------------------------------------------------
// Gates (G1–G5, evaluated on TRAIN only; G6 holdout gate lives in promote.ts)
// ---------------------------------------------------------------------------
function applyGates(res: ConfigResult, instrumentList: string[], cfg: Record<string, number>): void {
  const g = res.gates;
  const n = res.nTrades;
  const mean = res.meanNet;
  const q05 = res.q05;
  g.push({
    name: "G-DATA", pass: instrumentList.every(i => res.perInstrument[i]?.n >= 200),
    detail: `${instrumentList.map(i => `${i}:${res.perInstrument[i]?.n ?? 0}`).join(" ")} candles >= 200 each`,
  });
  g.push({ name: "G-TRADES", pass: n >= 30, detail: `n=${n} >= 30` });
  g.push({ name: "G-MEAN", pass: mean > 0, detail: `meanNet=${mean.toFixed(4)} > 0` });
  g.push({ name: "G-Q05", pass: q05 > 0, detail: `q05=${q05.toFixed(4)} > 0` });
  const pos = Object.values(res.perInstrument).filter(p => p.meanNet > 0).length;
  g.push({
    name: "G-CONSISTENCY", pass: pos >= 3, detail: `${pos}/5 instruments meanNet > 0 (>= 3)`,
  });
}

// ---------------------------------------------------------------------------
// Main search: pooled train candles (ALL instruments) → per-config metrics.
// ---------------------------------------------------------------------------
export function optimize(
  data: OptimizeCfg[],
  strategy: string,
  opts: { seed?: number; bootstrapRuns?: number } = {}
): ConfigResult[] {
  const rng = mulberry32(opts.seed ?? 42);
  const b = opts.bootstrapRuns ?? 1000;
  const instrumentList = data.map(d => d.instrument);
  const out: ConfigResult[] = [];
  for (const cfg of gridFor(strategy)) {
    const perInstrument: Record<string, number[]> = {};
    const nObs: Record<string, number> = {};
    let totalNet = 0, nTrades = 0;
    for (const d of data) {
      const o: BTOpts = { ...cfg, strategy, instrument: d.instrument, maxGapMult: 4 };
      const run = runBacktest(d.candles, o);
      perInstrument[d.instrument] = run.trades.map(t => t.netPnlPct);
      nObs[d.instrument] = d.candles.length;
      totalNet += run.trades.reduce((a, t) => a + t.netPnlPct, 0);
      nTrades += run.trades.length;
    }
    const { q05 } = clusterBootstrapQ05(perInstrument, rng, b);
    const res: ConfigResult = {
      cfg,
      nTrades,
      meanNet: nTrades ? totalNet / nTrades : 0,
      q05,
      perInstrument: Object.fromEntries(Object.keys(perInstrument).map(k => [k, { n: nObs[k], meanNet: perInstrument[k].length ? perInstrument[k].reduce((a, v) => a + v, 0) / perInstrument[k].length : 0 }])),
      gates: [],
    };
    applyGates(res, instrumentList, cfg);
    out.push(res);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plateau selection: top cluster within 0.05 net%/trade of argmax, max
// trade count wins. Never promote the single sharp peak.
// ---------------------------------------------------------------------------
export function selectPlateau(results: ConfigResult[]): ConfigResult | null {
  const gated = results.filter(r => r.gates.every(g => g.pass));
  if (!gated.length) return null;
  const best = Math.max(...gated.map(r => r.q05));
  const plateau = gated.filter(r => r.q05 >= best - 0.05);
  plateau.sort((a, b) => b.nTrades - a.nTrades || b.q05 - a.q05);
  return plateau[0];
}
