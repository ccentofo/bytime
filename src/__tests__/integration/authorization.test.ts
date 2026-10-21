import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dayjs from 'dayjs';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate } from '@/lib/date-utils';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  assignUserToClin,
  cleanupTestData,
} from './helpers';

// ---------------------------------------------------------------------------
// The 12-case authorization matrix from the security-hardening blueprint (§7b).
// Mocks only the I/O edges (tenant DB resolution, the Auth.js session) — every
// guard under test (requireSession/requireAdmin/requireApprover/
// assertCanAccessEmployee/getEmployeeScope) runs for real.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
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
          },
        }
      : null,
}));

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => undefined),
  sendTimesheetApprovedEmail: vi.fn(async () => undefined),
  sendTimesheetRejectedEmail: vi.fn(async () => undefined),
  sendDailyReminderEmail: vi.fn(async () => undefined),
  sendSubmissionDeadlineEmail: vi.fn(async () => undefined),
  sendPasswordResetEmail: vi.fn(async () => undefined),
}));

import { getUsers, updateUser, createUser } from '@/server/actions/users';
import { createApiKey } from '@/server/actions/api-keys';
import { bulkImportEmployees } from '@/server/actions/import';
import { startCheckout } from '@/server/actions/billing';
import { listChargeCodes } from '@/server/actions/charge-codes';
import { adminResetPassword } from '@/server/actions/password';
import { approvePeriod, rejectPeriod } from '@/server/actions/periods';
import { getTimesheetForReview, saveTimesheetBatch } from '@/server/actions/timesheet';
import { getTimesheetReportData } from '@/server/actions/reports';
import { getAuditEntries } from '@/server/actions/audit';

function actingAs(user: FakeSessionUser | null) {
  sessionState.user = user;
}

