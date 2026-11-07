import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-ux-people-codes.md §6 against Postgres: AU-2 (the summary follows the filters, a contract filter works
 * with no join, late counts a revision-1 app row with a CORRECTION reason), AU-3 (page 2 is the next 50; total is a
 * number), AU-4 (supervisor scope on entries, summary and export), AU-6 (getAdminChanges refuses a supervisor; the day
 * bounds are the workspace's), AU-8 (the CSV: raw reason, formula guard, 0 → 422, over the cap → 422, no start → 400,
 * and > 1,000 rows written in ONE transaction — one created_at — all exported).
 */

// ---------------------------------------------------------------------------
// Harness: mock only the I/O edges (tenant DB resolution, the Auth.js session).
// @/lib/session is NOT mocked — the real guards (requireSession/requireAdmin/
// assertCanAccessEmployee) run for real against the mocked @/auth session, so a
// regression in who's allowed to do what shows up here instead of being hidden.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // requireAdminFresh (feature-plan-launch-blockers.md P3) re-reads the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

// R2-1: getSessionUser() now checks session.user.tenantSlug against the request's tenant
// (getTenantSlug()). Keep them matching here so existing tests exercise authorization, not
// the tenant-binding check — that check gets its own dedicated test files.
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

// No outbound email. List every export explicitly — do NOT use a catch-all Proxy here: a Proxy
// that returns a function for every key also answers `then`, so vitest's `await factory()` treats
// the mock as a never-resolving thenable and the whole run hangs during module loading.
vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));

// Imports AFTER the mocks — vitest hoists vi.mock, so this is safe at module top level.
import { getAdminChanges, getAuditEntries, getAuditSummary } from '@/server/actions/audit';
import { GET as csv } from '@/app/api/reports/audit-csv/route';

function actingAs(user: { id: string; role: string; email: string; fullName: string }) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}
let ipSeq = 0;
const download = (qs: string) => csv(new NextRequest(`http://localhost/api/reports/audit-csv${qs}`, { headers: { 'x-forwarded-for': `10.9.0.${++ipSeq}` } }));
const csvRows = (text: string) => text.trim().split('\n').slice(1);

