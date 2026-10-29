import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { addMonths, diffDays, todayIn, type CalendarDate } from '@/lib/calendar-date';

// workspace_settings seeds 'America/New_York' by default (migration 0011); these tests never
// change it, so fixtures compute "today" the same way the real actions do.
const todayFixture = (): CalendarDate => todayIn('America/New_York');
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  assignUserToClin,
  cleanupTestData,
  expectOk,
  expectFailure,
} from './helpers';

// ---------------------------------------------------------------------------
// The 12-case authorization matrix from the security-hardening blueprint (§7b).
// Mocks only the I/O edges (tenant DB resolution, the Auth.js session) — every
// guard under test (requireSession/requireAdmin/requireApprover/
// assertCanAccessEmployee/getEmployeeScope) runs for real.
// ---------------------------------------------------------------------------

// Launch-blockers audit A3: while `writeClients.perCall` is on (case 5b), every getDbForWrite call gets its OWN
// one-connection client, so two concurrent demotions run truly concurrent transactions (the shared test client is
// `max: 1` and would serialise them, hiding a deadlock).
const writeClients = vi.hoisted(() => ({ perCall: false, open: [] as Array<{ end: () => Promise<void> }> }));
vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => {
    if (!writeClients.perCall) return getTestDb();
    const postgres = (await import('postgres')).default;
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const client = postgres(process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test', { max: 1 });
    writeClients.open.push(client);
    return drizzle(client, { schema: await import('@/db/schema') });
  },
  // requireAdminFresh/requireApproverFresh (R2-8) re-read the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

// R2-1: getSessionUser() now checks session.user.tenantSlug against the request's tenant
// (getTenantSlug()). Keep them matching here by default so existing tests exercise
// authorization, not the tenant-binding check — case 1e below is the one exception.
const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

// vitest 2.1.9 quirk (see dcaa-concurrency.test.ts): when two calls dynamically import() the same MOCKED module at the
// same moment, the overlapping one receives the REAL module. getSessionUser lazily imports the tenant context, so in
// the concurrent case (5b) one call runs the REAL getTenantSlug, which reads request headers. Give it headers that
// resolve to the same workspace, so the real guards stay under test whichever module a call receives.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: `${tenantState.requestSlug}.${process.env.APP_ROOT_DOMAIN ?? 'localhost'}` }),
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string; tenantSlug?: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
  /** Set below: when a call runs inside `als.run(actor, …)`, auth() returns that actor wherever it awaits. */
  als: null as null | { getStore(): FakeSessionUser | undefined },
}));

vi.mock('@/auth', () => ({
  auth: async () => {
    const user = sessionState.als?.getStore() ?? sessionState.user;
    return user
      ? {
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            tenantSlug: user.tenantSlug ?? tenantState.requestSlug,
          },
        }
      : null;
  },
}));

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetApprovedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendTimesheetRejectedEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
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

