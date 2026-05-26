import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/integration/setup-db.ts'],
    testTimeout: 30000, // Integration tests may be slower
    hookTimeout: 30000,
    pool: 'forks',     // Each test file gets its own process
    fileParallelism: false, // Run files sequentially (shared DB)
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
