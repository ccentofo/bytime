import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';

// feature-plan-cloud-export.md §10 (3d): the same build-time constant esbuild defines for the backup image
// (scripts/backup/bundle.mjs): the tenant migration journal's entry count.
const TENANT_JOURNAL_LENGTH = (JSON.parse(readFileSync(path.resolve(__dirname, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;

export default defineConfig({
  define: { __TENANT_JOURNAL_LENGTH__: String(TENANT_JOURNAL_LENGTH) },
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
