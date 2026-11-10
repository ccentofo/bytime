import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignApprovalScope, assignUserToClin, cleanupTestData, expectOk, expectFailure,
} from './helpers';

/**
 * feature-plan-approval-scope.md against Postgres (the guards run for real; only the I/O edges are mocked):
 * AS-3  — a supervisor with a charge code but no scope on X can't approve or see an employee on X.
 * AS-6  — a supervisor's own filter options include the CLINs they charge without scope (and their scope CLINs).
 * AS-7  — grantApprovalScope: a non-supervisor and an inactive CLIN refused; logged `{ supervisorId, clinId }`; a waiting
 *         timesheet re-routes to the new supervisor (email recorded).
 * AS-8  — revokeApprovalScope: deactivated and logged; a later Approve is refused; already inactive → unchanged.
 * AS-9  — promotion with [X]: exactly X even with membership on Y; logged; role_changed lists [X]; a second "promotion"
 *         of a supervisor with ids is refused and changes nothing.
 * AS-10 — demotion: scope removed, reviewed and logged; an unbacked membership row deactivated, a backed one kept.
 * AS-11 — the review: keep → reviewed + logged; remove → inactive + logged; app rows ignored; an inactive supervisor's
 *         and a demoted user's rows are reviewable; a second save skips them.
 * Fix round 1 (APPROVAL-SCOPE-AUDIT.md): M1 (in AS-9), M2 (createUserWithPassword grants), L1 (in AS-10), L2 (in AS-12),
 *         L4 (re-granting a converted row keeps it).
 * AS-12 — the import: a non-supervisor row is a row error; a forced SQL error in one row leaves the others committed;
 *         more than 500 rows refused.
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

import { approvePeriod, getScopedPeriods } from '@/server/actions/periods';
import { assignChargeCodesToUser } from '@/server/actions/charge-codes';
import { grantApprovalScope, revokeApprovalScope, reviewMigratedScopes } from '@/server/actions/assignments';
import { createUserWithPassword, updateUser } from '@/server/actions/users';
import { bulkImportAssignments } from '@/server/actions/import';
import { getReportFilterOptions } from '@/server/actions/reports';
import { getAdminChanges, getClinsForFilter, getContractsForFilter } from '@/server/actions/audit';
import { canApprove, loadApprovalFacts, reviewScopeFrom } from '@/server/internal/approval-rules';
import { approvalScopesToReview } from '@/server/internal/approval-scopes';

type U = Awaited<ReturnType<typeof createTestUser>>;
const actingAs = (u: U | null) => { sessionState.user = u ? { id: u.id, role: u.role, email: u.email, fullName: u.fullName } : null; };
const prevStart = (): CalendarDate => navigatePeriod(getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG), 'prev', DEFAULT_PERIOD_CONFIG);
const db = () => getTestDb();
const scopeRows = (supervisorId: string) => db().select().from(schema.approvalScopes).where(eq(schema.approvalScopes.supervisorId, supervisorId));
const scopeLogs = () => db().select().from(schema.adminChangeLog).where(eq(schema.adminChangeLog.entity, 'approval_scope'));
async function submittedPeriod(user: U) {
  const [p] = await db().insert(schema.timesheetPeriods)
    .values({ userId: user.id, periodStart: prevStart(), status: 'submitted', submittedAt: new Date(), submissionCount: 1, periodNumDays: 15 }).returning();
  return p;
}

describe('approval scope (feature-plan-approval-scope.md)', () => {
  let admin: U;
  beforeEach(async () => {
    await cleanupTestData();
    emails.submitted = [];
    admin = await createTestUser({ role: 'admin' });
  });
  afterEach(async () => { actingAs(null); await cleanupTestData(); });

  it('AS-3: a supervisor with a charge code but no scope on X can\'t approve or see an employee on X; scope on X can', async () => {
    const x = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(x.id);
    const sup = await createTestUser({ role: 'supervisor' });
    const emp = await createTestUser({ role: 'employee' });
    actingAs(admin);
    await expectOk(assignChargeCodesToUser({ userId: sup.id, chargeCodeIds: [code.id] }));   // membership on X, no scope
    await expectOk(assignChargeCodesToUser({ userId: emp.id, chargeCodeIds: [code.id] }));
    const period = await submittedPeriod(emp);

    actingAs(sup);
    expect((await getScopedPeriods()).map((p) => p.id)).not.toContain(period.id);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'not_found');
    let f = await loadApprovalFacts(db() as never);
    expect(canApprove(f, sup.id, emp.id)).toBe(false);
    expect(reviewScopeFrom(f, sup.id)).toEqual([sup.id]);

    await assignApprovalScope(sup.id, x.id);                                                 // an explicit grant
    f = await loadApprovalFacts(db() as never);
    expect(canApprove(f, sup.id, emp.id)).toBe(true);
    expect((await getScopedPeriods()).map((p) => p.id)).toContain(period.id);
    await expectOk(approvePeriod({ periodId: period.id, seen: 1 }));
    expect((await db().select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, period.id)))[0].status).toBe('approved');
  });

  it('AS-6: a supervisor\'s filter options include the CLINs they charge without scope, and their scope CLINs; nothing else', async () => {
    const charged = await createTestContract({ name: 'Charged Co' });
    const scoped = await createTestContract({ name: 'Scoped Co' });
    const other = await createTestContract({ name: 'Other Co' });
    const [x, y, z] = [await createTestClin(charged.id), await createTestClin(scoped.id), await createTestClin(other.id)];
    const sup = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(sup.id, x.id);                                                    // charges X, no scope
    await assignApprovalScope(sup.id, y.id);                                                 // approves Y
    void z;
    actingAs(sup);
    expect((await getReportFilterOptions()).contracts.map((c) => c.name).sort()).toEqual(['Charged Co', 'Scoped Co']);
    expect((await getContractsForFilter()).map((c) => c.name).sort()).toEqual(['Charged Co', 'Scoped Co']);
    expect((await getClinsForFilter(charged.id)).map((c) => c.id)).toEqual([x.id]);
    expect((await getClinsForFilter(other.id))).toEqual([]);
  });

  it('AS-7: grantApprovalScope refuses a non-supervisor and an inactive CLIN; logs { supervisorId, clinId }; a waiting timesheet re-routes to the new supervisor', async () => {
    const k = await createTestContract();
    const [x, closed] = [await createTestClin(k.id), await createTestClin(k.id, { status: 'inactive' })];
    const sup = await createTestUser({ role: 'supervisor', email: `sup-${Date.now()}@bytime.dev` });
    const emp = await createTestUser({ role: 'employee' });
    await assignUserToClin(emp.id, x.id);
    await submittedPeriod(emp);
    actingAs(admin);
    await expectFailure(grantApprovalScope({ supervisorId: emp.id, clinIds: [x.id] }), 'validation', /^Choose an active supervisor\.$/);
    await expectFailure(grantApprovalScope({ supervisorId: sup.id, clinIds: [closed.id] }), 'validation', /^Choose active CLINs on active contracts\.$/);
    expect(await scopeRows(sup.id)).toEqual([]);
    expect(emails.submitted).toEqual([]);

    expect(await expectOk(grantApprovalScope({ supervisorId: sup.id, clinIds: [x.id, x.id] }))).toEqual({ granted: 1 });
    const [row] = await scopeRows(sup.id);
    expect([row.clinId, row.isActive, row.source, row.grantedBy, row.reviewedAt !== null]).toEqual([x.id, true, 'app', admin.id, true]);
    expect((await scopeLogs()).map((l) => [l.action, l.entityId, l.actorId, l.newValue])).toEqual([['granted', row.id, admin.id, { supervisorId: sup.id, clinId: x.id }]]);
    expect(emails.submitted.map((e) => e.supervisorEmail)).toEqual([sup.email]);           // re-routed
    expect(await expectOk(grantApprovalScope({ supervisorId: sup.id, clinIds: [x.id] }))).toEqual({ granted: 0 }); // already active: skipped
    expect(await scopeLogs()).toHaveLength(1);
    // The Audit trail names the supervisor and the CLIN (adminChangeNames collects supervisorId and clinId).
    const day = todayIn('America/New_York');
    const admin1 = (await getAdminChanges({ start: day, end: day })).rows.find((r) => r.change === 'Approval scope added');
    expect(admin1?.details).toBe(`${sup.fullName} · ${k.name} CLIN ${x.clinNumber}`);
  });

  it('AS-8: revokeApprovalScope deactivates and logs; a later Approve is refused; already inactive → { changed: false }, no log', async () => {
    const x = await createTestClin((await createTestContract()).id);
    const sup = await createTestUser({ role: 'supervisor' });
    const emp = await createTestUser({ role: 'employee' });
    await assignUserToClin(emp.id, x.id);
    const scope = await assignApprovalScope(sup.id, x.id, { source: 'migration', reviewedAt: null });
    const period = await submittedPeriod(emp);
    actingAs(admin);
    expect(await expectOk(revokeApprovalScope({ supervisorId: sup.id, clinId: x.id }))).toEqual({ changed: true });
    const [row] = await scopeRows(sup.id);
    expect([row.isActive, row.reviewedAt !== null]).toEqual([false, true]);
    expect((await scopeLogs()).map((l) => [l.action, l.entityId, l.newValue])).toEqual([['removed', scope.id, { supervisorId: sup.id, clinId: x.id }]]);
    actingAs(sup);
    await expectFailure(approvePeriod({ periodId: period.id, seen: 1 }), 'not_found');
    actingAs(admin);
    expect(await expectOk(revokeApprovalScope({ supervisorId: sup.id, clinId: x.id }))).toEqual({ changed: false });
    expect(await scopeLogs()).toHaveLength(1);
  });

  it('AS-9: promotion with [X] gives exactly X (membership on Y ignored; a leftover converted scope on Z removed), logged; role_changed lists [X]; a second "promotion" with ids is refused', async () => {
    const k = await createTestContract();
    const [x, y, z] = [await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id)];
    const pat = await createTestUser({ role: 'employee' });
    await assignUserToClin(pat.id, y.id);                                                    // charges Y
    // APPROVAL-SCOPE-AUDIT.md M1: demoted by the OLD code during the deploy window, so their converted scope on Z is still active.
    const stale = await assignApprovalScope(pat.id, z.id, { source: 'migration', reviewedAt: null });
    actingAs(admin);
    await expectOk(updateUser(pat.id, { role: 'supervisor', approvalClinIds: [x.id] }));
    const rows = await scopeRows(pat.id);
    expect(rows.filter((r) => r.isActive).map((r) => [r.clinId, r.source])).toEqual([[x.id, 'app']]);
    const z1 = rows.find((r) => r.id === stale.id)!;
    expect([z1.isActive, z1.reviewedAt !== null]).toEqual([false, true]);
    expect((await scopeLogs()).map((l) => [l.action, l.entityId === stale.id ? 'stale' : 'new', l.newValue]).sort()).toEqual([
      ['granted', 'new', { supervisorId: pat.id, clinId: x.id }],
      ['removed', 'stale', { supervisorId: pat.id, clinId: z.id }],
    ]);
    const [roleLog] = await db().select().from(schema.adminChangeLog).where(and(eq(schema.adminChangeLog.entityId, pat.id), eq(schema.adminChangeLog.action, 'role_changed')));
    expect(roleLog.newValue).toEqual({ role: 'supervisor', clinIds: [x.id] });

    await expectFailure(updateUser(pat.id, { role: 'supervisor', approvalClinIds: [y.id] }), 'validation', /^Already a supervisor — edit their approval scope on Assignments\.$/);
    await expectFailure(updateUser(pat.id, { fullName: 'Pat S', approvalClinIds: [y.id] }), 'validation', /^Already a supervisor/);
    expect((await scopeRows(pat.id)).filter((r) => r.isActive).map((r) => r.clinId)).toEqual([x.id]);
  });

  it('M2: createUserWithPassword gives a new supervisor their chosen CLINs (logged; a waiting timesheet re-routes); a non-supervisor with ids is refused', async () => {
    const x = await createTestClin((await createTestContract()).id);
    const emp = await createTestUser({ role: 'employee' });
    await assignUserToClin(emp.id, x.id);
    await submittedPeriod(emp);
    actingAs(admin);
    const base = { fullName: 'New Sup', password: 'LongEnough123', flsaExempt: true };
    const email = `new-sup-${Date.now()}@bytime.dev`;
    await expectFailure(createUserWithPassword({ ...base, email: `x-${email}`, role: 'employee', approvalClinIds: [x.id] }), 'validation', /^Approval CLINs only apply when making someone a supervisor\.$/);
    const made = await expectOk(createUserWithPassword({ ...base, email, role: 'supervisor', approvalClinIds: [x.id] }));
    const rows = await scopeRows(made.id);
    expect(rows.map((r) => [r.clinId, r.isActive, r.source, r.grantedBy])).toEqual([[x.id, true, 'app', admin.id]]);
    expect((await scopeLogs()).map((l) => [l.action, l.entityId, l.newValue])).toEqual([['granted', rows[0].id, { supervisorId: made.id, clinId: x.id }]]);
    expect(emails.submitted.map((e) => e.supervisorEmail)).toEqual([email]);           // emp's waiting timesheet re-routed
  });

  it('L4: re-granting a converted, unreviewed CLIN keeps it — reviewed, logged `kept`, off the review list and Home count', async () => {
    const x = await createTestClin((await createTestContract()).id);
    const sup = await createTestUser({ role: 'supervisor' });
    const converted = await assignApprovalScope(sup.id, x.id, { source: 'migration', reviewedAt: null });
    actingAs(admin);
    expect(await approvalScopesToReview(db() as never)).toBe(1);
    expect(await expectOk(grantApprovalScope({ supervisorId: sup.id, clinIds: [x.id] }))).toEqual({ granted: 0 });
    const [row] = await scopeRows(sup.id);
    expect([row.id, row.isActive, row.source, row.reviewedAt !== null]).toEqual([converted.id, true, 'migration', true]);
    expect((await scopeLogs()).map((l) => [l.action, l.entityId])).toEqual([['kept', converted.id]]);
    expect(await approvalScopesToReview(db() as never)).toBe(0);
    expect(await expectOk(grantApprovalScope({ supervisorId: sup.id, clinIds: [x.id] }))).toEqual({ granted: 0 }); // now reviewed: nothing logged
    expect(await scopeLogs()).toHaveLength(1);
  });

  it('AS-10: demotion removes the scope (reviewed, logged); an unbacked membership row is deactivated, a backed one kept', async () => {
    const k = await createTestContract();
    const [x, y, z] = [await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id)];
    const code = await createTestChargeCode(x.id);
    const dee = await createTestUser({ role: 'supervisor' });
    actingAs(admin);
    await expectOk(assignChargeCodesToUser({ userId: dee.id, chargeCodeIds: [code.id] }));   // backed membership on X
    await assignUserToClin(dee.id, z.id);                                                    // unbacked (old supervisor-scope row)
    await assignApprovalScope(dee.id, x.id);
    await assignApprovalScope(dee.id, y.id, { source: 'migration', reviewedAt: null });
    await expectOk(updateUser(dee.id, { role: 'employee' }));
    const rows = await scopeRows(dee.id);
    expect(rows.every((r) => !r.isActive && r.reviewedAt !== null)).toBe(true);
    expect((await scopeLogs()).map((l) => l.action)).toEqual(['removed', 'removed']);
    const member = await db().select().from(schema.userAssignments).where(eq(schema.userAssignments.userId, dee.id));
    expect(Object.fromEntries(member.map((m) => [m.clinId, m.isActive]))).toEqual({ [x.id]: true, [z.id]: false });
    const [roleLog] = await db().select().from(schema.adminChangeLog).where(and(eq(schema.adminChangeLog.entityId, dee.id), eq(schema.adminChangeLog.action, 'role_changed')));
    expect(roleLog.newValue).toEqual({ role: 'employee', membershipRemoved: [z.id] });

    // APPROVAL-SCOPE-AUDIT.md L1: S10 runs only when LEAVING supervisor — an employee made admin keeps an unbacked row.
    const eve = await createTestUser({ role: 'employee' });
    await assignUserToClin(eve.id, z.id);
    await expectOk(updateUser(eve.id, { role: 'admin' }));
    expect((await db().select().from(schema.userAssignments).where(eq(schema.userAssignments.userId, eve.id))).map((m) => m.isActive)).toEqual([true]);
    const [eveLog] = await db().select().from(schema.adminChangeLog).where(and(eq(schema.adminChangeLog.entityId, eve.id), eq(schema.adminChangeLog.action, 'role_changed')));
    expect(eveLog.newValue).toEqual({ role: 'admin' });
  });

  it('AS-11: the review keeps and removes converted rows (an inactive supervisor\'s and a demoted user\'s too), ignores app rows, and skips them the second time', async () => {
    const k = await createTestContract();
    const [c1, c2, c3, c4] = [await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id), await createTestClin(k.id)];
    const sam = await createTestUser({ role: 'supervisor' });
    const gone = await createTestUser({ role: 'supervisor', isActive: false });
    const demoted = await createTestUser({ role: 'employee' });
    const m1 = await assignApprovalScope(sam.id, c1.id, { source: 'migration', reviewedAt: null });
    const m2 = await assignApprovalScope(gone.id, c2.id, { source: 'migration', reviewedAt: null });
    const m3 = await assignApprovalScope(demoted.id, c3.id, { source: 'migration', reviewedAt: null });
    const a1 = await assignApprovalScope(sam.id, c4.id);                                     // granted in the app: not reviewable
    actingAs(admin);
    expect(await expectOk(reviewMigratedScopes({ keep: [m1.id, a1.id], remove: [m2.id, m3.id] }))).toEqual({ kept: 1, removed: 2, skipped: 1 });
    const byId = new Map((await db().select().from(schema.approvalScopes)).map((r) => [r.id, r]));
    expect([byId.get(m1.id)!.isActive, byId.get(m1.id)!.reviewedAt !== null]).toEqual([true, true]);
    for (const id of [m2.id, m3.id]) expect([byId.get(id)!.isActive, byId.get(id)!.reviewedAt !== null]).toEqual([false, true]);
    expect(byId.get(a1.id)!.reviewedAt!.getTime()).toBe(a1.reviewedAt!.getTime());
    expect((await scopeLogs()).map((l) => [l.action, l.entityId]).sort()).toEqual([['kept', m1.id], ['removed', m2.id], ['removed', m3.id]].sort());
    expect(await expectOk(reviewMigratedScopes({ keep: [m1.id], remove: [m2.id] }))).toEqual({ kept: 0, removed: 0, skipped: 2 });
    expect(await scopeLogs()).toHaveLength(3);
  });

  it('AS-12: the import — a non-supervisor row errors, a forced SQL error in one row leaves the others committed; over 500 rows refused', async () => {
    const k = await createTestContract({ contractNumber: `IMP-${Date.now()}` });
    const [c1, c2, c3] = [await createTestClin(k.id, { clinNumber: '0001' }), await createTestClin(k.id, { clinNumber: '0002' }), await createTestClin(k.id, { clinNumber: '0003' })];
    const sup = await createTestUser({ role: 'supervisor', email: `imp-sup-${Date.now()}@bytime.dev` });
    const emp = await createTestUser({ role: 'employee', email: `imp-emp-${Date.now()}@bytime.dev` });
    const off = await createTestUser({ role: 'supervisor', isActive: false, email: `imp-off-${Date.now()}@bytime.dev` });
    // A real database error for CLIN 0002 only (a trigger), inside that row's savepoint.
    await db().execute(sql.raw(`CREATE OR REPLACE FUNCTION test_scope_import_fail() RETURNS trigger AS $$ BEGIN IF NEW.clin_id = '${c2.id}' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await db().execute(sql.raw('CREATE TRIGGER test_scope_import_fail BEFORE INSERT ON approval_scopes FOR EACH ROW EXECUTE FUNCTION test_scope_import_fail()'));
    try {
      actingAs(admin);
      const row = (email: string, clinNumber: string) => ({ email, contractNumber: k.contractNumber, clinNumber });
      const r = await expectOk(bulkImportAssignments([
        row(sup.email, '0001'), row(emp.email, '0001'), row(sup.email, '0002'), row(sup.email, '0003'), row(sup.email, '0001'),
        row('  Nobody@Bytime.dev ', '0001'), { ...row(sup.email, ' 9999 '), contractNumber: ` ${k.contractNumber} ` }, row(` ${off.email.toUpperCase()} `, '0001'),
      ]));
      expect(r.created).toBe(2);
      expect(r.skipped).toBe(1);
      expect(r.errors).toEqual([
        // Spreadsheet rows (feature-plan-ux-setup-import.md P11): the first data row is row 2.
        { row: 3, message: `${emp.email} isn't an active supervisor, so they can't approve a CLIN.` },
        { row: 4, message: 'Could not import this row.' },
        { row: 7, message: 'User "Nobody@Bytime.dev" not found' },                               // L2: the trimmed value
        { row: 8, message: `CLIN "9999" not found under contract "${k.contractNumber}"` },
        { row: 9, message: `${off.email.toUpperCase()} isn't an active supervisor, so they can't approve a CLIN.` }, // L2: inactive supervisor
      ]);
      expect(r.skippedRows).toEqual([{ row: 6, reason: 'Already approves this CLIN' }]);
      const rows = await scopeRows(sup.id);
      expect(rows.map((x) => [x.clinId, x.source]).sort()).toEqual([[c1.id, 'import'], [c3.id, 'import']].sort());
      expect((await scopeLogs()).map((l) => l.action)).toEqual(['granted', 'granted']);
    } finally {
      await db().execute(sql.raw('DROP TRIGGER IF EXISTS test_scope_import_fail ON approval_scopes'));
      await db().execute(sql.raw('DROP FUNCTION IF EXISTS test_scope_import_fail()'));
    }
    await expectFailure(bulkImportAssignments(Array.from({ length: 501 }, () => ({ email: sup.email, contractNumber: k.contractNumber, clinNumber: '0001' }))), 'validation', /^This file has 501 rows\. Split it into files of 500 rows or fewer\.$/);
  });
});
