import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

// ---------------------------------------------------------------------------
// R2-6: mass assignment. Client objects were spread into DB writes, so a caller
// could set columns a form never offered — up to and including another user's
// id, an account's password hash, or its admin/active status.
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

import { updateUser } from '@/server/actions/users';
import { updateNotificationPreferences } from '@/server/actions/notifications';

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

describe('Mass assignment is blocked (R2-6)', () => {
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('updateNotificationPreferences cannot target another user via an injected userId', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const userA = await createTestUser({ role: 'employee' });
    const userB = await createTestUser({ role: 'employee' });
    actingAs(userA);

    await updateNotificationPreferences({
      emailOnSubmit: false,
      // @ts-expect-error — simulating a caller sending an extra field the type doesn't declare.
      userId: userB.id,
    });

    const rowsA = await db.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userA.id));
    const rowsB = await db.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userB.id));

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].emailOnSubmit).toBe(false);
    expect(rowsB).toHaveLength(0); // userB's row was never created/touched
  });

  it('updateUser ignores passwordHash, sessionVersion, and totpEnabled sent in the request', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const admin = await createTestUser({ role: 'admin' });
    const target = await createTestUser({ role: 'employee', passwordHash: 'original-hash', totpEnabled: false });
    actingAs(admin);

    await updateUser(target.id, {
      fullName: 'Updated Name',
      // @ts-expect-error — simulating a caller sending extra fields the type doesn't declare.
      passwordHash: 'attacker-controlled-hash',
      sessionVersion: 999,
      totpEnabled: true,
    });

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(row.fullName).toBe('Updated Name');
    expect(row.passwordHash).toBe('original-hash');
    expect(row.totpEnabled).toBe(false);
    expect(row.sessionVersion).toBe(target.sessionVersion ?? 1);
  });

  it('updateUser rejects an invalid role', async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    const target = await createTestUser({ role: 'employee' });
    actingAs(admin);

    await expect(
      updateUser(target.id, { role: 'superadmin' as any })
    ).rejects.toThrow();
  });

  it('updateUser normalizes email (lowercase, trimmed)', async () => {
    await cleanupTestData();
    const db = getTestDb();
    const admin = await createTestUser({ role: 'admin' });
    const target = await createTestUser({ role: 'employee' });
    actingAs(admin);

    await updateUser(target.id, { email: '  MixedCase@Example.COM  ' });

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(row.email).toBe('mixedcase@example.com');
  });
});
