import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

// ---------------------------------------------------------------------------
// R2-3: never send secrets to the browser. getUsers() previously did a bare
// db.select().from(users) and returned full rows (passwordHash, totpSecret,
// totpRecoveryCodes, sessionVersion) straight to the Users page's client props;
// updateUser/createUser*'s .returning() did the same.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // requireAdminFresh/requireApproverFresh (R2-8) re-read the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant', plan: 'trial' }));

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

import { getUsers, updateUser, createUserWithPassword } from '@/server/actions/users';

const FORBIDDEN_KEYS = ['passwordHash', 'totpSecret', 'totpRecoveryCodes', 'sessionVersion'];

function assertNoSecretKeys(obj: Record<string, unknown> | undefined) {
  expect(obj).toBeDefined();
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(obj, key)).toBe(false);
  }
}

describe('No secrets sent to the browser (R2-3)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    sessionState.user = { id: admin.id, role: admin.role, email: admin.email, fullName: admin.fullName };
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('getUsers() rows have no secret columns', async () => {
    const employee = await createTestUser({ role: 'employee', totpEnabled: true, totpSecret: 'should-never-leak' });
    const rows = await getUsers();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      assertNoSecretKeys(row as any);
    }
    void employee;
  });

  it('updateUser() result has no secret columns', async () => {
    const employee = await createTestUser({ role: 'employee' });
    const result = await updateUser(employee.id, { fullName: 'Updated Name' });
    assertNoSecretKeys(result as any);
  });

  it('createUserWithPassword() result has no secret columns', async () => {
    const result = await createUserWithPassword({
      email: `new-${Date.now()}@bytime.dev`,
      fullName: 'New Hire',
      role: 'employee',
      password: 'SomeStrongPass123!',
    });
    assertNoSecretKeys(result as any);
  });
});
