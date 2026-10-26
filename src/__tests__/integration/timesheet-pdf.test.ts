import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData,
} from './helpers';

/**
 * feature-plan-certified-outputs.md C5 / §9 row "PDF" (indirect/leave rows; two codes on one CLIN the same day both
 * present; total = sum; stable reprint) and "Display" (imported rows labelled on the PDF): getTimesheetReportData
 * against real Postgres.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c5', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    if (!session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return session.user;
  };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireAdmin: async () => current() };
});

import { getTimesheetReportData } from '@/server/actions/reports';

describe('timesheet PDF data (certified-outputs C5)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let start: CalendarDate;
  const db = () => getTestDb();
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, entryDate: start, hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Pat Doe' });
    const current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
    start = getPeriodStartForDate(addDays(current, -1), DEFAULT_PERIOD_CONFIG);
    session.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('rows from latest-revision entries: two codes on one CLIN the same day, leave, a deactivated assignment, a legacy CLIN; total = sum; imported labelled; reprint identical', async () => {
    const contract = await createTestContract({ name: 'NAVAIR' });
    const clin = await createTestClin(contract.id);
    const a = await createTestChargeCode(clin.id, { code: 'NAV-A' });
    const b = await createTestChargeCode(clin.id, { code: 'NAV-B' });
    // No active CLIN assignment at all — the old PDF built rows from these and printed nothing.
    await db().insert(schema.userAssignments).values({ userId: emp.id, clinId: clin.id, isActive: false });
    const leave = await createTestIndirectCode({ code: 'LV-PTO', category: 'leave' });
    const [batch] = await db().insert(schema.importBatches).values({ kind: 'entries', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();

    await entry({ chargeCodeId: a.id, clinId: clin.id, hours: '3' });
    await entry({ chargeCodeId: a.id, clinId: clin.id, hours: '4', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'fix' }); // latest wins
    await entry({ chargeCodeId: b.id, clinId: clin.id, hours: '5' });
    await entry({ indirectCodeId: leave.id, entryDate: addDays(start, 1), hours: '8' });
    await entry({ clinId: clin.id, entryDate: addDays(start, 2), hours: '0.1', source: 'migration', importBatchId: batch.id, originalMetadata: { enteredBy: 'Pat (Deltek)' } });
    await entry({ chargeCodeId: b.id, clinId: clin.id, entryDate: addDays(start, 3), hours: '0.2' });

    const data = (await getTimesheetReportData(emp.id, start))!;
    expect(data.rows.map((r) => [r.kind, r.code, r.totalHours])).toEqual([
      ['charge', 'NAV-A', 4], ['charge', 'NAV-B', 5.2], ['clin', `CLIN ${clin.clinNumber}`, 0.1], ['indirect', 'LV-PTO', 8],
    ]);
    expect(data.rows[0].dailyHours[0] + data.rows[1].dailyHours[0]).toBe(9);
    expect(data.rows[3]).toMatchObject({ category: 'Leave' });
    expect(data.grandTotal).toBe(17.3);
    expect(data.dailyTotals.reduce((s, h) => s + h, 0)).toBeCloseTo(17.3, 10);
    expect(data.rows[2].provenance).toEqual([expect.stringMatching(/^Imported from Deltek on \d{4}-\d{2}-\d{2} by Ann Admin — originally entered by Pat \(Deltek\)$/)]);

    expect(await getTimesheetReportData(emp.id, start)).toEqual(data);
  });

  it('approved period: the approval line comes from the one helper and is identical on reprint', async () => {
    await db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: start, status: 'approved', submittedAt: new Date('2026-01-10T15:00:00Z'), reviewedBy: admin.id, reviewedAt: new Date('2026-01-11T15:00:00Z') });
    const first = (await getTimesheetReportData(emp.id, start))!;
    expect(first.approvalLine).toMatch(/Ann Admin/);
    expect(first.approvedBy).toBe('Ann Admin');
    expect(await getTimesheetReportData(emp.id, start)).toEqual(first);
  });
});
