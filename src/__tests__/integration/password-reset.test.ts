import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, flushAfter } from './helpers';

/**
 * feature-plan-launch-blockers.md P1 §4.2 / §9 "Reset" (database scenarios).
 *
 * The workspace is simulated as billing_only: getDb() refuses (as it does for a suspended workspace) while
 * getDbForAuth() — which tolerates billing_only — returns the test DB. A reset flow that still reached for getDb()
 * would fail here.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => { throw new Error('This workspace is suspended.'); },
  getDbForAuth: async () => getTestDb(),
}));

vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));

const sent = vi.hoisted(() => vi.fn(async (args: { resetUrl: string; appUrl: string }) => { void args; return { ok: true as const, id: 'test-message-id' }; }));
vi.mock('@/lib/email/send', () => ({ sendPasswordResetEmail: sent }));

import { requestPasswordReset, verifyResetToken, resetPassword } from '@/server/actions/password-reset';
import { tenantBaseUrl } from '@/lib/tenant/host';

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

async function issueToken(email: string, rawToken: string, expiresAt: Date) {
  await getTestDb().insert(schema.passwordResetTokens).values({ email, tokenHash: hash(rawToken), expiresAt });
}

describe('password reset (P1)', () => {
  beforeEach(async () => {
    await cleanupTestData();
    await getTestDb().delete(schema.passwordResetTokens);
    sent.mockClear();
  });
  afterEach(async () => {
    await getTestDb().delete(schema.passwordResetTokens);
    await cleanupTestData();
  });

  it('requested on a workspace host, the link points at that workspace host', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await expect(requestPasswordReset(admin.email)).resolves.toEqual({ success: true });
    await flushAfter();
    expect(sent).toHaveBeenCalledTimes(1);
    const arg = sent.mock.calls[0][0];
    expect(arg.appUrl).toBe(tenantBaseUrl('test-tenant'));
    expect(arg.resetUrl.startsWith(`${tenantBaseUrl('test-tenant')}/reset-password?token=`)).toBe(true);
  });

  it('a billing_only admin can verify the token and reset the password', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await issueToken(admin.email, 'tok-billing', new Date(Date.now() + 60 * 60_000));
    await expect(verifyResetToken(admin.email, 'tok-billing')).resolves.toEqual({ valid: true });
    await expect(resetPassword({ email: admin.email, token: 'tok-billing', newPassword: 'NewPassword123!' }))
      .resolves.toEqual({ success: true });
  });

  it('two concurrent resets with the same token: exactly one succeeds', async () => {
    const user = await createTestUser();
    await issueToken(user.email, 'tok-race', new Date(Date.now() + 60 * 60_000));
    const results = await Promise.all([
      resetPassword({ email: user.email, token: 'tok-race', newPassword: 'FirstPassword123!' }),
      resetPassword({ email: user.email, token: 'tok-race', newPassword: 'SecondPassword123!' }),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success)).toHaveLength(1);
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.sessionVersion).toBe(user.sessionVersion + 1); // bumped exactly once
  });

  it('an expired token is refused and the password is unchanged', async () => {
    const user = await createTestUser();
    await issueToken(user.email, 'tok-expired', new Date(Date.now() - 1000));
    const result = await resetPassword({ email: user.email, token: 'tok-expired', newPassword: 'NewPassword123!' });
    expect(result.success).toBe(false);
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.passwordHash).toBe(user.passwordHash);
  });

  it('a successful reset bumps sessionVersion (ends every existing session) and consumes the token', async () => {
    const user = await createTestUser();
    await getTestDb().update(schema.users).set({ sessionVersion: 7 }).where(eq(schema.users.id, user.id));
    await issueToken(user.email, 'tok-ok', new Date(Date.now() + 60 * 60_000));
    await expect(resetPassword({ email: user.email, token: 'tok-ok', newPassword: 'NewPassword123!' }))
      .resolves.toEqual({ success: true });
    const [row] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.sessionVersion).toBe(8);
    const [token] = await getTestDb().select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.tokenHash, hash('tok-ok')));
    expect(token.usedAt).not.toBeNull();
    // Reusing the token fails.
    expect((await resetPassword({ email: user.email, token: 'tok-ok', newPassword: 'Another123!!' })).success).toBe(false);
  });
});