const actorStore = new AsyncLocalStorage<FakeSessionUser>();
sessionState.als = actorStore;

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
    tenantState.requestSlug = 'test-tenant';
    await cleanupTestData();
  });

  // 1. ---------------------------------------------------------------------
  it('1. unauthenticated caller is rejected', async () => {
    actingAs(null);
    await expect(getUsers()).rejects.toThrow(/Unauthorized/);
  });

  // R2-1e. -------------------------------------------------------------------
  it('R2-1e. a session minted for tenant A is rejected on a request resolved to tenant B', async () => {
    const admin = await createTestUser({ role: 'admin' });
    actingAs({ ...asFake(admin), tenantSlug: 'tenant-a' });
    tenantState.requestSlug = 'tenant-b';

    await expect(getUsers()).rejects.toThrow(/Unauthorized/);
  });

  // 2. ---------------------------------------------------------------------
  it('2. an employee cannot approve any period, including their own', async () => {
    const employee = await createTestUser({ role: 'employee' });
    const db = getTestDb();
    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart: getPeriodStartForDate(todayFixture(), DEFAULT_PERIOD_CONFIG),
      status: 'submitted',
      submittedAt: new Date(),
    }).returning();

    actingAs(asFake(employee));
    await expectFailure(approvePeriod({ periodId: period.id, seen: 0 }), 'forbidden', /Approver role required/);
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

    const periodStart = getPeriodStartForDate(todayFixture(), DEFAULT_PERIOD_CONFIG);

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

    await expectOk(approvePeriod({ periodId: inScopePeriod.id, seen: 0 }));
    const [approved] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, inScopePeriod.id));
    expect(approved.status).toBe('approved');

    // R2-12: an out-of-scope period must look exactly like a missing one, not disclose that it exists.
    await expectFailure(rejectPeriod({ periodId: outOfScopePeriod.id, comment: 'nope', seen: 0 }), 'not_found', /Period not found/);

    // R2-7: a supervisor's own period is refused outright (Forbidden) — nothing to mask.
    await expectFailure(approvePeriod({ periodId: ownPeriod.id, seen: 0 }), 'forbidden', /Forbidden: You cannot approve your own timesheet/);
    await expectFailure(rejectPeriod({ periodId: ownPeriod.id, comment: 'x', seen: 0 }), 'forbidden', /Forbidden: You cannot reject your own timesheet/);
  });

  // R2-7. -------------------------------------------------------------------
  it('R2-7. an admin may approve their own period (marked reviewedBy = self); a supervisor still cannot', async () => {
    const db = getTestDb();
    const admin = await createTestUser({ role: 'admin' });
    const periodStart = getPeriodStartForDate(todayFixture(), DEFAULT_PERIOD_CONFIG);

    const [ownPeriod] = await db.insert(schema.timesheetPeriods).values({
      userId: admin.id, periodStart, status: 'submitted', submittedAt: new Date(),
    }).returning();

    actingAs(asFake(admin));
    await expectOk(approvePeriod({ periodId: ownPeriod.id, seen: 0 }));

    const [approved] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, ownPeriod.id));
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe(admin.id); // self-approved — reviewedBy === the period's own userId

    // A second admin period, rejected by themselves, to prove reject is allowed too.
    const [ownPeriod2] = await db.insert(schema.timesheetPeriods).values({
      userId: admin.id, periodStart: addMonths(periodStart, -1), status: 'submitted', submittedAt: new Date(),
    }).returning();
    await expectOk(rejectPeriod({ periodId: ownPeriod2.id, comment: 'self-correction needed', seen: 0 }));
    const [rejected] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, ownPeriod2.id));
    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewedBy).toBe(admin.id);
  });

  // 4. ---------------------------------------------------------------------
  it('4. a supervisor is blocked from every admin-only action', async () => {
    const supervisor = await createTestUser({ role: 'supervisor' });
    const target = await createTestUser({ role: 'employee' });
    actingAs(asFake(supervisor));

    await expectFailure(updateUser(target.id, { fullName: 'New Name' }), 'forbidden', /Admin role required/);
    await expectFailure(createUser({ email: `new-${Date.now()}@bytime.dev`, fullName: 'New User' }), 'forbidden', /Admin role required/);
    await expectFailure(createApiKey({ name: 'test key' }), 'forbidden', /Admin role required/);
    await expectFailure(bulkImportEmployees([]), 'forbidden', /Admin role required/);
    await expectFailure(startCheckout('starter'), 'forbidden', /Admin role required/);
    await expect(listChargeCodes()).rejects.toThrow(/Admin role required/);
  });

  // 5. ---------------------------------------------------------------------
  it('5. an admin cannot change their own role or deactivate themselves', async () => {
    const admin = await createTestUser({ role: 'admin' });
    actingAs(asFake(admin));

    await expectFailure(updateUser(admin.id, { role: 'employee' }), 'forbidden', /cannot change your own role/i);
    await expectFailure(updateUser(admin.id, { isActive: false }), 'forbidden', /cannot deactivate your own account/i);
  });

  it('5b. nobody can demote the last active admin — enforced from DB truth, not the session', async () => {
    const db = getTestDb();
    const activeAdminCount = async () =>
      (await db.select({ id: schema.users.id }).from(schema.users)
        .where(and(eq(schema.users.role, 'admin'), eq(schema.users.isActive, true)))).length;

    // (a) A stale session claiming 'admin' whose DB row is an employee is refused by the fresh
    // role check (R2-8) before it can touch the last real admin.
    const soleAdmin = await createTestUser({ role: 'admin' });
    const staleActor = await createTestUser({ role: 'employee' });
    actingAs({ id: staleActor.id, role: 'admin', email: staleActor.email, fullName: staleActor.fullName });
    await expectFailure(updateUser(soleAdmin.id, { role: 'employee' }), 'forbidden', /access has changed/i);
    await expectFailure(updateUser(soleAdmin.id, { isActive: false }), 'forbidden', /access has changed/i);
    expect(await activeAdminCount()).toBe(1);

    // (b) Two admins demote each other at the same moment, on separate connections (audit A3). Exactly one wins; the
    // other gets the last-admin refusal — never a deadlock (40P01 would surface as a thrown, unexpected error and
    // reject Promise.all). Several rounds, so an opposite-order lock shows up reliably.
    writeClients.perCall = true;
    try {
      for (let round = 0; round < 5; round++) {
        await cleanupTestData();
        const adminA = await createTestUser({ role: 'admin' });
        const adminB = await createTestUser({ role: 'admin' });
        // Each call carries its own actor through every await (AsyncLocalStorage) — never a shared, mutable session.
        const first = actorStore.run(asFake(adminA), () => updateUser(adminB.id, { role: 'employee' }));
        const second = actorStore.run(asFake(adminB), () => updateUser(adminA.id, { role: 'employee' }));
        const results = await Promise.all([first, second]); // ActionResults; a thrown error (deadlock) fails the test

        const tag = `round ${round}: ${JSON.stringify(results)}`;
        expect(results.filter((r) => r.ok), tag).toHaveLength(1);
        expect(results.find((r) => !r.ok), tag).toMatchObject({
          ok: false,
          code: 'forbidden',
          error: expect.stringMatching(/last active admin|access has changed/i),
        });
        expect(await activeAdminCount(), tag).toBe(1);
      }
    } finally {
      writeClients.perCall = false;
      await Promise.all(writeClients.open.splice(0).map((c) => c.end()));
    }
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

    const periodStart = getPeriodStartForDate(todayFixture(), DEFAULT_PERIOD_CONFIG);
    const todayIndex = diffDays(periodStart, todayFixture());

    actingAs(asFake(employee));
    await expectOk(saveTimesheetBatch({
      expectedUserId: employee.id,
      // @ts-expect-error — simulating a malicious/legacy client that still sends userId;
      // the action no longer declares this param, so it must be silently ignored.
      userId: otherEmployee.id,
      periodStart,
      cells: [{ chargeCodeId: chargeCode.id, dayIndex: todayIndex, hours: 4, isEdit: false, isLateEntry: false }],
    }));

    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.chargeCodeId, chargeCode.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(employee.id);
    expect(rows[0].userId).not.toBe(otherEmployee.id);
  });

  // 7. ---------------------------------------------------------------------
  it('7. employee A cannot read employee B\'s timesheet; a supervisor can only read in-scope employees', async () => {
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

    const periodStart = getPeriodStartForDate(todayFixture(), DEFAULT_PERIOD_CONFIG);

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

    const supervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(supervisor.id, scopedClin.id);

    const inScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(inScopeEmployee.id, scopedClin.id);
    const outOfScopeEmployee = await createTestUser({ role: 'employee' });
    await assignUserToClin(outOfScopeEmployee.id, otherClin.id);

    await db.insert(schema.timesheetEntries).values({
      userId: inScopeEmployee.id, clinId: scopedClin.id, entryDate: todayFixture(), hours: '2', revisionNumber: 1, createdBy: inScopeEmployee.id,
    });
    await db.insert(schema.timesheetEntries).values({
      userId: outOfScopeEmployee.id, clinId: otherClin.id, entryDate: todayFixture(), hours: '3', revisionNumber: 1, createdBy: outOfScopeEmployee.id,
    });

    actingAs(asFake(supervisor));
    const scoped = (await getAuditEntries({})).entries;
    expect(scoped.map((e) => e.userId)).toEqual([inScopeEmployee.id]);

    const admin = await createTestUser({ role: 'admin' });
    actingAs(asFake(admin));
    const all = (await getAuditEntries({})).entries;
    expect(all.map((e) => e.userId).sort()).toEqual([inScopeEmployee.id, outOfScopeEmployee.id].sort());
  });

  // R2-12. ------------------------------------------------------------------
  it('R2-12. getEmployeeScope (and so getAuditEntries) includes the supervisor\'s own entries, consistent with assertCanAccessEmployee', async () => {
    const db = getTestDb();
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);

    const supervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(supervisor.id, clin.id);

    await db.insert(schema.timesheetEntries).values({
      userId: supervisor.id, clinId: clin.id, entryDate: todayFixture(), hours: '4', revisionNumber: 1, createdBy: supervisor.id,
    });

    actingAs(asFake(supervisor));
    const scoped = (await getAuditEntries({})).entries;
    expect(scoped.map((e) => e.userId)).toContain(supervisor.id);
  });

  // 12. --------------------------------------------------------------------
  it('12. adminResetPassword invalidates the target\'s existing sessions', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const target = await createTestUser({ role: 'employee' });
    const db = getTestDb();

    actingAs(asFake(admin));
    await expectOk(adminResetPassword({ targetUserId: target.id, newPassword: 'BrandNewPass123!' }));

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
