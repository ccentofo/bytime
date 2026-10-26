import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestIndirectCode, cleanupTestData, expectOk } from './helpers';

/**
 * feature-plan-certified-outputs.md C7 / §9 rows "FLSA", "Leave columns", "Leave pre-set", "Gusto / exempt",
 * "Change log" (workweek change) and §10 "payroll export for a semi-monthly period with a boundary workweek matches a
 * hand calculation" — real Postgres through the real actions and the sync engine.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c7', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireAdmin: async () => current(), requireAdminFresh: async () => current() };
});

import { generatePayrollExportCSV, getPayrollExportPreview } from '@/server/actions/payroll-export';
import { updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import { seedIndirectCodes } from '@/server/actions/indirect-codes';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';

const d = (s: string) => s as CalendarDate;
// March 2026: Sun 1, Mon 2 … Sun 8, Mon 9 … Sun 15, Mon 16. Semi-monthly periods 1–15 and 16–31.

describe('payroll export — FLSA weekly overtime (certified-outputs C7)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let clinId: string;
  const db = () => getTestDb();
  const work = (date: string, hours: string, userId = emp.id) =>
    db().insert(schema.timesheetEntries).values({ userId, clinId, entryDate: date, hours, revisionNumber: 1, createdBy: userId });
  const leave = (codeId: string, date: string, hours: string, userId = emp.id) =>
    db().insert(schema.timesheetEntries).values({ userId, indirectCodeId: codeId, entryDate: date, hours, revisionNumber: 1, createdBy: userId });
  const period = (start: string, days: number, status: 'draft' | 'submitted' | 'approved', userId = emp.id) =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart: start, periodNumDays: days, periodType: 'semimonthly', status });
  const preview = async (start: string, end: string) => {
    const r = await expectOk(getPayrollExportPreview({ periodStart: d(start), periodEnd: d(end) }));
    if (r.status !== 'ready') throw new Error(`refused: ${r.message}`);
    return r;
  };

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Pat Doe' });
    clinId = (await createTestClin((await createTestContract()).id)).id;
    session.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('refused without the workweek setting; setting it is logged; then the export runs', async () => {
    expect(await expectOk(getPayrollExportPreview({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15') })))
      .toMatchObject({ status: 'refused', reason: 'workweek-unset' });
    await expectOk(updateWorkweekStartDay(1));
    const log = await db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.action, 'workweek_start_day_changed'));
    expect(log).toEqual([expect.objectContaining({ actorId: admin.id, oldValue: { workweekStartDay: null }, newValue: { workweekStartDay: 1 } })]);
    expect((await expectOk(getPayrollExportPreview({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15') }))).status).toBe('ready');
  });

  it('§10 hand calculation: semi-monthly exports 1–15 and 16–31 with a workweek (Thu–Wed) crossing the boundary', async () => {
    await expectOk(updateWorkweekStartDay(4)); // Thursday: week Thu 12 – Wed 18 crosses the 15th/16th
    await period('2026-03-01', 15, 'approved');
    await period('2026-03-16', 16, 'approved');
    // Week Thu 12 – Wed 18: Thu 10, Fri 10 | Mon 8, Tue 8, Wed 8 = 44 h → Wed 18: 4 regular + 4 OT.
    await work('2026-03-12', '10');
    await work('2026-03-13', '10');
    for (const day of ['16', '17', '18']) await work(`2026-03-${day}`, '8');
    // Week Thu 19 – Wed 25: 9 h × 5 = 45 h → Wed 25: 4 regular + 5 OT.
    for (const day of ['19', '20', '23', '24', '25']) await work(`2026-03-${day}`, '9');

    // Hand: export 1–15 → 20 regular, 0 OT. Export 16–31 → 8 + 8 + 4 + 40 = 60 regular, 4 + 5 = 9 OT.
    expect((await preview('2026-03-01', '2026-03-15')).employees[0]).toMatchObject({ regularHours: 20, overtimeHours: 0, otBasisIncludesUnapprovedDays: false });
    expect((await preview('2026-03-16', '2026-03-31')).employees[0]).toMatchObject({ regularHours: 60, overtimeHours: 9, otBasisIncludesUnapprovedDays: false });
    // Together: 80 regular + 9 OT = the 89 h worked — the boundary week's earlier days counted once, never twice.

    // An arbitrary range starting mid-period (10–20) includes the in-range days of the period that started on the 1st.
    expect((await preview('2026-03-10', '2026-03-20')).employees[0]).toMatchObject({ regularHours: 58, overtimeHours: 4 });

    const daily = (await expectOk(generatePayrollExportCSV({ periodStart: d('2026-03-16'), periodEnd: d('2026-03-31'), format: 'daily-hours' }))).csvContent.split('\n');
    expect(daily.find((l) => l.includes(',2026-03-18,'))).toMatch(/,2026-03-18,8\.00,4\.00,4\.00,0\.00,0\.00,0\.00,0\.00,0\.00,2026-03-12$/);
  });

  it('unapproved preceding days in the boundary week are counted and flag the employee', async () => {
    await period('2026-03-01', 15, 'submitted');
    await period('2026-03-16', 16, 'approved');
    // Thursday start: week Thu 12 – Wed 18 crosses the period boundary. Thu 12 – Sun 15 (unapproved) 36 h, Mon 16
    // (approved) 8 h → 4 regular + 4 OT, and the OT relied on unapproved days → flagged.
    await expectOk(updateWorkweekStartDay(4));
    for (const day of ['12', '13', '14', '15']) await work(`2026-03-${day}`, '9');
    await work('2026-03-16', '8');
    const r = await preview('2026-03-16', '2026-03-31');
    expect(r.employees[0]).toMatchObject({ regularHours: 4, overtimeHours: 4, otBasisIncludesUnapprovedDays: true });
  });

  it('40.00 h exactly → 0 OT; exempt → 0 OT + uncompensated; leave excluded and in its own columns; LWOP never paid', async () => {
    await expectOk(updateWorkweekStartDay(1));
    const exempt = await createTestUser({ role: 'employee', fullName: 'Ex Empt', flsaExempt: true });
    const hol = await createTestIndirectCode({ code: 'LV-HOL-T', category: 'leave', leavePayType: 'holiday' });
    const lwop = await createTestIndirectCode({ code: 'LV-LWOP-T', category: 'leave', leavePayType: 'unpaid' });
    for (const u of [emp.id, exempt.id]) await period('2026-03-01', 15, 'approved', u);
    for (const [day, h] of [['02', '13.33'], ['03', '13.33'], ['04', '13.34']]) await work(`2026-03-${day}`, h);
    await leave(hol.id, '2026-03-06', '8');
    await leave(lwop.id, '2026-03-05', '4');
    for (const day of ['02', '03', '04', '05', '06']) await work(`2026-03-${day}`, '9', exempt.id);

    const r = await preview('2026-03-01', '2026-03-15');
    expect(r.employees.find((e) => e.employeeName === 'Pat Doe')).toMatchObject({ regularHours: 40, overtimeHours: 0, holidayHours: 8, unpaidLeaveHours: 4, totalPaidHours: 48, totalRecordedHours: 52 });
    expect(r.employees.find((e) => e.employeeName === 'Ex Empt')).toMatchObject({ regularHours: 40, overtimeHours: 0, uncompensatedOvertimeHours: 5 });

    const adp = (await expectOk(generatePayrollExportCSV({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15'), format: 'adp' }))).csvContent.split('\n');
    const header = adp[0].split(',');
    const pat = adp.find((l) => l.includes('Pat'))!.split(',');
    expect(pat[header.indexOf('Holiday Hours')]).toBe('8.00');
    expect(pat[header.indexOf('Total Hours')]).toBe('48.00');
    expect(adp[0]).not.toMatch(/Uncompensated|Unpaid/);
    const custom = (await expectOk(generatePayrollExportCSV({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15'), format: 'custom' }))).csvContent;
    expect(custom).toMatch(/Ex Empt,.*,5\.00,/);
  });

  it('T4: only the LATEST revision counts — rev 1 = 10 h, rev 2 = 8 h → 8 h; a correction to 0 h omits the day', async () => {
    await expectOk(updateWorkweekStartDay(1));
    await period('2026-03-01', 15, 'approved');
    await work('2026-03-02', '10');
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, clinId, entryDate: '2026-03-02', hours: '8', revisionNumber: 2, createdBy: emp.id, changeReasonCode: 'CORRECTION', comment: 'x' });
    await work('2026-03-03', '6');
    await db().insert(schema.timesheetEntries).values({ userId: emp.id, clinId, entryDate: '2026-03-03', hours: '0', revisionNumber: 2, createdBy: emp.id, changeReasonCode: 'CORRECTION', comment: 'x' });
    expect((await preview('2026-03-01', '2026-03-15')).employees[0]).toMatchObject({ regularHours: 8, overtimeHours: 0, totalPaidHours: 8 });
    const daily = (await expectOk(generatePayrollExportCSV({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15'), format: 'daily-hours' }))).csvContent.split('\n');
    expect(daily.slice(1).map((l) => l.split(',')[2])).toEqual(['2026-03-02']);
  });

  it('a leave code without a pay type in the range refuses the export (codes listed); a new workspace\'s built-in codes never do', async () => {
    await expectOk(updateWorkweekStartDay(1));
    await period('2026-03-01', 15, 'approved');
    await expectOk(seedIndirectCodes());
    const [al] = await db().select().from(schema.indirectChargeCodes).where(eq(schema.indirectChargeCodes.code, 'LV-AL'));
    expect(al.leavePayType).toBe('pto');
    await leave(al.id, '2026-03-02', '8');
    expect((await preview('2026-03-01', '2026-03-15')).employees[0]).toMatchObject({ ptoHours: 8 });

    const custom = await createTestIndirectCode({ code: 'LV-JURY', category: 'leave', leavePayType: null });
    await leave(custom.id, '2026-03-03', '8');
    expect(await expectOk(getPayrollExportPreview({ periodStart: d('2026-03-01'), periodEnd: d('2026-03-15') })))
      .toMatchObject({ status: 'refused', reason: 'leave-pay-type', codes: ['LV-JURY'] });
  });

  it('Gusto: refuses before creating a sync log without the workweek; records the FLSA payload when set', async () => {
    const [conn] = await db().insert(schema.integrationConnections).values({ provider: 'gusto', displayName: 'Gusto — Test', isActive: true, externalCompanyId: 'co', connectedBy: admin.id }).returning();
    await expect(executeSyncOperation(conn.id, 'timesheet_push', d('2026-03-01'), d('2026-03-15'), admin.id)).rejects.toThrow(/workweek start day/);
    expect(await db().select().from(schema.integrationSyncLogs)).toEqual([]);

    await expectOk(updateWorkweekStartDay(1));
    await period('2026-03-01', 15, 'approved');
    for (const day of ['02', '03', '04', '05', '06']) await work(`2026-03-${day}`, '9');
    await db().insert(schema.integrationEntityMappings).values({ connectionId: conn.id, entityType: 'employee', bytimeEntityId: emp.id, externalEntityId: 'g-1' });
    const { result } = await executeSyncOperation(conn.id, 'timesheet_push', d('2026-03-01'), d('2026-03-15'), admin.id);
    expect(result).toMatchObject({ pushed: 1, failed: 0 });
    const [rec] = await db().select().from(schema.integrationSyncRecords);
    expect(JSON.parse(rec.requestPayload!)).toMatchObject({ method: 'FLSA weekly overtime', regularHours: 40, overtimeHours: 5, uncompensatedOvertimeHours: 0, flagged: false });
  });
});
