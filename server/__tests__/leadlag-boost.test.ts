// Verify lead-lag edge boost: CE signal on an edge strike gets confidence
// boosted and is logged; PE signal on same strike does NOT boost (data is CE→CE).
// The boost runs in poll() BEFORE the confidence gate — a sub-threshold CE
// signal on an edge strike must cross the threshold into an entry.
import { describe, it, expect } from "vitest";
import { AutoScalper } from "../auto-scalper.js";

function makeSignal(strike: number, optType: "CE" | "PE", confidence: number) {
  return {
    timestamp: Date.now(),
    direction: optType === "CE" ? ("BUY_CE" as const) : ("BUY_PE" as const),
    confidence,
    reasons: ["test"],
    rsi: 50,
    macd: "flat",
    vwapAbove: false,
    bbWidth: 0,
    volumeZscore: 0,
    pcr: 1,
    ivPercentile: 15,
    atmStrike: strike,
    targetStrike: strike,
    premium: 50,
    spot: 24600,
    optType,
  };
}

describe("lead-lag confidence boost", () => {
  it("boosts CE confidence on edge strike 24600", () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY" }) as any;
    const signal = makeSignal(24600, "CE", 60);
    s.applyLeadLagBoost(signal);
    expect(s.leadLagEdges[24600]).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(60);
  });

  it("does not boost PE on edge strike (data is CE→CE)", () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY" }) as any;
    const signal = makeSignal(24600, "PE", 60);
    s.applyLeadLagBoost(signal);
    expect(s.leadLagEdges[24600]).toBeGreaterThan(0); // edge exists
    expect(signal.confidence).toBe(60);
  });

  it("edge boost crosses a sub-threshold CE signal into an entry", () => {
    // confidenceThreshold default 55; signal at 54 + boost(edge 17.5/2=8.75)
    // → 62.75 ≥ 55. Old code boosted only inside placeEntry, which the gate
    // never reached → the edge could not flip a skip into an entry.
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY" }) as any;
    const signal = makeSignal(24600, "CE", 54);
    s.applyLeadLagBoost(signal);
    expect(signal.confidence).toBeGreaterThanOrEqual(55);
  });
});
