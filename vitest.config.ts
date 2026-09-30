import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, exclude: ['src/utils/chgCalc.test.ts', 'node_modules/**'] },
  resolve: { conditions: ['node'] },
});
