import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData, expectOk } from './helpers';

/**
 * feature-plan-ux-page-fixes.md C3 / T-C3d: a deterministic seed race. Another transaction inserts OH-001 and holds it
 * uncommitted; the seed starts, sees no rows (READ COMMITTED), and its INSERT … ON CONFLICT (code) DO NOTHING waits on
 * the unique index. Once the other transaction commits, the seed skips OH-001 and returns { created: 8 } — no unique
 * violation. A second seed then adds nothing.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: '00000000-0000-4000-8000-0000000000ad', email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import { seedIndirectCodes } from '@/server/actions/indirect-codes';

const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

describe('seedIndirectCodes under a racing insert (C3, T-C3d)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('an uncommitted OH-001 makes the seed wait, then skip it: { created: 8 }, no error; a second seed adds nothing', async () => {
    const racer = postgres(URL, { max: 1 });
    const observer = postgres(URL, { max: 1 });
    try {
      let seed!: ReturnType<typeof seedIndirectCodes>;
      await racer.begin(async (tx) => {
        await tx`INSERT INTO indirect_charge_codes (code, name, category, is_active, available_to_all) VALUES ('OH-001', 'Overhead (theirs)', 'overhead', true, true)`;
        seed = seedIndirectCodes();
        // Wait until the seed's INSERT is blocked on the uncommitted OH-001 (a row-lock wait on our transaction id).
        for (let i = 0; ; i++) {
          const [{ n }] = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'transactionid'`;
          if (n > 0) break;
          if (i > 400) throw new Error('the seed never waited on the uncommitted OH-001');
          await new Promise((res) => setTimeout(res, 25));
        }
      });
      expect(await seed).toEqual({ ok: true, data: { created: 8 } });
      const rows = await getTestDb().select({ code: schema.indirectChargeCodes.code, name: schema.indirectChargeCodes.name }).from(schema.indirectChargeCodes);
      expect(rows).toHaveLength(9);
      expect(rows.find((r) => r.code === 'OH-001')!.name).toBe('Overhead (theirs)');   // theirs kept, not duplicated
      expect(await expectOk(seedIndirectCodes())).toEqual({ created: 0 });
    } finally {
      await racer.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });
});
