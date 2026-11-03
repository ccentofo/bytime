import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-page-fixes.md C4 (R4) / T-C4b: assignUserToLaborCategory refuses a category that isn't assignable —
 * the same rule as getAssignableLaborCategories (an active category on an active CLIN of an active contract); a
 * non-UUID id is a validation error and an unknown id "no longer exists". An assignable one still assigns.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const session = vi.hoisted(() => ({ adminId: '' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const admin = async () => ({ id: session.adminId, email: 'admin@x', fullName: 'Admin', role: 'admin' });
  return { ...actual, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import { assignUserToLaborCategory } from '@/server/actions/labor-categories';

describe('assignUserToLaborCategory refuses an unassignable category (C4, T-C4b)', () => {
  let employeeId: string;
  const db = () => getTestDb();
  const lcatOn = async (o: { contract?: 'active' | 'inactive'; clin?: 'active' | 'inactive'; lcat?: 'active' | 'inactive' }) => {
    const contract = await createTestContract({ status: o.contract ?? 'active' });
    const clin = await createTestClin(contract.id, { status: o.clin ?? 'active' });
    const [lc] = await db().insert(schema.laborCategories).values({ clinId: clin.id, lcatCode: `LC-${Math.random().toString(36).slice(2, 8)}`, title: 'Engineer', status: o.lcat ?? 'active' }).returning();
    return lc.id;
  };
  const assign = (laborCategoryId: string) => assignUserToLaborCategory({ userId: employeeId, laborCategoryId, effectiveDate: '2026-11-01' as CalendarDate });

  beforeEach(async () => {
    await cleanupTestData();
    session.adminId = (await createTestUser({ role: 'admin' })).id;
    employeeId = (await createTestUser({ role: 'employee' })).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('an inactive category, a category on an inactive CLIN, or on an inactive contract → refused, nothing written', async () => {
    const inactive = /can't be assigned because it, its CLIN or its contract is inactive/;
    await expectFailure(assign(await lcatOn({ lcat: 'inactive' })), 'validation', inactive);
    await expectFailure(assign(await lcatOn({ clin: 'inactive' })), 'validation', inactive);
    await expectFailure(assign(await lcatOn({ contract: 'inactive' })), 'validation', inactive);
    expect(await db().select().from(schema.userLaborCategories).where(eq(schema.userLaborCategories.userId, employeeId))).toEqual([]);
  });

  it('a non-UUID id → validation error; an unknown id → "no longer exists"', async () => {
    await expectFailure(assign('not-a-uuid'), 'validation', /Labor category is not a valid identifier/);
    await expectFailure(assign('9f2c4c8e-0000-4000-8000-000000000000'), 'validation', /That labor category no longer exists/);
  });

  it('an assignable category still assigns', async () => {
    const id = await lcatOn({});
    const row = await expectOk(assign(id));
    expect(row).toMatchObject({ userId: employeeId, laborCategoryId: id });
  });
});
