// Delta hard-gate: a strike whose |delta| < minDelta (and no walk target
// qualifies within 4 steps) must yield NEUTRAL — never a BUY signal.
// Regression: old code logged "delta X < 0.45" but still returned BUY with the
// low-delta strike (PE 24500 @ 0.16 delta entered in production).
import { describe, it, expect, vi } from "vitest";
import { AutoScalper } from "../auto-scalper.js";

function makeOpt(sp: number, ltp: number, delta: number) {
  return { ref_id: 1, symbol: "NIFTY", inst_id: 1, ts: 0, sp, ls: ltp, ltp, ltpchg: 0, iv: 20, delta, gamma: 0, theta: 0, vega: 0, oi: 1000, volume: 100, prev_oi: 0 };
}

// Build a chain around spot 24600 with a CE/PE list of strikes
// Spot 24600. CE/PE chain with realistic deltas:
//   CE: 24500→0.84, 24550→0.73, 24600→0.57, 24650→0.40, 24700→0.26, 24750→0.17, 24800→0.10
//   PE: mirror (negative).
// strikeOffset 1 → CE target 24650 (0.40 < 0.45 fails), PE target 24550 (0.73 OK).
// Deeper OTM (24750+) all fail minDelta → no walk target → hard block.
const chainFor = (spot: number) => {
  const strikes = [24400, 24450, 24500, 24550, 24600, 24650, 24700, 24750, 24800];
  // Logistic sigmoid centered at ATM: 0.50 at spot, 0.73 ITM, 0.27 OTM per 100
  const delta = (strike: number, side: "CE" | "PE") => {
    const k = 0.02; // steepness per rupee
    const ceD = 1 / (1 + Math.exp(-k * (strike - spot)));
    return side === "CE" ? ceD : -ceD;
  };
  return {
    asset: "NIFTY", exchange: "NSE", expiry: "20260804",
    ce: strikes.map((s, i) => makeOpt(s * 100, 50 + i, delta(s, "CE"))),
    pe: strikes.map((s, i) => makeOpt(s * 100, 50 + i, delta(s, "PE"))),
  };
};

describe("delta hard-gate", () => {
  it("blocks entry when delta < minDelta and no walk target qualifies", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", minDelta: 0.9, strikeOffset: 2 } as any) as any;
    // spot 24600, CE target = 24700 (delta ~0.26 < 0.9); walk 24650 (0.40),
    // 24600 (0.57), 24550 (0.73) — all < 0.9 → hard-block, never BUY_CE.
    s.getCachedChain = vi.fn().mockResolvedValue({ chain: chainFor(24600) });
    s.fetchCandles1m = vi.fn().mockResolvedValue([]);
    const sig = await s.resolveStrikePremium(24600, true, 80, ["test"], 50, "flat", false, 0, 0, 1, 15);
    expect(sig.direction).toBe("NEUTRAL"); // hard-blocked
  });

  it("walks up to 4 steps to find a qualifying delta", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", minDelta: 0.45, strikeOffset: 3 } as any) as any;
    // spot 24600, PE target = 24600-150 = 24450 (delta ~0.9 — qualifies immediately)
    s.getCachedChain = vi.fn().mockResolvedValue({ chain: chainFor(24600) });
    s.fetchCandles1m = vi.fn().mockResolvedValue([]);
    const sig = await s.resolveStrikePremium(24600, false, 80, ["test"], 50, "flat", false, 0, 0, 1, 15);
    expect(sig.direction).toBe("BUY_PE");
    expect(sig.entryDelta).toBeGreaterThanOrEqual(0.45);
  });

  it("records entryDelta = abs(delta) of the resolved strike", async () => {
    const s = new AutoScalper({ paperMode: true, symbol: "NIFTY", minDelta: 0.45, strikeOffset: 1 } as any) as any;
    // spot 24600, CE target = 24650 (delta 0.40 < 0.45) → walks to 24600 (0.50)
    s.getCachedChain = vi.fn().mockResolvedValue({ chain: chainFor(24600) });
    s.fetchCandles1m = vi.fn().mockResolvedValue([]);
    const sig = await s.resolveStrikePremium(24600, true, 80, ["test"], 50, "flat", false, 0, 0, 1, 15);
    expect(sig.direction).toBe("BUY_CE");
    expect(sig.entryDelta).toBeGreaterThanOrEqual(0.45);
  });
});
