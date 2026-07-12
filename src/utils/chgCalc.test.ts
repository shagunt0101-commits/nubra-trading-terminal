/**
 * Test file for Percentage Change and Open Interest (OI) Change logic.
 * Executes assertions and logs results for % chg and % OI chg calculations.
 */

import {
  calculatePercentageChange,
  formatPercentageChange,
  formatPercentageChangeNum,
  calculateOiChangePercentage,
  runChgTests
} from "./chgCalc";

export function runAllTests(): { passed: boolean; logs: string[] } {
  const logs: string[] = [];
  let allPassed = true;

  const assert = (condition: boolean, msg: string) => {
    if (!condition) {
      allPassed = false;
      logs.push(`❌ ASSERTION FAILED: ${msg}`);
    } else {
      logs.push(`✅ PASSED: ${msg}`);
    }
  };

  logs.push("--- Starting % Chg & % OI Chg Unit Tests ---");

  // Test 1: Percentage change calculations
  assert(calculatePercentageChange(110, 100) === 10.0, "calculatePercentageChange(110, 100) == 10.0");
  assert(calculatePercentageChange(90, 100) === -10.0, "calculatePercentageChange(90, 100) == -10.0");
  assert(calculatePercentageChange(100, 0) === 0, "calculatePercentageChange(100, 0) == 0 (zero division guard)");

  // Test 2: Formatting percentage change strings
  assert(formatPercentageChange(0.05) === "+5.00%", "formatPercentageChange(0.05) == '+5.00%'");
  assert(formatPercentageChange(3.5) === "+3.50%", "formatPercentageChange(3.5) == '+3.50%'");
  assert(formatPercentageChange(-0.021) === "-2.10%", "formatPercentageChange(-0.021) == '-2.10%'");
  assert(formatPercentageChange(0) === "+0.00%", "formatPercentageChange(0) == '+0.00%'");
  assert(formatPercentageChange(undefined) === "0.00%", "formatPercentageChange(undefined) == '0.00%'");

  // Test 3: Formatting percentage change numbers
  assert(formatPercentageChangeNum(0.045) === 4.5, "formatPercentageChangeNum(0.045) == 4.5");
  assert(formatPercentageChangeNum(5.25) === 5.25, "formatPercentageChangeNum(5.25) == 5.25");
  assert(formatPercentageChangeNum(-0.015) === -1.5, "formatPercentageChangeNum(-0.015) == -1.5");

  // Test 4: OI change percentage calculations
  assert(calculateOiChangePercentage(150000, 120000) === 25.0, "calculateOiChangePercentage(150000, 120000) == 25.0");
  assert(calculateOiChangePercentage(80000, 100000) === -20.0, "calculateOiChangePercentage(80000, 100000) == -20.0");
  assert(calculateOiChangePercentage(50000, 0) === 0, "calculateOiChangePercentage(50000, 0) == 0");

  // Test 5: Built-in suite execution
  const suite = runChgTests();
  assert(suite.passed, "Built-in chgCalc suite passed");
  suite.results.forEach(r => logs.push(`   [Suite] ${r}`));

  logs.push(`--- Test Run Completed. Result: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} ---`);
  return { passed: allPassed, logs };
}

// Auto-run when imported in test environments or browser console
if (typeof window !== "undefined") {
  (window as any).__runChgTests = runAllTests;
}
