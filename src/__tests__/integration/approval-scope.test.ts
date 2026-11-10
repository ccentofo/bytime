import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getPeriodStartForDate, navigatePeriod, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn, type CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignApprovalScope, cleanupTestData, expectOk, expectFailure,
} from './helpers';

/**
 * feature-plan-approval-scope.md against Postgres (the guards run for real; only the I/O edges are mocked):
 * AS-3 — a supervisor with a charge code but no scope on X can't approve or see an employee on X.
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
import { canApprove, loadApprovalFacts, reviewScopeFrom } from '@/server/internal/approval-rules';

type U = Awaited<ReturnType<typeof createTestUser>>;
const actingAs = (u: U | null) => { sessionState.user = u ? { id: u.id, role: u.role, email: u.email, fullName: u.fullName } : null; };
const prevStart = (): CalendarDate => navigatePeriod(getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG), 'prev', DEFAULT_PERIOD_CONFIG);
const db = () => getTestDb();
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
});
