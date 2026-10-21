import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  assignUserToClin,
  cleanupTestData,
} from './helpers';

// ---------------------------------------------------------------------------
// R2-5: getEmployeeSummaryReport must OMIT the totalCost key entirely for
// supervisors (not return it as 0) — dollar data is admin-only.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
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

import { getEmployeeSummaryReport } from '@/server/actions/reports';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('getEmployeeSummaryReport cost visibility (R2-5)', () => {
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let supervisor: Awaited<ReturnType<typeof createTestUser>>;
  let admin: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestData();
    const db = getTestDb();

    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);

    employee = await createTestUser({ role: 'employee' });
    supervisor = await createTestUser({ role: 'supervisor' });
    admin = await createTestUser({ role: 'admin' });

    await assignUserToClin(employee.id, clin.id);
    await assignUserToClin(supervisor.id, clin.id);

    await db.insert(schema.timesheetEntries).values({
      userId: employee.id,
      clinId: clin.id,
      entryDate: '2026-01-01',
      hours: '8',
      revisionNumber: 1,
      createdBy: employee.id,
    });
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('omits totalCost for a supervisor (not present, not zero)', async () => {
    actingAs(supervisor);
    const rows = await getEmployeeSummaryReport('2000-01-01' as CalendarDate, '2100-01-01' as CalendarDate);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'totalCost')).toBe(false);
    }
  });

  it('includes totalCost for an admin', async () => {
    actingAs(admin);
    const rows = await getEmployeeSummaryReport('2000-01-01' as CalendarDate, '2100-01-01' as CalendarDate);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'totalCost')).toBe(true);
    }
  });
});
