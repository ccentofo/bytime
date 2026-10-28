import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addDays, todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, assignUserToClin, cleanupTestData, expectOk, expectFailure, flushAfter,
} from './helpers';

/**
 * feature-plan-certified-outputs.md C2 / §9 rows "Approver", "Approver (base)", "Stale approval", "Approval rows",
 * "Self-approval switch", "Designee scope", "Self-approved label" (screens, PDF, v1 — audit trail and export land with
 * C6/C8). The guards run for real (session from a mocked Auth.js, fresh role through getDbForAuth); only the I/O edges
 * are mocked.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c2', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'test-tenant.localhost' }) }));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));
vi.mock('@/auth', () => ({
  auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null),
}));
const emails = vi.hoisted(() => ({ submitted: [] as Array<{ supervisorEmail: string; employeeEmail: string; note?: string }> }));
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async (d: { supervisorEmail: string; employeeEmail: string; note?: string }) => { emails.submitted.push(d); return { ok: true as const, id: 'm' }; }),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'm' })),
}));

import { approvePeriod, rejectPeriod, getScopedPeriods, submitPeriod } from '@/server/actions/periods';
import { getTimesheetForReview, getTimesheetPeriod } from '@/server/actions/timesheet';
import { setUserApprover, updateUser, getApprovalNotices, getUsers } from '@/server/actions/users';
import { getCellRevisionHistory, getAuditEntries, getAuditPeriodEvents } from '@/server/actions/audit';
import { getTimesheetReportData, getEmployeeSummaryReport } from '@/server/actions/reports';
import { GET as getV1Periods } from '@/app/api/v1/periods/route';

type U = Awaited<ReturnType<typeof createTestUser>>;
const actingAs = (u: U | null) => { sessionState.user = u ? { id: u.id, role: u.role, email: u.email, fullName: u.fullName } : null; };
const today = () => todayIn('America/New_York');
const prevStart = (n = 1): CalendarDate => {
  let s = getPeriodStartForDate(today(), DEFAULT_PERIOD_CONFIG);
  for (let i = 0; i < n; i++) s = navigatePeriod(s, 'prev', DEFAULT_PERIOD_CONFIG);
  return s;
};
const SELF_OFF = 'Your timesheet must be approved by another admin or your designated approver.';

async function submittedPeriod(user: U, start = prevStart(1)) {
  const [p] = await getTestDb().insert(schema.timesheetPeriods)
    .values({ userId: user.id, periodStart: start, status: 'submitted', submittedAt: new Date(), submissionCount: 1, periodNumDays: 15 }).returning();
  return p;
}
async function designate(target: U, approver: U | null, as: U) {
  actingAs(as);
  return setUserApprover(target.id, approver?.id ?? null);
}
const logRows = (entity: string) => getTestDb().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entity, entity));

describe('approver rules (certified-outputs C2)', () => {
  let admin: U;
  beforeEach(async () => {
    await cleanupTestData();
    emails.submitted = [];
    admin = await createTestUser({ role: 'admin' });
  });
  afterEach(async () => {
    actingAs(null);
    await cleanupTestData();
  });

  // ── Approver (base) ───────────────────────────────────────────────────────
  it('a supervisor can\'t approve a CLIN-sharing supervisor (viewable, not approvable); approves a CLIN-sharing employee', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const supA = await createTestUser({ role: 'supervisor' });
    const supB = await createTestUser({ role: 'supervisor' });
    const emp = await createTestUser({ role: 'employee' });
    for (const u of [supA, supB, emp]) await assignUserToClin(u.id, clin.id);
    const peerPeriod = await submittedPeriod(supB);
    const empPeriod = await submittedPeriod(emp);

    actingAs(supA);
    const list = await getScopedPeriods();
    expect(list.find((p) => p.id === peerPeriod.id)).toMatchObject({ canApprove: false }); // CO-D9: visible read-only
    expect(list.find((p) => p.id === empPeriod.id)).toMatchObject({ canApprove: true });
    expect((await getTimesheetForReview(supB.id, prevStart(1))).canApprove).toBe(false);
    await expectFailure(approvePeriod({ periodId: peerPeriod.id, seen: 1 }), 'not_found', /Period not found/);
    await expectOk(approvePeriod({ periodId: empPeriod.id, seen: 1 }));
  });

  it('a designated supervisor with NO shared CLIN lists, reviews and approves; the designee demoted → refused, admins approve', async () => {
    const sup = await createTestUser({ role: 'supervisor' });
    const designee = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(sup, designee, admin));
    const period = await submittedPeriod(sup);

    actingAs(designee);
    expect((await getScopedPeriods()).map((p) => p.id)).toContain(period.id);
    expect(await getTimesheetForReview(sup.id, prevStart(1))).toMatchObject({ canApprove: true, submissionCount: 1 });

    // Demote the designee: the fresh check refuses them; admins remain approvers.
    actingAs(admin);
    await expectOk(updateUser(designee.id, { role: 'employee' }));
    actingAs(designee);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'forbidden');
    actingAs(admin);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
  });

  it('a supervisor demoted to employee: the former designee (no shared CLIN) can no longer approve them', async () => {
    const sup = await createTestUser({ role: 'supervisor' });
    const designee = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(sup, designee, admin));
    actingAs(admin);
    await expectOk(updateUser(sup.id, { role: 'employee' }));
    const period = await submittedPeriod(sup);
    actingAs(designee);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'not_found');
  });

  it('admin designates a supervisor (bookkeeper): the bookkeeper lists, reviews and approves the admin\'s timesheet; the admin can\'t self-approve', async () => {
    const book = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(admin, book, admin));
    const period = await submittedPeriod(admin);

    actingAs(admin);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'forbidden', new RegExp(SELF_OFF));

    actingAs(book);
    expect((await getScopedPeriods()).map((p) => p.id)).toContain(period.id);
    expect((await getTimesheetForReview(admin.id, prevStart(1))).canApprove).toBe(true);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
  });

  it('a supervisor can\'t approve an admin who did not designate them', async () => {
    const sup = await createTestUser({ role: 'supervisor' });
    const period = await submittedPeriod(admin);
    actingAs(sup);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'not_found');
  });

  it('second active admin created → the first admin\'s pending self-approval is refused; the second admin approves', async () => {
    const period = await submittedPeriod(admin);
    const admin2 = await createTestUser({ role: 'admin' });
    actingAs(admin);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'forbidden', new RegExp(SELF_OFF));
    actingAs(admin2);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
  });

  it('Approver select: rejects self, a non-approver, an inactive approver and an employee-role target; the change is logged', async () => {
    const sup = await createTestUser({ role: 'supervisor' });
    const emp = await createTestUser({ role: 'employee' });
    const inactive = await createTestUser({ role: 'supervisor', isActive: false });
    actingAs(admin);
    await expectFailure(setUserApprover(sup.id, sup.id), 'validation', /own approver/);
    await expectFailure(setUserApprover(sup.id, emp.id), 'validation', /active admin or supervisor/);
    await expectFailure(setUserApprover(sup.id, inactive.id), 'validation', /active admin or supervisor/);
    await expectFailure(setUserApprover(emp.id, admin.id), 'validation', /supervisors and admins only/);
    await expectOk(setUserApprover(sup.id, admin.id));
    const rows = await logRows('user');
    expect(rows).toEqual([expect.objectContaining({ actorId: admin.id, entityId: sup.id, action: 'approver_changed', oldValue: { approverId: null }, newValue: { approverId: admin.id } })]);
    expect((await getUsers()).find((u) => u.id === sup.id)?.approverId).toBe(admin.id);
  });

  it('mutual designation (owner ↔ bookkeeper) works both ways', async () => {
    const book = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(admin, book, admin));
    await expectOk(designate(book, admin, admin));
    const ownerPeriod = await submittedPeriod(admin);
    const bookPeriod = await submittedPeriod(book);
    actingAs(book);
    await expectOk(approvePeriod({ periodId: ownerPeriod.id, seen: 1 }));
    actingAs(admin);
    await expectOk(approvePeriod({ periodId: bookPeriod.id, seen: 1 }));
  });

  it('the submission email goes to the designee and not to a CLIN-sharing peer supervisor', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const sup = await createTestUser({ role: 'supervisor' });
    const peer = await createTestUser({ role: 'supervisor' });
    const designee = await createTestUser({ role: 'supervisor' });
    for (const u of [sup, peer]) await assignUserToClin(u.id, clin.id);
    await expectOk(designate(sup, designee, admin));
    await getTestDb().insert(schema.timesheetEntries).values({ userId: sup.id, clinId: clin.id, entryDate: prevStart(1), hours: '8', revisionNumber: 1, createdBy: sup.id });
    actingAs(sup);
    await expectOk(submitPeriod({ expectedUserId: sessionState.user!.id, periodStart: prevStart(1) }));
    await flushAfter();
    const to = emails.submitted.map((e) => e.supervisorEmail);
    expect(to).toContain(designee.email);
    expect(to).toContain(admin.email);
    expect(to).not.toContain(peer.email);
    expect(to).not.toContain(sup.email);
  });

  // ── Stale approval ────────────────────────────────────────────────────────
  it('stale approval: open (n) → reject + resubmit (n+1) → stale approve refused "resubmitted"; fresh approve OK; missing seen refused', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const emp = await createTestUser({ role: 'employee' });
    await getTestDb().insert(schema.timesheetEntries).values({ userId: emp.id, clinId: clin.id, entryDate: prevStart(1), hours: '8', revisionNumber: 1, createdBy: emp.id });
    actingAs(emp);
    const submitted = await expectOk(submitPeriod({ expectedUserId: sessionState.user!.id, periodStart: prevStart(1) }));
    actingAs(admin);
    const opened = await getTimesheetForReview(emp.id, prevStart(1));
    expect(opened.submissionCount).toBe(1);

    // Another reviewer path: reject (seen 1), the employee resubmits (count 2).
    await expectOk(rejectPeriod({ periodId: submitted.id!, comment: 'fix', seen: 1 }));
    actingAs(emp);
    await expectOk(submitPeriod({ expectedUserId: sessionState.user!.id, periodStart: prevStart(1) }));
    actingAs(admin);
    await expectFailure(approvePeriod({ periodId: submitted.id!, seen: opened.submissionCount }), 'conflict', /resubmitted after you opened it/);
    await expectFailure(approvePeriod({ periodId: submitted.id! } as never), 'validation', /reviewed version is missing/);
    const reopened = await getTimesheetForReview(emp.id, prevStart(1));
    expect(reopened.submissionCount).toBe(2);
    await expectOk(approvePeriod({ periodId: submitted.id!, seen: 2 }));
  });

  it('another reviewer decided first → "just changed by someone else"', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    const emp = await createTestUser({ role: 'employee' });
    const period = await submittedPeriod(emp);
    actingAs(admin2);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
    actingAs(admin);
    // Loaded before the decision (stale list): the status check sees it decided.
    await expectFailure(rejectPeriod({ periodId: period.id, seen: 1, comment: 'x' }), 'validation', /Only submitted periods/);
  });

  it('T8: decided by someone else AFTER the status pre-check → the conditional UPDATE matches no row → re-read → "just changed"', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    const emp = await createTestUser({ role: 'employee' });
    const period = await submittedPeriod(emp);
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
    const r = postgres(url, { max: 1 });
    const observer = postgres(url, { max: 1 });
    try {
      actingAs(admin);
      let decision!: Promise<Awaited<ReturnType<typeof rejectPeriod>>>;
      await r.begin(async (tx) => {
        // Hold the user-rules lock (F1) so the decision passes its pre-checks (still "submitted") and then waits
        // inside its transaction, BEFORE its UPDATE …
        await tx`SELECT pg_advisory_xact_lock(hashtext('user-rules'))`;
        decision = rejectPeriod({ periodId: period.id, seen: 1, comment: 'x' });
        for (let i = 0; ; i++) {
          const [{ n }] = await observer<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
          if (n > 0) break;
          if (i > 400) throw new Error('the decision never waited on the user-rules lock');
          await new Promise((res) => setTimeout(res, 25));
        }
        // … while another reviewer approves it.
        await tx`UPDATE timesheet_periods SET status = 'approved', reviewed_by = ${admin2.id}, reviewed_at = now() WHERE id = ${period.id}`;
      });
      expect(await decision).toEqual({ ok: false, code: 'conflict', error: expect.stringMatching(/just changed by someone else/) });
      const [after] = await getTestDb().select({ status: schema.timesheetPeriods.status, reviewedBy: schema.timesheetPeriods.reviewedBy })
        .from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, period.id));
      expect(after).toEqual({ status: 'approved', reviewedBy: admin2.id });
      const events = await getTestDb().select().from(schema.periodEvents).where(eq(schema.periodEvents.periodId, period.id));
      expect(events.filter((e) => e.event === 'rejected')).toEqual([]);
    } finally {
      await r.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  // ── Approval rows ─────────────────────────────────────────────────────────
  it('draft / approved / rejected → refused; employee-role with no shared CLIN, not designated → not found; non-admin self → explicit', async () => {
    const emp = await createTestUser({ role: 'employee' });
    const sup = await createTestUser({ role: 'supervisor' });
    for (const [status, i] of [['draft', 2], ['approved', 3], ['rejected', 4]] as const) {
      const [p] = await getTestDb().insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: prevStart(i), status, submissionCount: 1 }).returning();
      actingAs(admin);
      await expectFailure(approvePeriod({ periodId: p.id, seen: 1 }), 'validation', /Only submitted periods/);
    }
    const p = await submittedPeriod(emp);
    actingAs(sup);
    await expectFailure(approvePeriod({ periodId: p.id, seen: 1 }), 'not_found');
    const own = await submittedPeriod(sup, prevStart(5));
    await expectFailure(approvePeriod({ periodId: own.id, seen: 1 }), 'forbidden', /You cannot approve your own timesheet/);
  });

  // ── Self-approval switch ──────────────────────────────────────────────────
  it('deactivating the second admin writes self_approval enabled (count 1), the notice shows, and the sole admin self-approves with approval_context', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    actingAs(admin);
    // Record the "off" state first (two admins), then deactivate the second.
    await expectOk(updateUser(admin2.id, { fullName: 'Second Admin' }));
    await expectOk(updateUser(admin2.id, { isActive: false }));
    const enabled = (await logRows('self_approval')).filter((r) => r.entityId === admin.id && r.action === 'enabled');
    expect(enabled.at(-1)).toMatchObject({ newValue: { enabled: true, activeAdminCount: 1 } });

    // The "back on" notice needs an earlier "disabled" for this admin: re-activate then deactivate again.
    await expectOk(updateUser(admin2.id, { isActive: true }));
    await expectOk(updateUser(admin2.id, { isActive: false }));
    const notices = await getApprovalNotices();
    expect(notices.selfApprovalBackOn).not.toBeNull();
    expect(notices.recommendDesignee).toBe(true);

    const period = await submittedPeriod(admin);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
    const [event] = await getTestDb().select().from(schema.periodEvents).where(and(eq(schema.periodEvents.periodId, period.id), eq(schema.periodEvents.event, 'approved')));
    expect(event.approvalContext).toMatchObject({ selfApproved: true, activeAdminCount: 1, effectiveDesignee: null, selfApprovalEnabledBy: admin.id });
    expect((event.approvalContext as { selfApprovalEnabledAt: string }).selfApprovalEnabledAt).toBeTruthy();
  });

  it('R2: a pre-C2 sole-admin workspace (no self_approval rows) — an unrelated user write records the state, no "back on" notice', async () => {
    const emp = await createTestUser({ role: 'employee' });
    expect(await logRows('self_approval')).toEqual([]);
    actingAs(admin);
    await expectOk(updateUser(emp.id, { fullName: 'Renamed Employee' }));
    const rows = (await logRows('self_approval')).filter((r) => r.entityId === admin.id);
    expect(rows).toEqual([expect.objectContaining({ action: 'enabled', newValue: expect.objectContaining({ reason: 'existing state recorded' }) })]);
    expect((await getApprovalNotices()).selfApprovalBackOn).toBeNull();
  });

  it('F2: a workspace with two admins and NO prior self_approval rows → deactivate one → the notice shows for the other', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    expect(await logRows('self_approval')).toEqual([]);
    actingAs(admin);
    await expectOk(updateUser(admin2.id, { isActive: false }));
    expect((await getApprovalNotices()).selfApprovalBackOn).not.toBeNull();
  });

  it('with an active designee nothing is enabled; reactivating the admin / designating writes disabled', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    const book = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(admin, book, admin)); // self-approval off (designee) — recorded state for admin: none/disabled
    actingAs(admin);
    await expectOk(updateUser(admin2.id, { isActive: false })); // sole admin, but has a designee → not enabled
    expect((await logRows('self_approval')).filter((r) => r.entityId === admin.id && r.action === 'enabled')).toEqual([]);

    await expectOk(designate(admin, null, admin)); // designee cleared → enabled
    expect((await logRows('self_approval')).filter((r) => r.entityId === admin.id).at(-1)?.action).toBe('enabled');
    actingAs(admin);
    await expectOk(updateUser(admin2.id, { isActive: true })); // second admin back → disabled
    expect((await logRows('self_approval')).filter((r) => r.entityId === admin.id).at(-1)?.action).toBe('disabled');
  });

  it('waiting timesheet of a supervisor whose designee is deactivated → admins emailed with the note (ruling Q8), approvable', async () => {
    const admin2 = await createTestUser({ role: 'admin' });
    const sup = await createTestUser({ role: 'supervisor' });
    const designee = await createTestUser({ role: 'supervisor' });
    await expectOk(designate(sup, designee, admin));
    const period = await submittedPeriod(sup);
    emails.submitted = [];
    actingAs(admin);
    await expectOk(updateUser(designee.id, { isActive: false }));    // the designee is lost → current approvers re-notified
    await flushAfter();
    expect(emails.submitted.map((e) => e.supervisorEmail).sort()).toEqual([admin.email, admin2.email].sort()); // once each
    for (const e of emails.submitted) expect(e).toMatchObject({ note: 'Its designated approver is no longer available.' });

    emails.submitted = [];
    await expectOk(updateUser(admin2.id, { isActive: false }));      // nobody gained, no designee lost → no email
    await flushAfter();
    expect(emails.submitted).toEqual([]);
    await expectOk(updateUser(admin2.id, { isActive: true }));       // admin2 newly eligible → emailed, without the note
    await flushAfter();
    expect(emails.submitted).toEqual([expect.objectContaining({ supervisorEmail: admin2.email })]);
    expect(emails.submitted[0].note).toBeUndefined();
    actingAs(admin2);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
  });

  // ── Designee scope (CO-D18) ───────────────────────────────────────────────
  it('a supervisor with NO CLINs designated by X sees exactly {self, X} in approvals, review, revision history, audit trail, hours report, PDF', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const book = await createTestUser({ role: 'supervisor' });
    const X = await createTestUser({ role: 'supervisor' });
    const other = await createTestUser({ role: 'employee' });
    await assignUserToClin(X.id, clin.id);
    await assignUserToClin(other.id, clin.id);
    await expectOk(designate(X, book, admin));
    const d = addDays(prevStart(1), 1);
    for (const u of [book, X, other]) {
      await getTestDb().insert(schema.timesheetEntries).values({ userId: u.id, clinId: clin.id, entryDate: d, hours: '8', revisionNumber: 1, createdBy: u.id });
      const p = await submittedPeriod(u);
      await getTestDb().insert(schema.periodEvents).values({ periodId: p.id, userId: u.id, event: 'submitted', actorId: u.id });
    }

    actingAs(book);
    expect(new Set((await getScopedPeriods()).map((p) => p.userId))).toEqual(new Set([book.id, X.id]));
    await expect(getTimesheetForReview(X.id, prevStart(1))).resolves.toBeDefined();
    await expect(getTimesheetForReview(other.id, prevStart(1))).rejects.toThrow(/not authorized/);
    await expect(getCellRevisionHistory(X.id, clin.id, d)).resolves.not.toBeNull();
    await expect(getCellRevisionHistory(other.id, clin.id, d)).rejects.toThrow(/not authorized/);
    const audit = (await getAuditEntries({})).entries;
    expect(new Set(audit.map((a) => a.userId))).toEqual(new Set([book.id, X.id]));
    // T2: the audit trail's period events are scoped the same way.
    expect(new Set((await getAuditPeriodEvents({})).events.map((e) => e.userId))).toEqual(new Set([book.id, X.id]));
    expect((await getAuditPeriodEvents({ userId: other.id })).events).toEqual([]);
    const summary = await getEmployeeSummaryReport(prevStart(1), addDays(prevStart(1), 14));
    expect(summary.map((s) => s.employeeName).sort()).toEqual([book.fullName, X.fullName].sort());
    await expect(getTimesheetReportData(X.id, prevStart(1))).resolves.not.toBeNull();
    await expect(getTimesheetReportData(other.id, prevStart(1))).rejects.toThrow(/not authorized/);
    // Admin-only writes stay refused (launch-blockers P3).
    await expect(updateUser(other.id, { fullName: 'nope' })).resolves.toMatchObject({ ok: false });
  });

  // ── Self-approved label ───────────────────────────────────────────────────
  it('"Self-approved" on the approvals list, review, timesheet status, PDF and v1 API — one helper', async () => {
    const period = await submittedPeriod(admin);
    actingAs(admin);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
    expect((await getScopedPeriods()).find((p) => p.id === period.id)?.approvalBadge).toBe('Self-approved');
    expect((await getTimesheetForReview(admin.id, prevStart(1))).approvalBadge).toBe('Self-approved');
    expect((await getTimesheetPeriod(prevStart(1))).approvalBadge).toBe('Self-approved');
    expect((await getTimesheetReportData(admin.id, prevStart(1)))?.approvedBy).toBe('Self-approved');

    const rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
    await getTestDb().insert(schema.apiKeys).values({
      name: 'k', keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.slice(0, 8), createdByUserId: admin.id, permissions: 'read', isActive: true,
    });
    const res = await getV1Periods(new Request(`http://localhost:3000/api/v1/periods?startDate=${prevStart(2)}`, { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.52' } }) as never);
    const body = await res.json();
    expect(body.data.find((p: { id: string }) => p.id === period.id)).toMatchObject({ selfApproved: true, approvalSource: 'app' });
  });
});
