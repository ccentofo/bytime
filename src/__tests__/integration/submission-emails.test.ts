import { describe, it, expect, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  assignUserToClin,
  cleanupTestData,
  flushAfter,
  expectOk,
} from './helpers';
import { tenantBaseUrl } from '@/lib/tenant/host';

// ---------------------------------------------------------------------------
// R2-10: submitPeriod previously emailed EVERY supervisor and admin in the
// tenant, regardless of scope or active status. Now it must notify only
// active admins and active supervisors whose scope includes the submitter.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // approve/reject use requireApproverFresh, which re-reads the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

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

const emailState = vi.hoisted(() => ({
  sendTimesheetSubmittedEmail: vi.fn(async (args: { supervisorEmail: string; appUrl: string }) => { void args; return { ok: true as const, id: 'test-message-id' }; }),
  sendTimesheetApprovedEmail: vi.fn(async (args: { appUrl: string }) => { void args; return { ok: true as const, id: 'test-message-id' }; }),
  sendTimesheetRejectedEmail: vi.fn(async (args: { appUrl: string }) => { void args; return { ok: true as const, id: 'test-message-id' }; }),
}));

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: emailState.sendTimesheetSubmittedEmail,
  sendTimesheetApprovedEmail: emailState.sendTimesheetApprovedEmail,
  sendTimesheetRejectedEmail: emailState.sendTimesheetRejectedEmail,
  sendDailyReminderEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendSubmissionDeadlineEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })),
}));

import { submitPeriod, approvePeriod, rejectPeriod } from '@/server/actions/periods';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Submission notifications are scoped (R2-10)', () => {
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
    emailState.sendTimesheetSubmittedEmail.mockClear();
    emailState.sendTimesheetApprovedEmail.mockClear();
    emailState.sendTimesheetRejectedEmail.mockClear();
  });

  it('notifies only an in-scope, active supervisor — not an out-of-scope or inactive one', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const contract = await createTestContract();
    const scopedClin = await createTestClin(contract.id);
    const otherClin = await createTestClin(contract.id);

    const employee = await createTestUser({ role: 'employee' });
    await assignUserToClin(employee.id, scopedClin.id);

    const inScopeSupervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(inScopeSupervisor.id, scopedClin.id);

    const outOfScopeSupervisor = await createTestUser({ role: 'supervisor' });
    await assignUserToClin(outOfScopeSupervisor.id, otherClin.id);

    const inactiveInScopeSupervisor = await createTestUser({ role: 'supervisor', isActive: false });
    await assignUserToClin(inactiveInScopeSupervisor.id, scopedClin.id);

    const inactiveAdmin = await createTestUser({ role: 'admin', isActive: false });
    const activeAdmin = await createTestUser({ role: 'admin' });
    const optedOutAdmin = await createTestUser({ role: 'admin' });
    await db.insert(schema.notificationPreferences).values({ userId: optedOutAdmin.id, emailOnSubmit: false });

    const periodStart = '2020-01-01' as CalendarDate;
    await db.insert(schema.timesheetEntries).values({
      userId: employee.id,
      clinId: scopedClin.id,
      entryDate: periodStart,
      hours: '8',
      revisionNumber: 1,
      createdBy: employee.id,
    });

    actingAs(employee);
    await expectOk(submitPeriod({ periodStart }));
    await flushAfter(); // sends are scheduled with after() (feature-plan-launch-blockers.md P1)

    const notifiedEmails = emailState.sendTimesheetSubmittedEmail.mock.calls.map((call) => call[0].supervisorEmail);
    // Every link goes to the submitter's workspace host, never the apex.
    for (const call of emailState.sendTimesheetSubmittedEmail.mock.calls) {
      expect(call[0].appUrl).toBe(tenantBaseUrl('test-tenant'));
    }
    expect(notifiedEmails).toContain(inScopeSupervisor.email);
    expect(notifiedEmails).toContain(activeAdmin.email);
    expect(notifiedEmails).not.toContain(outOfScopeSupervisor.email);
    expect(notifiedEmails).not.toContain(inactiveAdmin.email);
    expect(notifiedEmails).not.toContain(inactiveInScopeSupervisor.email);
    expect(notifiedEmails).not.toContain(optedOutAdmin.email); // emailOnSubmit = false
    expect(notifiedEmails).not.toContain(employee.email); // never the submitter themselves
  });

  it('notifies on a re-submission after rejection too, and never emails an admin about their own submission', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const submittingAdmin = await createTestUser({ role: 'admin' });
    const otherAdmin = await createTestUser({ role: 'admin' });

    const periodStart = '2020-01-01' as CalendarDate;
    await db.insert(schema.timesheetEntries).values({
      userId: submittingAdmin.id, clinId: clin.id, entryDate: periodStart, hours: '8', revisionNumber: 1, createdBy: submittingAdmin.id,
    });
    // A previously rejected period: submitPeriod takes the update path, not the insert path.
    await db.insert(schema.timesheetPeriods).values({ userId: submittingAdmin.id, periodStart, status: 'rejected' });

    actingAs(submittingAdmin);
    await expectOk(submitPeriod({ periodStart }));
    await flushAfter();

    const notifiedEmails = emailState.sendTimesheetSubmittedEmail.mock.calls.map((call) => call[0].supervisorEmail);
    expect(notifiedEmails).toEqual([otherAdmin.email]);
  });
  it('approval and rejection emails link to the workspace host (tenantBaseUrl), not the apex', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const employee = await createTestUser({ role: 'employee' });
    await assignUserToClin(employee.id, clin.id);
    const admin = await createTestUser({ role: 'admin' });

    const [approveMe] = await db.insert(schema.timesheetPeriods)
      .values({ userId: employee.id, periodStart: '2020-01-01', status: 'submitted', submittedAt: new Date() }).returning();
    const [rejectMe] = await db.insert(schema.timesheetPeriods)
      .values({ userId: employee.id, periodStart: '2020-01-16', status: 'submitted', submittedAt: new Date() }).returning();

    actingAs(admin);
    await expectOk(approvePeriod({ periodId: approveMe.id }));
    await expectOk(rejectPeriod({ periodId: rejectMe.id, comment: 'Please fix Tuesday.' }));
    await flushAfter();

    expect(emailState.sendTimesheetApprovedEmail).toHaveBeenCalledTimes(1);
    expect(emailState.sendTimesheetApprovedEmail.mock.calls[0][0].appUrl).toBe(tenantBaseUrl('test-tenant'));
    expect(emailState.sendTimesheetRejectedEmail).toHaveBeenCalledTimes(1);
    expect(emailState.sendTimesheetRejectedEmail.mock.calls[0][0].appUrl).toBe(tenantBaseUrl('test-tenant'));
  });
});
