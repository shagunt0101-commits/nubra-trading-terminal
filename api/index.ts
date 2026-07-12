// Minimal Vercel serverless entry — dynamically imports Express app
// Avoids static top-level imports that may cause bundling issues on Vercel
import express from "express";

const app = express();
app.use(express.json());

// Lazy-load the full server setup on first request
let initialized = false;
async function ensureInitialized() {
  if (initialized) return;
  // Re-apply the app-level middleware from server.ts
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Dynamically import route handlers to avoid Vercel bundling failures
  const { nubraApi, nubraLogin, nubraSendOtp, nubraVerifyOtp, getLoginState, getSessionToken } = await import("../server/nubra.js");
  const { generateTradingSignals } = await import("../server/gemini.js");
  const { calculateSMA, calculateEMA, calculateRSI, calculateBollingerBands, calculateMACD } = await import("../server/indicators.js");
  const { getGlobalSentiment } = await import("../server/global.js");

  // Register all routes
  await import("../server.js");

  initialized = true;
}

// Health check — always works
app.get("/api/health", (req, res) => res.json({ ok: true }));

// All other API routes go through the lazy-loaded server
app.all("/api/*", async (req, res, next) => {
  try {
    await ensureInitialized();
    next();
  } catch (err: any) {
    res.status(500).json({ error: "Init failed", message: err.message });
  }
});

export default app;
