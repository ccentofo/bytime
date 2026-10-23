import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { encrypt } from '@/lib/encryption';
import { hashRecoveryCode } from '@/lib/totp';
import { getTestDb, createTestUser, cleanupTestData, expectFailure } from './helpers';

/**
 * feature-plan-launch-blockers.md P3 / §9 "Account security" (database scenarios). getDbForAuth returns the test DB, so
 * login_attempts counting and row locks run for real.
 *
 * vitest 2.1.9 quirk (see dcaa-concurrency.test.ts): when two calls dynamically import() the same MOCKED module at the
 * same moment, the overlapping one receives the REAL module. The real getDbForAuth lazily imports the tenant context
 * and registry, so the concurrent sign-in test would see a "missing workspace" (null) instead of the row-lock outcome.
 * getDbForAuth is therefore stubbed (production has no mocks; Node imports of loaded modules are safe).
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

vi.mock('@/db', async (importOriginal) => {
  const { getTestDb } = await import('./helpers');
  return { ...(await importOriginal<typeof import('@/db')>()), getDbForAuth: async () => getTestDb() };
});

vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) => slug === 'test-tenant'
    ? {
        id: 'test-tenant-id', slug: 'test-tenant', name: 'Test Tenant', status: 'active', plan: 'trial', dbUrl: TEST_DB_URL,
        subscriptionStatus: null, stripeSubscriptionId: null, trialEndsAt: null, pastDueSince: null, suspendedAt: null,
        suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null, firstGoodAt: null, lifecycleExempt: false,
        policyExportAllowed: false, stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null,
        neonProjectId: null, lifecycleVersion: 0,
      }
    : null,
}));

const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; email: string; fullName: string; role: string } }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  requireSession: async () => {
    if (!sessionState.user) throw new Error('Unauthorized: No active session');
    return sessionState.user;
  },
}));

import { authorizeCredentials } from '@/auth';
import { changePassword } from '@/server/actions/password';
import { disableMFA, completeMFASetup } from '@/server/actions/mfa';

const PASSWORD = 'CorrectHorseBattery9!';

async function userWithPassword(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const user = await createTestUser({ passwordHash: await bcrypt.hash(PASSWORD, 4), ...overrides });
  sessionState.user = { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
  return user;
}

describe('account security (P3)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

  it('MFA setup without the current password is refused; MFA stays off', async () => {
    const user = await userWithPassword();
    await expectFailure(completeMFASetup({ pendingSecret: 'JBSWY3DPEHPK3PXP', code: '000000', currentPassword: '' }), 'validation', /incorrect/i);
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.totpEnabled).toBe(false);
  });

  it('MFA setup on an account with no password → "Set a password first"', async () => {
    await userWithPassword({ passwordHash: null });
    await expectFailure(completeMFASetup({ pendingSecret: 'JBSWY3DPEHPK3PXP', code: '000000', currentPassword: 'x' }), 'validation', /^Set a password first\.$/);
  });

  it('two concurrent sign-ins with the same recovery code: exactly one succeeds', async () => {
    const CODE = 'ABCD2345';
    const user = await userWithPassword({
      totpEnabled: true,
      totpSecret: null,
      totpRecoveryCodes: encrypt(JSON.stringify([hashRecoveryCode(CODE), hashRecoveryCode('ZZZZ9999')])),
    });
    const attempt = () => authorizeCredentials({ email: user.email, password: PASSWORD, mfaCode: CODE })
      .then((u) => (u ? 'ok' : 'null'), (e: { code?: string; message?: string }) => `rejected:${e?.code ?? e?.message}`);
    const results = await Promise.all([attempt(), attempt()]);
    // The loser must be refused as an invalid MFA code (the code was consumed by the winner) — never signed in.
    expect([...results].sort(), JSON.stringify(results)).toEqual(['ok', 'rejected:mfa_invalid']);
  });

  it('changePassword: the 6th attempt after 5 bad passwords is refused even with the right password', async () => {
    const user = await userWithPassword();
    for (let i = 0; i < 5; i++) {
      await expectFailure(changePassword({ currentPassword: `wrong-${i}`, newPassword: 'BrandNewPass123!' }), 'validation', /^Current password is incorrect\.$/);
    }
    await expectFailure(changePassword({ currentPassword: PASSWORD, newPassword: 'BrandNewPass123!' }), 'validation', /too many failed attempts/i);
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(await bcrypt.compare(PASSWORD, row.passwordHash!)).toBe(true); // unchanged
  });

  it('disableMFA: the 6th attempt after 5 bad passwords is refused; MFA stays on', async () => {
    const user = await userWithPassword({ totpEnabled: true, totpSecret: encrypt('JBSWY3DPEHPK3PXP') });
    for (let i = 0; i < 5; i++) {
      await expectFailure(disableMFA(`wrong-${i}`), 'validation', /incorrect/i);
    }
    await expectFailure(disableMFA(PASSWORD), 'validation', /too many failed attempts/i);
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.totpEnabled).toBe(true);
  });
});
