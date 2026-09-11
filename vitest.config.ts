import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // Server-side tests (default)
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    // Integration tests require a real Postgres + the integration setup (setup-db.ts) and
    // run via `npm run test:integration`. Exclude them here so the unit runner (`npm run test`)
    // doesn't sweep them in (which fails: no __TEST_DB__, no server-only mock).
    exclude: [...configDefaults.exclude, 'src/__tests__/integration/**'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/server/actions/**'],
      exclude: ['src/__tests__/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
