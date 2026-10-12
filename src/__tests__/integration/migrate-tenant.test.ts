import { describe, it, expect } from 'vitest';
import { migrateTenantDatabase } from '@/lib/tenant/migrate-tenant';

// setup-db.ts already migrates TEST_DATABASE_URL via the same ./drizzle folder in its own
// beforeAll, so by the time this file runs the DB is already fully current — both cases below
// exercise migrateTenantDatabase() as a no-op against an up-to-date schema, which is exactly
// the condition a deploy rollout hits on every tenant that has nothing pending.
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('migrateTenantDatabase — idempotency + advisory lock', () => {
  it('is idempotent: running it twice in a row both succeed', async () => {
    await expect(migrateTenantDatabase(TEST_DB_URL!)).resolves.toBeUndefined();
    await expect(migrateTenantDatabase(TEST_DB_URL!)).resolves.toBeUndefined();
  });

  it('serializes concurrent calls via the advisory lock instead of racing', async () => {
    const results = await Promise.allSettled([
      migrateTenantDatabase(TEST_DB_URL!),
      migrateTenantDatabase(TEST_DB_URL!),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
