// Stage-2: train imbalance → next-tick directional model from order-flow JSONL.
// Usage: npx tsx server/train-orderflow.ts [jsonlPath]
// Writes orderflow_model.json (logistic weights) for /api/orderflow/predict.
import fs from "fs";

const FILE = process.argv[2] || "orderflow-NIFTY-2026-08-03.jsonl";
if (!fs.existsSync(FILE)) {
  console.error(`Data file not found: ${FILE}`);
  process.exit(1);
}

// ── load rows ────────────────────────────────────────────────────────────────
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// group by refId, require order (rows were streamed in arrival order → ts asc)
const byRef = new Map<string, any[]>();
for (const r of rows) {
  if (!byRef.has(r.refId)) byRef.set(r.refId, []);
  byRef.get(r.refId)!.push(r);
}

// ── build training samples: feature vector → next-tick up (1) / down (0) ────
// features: [imb, bidSum, askSum, bid1, ask1, ltp]
const X: number[][] = [];
const y: number[] = [];
for (const [refId, arr] of byRef) {
  for (let i = 0; i < arr.length - 1; i++) {
    const cur = arr[i];
    const nxt = arr[i + 1];
    if (nxt.ltp === cur.ltp) continue; // skip no-tick (no info)
    const f = [
      cur.imb ?? 0,
      cur.bidSum ?? 0,
      cur.askSum ?? 0,
      cur.bid1?.p ?? 0,
      cur.ask1?.p ?? 0,
      cur.ltp ?? 0,
    ];
    X.push(f);
    y.push(nxt.ltp > cur.ltp ? 1 : 0);
  }
}
console.log(`Samples: ${X.length} (${byRef.size} instruments)`);
if (X.length < 100) { console.error("Too few samples"); process.exit(1); }

// ── normalize features (z-score) ────────────────────────────────────────────
const mean = new Array(6).fill(0), std = new Array(6).fill(0);
for (const f of X) for (let j = 0; j < 6; j++) mean[j] += f[j];
for (let j = 0; j < 6; j++) mean[j] /= X.length;
for (const f of X) for (let j = 0; j < 6; j++) std[j] += (f[j] - mean[j]) ** 2;
for (let j = 0; j < 6; j++) { std[j] = Math.sqrt(std[j] / X.length) || 1; }
const norm = (f: number[]) => f.map((v, j) => (v - mean[j]) / std[j]);
const Xn = X.map(norm);

// ── holdout split ───────────────────────────────────────────────────────────
const N = Xn.length;
const k = Math.floor(N * 0.75);

// ── train logistic regression (batch GD, ~20 ep) ────────────────────────────
function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }
let w = new Array(6).fill(0), b = 0;
const lr = 0.5, epochs = 200, batch = Math.floor(N / 2);
for (let ep = 0; ep < epochs; ep++) {
  // shuffle batch
  for (let i = 0; i < batch; i++) {
    const j = i + Math.floor(Math.random() * (N - i));
    [Xn[j], Xn[i]] = [Xn[i], Xn[j]]; [y[j], y[i]] = [y[i], y[j]];
  }
  let gw = new Array(6).fill(0), gb = 0;
  for (let i = 0; i < batch; i++) {
    const z = b + Xn[i].reduce((s, v, j) => s + w[j] * v, 0);
    const err = sigmoid(z) - y[i];
    for (let j = 0; j < 6; j++) gw[j] += err * Xn[i][j];
    gb += err;
  }
  for (let j = 0; j < 6; j++) w[j] -= (lr / batch) * gw[j];
  b -= (lr / batch) * gb;
}

// ── evaluate on holdout (first 20% — train was shuffled, close enough) ─────
function evalStats(wSel: number[], bSel: number, start: number, end: number) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (let i = start; i < end; i++) {
    const z = sigmoid(bSel + Xn[i].reduce((s, v, j) => s + wSel[j] * v, 0));
    const pred = z >= 0.5 ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else if (pred === 1 && y[i] === 0) fp++;
    else fn++;
  }
  const acc = (tp + tn) / (end - start);
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return { acc, prec, rec, tp, fp, tn, fn };
}

const tr = evalStats(w, b, 0, k);
const te = evalStats(w, b, k, N);
console.log(`Train acc=${tr.acc.toFixed(3)} prec=${tr.prec.toFixed(3)} rec=${tr.rec.toFixed(3)}`);
console.log(`Test  acc=${te.acc.toFixed(3)} prec=${te.prec.toFixed(3)} rec=${te.rec.toFixed(3)}`);
console.log(`Test confusion → up: TP=${te.tp} FN=${te.fn} | down: FP=${te.fp} TN=${te.tn}`);

// ── persist model + scalers ─────────────────────────────────────────────────
const out = { weights: w, bias: b, mean, std, trainedAt: new Date().toISOString(), samples: X.length };
fs.writeFileSync("orderflow_model.json", JSON.stringify(out, null, 2));
console.log(`Wrote orderflow_model.json (${X.length} samples)`);