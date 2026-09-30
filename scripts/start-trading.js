// scripts/start-trading.js — Start server + auto-scalper with best strategy
// Run via: node scripts/start-trading.js
// Scheduled: Windows Task Scheduler at 8:55 AM IST daily (Mon-Fri)

import { spawn } from "child_process";
import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PID_FILE = join(process.env.TEMP || "C:\\Temp", "mvf-server.pid");
const LOG_FILE = join(process.env.TEMP || "C:\\Temp", "mvf-trading.log");

function log(msg) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
}

// Check if already running
if (existsSync(PID_FILE)) {
  const pid = parseInt(require("fs").readFileSync(PID_FILE, "utf8").trim());
  try { process.kill(pid, 0); log(`Server already running (PID ${pid}), skipping`); process.exit(0); } catch {}
}

log("=== TRADING SESSION START ===");
log("Starting dev server...");

// Start the server as detached child
const server = spawn("npx", ["tsx", "server.ts"], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
  env: { ...process.env, NODE_ENV: "development" },
});

server.unref();
writeFileSync(PID_FILE, String(server.pid));
log(`Server started (PID ${server.pid})`);

// Wait for server to boot, then configure scalper via API
setTimeout(async () => {
  try {
    // Strategy selection rationale:
    // bollinger_band_reversal (PGHO 1m promotion): holdout n=160 meanNet +0.91 PASS
    // - BB 20/2.5, TP 15%, SL 50%, sl_tp mode, theta 0
    // - Best validated strategy with real tick data
    // - FVG strategy promising but insufficient data (only 2 days, 6 trades)
    //
    // Using bollinger_band_reversal as primary — proven in PGHO holdout.
    // FVG as secondary when more data validates it.

    const config = {
      symbol: "NIFTY",
      exchange: "NSE",
      strategy: "bollinger_band_reversal",  // PGHO-validated, best WR + lowest DD
      paperMode: true,                       // SAFETY: paper mode until live-validated
      lotSize: 65,
      lotCount: 2,
      totalQty: 130,
      pollIntervalMs: 15000,
      confidenceThreshold: 55,
      premiumTargetPct: 15,       // PGHO promoted
      stopLossPct: 50,            // PGHO promoted
      bbPeriod: 20,               // PGHO promoted
      bbStdDev: 2.5,              // PGHO promoted
      exitMode: "sl_tp",          // PGHO promoted
      strikeOffset: 1,
      maxConcurrentTrades: 1,
      maxHoldingMinutes: 45,
      entryCutoff: "15:25",       // No new entries after 15:25 IST (CAS buffer)
      trendGateAdx: 0,
      srEnabled: false,
    };

    log("Configuring scalper: bollinger_band_reversal (PGHO validated)");
    log(`  BB: ${config.bbPeriod}/${config.bbStdDev}, TP: ${config.premiumTargetPct}%, SL: ${config.stopLossPct}%`);
    log(`  Paper mode: ${config.paperMode}`);

    // POST config then start
    const res1 = await fetch("http://localhost:3000/api/scalper/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res1.ok) throw new Error(`Config failed: ${res1.status}`);

    const res2 = await fetch("http://localhost:3000/api/scalper/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res2.ok) throw new Error(`Start failed: ${res2.status}`);

    const status = await res2.json();
    log(`Scalper started: mode=${status.mode}, strategy=${config.strategy}`);
    log("=== TRADING SESSION ACTIVE ===");
  } catch (e) {
    log(`ERROR starting scalper: ${e.message}`);
    log("Server is running but scalper failed — check broker login");
  }
  process.exit(0);
}, 8000); // 8s boot wait
