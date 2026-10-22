import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  cleanupTestData,
  expectFailure,
  expectOk,
} from './helpers';

// ---------------------------------------------------------------------------
// Fixes from the calendar-dates audit: cell identity on save, the public approved-timesheets
// API, readers of stored periods that don't match today's schedule, imported periods, the
// unique-violation mapping, and workspace timezone validation.
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
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } }
      : null,
}));

import { saveTimesheetBatch, getTimesheetForReview } from '@/server/actions/timesheet';
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';
import { importMigrationPeriods } from '@/server/actions/migration';
import { updateWorkspaceTimezone } from '@/server/actions/workspace-settings';
import { GET as getApprovedTimesheets } from '@/app/api/v1/timesheets/approved/route';
import { isUniqueViolation } from '@/lib/db-errors';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

async function seedApiKey(createdBy: string): Promise<string> {
  const rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
  await getTestDb().insert(schema.apiKeys).values({
    name: 'Test key',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.substring(0, 8),
    createdByUserId: createdBy,
    permissions: 'read',
    isActive: true,
  });
  return rawKey;
}

describe('calendar-dates audit fixes', () => {
  let employee: Awaited<ReturnType<typeof createTestUser>>;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let clinId: string;
  let chargeCodeId: string;

  beforeEach(async () => {
    await cleanupTestData();
    employee = await createTestUser({ role: 'employee' });
    admin = await createTestUser({ role: 'admin' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    clinId = clin.id;
    const code = await createTestChargeCode(clin.id);
    chargeCodeId = code.id;
    await getTestDb().insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId, isActive: true });
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  describe('saveTimesheetBatch cell identity (booking to an unassigned contract)', () => {
    const periodStart = '2020-01-01' as CalendarDate; // a past semimonthly period: any day is a late entry

    it('rejects a cell naming both an indirect code and a charge code', async () => {
      const db = getTestDb();
      const [indirect] = await db.insert(schema.indirectChargeCodes).values({ code: 'OH', name: 'Overhead', category: 'overhead' }).returning();
      const otherContract = await createTestContract();
      const otherClin = await createTestClin(otherContract.id);
      const unassignedCode = await createTestChargeCode(otherClin.id);
      actingAs(employee);

      await expectFailure(saveTimesheetBatch({
        periodStart,
        changeReasonCode: 'LATE_ENTRY',
        cells: [{ indirectCodeId: indirect.id, chargeCodeId: unassignedCode.id, clinId: otherClin.id, dayIndex: 1, hours: 8, isEdit: false, isLateEntry: true }],
      }), 'validation', /exactly one charge code, CLIN, or indirect code/);

      const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, employee.id));
      expect(rows).toHaveLength(0);
    });

    it('rejects an inactive indirect code, and a SLIN without a CLIN', async () => {
      const db = getTestDb();
      const [inactive] = await db.insert(schema.indirectChargeCodes).values({ code: 'OLD', name: 'Retired', category: 'overhead', isActive: false }).returning();
      actingAs(employee);

      await expectFailure(saveTimesheetBatch({
        periodStart, changeReasonCode: 'LATE_ENTRY',
        cells: [{ indirectCodeId: inactive.id, dayIndex: 1, hours: 8, isEdit: false, isLateEntry: true }],
      }), 'validation', /is not available/);

      await expectFailure(saveTimesheetBatch({
        periodStart, changeReasonCode: 'LATE_ENTRY',
        cells: [{ chargeCodeId, slinId: crypto.randomUUID(), dayIndex: 1, hours: 8, isEdit: false, isLateEntry: true }],
      }), 'validation', /SLIN can only be given with a legacy CLIN/);
    });
  });

  it('a duplicate revision insert is recognized as a unique violation through Drizzle\'s wrapper', async () => {
    const db = getTestDb();
    const row = { userId: employee.id, chargeCodeId, clinId, entryDate: '2020-01-02', hours: '8', revisionNumber: 1, createdBy: employee.id };
    await db.insert(schema.timesheetEntries).values(row);
    const error = await db.insert(schema.timesheetEntries).values(row).then(() => null, (e: unknown) => e);
    expect(isUniqueViolation(error, 'entries_user_code_date_rev_unique_idx')).toBe(true);
    expect(isUniqueViolation(new Error('unique-looking message'))).toBe(false);
  });

  it('GET /api/v1/timesheets/approved returns 200 for an API key (no session) and counts every charge code', async () => {
    const db = getTestDb();
    const rawKey = await seedApiKey(admin.id);
    const secondCode = await createTestChargeCode(clinId);
    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id, periodStart: '2026-01-01', status: 'approved', reviewedAt: new Date(), periodNumDays: 15,
    });
    // Two charge codes under the SAME CLIN on the same day; only the first was edited (rev 2).
    await db.insert(schema.timesheetEntries).values([
      { userId: employee.id, chargeCodeId, clinId, entryDate: '2026-01-05', hours: '4', revisionNumber: 1, createdBy: employee.id },
      { userId: employee.id, chargeCodeId, clinId, entryDate: '2026-01-05', hours: '5', revisionNumber: 2, createdBy: employee.id },
      { userId: employee.id, chargeCodeId: secondCode.id, clinId, entryDate: '2026-01-05', hours: '3', revisionNumber: 1, createdBy: employee.id },
      // Next period's day: outside this period's window.
      { userId: employee.id, chargeCodeId, clinId, entryDate: '2026-01-20', hours: '7', revisionNumber: 1, createdBy: employee.id },
    ]);

    const response = await getApprovedTimesheets(new Request(
      'http://localhost:3000/api/v1/timesheets/approved?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.31' } },
    ) as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    const hours = body.data[0].entries.map((e: { hours: string }) => e.hours).sort();
    expect(hours).toEqual(['3', '5']); // latest of each code; the second code's rev 1 is not dropped
  });

  it('a stored period that does not match today\'s schedule stays readable', async () => {
    const db = getTestDb();
    // Monday Jan 5 is not a semimonthly period start; no length snapshot (imported history).
    await db.insert(schema.timesheetPeriods).values({ userId: employee.id, periodStart: '2026-01-05', status: 'approved' });

    actingAs(admin);
    await expect(getTimesheetForReview(employee.id, '2026-01-05' as CalendarDate)).resolves.toBeDefined();
    actingAs(employee);
    await expect(getEmployeeDashboardData()).resolves.toBeDefined();
  });

  it('importMigrationPeriods stores the length snapshot and reports off-schedule starts clearly', async () => {
    actingAs(admin);
    const result = await expectOk(importMigrationPeriods([
      { employeeEmail: employee.email, periodStart: '2026-01-16', status: 'approved', submittedAt: '', reviewedAt: '', reviewedByEmail: '', reviewComment: '' },
      { employeeEmail: employee.email, periodStart: '2026-01-05', status: 'approved', submittedAt: '', reviewedAt: '', reviewedByEmail: '', reviewComment: '' },
    ]));
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/not a period start under this workspace's pay schedule/);
    expect(result.errors[0].message).not.toMatch(/insert|params/i);

    const [stored] = await getTestDb().select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, employee.id));
    expect(stored).toMatchObject({ periodStart: '2026-01-16', periodType: 'semimonthly', periodNumDays: 16 });
  });

  it('updateWorkspaceTimezone stores the canonical IANA name and rejects abbreviations and non-strings', async () => {
    actingAs(admin);
    expect(await expectOk(updateWorkspaceTimezone('america/new_york'))).toBe('America/New_York');
    await expectFailure(updateWorkspaceTimezone('EST'), 'validation', /Choose a timezone/);
    await expectFailure(updateWorkspaceTimezone(['UTC'] as unknown as string), 'validation', /Choose a timezone/);
    const [row] = await getTestDb().select().from(schema.workspaceSettings);
    expect(row.timezone).toBe('America/New_York');
  });
});
