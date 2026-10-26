import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData,
} from './helpers';

/**
 * feature-plan-certified-outputs.md C6 / §9 rows "Audit" (indirect entries appear; sibling codes separate histories;
 * MIGRATION label), "Display" (audit trail / revision history label imported rows), "Self-approved label" and
 * "Self-approval switch" (audit trail period events show the label and the recorded approval context) — real Postgres.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c6', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
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
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), requireApprover: async () => current(), requireAdmin: async () => current() };
});

import { getAuditEntries, getAuditPeriodEvents, getCellRevisionHistory } from '@/server/actions/audit';

const D = '2026-03-03' as CalendarDate;

describe('audit trail (certified-outputs C6)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  const db = () => getTestDb();
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, entryDate: D, hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Pat Doe' });
    session.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('indirect entries appear (with category); two charge codes on one CLIN the same day keep separate histories', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const a = await createTestChargeCode(clin.id, { code: 'SIB-A' });
    const b = await createTestChargeCode(clin.id, { code: 'SIB-B' });
    const leave = await createTestIndirectCode({ code: 'LV-PTO', category: 'leave' });
    await entry({ chargeCodeId: a.id, clinId: clin.id, hours: '3' });
    await entry({ chargeCodeId: a.id, clinId: clin.id, hours: '4', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'fix' });
    await entry({ chargeCodeId: b.id, clinId: clin.id, hours: '5' });
    await entry({ indirectCodeId: leave.id });

    const rows = (await getAuditEntries({ userId: emp.id })).entries;
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.kind === 'indirect')).toMatchObject({ codeLabel: 'LV-PTO (Leave)', contractName: null, cellCode: leave.id });

    const histA = (await getCellRevisionHistory(emp.id, a.id, D))!;
    const histB = (await getCellRevisionHistory(emp.id, b.id, D))!;
    // T7: the database stores hours as saved ("3", not "3.00") — compare numerically.
    const hrs = (h: { revisions: Array<{ hours: string }> }) => h.revisions.map((r) => Number(r.hours).toFixed(2));
    expect(hrs(histA)).toEqual(['3.00', '4.00']);
    expect(hrs(histB)).toEqual(['5.00']);
    const histL = (await getCellRevisionHistory(emp.id, leave.id, D))!;
    expect(histL).toMatchObject({ kind: 'indirect', codeLabel: 'LV-PTO (Leave)' });
    expect(hrs(histL)).toEqual(['8.00']);
  });

  it('imported and legacy-imported (MIGRATION) rows are labelled in the list and the revision history', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const legacyClin = await createTestClin(contract.id);
    const [batch] = await db().insert(schema.importBatches).values({ kind: 'entries', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();
    await entry({ clinId: clin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { enteredBy: null }, createdBy: admin.id });
    await entry({ clinId: legacyClin.id, changeReasonCode: 'MIGRATION' });

    const rows = (await getAuditEntries({ userId: emp.id })).entries;
    expect(rows.find((r) => r.cellCode === clin.id)?.provenance).toMatch(/^Imported from Deltek on \d{4}-\d{2}-\d{2} by Ann Admin — originally entered by author not recorded$/);
    expect(rows.find((r) => r.cellCode === legacyClin.id)).toMatchObject({ provenance: 'Legacy import — details not recorded', changeReasonCode: 'MIGRATION' });
    expect((await getCellRevisionHistory(emp.id, clin.id, D))!.revisions[0].provenance).toMatch(/^Imported from Deltek/);
  });

  it('period events: a self-approval shows "Self-approved" and its recorded context; imported events are labelled', async () => {
    // Self-approval was switched on by someone other than the approver (e.g. the second admin's deactivation by Bo).
    const bo = await createTestUser({ role: 'supervisor', fullName: 'Bo Boss' });
    const [own] = await db().insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2026-03-01', status: 'approved', reviewedBy: admin.id, reviewedAt: new Date('2026-03-20T14:00:00Z') }).returning();
    await db().insert(schema.periodEvents).values([
      { periodId: own.id, userId: admin.id, event: 'submitted', actorId: admin.id, createdAt: new Date('2026-03-19T14:00:00Z') },
      { periodId: own.id, userId: admin.id, event: 'approved', actorId: admin.id, createdAt: new Date('2026-03-20T14:00:00Z'),
        approvalContext: { selfApproved: true, activeAdminCount: 1, effectiveDesignee: null, selfApprovalEnabledAt: '2026-03-01T10:00:00Z', selfApprovalEnabledBy: bo.id } },
    ]);
    const [batch] = await db().insert(schema.importBatches).values({ kind: 'periods', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();
    const [imp] = await db().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: '2026-02-01', status: 'approved', periodNumDays: 15 }).returning();
    await db().insert(schema.periodEvents).values({ periodId: imp.id, userId: emp.id, event: 'approved', actorId: admin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { reviewer: 'boss@old.example', reviewedAt: '2026-02-17' } });

    const events = (await getAuditPeriodEvents({})).events;
    const self = events.find((e) => e.userId === admin.id && e.event === 'approved')!;
    expect(self).toMatchObject({ selfApproved: true, text: expect.stringMatching(/^Self-approved on Mar 20, 2026/) });
    expect(self.context).toMatch(/^1 active admin at the time; self-approval on since Mar 1, 2026.* \(switched on by Bo Boss\)$/);
    expect(events.find((e) => e.userId === admin.id && e.event === 'submitted')?.text).toMatch(/^Submitted by Ann Admin/);
    expect(events.find((e) => e.userId === emp.id)?.text).toMatch(/^Approved in Deltek by boss@old\.example on 2026-02-17 \(imported \d{4}-\d{2}-\d{2}\)$/);
    expect(((await getAuditPeriodEvents({ userId: emp.id })).events).map((e) => e.userId)).toEqual([emp.id]);
    expect((await getAuditPeriodEvents({ startDate: '2026-03-01' as CalendarDate, endDate: '2026-03-31' as CalendarDate })).events).toHaveLength(2);
    // F12: a period that STARTED before the range but overlaps it is included (the import period 2026-02-01, 15 days).
    expect((await getAuditPeriodEvents({ startDate: '2026-02-10' as CalendarDate, endDate: '2026-02-28' as CalendarDate })).events.map((e) => e.userId)).toEqual([emp.id]);
    expect((await getAuditPeriodEvents({ startDate: '2026-02-16' as CalendarDate, endDate: '2026-02-28' as CalendarDate })).events).toEqual([]);
  });
});
