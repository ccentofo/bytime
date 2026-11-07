import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-ux-people-codes.md §5.1 — US-3 adminResetMfa, US-4 updateUser logs, US-5 createUserWithPassword,
 * US-6 adminResetPassword and bulkImportEmployees logs, against Postgres.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // requireAdminFresh/requireApproverFresh (R2-8) re-read the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant', plan: 'enterprise' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
  // Seat checks (createUser*, reactivation) read the tenant's plan.
  getTenantOrThrow: async () => ({
    id: 'test-tenant-id',
    slug: tenantState.requestSlug,
    name: 'Test Tenant',
    status: 'active',
    plan: tenantState.plan,
    dbUrl: 'unused-in-this-test',
  }),
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
}));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

import { updateUser, createUserWithPassword } from '@/server/actions/users';
import { adminResetMfa } from '@/server/actions/mfa';
import { adminResetPassword } from '@/server/actions/password';
import { bulkImportEmployees } from '@/server/actions/import';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}
const logsFor = async (entityId: string) => (await getTestDb().select().from(schema.adminChangeLog)
  .where(and(eq(schema.adminChangeLog.entity, 'user'), eq(schema.adminChangeLog.entityId, entityId))));
const attemptsFor = async (email: string) => getTestDb().select().from(schema.loginAttempts).where(eq(schema.loginAttempts.email, email.toLowerCase()));

describe('Users server (UX-4c §5.1)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', passwordHash: await bcrypt.hash('AdminPass123!', 4) });
    actingAs(admin);
  });
  afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

  it('US-3: wrong admin password refused and recorded; success clears 3 fields, turns off, bumps the session, logs once; already off → no log; self refused without an attempt', async () => {
    const db = getTestDb();
    const target = await createTestUser({ totpEnabled: true, totpSecret: 'enc-secret', totpRecoveryCodes: 'enc-codes', totpLastUsedStep: 42, sessionVersion: 3 });
    await expectFailure(adminResetMfa({ userId: target.id, currentPassword: 'wrong' }), 'validation', /^That password isn't right\.$/);
    expect((await attemptsFor(admin.email)).filter((a) => !a.successful)).toHaveLength(1);
    expect(await expectOk(adminResetMfa({ userId: target.id, currentPassword: 'AdminPass123!' }))).toEqual({ changed: true });
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect([after.totpEnabled, after.totpSecret, after.totpRecoveryCodes, after.totpLastUsedStep, after.sessionVersion]).toEqual([false, null, null, null, 4]);
    expect((await logsFor(target.id)).map((l) => l.action)).toEqual(['mfa_reset']);
    expect(await expectOk(adminResetMfa({ userId: target.id, currentPassword: 'AdminPass123!' }))).toEqual({ changed: false });
    expect(await logsFor(target.id)).toHaveLength(1);
    const before = (await attemptsFor(admin.email)).length;
    await expectFailure(adminResetMfa({ userId: admin.id, currentPassword: 'wrong' }), 'validation', /^Use your profile to turn off two-step sign-in\.$/);
    expect(await attemptsFor(admin.email)).toHaveLength(before);
  });

  it('US-4: only changed fields are logged (promotion to admin and FLSA included); a promotion to supervisor lists their active CLIN ids; name-only → no log', async () => {
    const db = getTestDb();
    const pat = await createTestUser({ role: 'employee', flsaExempt: false });
    const clin = await createTestClin((await createTestContract()).id);
    const off = await createTestClin((await createTestContract()).id);
    await db.insert(schema.userAssignments).values([{ userId: pat.id, clinId: clin.id, isActive: true }, { userId: pat.id, clinId: off.id, isActive: false }]);
    await expectOk(updateUser(pat.id, { fullName: 'Pat Renamed' }));
    expect(await logsFor(pat.id)).toHaveLength(0);
    await expectOk(updateUser(pat.id, { role: 'supervisor' }));
    await expectOk(updateUser(pat.id, { role: 'admin' }));
    await expectOk(updateUser(pat.id, { flsaExempt: true }));
    await expectOk(updateUser(pat.id, { flsaExempt: true }));                                // unchanged → no log
    const logs = (await logsFor(pat.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(logs.map((l) => [l.action, l.oldValue, l.newValue])).toEqual([
      ['role_changed', { role: 'employee' }, { role: 'supervisor', clinIds: [clin.id] }],
      ['role_changed', { role: 'supervisor' }, { role: 'admin' }],
      ['flsa_changed', { flsaExempt: false }, { flsaExempt: true }],
    ]);
  });

  it('US-5: missing flsaExempt, a short password, an approver for an employee → refused; logs created', async () => {
    const base = { email: `n-${Date.now()}@bytime.dev`, fullName: 'New Person', role: 'employee' as const, password: 'LongEnough123', flsaExempt: true };
    await expectFailure(createUserWithPassword({ ...base, flsaExempt: undefined as never }), 'validation', /^Choose an overtime status\.$/);
    await expectFailure(createUserWithPassword({ ...base, password: 'short' }), 'validation', /at least 8 characters/);
    await expectFailure(createUserWithPassword({ ...base, approverId: admin.id }), 'validation', /supervisors and admins only/);
    const made = await expectOk(createUserWithPassword(base));
    expect(made.flsaExempt).toBe(true);
    expect((await logsFor(made.id)).map((l) => [l.action, l.newValue])).toEqual([['created', { role: 'employee', flsaExempt: true }]]);
  });

  it('US-6: adminResetPassword bumps the session in SQL and logs; bulkImportEmployees logs created per user', async () => {
    const db = getTestDb();
    const target = await createTestUser({ sessionVersion: 7 });
    await expectOk(adminResetPassword({ targetUserId: target.id, newPassword: 'BrandNew123' }));
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(after.sessionVersion).toBe(8);
    expect((await logsFor(target.id)).map((l) => l.action)).toEqual(['password_reset']);
    const r = await expectOk(bulkImportEmployees([
      { email: `i1-${Date.now()}@bytime.dev`, name: 'Imp One', role: 'employee', flsaExempt: 'yes' },
      { email: `i2-${Date.now()}@bytime.dev`, name: 'Imp Two', role: 'supervisor' },
    ] as never));
    expect(r.created).toBe(2);
    const created = await db.select().from(schema.adminChangeLog).where(and(eq(schema.adminChangeLog.entity, 'user'), eq(schema.adminChangeLog.action, 'created')));
    expect(created.map((l) => l.newValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { role: 'employee', flsaExempt: true }, { role: 'supervisor', flsaExempt: false },
    ]);
  });
});