function asFake(user: Awaited<ReturnType<typeof createTestUser>>): FakeSessionUser {
  return { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Authorization matrix (security-hardening blueprint §7b)', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  // 1. ---------------------------------------------------------------------
  it('1. unauthenticated caller is rejected', async () => {
    actingAs(null);
    await expect(getUsers()).rejects.toThrow(/Unauthorized/);
  });

  // 2. ---------------------------------------------------------------------
  it('2. an employee cannot approve any period, including their own', async () => {
    const employee = await createTestUser({ role: 'employee' });
    const db = getTestDb();
    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: getPeriodStartForDate(new Date()),
      status: 'submitted',
      submittedAt: new Date(),
    }).returning();

    actingAs(asFake(employee));
    await expect(approvePeriod({ periodId: period.id })).rejects.toThrow(/Approver role required/);
  });

  // 3. ---------------------------------------------------------------------
  it('3. a supervisor approves in-scope, is blocked out-of-scope, and cannot approve their own period', async () => {
    const db = getTestDb();
    const supervisor = await createTestUser({ role: 'supervisor' });
    const contract = await createTestContract();
    const scopedClin = await createTestClin(contract.id);
    const otherClin = await createTestClin(contract.id);

    await assignUserToClin(supervisor.id, scopedClin.id);

    const inScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(inScopeEmployee.id, scopedClin.id);

    const outOfScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(outOfScopeEmployee.id, otherClin.id);

    const periodStart = getPeriodStartForDate(new Date());

    const [inScopePeriod] = await db.insert(schema.timesheetPeriods).values({
      userId: inScopeEmployee.id, periodStart, status: 'submitted', submittedAt: new Date(),
    }).returning();
    const [outOfScopePeriod] = await db.insert(schema.timesheetPeriods).values({
      userId: outOfScopeEmployee.id, periodStart, status: 'submitted', submittedAt: new Date(),
    }).returning();
    const [ownPeriod] = await db.insert(schema.timesheetPeriods).values({
      userId: supervisor.id, periodStart, status: 'submitted', submittedAt: new Date(),
    }).returning();

    actingAs(asFake(supervisor));

    await approvePeriod({ periodId: inScopePeriod.id });
    const [approved] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, inScopePeriod.id));
    expect(approved.status).toBe('approved');

    await expect(rejectPeriod({ periodId: outOfScopePeriod.id, comment: 'nope' }))
      .rejects.toThrow(/not authorized/i);

    await expect(approvePeriod({ periodId: ownPeriod.id }))
      .rejects.toThrow(/cannot approve your own timesheet/i);
  });

  // 4. ---------------------------------------------------------------------
  it('4. a supervisor is blocked from every admin-only action', async () => {
    const supervisor = await createTestUser({ role: 'supervisor' });
    const target = await createTestUser({ role: 'employee' });
    actingAs(asFake(supervisor));

    await expect(updateUser(target.id, { fullName: 'New Name' })).rejects.toThrow(/Admin role required/);
    await expect(createUser({ email: `new-${Date.now()}@bytime.dev`, fullName: 'New User' })).rejects.toThrow(/Admin role required/);
    await expect(createApiKey({ name: 'test key' })).rejects.toThrow(/Admin role required/);
    await expect(bulkImportEmployees([])).rejects.toThrow(/Admin role required/);
    await expect(startCheckout('starter')).rejects.toThrow(/Admin role required/);
    await expect(listChargeCodes()).rejects.toThrow(/Admin role required/);
  });

  // 5. ---------------------------------------------------------------------
  it('5. an admin cannot change their own role or deactivate themselves', async () => {
    const admin = await createTestUser({ role: 'admin' });
    actingAs(asFake(admin));

    await expect(updateUser(admin.id, { role: 'employee' })).rejects.toThrow(/cannot change your own role/i);
    await expect(updateUser(admin.id, { isActive: false })).rejects.toThrow(/cannot deactivate your own account/i);
  });

  it('5b. nobody can demote the last active admin — enforced from DB truth, not the session', async () => {
    // Models a stale/divergent session: the caller's session claims 'admin' (so it clears
    // requireAdmin()), but their own DB row is NOT an active admin — e.g. a role change by
    // another admin that this session's JWT hasn't revalidated yet (there's up to a 60s
    // window in the auth.ts jwt callback). The target is the one remaining real admin.
    // This is the only way to exercise the check: the self-change guard above always fires
    // first for a real admin acting on themselves, so the last-admin count (which excludes
    // only the target, per `ne(users.id, id)`) can only ever hit zero when the actor's own
    // DB row doesn't count as an active admin.
    const soleAdmin = await createTestUser({ role: 'admin' });
    const staleActor = await createTestUser({ role: 'employee' });
    actingAs({ id: staleActor.id, role: 'admin', email: staleActor.email, fullName: staleActor.fullName });

    await expect(updateUser(soleAdmin.id, { role: 'employee' }))
      .rejects.toThrow(/last active admin/i);
    await expect(updateUser(soleAdmin.id, { isActive: false }))
      .rejects.toThrow(/last active admin/i);
  });

  // 6. ---------------------------------------------------------------------
  it('6. saveTimesheetBatch always writes under the session actor, even if the caller injects another id', async () => {
    const employee = await createTestUser({ role: 'employee' });
    const otherEmployee = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);

    const db = getTestDb();
    await db.insert(schema.userChargeCodes).values({ userId: employee.id, chargeCodeId: chargeCode.id, isActive: true });

    const periodStart = getPeriodStartForDate(new Date());
    const todayIndex = dayjs().startOf('day').diff(dayjs(periodStart), 'day');

    actingAs(asFake(employee));
    await saveTimesheetBatch({
      // @ts-expect-error — simulating a malicious/legacy client that still sends userId;
      // the action no longer declares this param, so it must be silently ignored.
      userId: otherEmployee.id,
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 4, isEdit: false, isLateEntry: false }],
    });

    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(employee.id);
    expect(rows[0].userId).not.toBe(otherEmployee.id);
  });

  // 7. ---------------------------------------------------------------------
  it('7. employee A cannot read employee B\'s timesheet; a supervisor can only read in-scope employees', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const scopedClin = await createTestClin(contract.id);
    const otherClin = await createTestClin(contract.id);

    const supervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(supervisor.id, scopedClin.id);

    const employeeA = await createTestUser({ role: 'employee' });
    const employeeB = await createTestUser({ role: 'employee' });
    await assignUserToClin(employeeB.id, scopedClin.id);

    const employeeC = await createTestUser({ role: 'employee' });
    await assignUserToClin(employeeC.id, otherClin.id);

    const periodStart = getPeriodStartForDate(new Date());

    actingAs(asFake(employeeA));
    await expect(getTimesheetForReview(employeeB.id, periodStart)).rejects.toThrow(/not authorized/i);
    await expect(getTimesheetReportData(employeeB.id, periodStart)).rejects.toThrow(/not authorized/i);

    actingAs(asFake(supervisor));
    await expect(getTimesheetForReview(employeeB.id, periodStart)).resolves.toBeDefined();
    await expect(getTimesheetForReview(employeeC.id, periodStart)).rejects.toThrow(/not authorized/i);
  });

  // 8. ---------------------------------------------------------------------
  it('8. getAuditEntries is scoped to the supervisor\'s employees; admin sees everyone', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const scopedClin = await createTestClin(contract.id);
    const otherClin = await createTestClin(contract.id);
    const scopedCode = await createTestChargeCode(scopedClin.id);
    const otherCode = await createTestChargeCode(otherClin.id);

    const supervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(supervisor.id, scopedClin.id);

    const inScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(inScopeEmployee.id, scopedClin.id);
    const outOfScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(outOfScopeEmployee.id, otherClin.id);

    await db.insert(schema.timesheetEntries).values({
      userId: inScopeEmployee.id, clinId: scopedClin.id, entryDate: new Date(), hours: '2', revisionNumber: 1, createdBy: inScopeEmployee.id,
    });
    await db.insert(schema.timesheetEntries).values({
      userId: outOfScopeEmployee.id, clinId: otherClin.id, entryDate: new Date(), hours: '3', revisionNumber: 1, createdBy: outOfScopeEmployee.id,
    });

    actingAs(asFake(supervisor));
    const scoped = await getAuditEntries({});
    expect(scoped.map((e) => e.userId)).toEqual([inScopeEmployee.id]);

    const admin = await createTestUser({ role: 'admin' });
    actingAs(asFake(admin));
    const all = await getAuditEntries({});
    expect(all.map((e) => e.userId).sort()).toEqual([inScopeEmployee.id, outOfScopeEmployee.id].sort());
  });

  // 12. --------------------------------------------------------------------
  it('12. adminResetPassword invalidates the target\'s existing sessions', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const target = await createTestUser({ role: 'employee' });
    const db = getTestDb();

    actingAs(asFake(admin));
    const result = await adminResetPassword({ targetUserId: target.id, newPassword: 'BrandNewPass123!' });
    expect(result.success).toBe(true);

    const [updated] = await db.select({ sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, target.id));
    expect(updated.sessionVersion).toBe((target.sessionVersion ?? 1) + 1);
  });
});

