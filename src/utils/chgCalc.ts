/**
 * Percentage Change & Open Interest Change (OI Chg) Calculation & Formatting Utilities
 * Created for unit testing and accurate option chain metrics.
 */

export function calculatePercentageChange(current: number, previous: number): number {
  if (!previous || previous === 0) return 0;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

export function formatPercentageChange(rawChange?: number): string {
  if (rawChange === undefined || rawChange === null || isNaN(rawChange)) return "0.00%";
  let pct = rawChange;
  if (Math.abs(rawChange) <= 1 && rawChange !== 0) {
    pct = rawChange * 100;
  }
  const formatted = pct.toFixed(2);
  return `${pct >= 0 ? "+" : ""}${formatted}%`;
}

export function formatPercentageChangeNum(rawChange?: number): number {
  if (rawChange === undefined || rawChange === null || isNaN(rawChange)) return 0;
  let pct = rawChange;
  if (Math.abs(rawChange) <= 1 && rawChange !== 0) {
    pct = rawChange * 100;
  }
  return Number(pct.toFixed(2));
}

export function calculateOiChangePercentage(currentOi: number, previousOi: number): number {
  if (!previousOi || previousOi === 0) return 0;
  return Number((((currentOi - previousOi) / previousOi) * 100).toFixed(2));
}

// Unit test suite for % chg and % OI chg
export function runChgTests(): { passed: boolean; results: string[] } {
  const results: string[] = [];
  let passed = true;

  try {
    // Test 1: Decimal percentage conversion (0.05 -> +5.00%)
    const res1 = formatPercentageChange(0.05);
    if (res1 !== "+5.00%") {
      passed = false;
      results.push(`Test 1 Failed: expected +5.00%, got ${res1}`);
    } else {
      results.push(`Test 1 Passed: 0.05 -> ${res1}`);
    }

    // Test 2: Absolute percentage value (3.5 -> +3.50%)
    const res2 = formatPercentageChange(3.5);
    if (res2 !== "+3.50%") {
      passed = false;
      results.push(`Test 2 Failed: expected +3.50%, got ${res2}`);
    } else {
      results.push(`Test 2 Passed: 3.5 -> ${res2}`);
    }

    // Test 3: Negative change (-0.021 -> -2.10%)
    const res3 = formatPercentageChange(-0.021);
    if (res3 !== "-2.10%") {
      passed = false;
      results.push(`Test 3 Failed: expected -2.10%, got ${res3}`);
    } else {
      results.push(`Test 3 Passed: -0.021 -> ${res3}`);
    }

    // Test 4: OI change percentage calculation (120000 -> 150000 = +25.00%)
    const oiChg = calculateOiChangePercentage(150000, 120000);
    if (oiChg !== 25.0) {
      passed = false;
      results.push(`Test 4 Failed: expected 25.0, got ${oiChg}`);
    } else {
      results.push(`Test 4 Passed: OI Chg 120k -> 150k = ${oiChg}%`);
    }

    // Test 5: Price change calculation from LTP and prev_close
    const priceChg = calculatePercentageChange(525, 500); // (25 / 500) * 100 = 5.0%
    if (priceChg !== 5.0) {
      passed = false;
      results.push(`Test 5 Failed: expected 5.0, got ${priceChg}`);
    } else {
      results.push(`Test 5 Passed: LTP 500 -> 525 = ${priceChg}%`);
    }

  } catch (e: any) {
    passed = false;
    results.push(`Test Exception: ${e.message}`);
  }

  return { passed, results };
}
