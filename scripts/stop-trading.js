// scripts/stop-trading.js — Stop auto-scalper + server at 3:40 PM IST
// Run via: node scripts/stop-trading.js
// Scheduled: Windows Task Scheduler at 3:40 PM IST daily (Mon-Fri)

import { readFileSync, unlinkSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const PID_FILE = join(process.env.TEMP || "C:\\Temp", "mvf-server.pid");
const LOG_FILE = join(process.env.TEMP || "C:\\Temp", "mvf-trading.log");

function log(msg) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
}

async function main() {
  log("=== TRADING SESSION END ===");

  // 1. Force-close any open trade via API (before killing server)
  try {
    const closeRes = await fetch("http://localhost:3000/api/scalper/close-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const closeData = await closeRes.json();
    log(`Force-close result: closed=${closeData.closed}, premium=${closeData.premium}`);
  } catch (e) {
    log(`Force-close skipped (server may be down): ${e.message}`);
  }

  // 2. Stop scalper via API
  try {
    await fetch("http://localhost:3000/api/scalper/stop", { method: "POST" });
    log("Scalper stopped via API");
  } catch (e) {
    log(`Scalper stop skipped: ${e.message}`);
  }

  // 3. Get final session stats
  try {
    const statusRes = await fetch("http://localhost:3000/api/scalper/status");
    const status = await statusRes.json();
    const stats = status.stats || {};
    log(`Session stats: PnL=${stats.totalPnl}, Wins=${stats.totalWins}, Losses=${stats.totalLosses}`);
    if (status.dayPnl?.length) {
      const today = status.dayPnl[0];
      log(`Today: PnL=${today.pnl}, Trades=${today.trades}, Wins=${today.wins}`);
    }
  } catch {}

  // 4. Kill server process
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
      log(`Server process ${pid} terminated`);
    } catch (e) {
      log(`Server process ${pid} already dead`);
    }
    unlinkSync(PID_FILE);
  } else {
    log("No PID file found — server may not be running");
  }

  log("=== SESSION CLOSED ===");
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
