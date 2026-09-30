// ─────────────────────────────────────────────────────────────────────────────
// Order-flow WS probe — Stage 1 live verification + Stage 2 data collection.
//
// Run during market hours (09:15 IST open):
//   NUBRA_ENV=UAT npx tsx server/nubra-ws-probe.ts [minutes] [symbol] [spot]
//   (defaults: 30 minutes, NIFTY, spot auto-resolved from current price)
//
// What it does:
//   1. Logs in (TOTP auto-login — reuses nubra.ts)
//   2. Resolves the ATM option ref_ids for the symbol from getInstruments()
//   3. Subscribes orderbook (top-4 depth) via the Stage-1 NubraWsClient
//   4. Logs every decoded frame + computed top-of-book imbalance to
//      orderflow-<symbol>-<date>.jsonl AND console (LTP, best bid/ask, qty)
//   5. Every 60s, fetches a REST quote snapshot and prints a parity check
//      line (WS best bid/ask vs REST) — the plan's UAT sanity gate.
//
// Output file feeds the Stage-2 lead-lag validation note. Nothing here places
// orders — read-only market data.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { getSessionToken, nubraApi } from "./nubra.js";
import { NubraWsClient } from "./nubra-ws.js";

const MINUTES = parseInt(process.argv[2] || "30", 10);
const SYMBOL = (process.argv[3] || "NIFTY").toUpperCase();
const SPOT_OVERRIDE = process.argv[4] ? parseFloat(process.argv[4]) : 0;

function topOfBookImbalance(snap: { bids: { quantity: number }[]; asks: { quantity: number }[] }): number {
  const bidQty = snap.bids.reduce((s, b) => s + b.quantity, 0);
  const askQty = snap.asks.reduce((s, a) => s + a.quantity, 0);
  if (bidQty + askQty === 0) return 0;
  return (bidQty - askQty) / (bidQty + askQty);
}

async function main() {
  // Reuse the existing session token (.nubra_session) — the account has no TOTP
  // enabled, so a fresh nubraLogin() fails. WS + REST both read the loaded token.
  const token = getSessionToken();
  if (!token) {
    console.error("No session token loaded — run the server once (reuses .nubra_session) first.");
    process.exit(1);
  }
  console.log(`Session token loaded. Env=${process.env.NUBRA_ENV || "PROD"} symbol=${SYMBOL} minutes=${MINUTES}`);

  // Resolve spot (current price) + ATM option ref_ids
  let spot = SPOT_OVERRIDE;
  try {
    const px = await nubraApi.getCurrentPrice(SYMBOL, "NSE");
    // getCurrentPrice shape varies by env — accept ltp/price/current_price
    const raw = px?.ltp ?? px?.price ?? px?.current_price ?? px?.data?.ltp;
    if (!spot && raw) spot = Number(raw) / 100; // broker sends paise
    console.log(`Spot (REST): ${spot}`);
  } catch (e: any) {
    console.warn(`getCurrentPrice failed: ${e.message} — using spot=${spot || "UNKNOWN"}`);
  }
  if (!spot) {
    console.error("No spot — pass it as argv[4], e.g. 25000");
    process.exit(1);
  }

  const client = new NubraWsClient();
  const refIds = await client.resolveRefIds(SYMBOL, spot, 3);
  console.log(`Subscribing orderbook for ref_ids: [${refIds.join(", ")}] (spot ${spot})`);
  if (!refIds.length) {
    console.error("No option ref_ids resolved — instruments master mismatch. Check symbol/date/env.");
    process.exit(1);
  }

  const outFile = path.join(process.cwd(), `orderflow-${SYMBOL}-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const out = fs.createWriteStream(outFile, { flags: "a" });
  let frameCount = 0;
  let lastRestCheck = 0;

  client.start(refIds, (snap) => {
    frameCount++;
    const imb = topOfBookImbalance(snap);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      refId: snap.refId,
      ltp: snap.ltp,
      imb: Math.round(imb * 1000) / 1000,
      bid1: snap.bids[0] ? { p: snap.bids[0].price, q: snap.bids[0].quantity } : null,
      ask1: snap.asks[0] ? { p: snap.asks[0].price, q: snap.asks[0].quantity } : null,
      bidSum: snap.bids.reduce((s, b) => s + b.quantity, 0),
      askSum: snap.asks.reduce((s, a) => s + a.quantity, 0),
    });
    out.write(line + "\n");
    // console: first frame per refId + every 20th thereafter (avoid spam)
    if (frameCount % 20 === 1) {
      console.log(`[${frameCount}] refId=${snap.refId} ltp=${snap.ltp} imb=${line.includes('"imb":') ? JSON.parse(line).imb : "?"} b1=${line.includes("bid1") ? JSON.parse(line).bid1?.p : "?"}/${line.includes("ask1") ? JSON.parse(line).ask1?.p : "?"}`);
    }

    // every 60s: REST parity snapshot (compare the SAME option: its own ticker)
    if (Date.now() - lastRestCheck > 60_000) {
      lastRestCheck = Date.now();
      const optSym = client.symbolForRefId(Number(snap.refId)) || SYMBOL;
      nubraApi.getCurrentPrice(optSym, "NSE")
        .then((rest) => {
          // option premium in paise, same unit as WS ltp
          const rltp = (rest?.ltp ?? rest?.price ?? rest?.current_price ?? rest?.data?.ltp) ?? 0;
          console.log(`[PARITY] ${optSym} refId=${snap.refId} WS ltp=${snap.ltp} | REST ltp=${rltp} (diff ${Math.abs(snap.ltp - rltp)})`);
        })
        .catch((e) => console.warn(`[PARITY] REST fetch failed: ${e.message}`));
    }
  });

  console.log(`Probe running ${MINUTES} min — writing ${outFile}`);
  console.log("Ctrl+C to stop early.");

  setTimeout(() => {
    client.stop();
    out.end();
    console.log(`Done — ${frameCount} frames. File: ${outFile}`);
    process.exit(0);
  }, MINUTES * 60_000);
}

main().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
