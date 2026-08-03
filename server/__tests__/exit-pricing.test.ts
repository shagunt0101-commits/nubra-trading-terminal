// Regression: paper-mode exits must price off real chain LTP, never the
// synthetic 0.6-delta spot model. Today's phantom exit (CE 24550 "exited"
// @186.57 while real LTP stayed 62-67.35) happened because the fallback
// trigger `currentPremium === trade.entryPremium` mistook a real LTP that
// equalled the entry for "LTP missing" and re-invoked the model.
import { describe, it, expect, vi } from "vitest";
import { AutoScalper } from "../auto-scalper.js";

function makeTrade() {
  return {
    id: `T${Date.now()}`,
    entryTime: Date.now(),
    entryPremium: 66,
    entrySpot: 24700,
    optType: "CE",
    strike: 24550,
    status: "OPEN",
    stopLoss: 60,
    target: 70,
  };
}

describe("exit pricing: real chain LTP preferred over model", () => {
  it("uses chain LTP when present, even if it equals entryPremium (F1 regression)", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY" }) as any;
    const trade = makeTrade();
    s.activeTrade = trade;
    // LTP == entryPremium: old code saw `currentPremium === entryPremium`
    // and replaced it with 66 + 0.6*200 = 186.57 (phantom). New code keeps it.
    s.getCachedChain = vi.fn().mockResolvedValue({
      chain: { ce: [{ sp: 2455000, ltp: 6600 }], pe: [] },
    });
    s.fetchCandles1m = vi.fn().mockResolvedValue([]);
    s.checkStandardExit = vi.fn();
    s.checkOptionRsiMrExit = vi.fn();
    await s.checkExit(24900); // +200 spot, model would say 186.57
    // checkExit stored the real LTP (66.00), not the model price
    expect(s.checkStandardExit).toHaveBeenCalledWith(
      trade,
      expect.closeTo(66, 0.01)
    );
  });

  it("falls back to the spot model only when chain LTP is absent", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY" }) as any;
    const trade = makeTrade();
    s.activeTrade = trade;
    s.getCachedChain = vi.fn().mockResolvedValue(null); // no chain at all
    s.fetchCandles1m = vi.fn().mockResolvedValue([]);
    s.checkStandardExit = vi.fn();
    s.checkOptionRsiMrExit = vi.fn();
    await s.checkExit(24750); // +50 spot → model 66 + 0.6*50 = 96
    expect(s.checkStandardExit).toHaveBeenCalledWith(
      trade,
      expect.closeTo(96, 0.01)
    );
  });
});