describe('Audit trail (UX-4c §6)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let other: Awaited<ReturnType<typeof createTestUser>>;
  const db = () => getTestDb();
  const entry = (o: Partial<typeof schema.timesheetEntries.$inferInsert>) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, entryDate: '2026-10-05', hours: '8', revisionNumber: 1, createdBy: emp.id, ...o });

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
    emp = await createTestUser({ role: 'employee', fullName: 'Pat Doe' });
    other = await createTestUser({ role: 'employee', fullName: 'Oz Other' });
    actingAs(admin);
  });
  afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

  it('AU-2: the summary follows the filters (a contract filter, no missing-FROM error); late = a revision-1 app row with a reason', async () => {
    const [k1, k2] = [await createTestContract(), await createTestContract()];
    const [c1, c2] = [await createTestClin(k1.id), await createTestClin(k2.id)];
    await entry({ clinId: c1.id });                                                       // plain
    await entry({ clinId: c1.id, entryDate: '2026-10-06', changeReasonCode: 'CORRECTION', comment: 'late, typed as a correction' }); // late (R3)
    await entry({ clinId: c1.id, entryDate: '2026-10-06', revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'fixed' });  // changed
    await entry({ clinId: c2.id, userId: other.id, createdBy: other.id });
    await entry({ clinId: c1.id, source: 'migration', changeReasonCode: 'LATE_ENTRY' });  // imported: not late
    const f = { startDate: '2026-10-01' as CalendarDate, endDate: '2026-10-31' as CalendarDate };
    expect(await getAuditSummary(f)).toEqual({ entries: 5, changed: 1, late: 1, people: 2 });
    expect(await getAuditSummary({ ...f, contractId: k1.id })).toEqual({ entries: 4, changed: 1, late: 1, people: 1 });
    expect(await getAuditSummary({ ...f, reasonCode: 'CORRECTION' })).toEqual({ entries: 2, changed: 1, late: 1, people: 1 });
    expect((await getAuditEntries({ ...f, contractId: k2.id })).total).toBe(1);
  });

  it('AU-3: page 2 is the next 50 (created_at, id order); total is a number equal to the filtered count', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    for (let i = 0; i < 120; i++) await entry({ clinId: clin.id, entryDate: '2026-10-05', hours: String(i % 8), createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, i)) });
    const f = { startDate: '2026-10-01' as CalendarDate, endDate: '2026-10-31' as CalendarDate };
    const p1 = await getAuditEntries({ ...f, page: 1 });
    const p2 = await getAuditEntries({ ...f, page: 2 });
    const p3 = await getAuditEntries({ ...f, page: 3 });
    expect(typeof p1.total).toBe('number');
    expect([p1.total, p1.entries.length, p2.entries.length, p3.entries.length]).toEqual([120, 50, 50, 20]);
    expect(new Set([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id)).size).toBe(120);
    expect(p1.entries[49].createdAt.getTime()).toBeGreaterThan(p2.entries[0].createdAt.getTime());
  });

  it('AU-4: a supervisor sees only their scope — entries, summary and the export', async () => {
    const sup = await createTestUser({ role: 'supervisor', fullName: 'Sam Super' });
    const clin = await createTestClin((await createTestContract()).id);
    const away = await createTestClin((await createTestContract()).id);
    await db().insert(schema.userAssignments).values([{ userId: sup.id, clinId: clin.id, isActive: true }, { userId: emp.id, clinId: clin.id, isActive: true }, { userId: other.id, clinId: away.id, isActive: true }]);
    await entry({ clinId: clin.id });
    await entry({ clinId: away.id, userId: other.id, createdBy: other.id });
    actingAs(sup);
    const f = { startDate: '2026-10-01' as CalendarDate, endDate: '2026-10-31' as CalendarDate };
    expect((await getAuditEntries(f)).entries.map((e) => e.userName)).toEqual(['Pat Doe']);
    expect((await getAuditSummary(f)).people).toBe(1);
    const res = await download('?start=2026-10-01&end=2026-10-31');
    expect(csvRows(await res.text()).map((l) => l.split(',')[1])).toEqual(['Pat Doe']);
    const outside = await download(`?start=2026-10-01&end=2026-10-31&user=${other.id}`);
    expect(outside.status).toBe(422);
  });

  it('AU-6: getAdminChanges refuses a supervisor; a row at 11:30 PM New York on day X is in day X', async () => {
    const at = new Date('2026-10-06T03:30:00Z');                                         // Oct 5, 11:30 PM in New York (EDT)
    await db().insert(schema.adminChangeLog).values({ actorId: admin.id, entity: 'user', entityId: emp.id, action: 'mfa_reset', createdAt: at });
    const day = (d: string) => getAdminChanges({ start: d as CalendarDate, end: d as CalendarDate });
    expect((await day('2026-10-05')).rows.map((r) => [r.change, r.details, r.byName])).toEqual([['Two-step sign-in reset', 'Pat Doe', 'Ann Admin']]);
    expect((await day('2026-10-06')).rows).toEqual([]);
    const sup = await createTestUser({ role: 'supervisor' });
    actingAs(sup);
    await expect(day('2026-10-05')).rejects.toThrow();
  });

  it('AU-8: raw reason, formula guard; 0 rows → 422; missing start → 400; over 50,000 → 422', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    const code = await createTestChargeCode(clin.id, { code: 'NAV-CSV' });
    await entry({ chargeCodeId: code.id, clinId: clin.id, changeReasonCode: 'LATE_ENTRY', comment: '=HYPERLINK("http://x")' });
    const ok = await download('?start=2026-10-01&end=2026-10-31');
    expect(ok.status).toBe(200);
    const [line] = csvRows(await ok.text());
    expect(line).toContain(',LATE_ENTRY,');
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect((await download('?start=2026-11-01&end=2026-11-30')).status).toBe(422);
    expect((await download('?end=2026-10-31')).status).toBe(400);
    await db().execute(sql`INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number, created_by)
      SELECT ${emp.id}, ${clin.id}, '2026-09-01'::date + (g % 28), '1', 1, ${emp.id} FROM generate_series(1, 50001) g`);
    const tooMany = await download('?start=2026-09-01&end=2026-09-30');
    expect([tooMany.status, (await tooMany.json()).error]).toEqual([422, 'More than 50,000 entries match. Choose a shorter date range.']);
  }, 120_000);

  it('AU-8: more than 1,000 rows written in ONE transaction (one created_at) → the CSV row count equals the COUNT', async () => {
    const clin = await createTestClin((await createTestContract()).id);
    await db().transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number, created_by)
        SELECT ${emp.id}, ${clin.id}, '2026-08-01'::date + (g % 28), '2', 1, ${emp.id} FROM generate_series(1, 2345) g`);
    });
    const [{ distinct }] = await db().execute(sql`SELECT COUNT(DISTINCT created_at)::int AS distinct FROM timesheet_entries WHERE entry_date BETWEEN '2026-08-01' AND '2026-08-31'`) as unknown as Array<{ distinct: number }>;
    expect(distinct).toBe(1);                                                            // one save: one created_at
    const res = await download('?start=2026-08-01&end=2026-08-31');
    const rows = csvRows(await res.text());
    expect(rows).toHaveLength(2345);
    expect((await getAuditEntries({ startDate: '2026-08-01' as CalendarDate, endDate: '2026-08-31' as CalendarDate })).total).toBe(2345);
  }, 120_000);
});
