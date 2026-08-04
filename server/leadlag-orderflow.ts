// Stage-2b: cross-instrument lead-lag from orderflow JSONL.
// Does order-flow imbalance at strike/type A at time t predict the premium
// move of B on its NEXT tick? Compares against the same-instrument baseline.
// Usage: npx tsx server/leadlag-orderflow.ts [jsonlPath]
import fs from "fs";
import path from "path";

const FILE = process.argv[2] || "orderflow-NIFTY-2026-08-03.jsonl";
if (!fs.existsSync(FILE)) { console.error(`Not found: ${FILE}`); process.exit(1); }

interface Row { refId: string; ts: string; ltp: number; imb: number; bidSum: number; askSum: number; }
const rows: Row[] = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// key refId by option name (resolve from symbol map we know from probe runs)
const known: Record<string, string> = {
  "1571953": "24600 CE", "1571954": "24600 PE", "1571955": "24650 CE",
};
const nameOf = (id: string) => known[id] || id;

// group by refId, sort by ts asc (stream order was arrival order → ok)
const byRef = new Map<string, Row[]>();
for (const r of rows) {
  if (!byRef.has(r.refId)) byRef.set(r.refId, []);
  byRef.get(r.refId)!.push(r);
}
const ids = [...byRef.keys()];
console.log(`Instruments: ${ids.map(nameOf).join(", ")}`);

function nextTickAfter(arr: Row[], tMs: number): Row | null {
  for (const r of arr) { if (new Date(r.ts).getTime() >= tMs) return r; }
  return null;
}
function prevTickBefore(arr: Row[], tMs: number): Row | null {
  let best: Row | null = null;
  for (const r of arr) { if (new Date(r.ts).getTime() <= tMs) best = r; else break; }
  return best;
}
function nextTickAfterMs(arr: Row[], afterMs: number): Row | null {
  for (const r of arr) { if (new Date(r.ts).getTime() > afterMs) return r; }
  return null;
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
  }
}
console.log(`Baseline next-tick up rate: ${(baseRate * 100).toFixed(1)}%\n`);
console.log(out.join("\n"));

function nextTickFor(arr: Row[], afterMs: number): Row | null {
  for (const r of arr) { if (new Date(r.ts).getTime() > afterMs) return r; }
  return null;
}