import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'scripts/test/**/*.test.mjs', 'web/test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: false,
  },
});
