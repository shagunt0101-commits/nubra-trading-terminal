# Audit Plan: src/App.tsx

## Goals
1. Glass theme consistency.
2. Layout robustness.
3. Performance optimization (context/memoization).
4. Type safety (replace `any`).

## Steps
1. [ ] Create a `MarketData` context or similar to reduce prop drilling.
2. [ ] Audit `index.css` for consistent glass utility usage.
3. [ ] Replace `any` types in `MainWorkspace` with proper interfaces.
4. [ ] Identify and memoize heavy components/callbacks.
5. [ ] Apply fixes.
