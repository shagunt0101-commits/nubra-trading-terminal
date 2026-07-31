import { Router } from "express";
import { validate, scalperStartSchema, scalperConfigSchema } from "../validation.js";
import { scalper } from "../scalper-instance.js";
import logger from "../logger.js";

const router = Router();

router.post("/start", validate(scalperStartSchema), (req, res) => {
  const { symbol, lotCount, confidenceThreshold, premiumTargetPct, stopLossPct, strikeOffset, pollIntervalMs } = req.body || {};
  if (symbol) scalper.updateConfig({ symbol });
  if (lotCount) scalper.updateConfig({ lotCount, totalQty: (scalper.getConfig().lotSize || 75) * lotCount });
  if (confidenceThreshold) scalper.updateConfig({ confidenceThreshold });
  if (premiumTargetPct) scalper.updateConfig({ premiumTargetPct });
  if (stopLossPct) scalper.updateConfig({ stopLossPct });
  if (strikeOffset) scalper.updateConfig({ strikeOffset });
  if (pollIntervalMs) scalper.updateConfig({ pollIntervalMs });
  scalper.start();
  res.json({ success: true, mode: scalper.getMode(), config: scalper.getConfig() });
});

router.post("/stop", (req, res) => {
  scalper.stop();
  res.json({ success: true, mode: scalper.getMode() });
});

router.post("/reset", (req, res) => {
  scalper.reset();
  res.json({ success: true, mode: scalper.getMode() });
});

router.post("/clear-old-trades", (req, res) => {
  scalper.clearOldTrades();
  res.json({ success: true, trades: scalper.getTrades().length });
});

router.get("/status", (req, res) => {
  res.json({
    mode: scalper.getMode(),
    config: scalper.getConfig(),
    stats: scalper.getStats(),
    activeTrade: scalper.getActiveTrade(),
    trades: scalper.getTrades().slice(-20),
    logs: scalper.getLogs(30),
  });
});

// ── Scalper trades in order-book-compatible format ─────────────────
router.get("/trades", (req, res) => {
  const raw = scalper.getTrades();
  const mapped = raw.map((t: any) => ({
    intentOrderId: 10000 + (t.id || 0),
    side: t.side || (t.optType === "CE" ? "BUY" : "SELL"),
    orderQty: t.qty || 0,
    orderPrice: (t.entryPremium || 0) * 100,
    symbol: t.symbol || "",
    status: t.status === "CLOSED" ? "EXECUTED" : t.status === "OPEN" ? "OPEN" : "EXECUTED",
    scalper: true,
    isMulti: false,
    refId: t.strike ? `SCALPER-${t.optType || ""}${t.strike || ""}` : "SCALPER",
    timestamps: { intentCreatedAt: t.entryTime ? new Date(t.entryTime).toISOString() : new Date().toISOString() },
    pnl: t.pnl,
    pnlPercent: t.pnlPercent,
    exitReason: t.exitReason,
    entryPremium: t.entryPremium,
    exitPremium: t.exitPremium,
    strike: t.strike,
    optType: t.optType,
    result: t.result,
  }));
  res.json({ success: true, count: mapped.length, trades: mapped });
});

router.post("/config", validate(scalperConfigSchema), (req, res) => {
  scalper.updateConfig(req.body);
  res.json({ success: true, config: scalper.getConfig() });
});

// ── Trade journal export ──────────────────────────────────────────
router.get("/export-trades", (req, res) => {
  const fmt = String(req.query.format || "json").toLowerCase();
  const trades = scalper.getTrades();

  if (fmt === "csv") {
    const header = "id,symbol,side,entryTime,exitTime,entryPrice,exitPrice,qty,pnl,pnlPercent,result,optType,strike,exitReason,status,barsHeld";
    const rows = trades.map((t: any) =>
      [t.id, t.symbol, t.side, t.entryTime, t.exitTime || "", t.entryPrice, t.exitPrice || "", t.qty, t.pnl?.toFixed(2) || "", t.pnlPercent?.toFixed(2) || "", t.result || "", t.optType || "", t.strike || "", t.exitReason || "", t.status || "", t.barsHeld || ""].join(",")
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="scalper-trades-${Date.now()}.csv"`);
    return res.send([header, ...rows].join("\n"));
  }

  res.json({ success: true, count: trades.length, trades });
});

export default router;
