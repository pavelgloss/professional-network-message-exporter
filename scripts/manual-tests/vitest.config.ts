import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/manual-tests/inmail-live.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
