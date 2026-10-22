import { describe, it, expect, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getTestDb, createTestUser, cleanupTestData, expectFailure } from './helpers';

// ---------------------------------------------------------------------------
// R2-8: fresh authorization for sensitive actions. The JWT's cached role is
// refreshed at most every 60s and fails OPEN on DB error (see auth.ts). For
// sensitive, hard-to-undo actions, a demoted or deactivated admin must be
// denied IMMEDIATELY — not up to a minute later — and the check must fail
// CLOSED. requireAdminFresh()/requireApproverFresh() re-read role/isActive
// straight from the tenant DB on every call, bypassing the token entirely.
//
// Models a session whose claimed role is stale relative to the DB — exactly
// the gap a cached JWT creates between a role change and the next refresh.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
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

import { adminResetPassword } from '@/server/actions/password';
import { approvePeriod } from '@/server/actions/periods';

function actingAsStale(user: Awaited<ReturnType<typeof createTestUser>>, claimedRole: string) {
  // The SESSION claims claimedRole (as a stale/cached JWT would); the user's real DB row is
  // whatever `user` currently is, which the test sets up to have diverged from that claim.
  sessionState.user = { id: user.id, role: claimedRole, email: user.email, fullName: user.fullName };
}

describe('Fresh authorization for sensitive actions (R2-8)', () => {
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('adminResetPassword denies a session claiming admin whose DB role has been demoted to employee', async () => {
    await cleanupTestData();
    const demoted = await createTestUser({ role: 'employee' }); // DB truth: employee now
    const target = await createTestUser({ role: 'employee' });
    actingAsStale(demoted, 'admin'); // stale session: still claims admin

    await expect(
      adminResetPassword({ targetUserId: target.id, newPassword: 'NewPassword123!' })
    ).rejects.toThrow(/access has changed/i);
  });

  it('adminResetPassword denies a session claiming admin whose DB row has been deactivated', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const deactivatedAdmin = await createTestUser({ role: 'admin', isActive: false }); // DB truth: deactivated
    const target = await createTestUser({ role: 'employee' });
    actingAsStale(deactivatedAdmin, 'admin');

    await expect(
      adminResetPassword({ targetUserId: target.id, newPassword: 'NewPassword123!' })
    ).rejects.toThrow(/access has changed/i);

    const [row] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, target.id));
    expect(row.passwordHash).not.toBeNull(); // unchanged — the reset never happened
  });

  it('approvePeriod denies a session claiming admin whose DB role has been demoted to supervisor (self-approval no longer allowed)', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const demoted = await createTestUser({ role: 'supervisor' }); // DB truth: supervisor now, not admin
    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: demoted.id,
      periodStart: '2026-01-01',
      status: 'submitted',
      submittedAt: new Date(),
    }).returning();

    actingAsStale(demoted, 'admin'); // stale session: still claims admin
    // The fresh guard admits a supervisor, but must hand back the DB role, so the admin-only
    // self-approval exception no longer applies.
    await expectFailure(approvePeriod({ periodId: period.id }), 'forbidden', /cannot approve your own timesheet/i);

    const [unchanged] = await db.select({ status: schema.timesheetPeriods.status }).from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, period.id));
    expect(unchanged.status).toBe('submitted');
  });
});
