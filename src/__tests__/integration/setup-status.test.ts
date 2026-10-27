import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.7 / T14 (UX-AUDIT B1): Setup is complete only when an active employee has an
 * active assignment to a CHARGEABLE code (what makes a direct timesheet row appear) — not when a CLIN assignment
 * (user_assignments, approval scope) exists.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000b1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { getSetupStatusInternal } from '@/server/internal/setup';

describe('Setup status (B1)', () => {
  const db = () => getTestDb();
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clin: Awaited<ReturnType<typeof createTestClin>>;
  beforeEach(async () => {
    await cleanupTestData();
    await createTestUser({ role: 'admin' });
    emp = await createTestUser({ role: 'employee' });
    clin = await createTestClin((await createTestContract()).id);
  });
  afterEach(async () => { await cleanupTestData(); });

  const grant = async (userId: string, chargeCodeId: string) => db().insert(schema.userChargeCodes).values({ userId, chargeCodeId, isActive: true });

  it('B1 repro: contract + CLIN + employee + a CLIN assignment, no charge-code access → incomplete', async () => {
    await db().insert(schema.userAssignments).values({ userId: emp.id, clinId: clin.id, isActive: true });
    const st = await getSetupStatusInternal();
    expect(st).toMatchObject({ contracts: 1, clins: 1, chargeCodes: 0, employees: 1, employeesWithAccess: 0, isComplete: false });
    expect(st.steps.find((s) => s.key === 'chargeCodeAccess')).toEqual({ key: 'chargeCodeAccess', done: false, required: true });
  });

  it('one active employee with an active chargeable code → complete; steps and done/total', async () => {
    const code = await createTestChargeCode(clin.id);
    await grant(emp.id, code.id);
    const st = await getSetupStatusInternal();
    expect(st).toMatchObject({ chargeCodes: 1, employeesWithAccess: 1, isComplete: true, total: 7 });
    expect(st.steps.map((s) => s.key)).toEqual(['indirectCodes', 'contracts', 'clins', 'chargeCodes', 'laborCategories', 'employees', 'chargeCodeAccess']);
    expect(st.done).toBe(st.steps.filter((s) => s.done).length);
  });

  it('inactive employee, inactive assignment, inactive code, or an inactive SLIN on the only code → incomplete', async () => {
    const code = await createTestChargeCode(clin.id);
    await grant(emp.id, code.id);
    expect((await getSetupStatusInternal()).isComplete).toBe(true);

    await db().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, emp.id));
    expect(await getSetupStatusInternal()).toMatchObject({ employees: 0, employeesWithAccess: 0, isComplete: false });
    await db().update(schema.users).set({ isActive: true }).where(eq(schema.users.id, emp.id));

    await db().update(schema.userChargeCodes).set({ isActive: false }).where(eq(schema.userChargeCodes.userId, emp.id));
    expect((await getSetupStatusInternal()).isComplete).toBe(false);
    await db().update(schema.userChargeCodes).set({ isActive: true }).where(eq(schema.userChargeCodes.userId, emp.id));

    await db().update(schema.chargeCodes).set({ isActive: false }).where(eq(schema.chargeCodes.id, code.id));
    expect(await getSetupStatusInternal()).toMatchObject({ chargeCodes: 0, isComplete: false });
    await db().update(schema.chargeCodes).set({ isActive: true }).where(eq(schema.chargeCodes.id, code.id));

    const [slin] = await db().insert(schema.slins).values({ clinId: clin.id, slinNumber: 'S1', status: 'inactive' }).returning();
    await db().update(schema.chargeCodes).set({ slinId: slin.id }).where(eq(schema.chargeCodes.id, code.id));
    expect(await getSetupStatusInternal()).toMatchObject({ chargeCodes: 0, employeesWithAccess: 0, isComplete: false });
    await db().update(schema.slins).set({ status: 'active' }).where(eq(schema.slins.id, slin.id));
    expect((await getSetupStatusInternal()).isComplete).toBe(true);
  });

  it('distinct counting: two codes for one employee count once; admins with access and inactive parents do not count', async () => {
    const a = await createTestChargeCode(clin.id);
    const b = await createTestChargeCode(clin.id);
    await grant(emp.id, a.id);
    await grant(emp.id, b.id);
    const admin2 = await createTestUser({ role: 'admin' });
    await grant(admin2.id, a.id);
    const emp2 = await createTestUser({ role: 'employee' });
    const otherClin = await createTestClin((await createTestContract({ status: 'inactive' })).id);
    await grant(emp2.id, (await createTestChargeCode(otherClin.id)).id);
    expect(await getSetupStatusInternal()).toMatchObject({ employees: 2, employeesWithAccess: 1, chargeCodes: 2, contracts: 1, clins: 2 });
  });
});
