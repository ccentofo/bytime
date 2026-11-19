import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * SWEEP-FINDINGS.md A3-D1 (behaviour with real rows): /api/v1/timesheets pages never overlap or skip entries that tie
 * on the employee's name and the date, and meta.total is every matching entry on every page. The deterministic pin of
 * the ORDER BY and the count query is unit/v1-timesheets-periods-params.test.ts (tie order without the id key is up to
 * the planner, so this file alone can't be the revert check).
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { GET as getTimesheets } from '@/app/api/v1/timesheets/route';

async function seedApiKey(createdBy: string): Promise<string> {
  const rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
  await getTestDb().insert(schema.apiKeys).values({
    name: 'Paging key',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.substring(0, 8),
    createdByUserId: createdBy,
    permissions: 'read',
    isActive: true,
  });
  return rawKey;
}

describe('/api/v1/timesheets paging with ties (A3-D1)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('walking every page returns each entry exactly once, in (name, date, id) order, with the true total', async () => {
    const db = getTestDb();
    const admin = await createTestUser({ role: 'admin', fullName: 'Zed Admin' });
    // Two people with the SAME name: every entry below ties on (full name, date).
    const a = await createTestUser({ fullName: 'Sam Same' });
    const b = await createTestUser({ fullName: 'Sam Same' });
    const clin = await createTestClin((await createTestContract()).id);
    const codes = await Promise.all([1, 2, 3].map(() => createTestChargeCode(clin.id)));
    const inserted = await db.insert(schema.timesheetEntries).values([
      ...codes.map((c) => ({ userId: a.id, chargeCodeId: c.id, clinId: clin.id, entryDate: '2026-10-07', hours: '1', revisionNumber: 1, createdBy: a.id })),
      ...codes.slice(0, 2).map((c) => ({ userId: b.id, chargeCodeId: c.id, clinId: clin.id, entryDate: '2026-10-07', hours: '2', revisionNumber: 1, createdBy: b.id })),
    ]).returning({ id: schema.timesheetEntries.id });
    const rawKey = await seedApiKey(admin.id);

    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const res = await getTimesheets(new Request(
        `http://localhost:3000/api/v1/timesheets?startDate=2026-10-01&endDate=2026-10-31&page=${page}&pageSize=2`,
        { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.71' } },
      ) as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta).toMatchObject({ total: 5, page, pageSize: 2 });
      expect(body.data).toHaveLength(page <= 2 ? 2 : page === 3 ? 1 : 0);
      seen.push(...body.data.map((r: { id: string }) => r.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual(inserted.map((r) => r.id).sort());
    expect(seen).toEqual([...seen].sort()); // same name and date throughout, so the id decides
  });
});