// ---------------------------------------------------------------------------
// 11. Cron endpoints fail closed when CRON_SECRET is unset in production —
// previously `if (process.env.CRON_SECRET && cronSecret !== ...)` failed OPEN
// (skipped the check entirely) when CRON_SECRET was never configured.
// ---------------------------------------------------------------------------
describe('11. Cron endpoints fail closed in production with no CRON_SECRET configured', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCronSecret = process.env.CRON_SECRET;

  afterEach(() => {
    vi.stubEnv('NODE_ENV', originalNodeEnv ?? 'test');
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    vi.unstubAllEnvs();
  });

  it('submission-deadline cron returns 401 in production with no CRON_SECRET set, request unauthenticated', async () => {
    delete process.env.CRON_SECRET;
    vi.stubEnv('NODE_ENV', 'production');

    const { GET } = await import('@/app/api/cron/submission-deadline/route');
    const { NextRequest } = await import('next/server');
    const request = new NextRequest('http://localhost:3000/api/cron/submission-deadline', {
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });

    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it('daily-reminder cron returns 401 in production with no CRON_SECRET set, request unauthenticated', async () => {
    delete process.env.CRON_SECRET;
    vi.stubEnv('NODE_ENV', 'production');

    const { GET } = await import('@/app/api/cron/daily-reminder/route');
    const { NextRequest } = await import('next/server');
    const request = new NextRequest('http://localhost:3000/api/cron/daily-reminder', {
      headers: { 'x-forwarded-for': '203.0.113.12' },
    });

    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});
