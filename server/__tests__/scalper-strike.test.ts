import { describe, it, expect } from "vitest";
import { AutoScalper } from "../auto-scalper.js";

// atmAround is private — exercise through the public constructor + a cast,
// mirroring how the engine resolves ATM strikes per instrument.
function atmFor(symbol: string, spot: number): number {
  const s = new AutoScalper({ symbol } as any);
  return (s as any).atmAround(spot);
}

describe("AutoScalper per-instrument strike step", () => {
  it("rounds ATM to 50 for NIFTY (default)", () => {
    expect(atmFor("NIFTY", 24882.5)).toBe(24900);
  });

  it("rounds ATM to 100 for BANKNIFTY", () => {
    expect(atmFor("BANKNIFTY", 52347)).toBe(52300);
  });

  it("rounds ATM to 100 for SENSEX", () => {
    expect(atmFor("SENSEX", 82950.3)).toBe(83000);
  });

  it("honors explicit strikeStep override", () => {
    const s = new AutoScalper({ symbol: "NIFTY", strikeStep: 100 } as any);
    expect((s as any).atmAround(24120)).toBe(24100);
  });
});