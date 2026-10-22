import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  getTestDb,
  createTestUser,
  cleanupTestData,
  expectOk,
  expectFailure,
} from './helpers';

// ---------------------------------------------------------------------------
// R2-11: bulkImportEmployees previously had no seat-limit check at all — only
// the single-user creation paths (createUser/createUserWithPassword) checked
// the plan's seat limit. A batch must be rejected ATOMICALLY (creates nothing)
// if it would push the tenant over its plan's limit.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({
    id: 'test-tenant-id',
    slug: 'test-tenant',
    name: 'Test Tenant',
    status: 'active',
    plan: 'trial', // seatLimit: 10 (src/lib/billing/plans.ts)
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
            tenantSlug: 'test-tenant',
          },
        }
      : null,
}));

import { bulkImportEmployees, type EmployeeImportRow } from '@/server/actions/import';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

function makeRows(count: number, prefix: string): EmployeeImportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix} ${i}`,
    email: `${prefix}-${i}@bytime.dev`,
    role: 'employee',
    flsaExempt: 'no',
  }));
}

describe('Bulk import respects the plan seat limit atomically (R2-11)', () => {
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('rejects a batch that would exceed the trial plan\'s 10-seat limit, creating nothing', async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    actingAs(admin);
    // 1 admin already active; a batch of 10 more would make 11 > the trial's 10-seat limit.
    const rows = makeRows(10, 'overflow');

    await expectFailure(bulkImportEmployees(rows), 'validation', /plan allows 10 active users/i);

    const db = getTestDb();
    const created = await db.select().from(schema.users).where(eq(schema.users.fullName, 'overflow 0'));
    expect(created).toHaveLength(0);
  });

  it('allows a batch that fits within the seat limit', async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    actingAs(admin);
    const rows = makeRows(5, 'fits'); // 1 admin + 5 new = 6, within the 10-seat trial limit

    const result = await expectOk(bulkImportEmployees(rows));
    expect(result.created).toBe(5);
    expect(result.errors).toHaveLength(0);
  });

  it('does not double-count rows that match an existing user (skipped, not new)', async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    const existing = await createTestUser({ role: 'employee', email: 'already-here@bytime.dev' });
    actingAs(admin);

    const rows: EmployeeImportRow[] = [
      { name: 'Already Here', email: existing.email, role: 'employee', flsaExempt: 'no' },
      ...makeRows(3, 'brandnew'),
    ];

    const result = await expectOk(bulkImportEmployees(rows));
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(3);
  });
});
