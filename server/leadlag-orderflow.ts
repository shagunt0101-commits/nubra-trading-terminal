// Stage-2b: cross-instrument lead-lag from orderflow JSONL.
// Does order-flow imbalance at strike/type A at time t predict the premium
// move of B on its NEXT tick? Compares against the same-instrument baseline.
// Usage: npx tsx server/leadlag-orderflow.ts [jsonlPath]
// refId → name map resolved live from broker refdata (no hardcoded IDs — the
// old 08-03 hardcode mislabeled newer runs' strikes).
import fs from "fs";
import path from "path";
import { nubraApi } from "./nubra";

const FILE = process.argv[2] || "orderflow-NIFTY-2026-08-03.jsonl";
if (!fs.existsSync(FILE)) { console.error(`Not found: ${FILE}`); process.exit(1); }

interface Row { refId: string; ts: string; ltp: number; imb: number; bidSum: number; askSum: number; }
const rows: Row[] = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// Resolve refId → "STRIKE CE/PE" from broker refdata (today's instruments;
// close enough for display — refIds repeat across sessions, names may drift).
async function buildKnown(): Promise<Record<string, string>> {
  const known: Record<string, string> = {};
  try {
    const date = new Date().toISOString().slice(0, 10);
    const data = await nubraApi.getInstruments(date, "NSE");
    for (const r of (data?.refdata || [])) {
      if (r.asset !== "NIFTY" || r.derivative_type !== "OPT") continue;
      // NIFTY2681124600CE = NIFTY + expiry 2681124 + strike 24600 + CE —
      // strike is the last 5 digits of the numeric run, expiry the rest.
      const m = /^([A-Z]+)(\d+)(CE|PE)$/.exec(String(r.stock_name || ""));
      if (!m) continue;
      const strike = Number(m[2].slice(-5)) / 100;
      if (!strike) continue;
      known[String(r.ref_id)] = `${strike} ${m[3]}`;
    }
  } catch (e: any) {
    console.warn(`refdata fetch failed (${e?.message || e}) — using raw refIds`);
  }
  return known;
}
let known: Record<string, string> = {};
const nameOf = (id: string) => known[id] || id;

// group by refId, sort by ts asc (stream order was arrival order → ok)
const byRef = new Map<string, Row[]>();
for (const r of rows) {
  if (!byRef.has(r.refId)) byRef.set(r.refId, []);
  byRef.get(r.refId)!.push(r);
}
const ids = [...byRef.keys()];
known = await buildKnown();
console.log(`Instruments: ${ids.map(nameOf).join(", ")}`);

// O(log n) window scans via binary search over ms timestamps (per-instrument
// arrays stay ts-ascending). Original prevTickBefore/nextTickAfterMs were O(n)
// linear scans restarted from index 0 per row — O(lenA×lenB) per pair, unusable
// past ~10k rows. Binary search keeps the whole analysis ~1s on 138k rows.
const tsCache = new WeakMap<Row[], number[]>();
function tsIdx(arr: Row[]): number[] {
  let c = tsCache.get(arr);
  if (!c) { c = arr.map((r) => new Date(r.ts).getTime()); tsCache.set(arr, c); }
  return c;
}
function nextTickAfterMs(arr: Row[], afterMs: number): Row | null {
  const t = tsIdx(arr);
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] > afterMs) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans >= 0 ? arr[ans] : null;
}
function prevTickBefore(arr: Row[], tMs: number): Row | null {
  const t = tsIdx(arr);
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

// ── per-pair lead-lag: A(imb) → B(premium move on its own next tick) ────────
// baseline: unconditional next-tick up rate, all instruments pooled
let baseUp = 0, baseN = 0;
for (const id of ids) {
  const arr = byRef.get(id)!;
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i + 1].ltp !== arr[i].ltp) { baseN++; baseUp += arr[i + 1].ltp > arr[i].ltp ? 1 : 0; }
  }
}
const baseRate = baseN ? baseUp / baseN : 0.5;

const out: string[] = [];
const edges: Record<string, number> = {};
for (const A of ids) {
  const arrA = byRef.get(A)!;
  for (const B of ids) {
    if (A === B) continue;
    const arrB = byRef.get(B)!;
    let hiUp = 0, hiN = 0, loUp = 0, loN = 0;
    for (const rA of arrA) {
      const b0 = prevTickBefore(arrB, new Date(rA.ts).getTime());
      if (!b0) continue;
      const b1 = nextTickAfterMs(arrB, new Date(b0.ts).getTime());
      // need B to move after b0
      if (!b1 || b1.ltp === b0.ltp) continue;
      const up = b1.ltp > b0.ltp ? 1 : 0;
      if (rA.imb > 0.2) { hiUp += up; hiN++; }
      else if (rA.imb < -0.2) { loUp += up; loN++; }
    }
    const hiRate = hiN ? hiUp / hiN : 0.5;
    const loRate = loN ? loUp / loN : 0.5;
    const edge = hiN >= 30 && loN >= 30 ? (hiRate - loRate) : 0;
    out.push(`  ${nameOf(A)}→${nameOf(B)}: A-imb>0.2 → B-up ${(hiRate * 100).toFixed(1)}% (n=${hiN})  |  A-imb<-0.2 → B-up ${(loRate * 100).toFixed(1)}% (n=${loN})  edge ${(edge * 100).toFixed(1)}`);
    if (edge !== 0) edges[nameOf(A) + "→" + nameOf(B)] = Math.round(edge * 1000) / 10;
  }
}
console.log(`Baseline next-tick up rate: ${(baseRate * 100).toFixed(1)}%\n`);
console.log(out.join("\n"));

// Persist non-zero edges (percent points) for /api/orderflow/predict —
// consumed as: A-imb>0.2 → expect B-up edge pts above baseline.
fs.writeFileSync("leadlag_edges.json", JSON.stringify(edges, null, 2));
console.log(`\nWrote leadlag_edges.json (${Object.keys(edges).length} non-zero edges)`);