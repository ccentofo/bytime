import { describe, it, expect, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  assignUserToClin,
  cleanupTestData,
} from './helpers';

// ---------------------------------------------------------------------------
// R2-10: submitPeriod previously emailed EVERY supervisor and admin in the
// tenant, regardless of scope or active status. Now it must notify only
// active admins and active supervisors whose scope includes the submitter.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
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
  sendTimesheetSubmittedEmail: vi.fn(async (args: { supervisorEmail: string }) => { void args; }),
}));

vi.mock('@/lib/email/send', () => ({
  sendTimesheetSubmittedEmail: emailState.sendTimesheetSubmittedEmail,
  sendTimesheetApprovedEmail: vi.fn(async () => undefined),
  sendTimesheetRejectedEmail: vi.fn(async () => undefined),
  sendDailyReminderEmail: vi.fn(async () => undefined),
  sendSubmissionDeadlineEmail: vi.fn(async () => undefined),
  sendPasswordResetEmail: vi.fn(async () => undefined),
}));

import { submitPeriod } from '@/server/actions/periods';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Submission notifications are scoped (R2-10)', () => {
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
    emailState.sendTimesheetSubmittedEmail.mockClear();
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

    const inactiveAdmin = await createTestUser({ role: 'admin', isActive: false });
    const activeAdmin = await createTestUser({ role: 'admin' });

    const periodStart = new Date('2020-01-01');
    await db.insert(schema.timesheetEntries).values({
      userId: employee.id,
      clinId: scopedClin.id,
      entryDate: periodStart,
      hours: '8',
      revisionNumber: 1,
      createdBy: employee.id,
    });

    actingAs(employee);
    await submitPeriod({ periodStart });

    const notifiedEmails = emailState.sendTimesheetSubmittedEmail.mock.calls.map((call) => call[0].supervisorEmail);
    expect(notifiedEmails).toContain(inScopeSupervisor.email);
    expect(notifiedEmails).toContain(activeAdmin.email);
    expect(notifiedEmails).not.toContain(outOfScopeSupervisor.email);
    expect(notifiedEmails).not.toContain(inactiveAdmin.email);
    expect(notifiedEmails).not.toContain(employee.email); // never the submitter themselves
  });
});
