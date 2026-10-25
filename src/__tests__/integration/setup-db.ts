import { beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';

// Server-only modules (src/lib/tenant/context.ts, registry.ts, provision.ts, neon.ts) import
// the `server-only` guard, which the integration runner can't resolve. Stub it (and client-only)
// so integration tests can import those modules. Mirrors the unit setup's approach.
vi.mock('server-only', () => ({}));
vi.mock('client-only', () => ({}));

// Next 16 `after()` throws outside a request scope, and server actions schedule their emails with it
// (feature-plan-launch-blockers.md P1). Run each callback immediately and keep its promise so a test can
// `await flushAfter()` (helpers.ts) before asserting on sends. A test file's own `next/server` mock overrides this.
(globalThis as Record<string, unknown>).__AFTER_PROMISES__ = [];
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: unknown) => {
    const run = Promise.resolve().then(() => (typeof task === 'function' ? (task as () => unknown)() : task));
    ((globalThis as Record<string, unknown>).__AFTER_PROMISES__ as Promise<unknown>[]).push(run);
  },
}));

// ALWAYS use a separate test database — NEVER the dev database.
// The dev DB fallback was removed because cleanupTestData() deletes ALL rows,
// which previously wiped all seed users from the dev database.
// DO NOT add process.env.DATABASE_URL as a fallback here.
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

// CI sets REQUIRE_CONTROL_PLANE_TESTS so the lifecycle / billing / deletion suites can never skip silently there.
if (process.env.REQUIRE_CONTROL_PLANE_TESTS === '1' && !process.env.CONTROL_PLANE_DATABASE_URL) {
  throw new Error('REQUIRE_CONTROL_PLANE_TESTS=1 but CONTROL_PLANE_DATABASE_URL is not set — control-plane suites would skip.');
}

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // Connect to the test database (uses existing bytime DB if bytime_test not available)
  sql = postgres(TEST_DB_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  // Skip migrations if tables already exist (dev DB already has schema)
  // In CI, the DB is fresh and migrations are needed
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
  } catch (err: any) {
    // If types/tables already exist, that's fine — we're using the dev DB
    if (err?.cause?.code !== '42710' && err?.cause?.code !== '42P07') {
      throw err;
    }
  }

  // Export the test DB connection for use in tests
  (globalThis as any).__TEST_DB__ = db;
  (globalThis as any).__TEST_SQL__ = sql;
});

afterAll(async () => {
  if (sql) {
    await sql.end();
  }
});
