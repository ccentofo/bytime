import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { encrypt, decrypt } from '@/lib/encryption';
import { hashRecoveryCode } from '@/lib/totp';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

// ---------------------------------------------------------------------------
// Cases 9 & 10 of the security-hardening blueprint's authorization matrix
// (§7b): the MFA sign-in flow (now inline in auth.ts's authorize(), not a
// separate verifyMFALogin action) and suspended-workspace sign-in (F10).
//
// Exercises the REAL authorizeCredentials() from @/auth — extracted out of the
// Credentials provider config specifically so it's callable without driving
// the full NextAuth request stack. Only the tenant-resolution layer is mocked,
// pointed at the real test database, so checkLockout/recordFailedAttempt/
// recordSuccessfulLogin (which all go through getDbForAuth) run for real.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

let tenantStatus: 'active' | 'suspended' = 'active';

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
}));

vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) =>
    slug === 'test-tenant'
      ? {
          id: 'test-tenant-id',
          slug: 'test-tenant',
          name: 'Test Tenant',
          status: tenantStatus,
          plan: 'trial',
          dbUrl: TEST_DB_URL,
        }
      : null,
}));

import { authorizeCredentials } from '@/auth';

function currentTotpCode(base32Secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'CadenzPoint',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}

describe('MFA sign-in flow and suspended-workspace sign-in (F10)', () => {
  const PASSWORD = 'CorrectHorseBattery9!';

  beforeEach(async () => {
    await cleanupTestData();
    tenantStatus = 'active';
  });

  afterEach(async () => {
    tenantStatus = 'active';
    await cleanupTestData();
  });

  // 9. ---------------------------------------------------------------------
  it('9a. requires an MFA code when TOTP is enabled and none is submitted', async () => {
    const db = getTestDb();
    const hash = await (await import('bcryptjs')).default.hash(PASSWORD, 4);
    const [user] = await db.insert(schema.users).values({
      email: `mfa-required-${Date.now()}@bytime.dev`,
      fullName: 'MFA User',
      role: 'employee',
      passwordHash: hash,
      isActive: true,
      totpEnabled: true,
      totpSecret: encrypt('JBSWY3DPEHPK3PXP'),
    }).returning();

    await expect(
      authorizeCredentials({ email: user.email, password: PASSWORD })
    ).rejects.toMatchObject({ code: 'mfa_required' });
  });

  it('9b. rejects an invalid TOTP code and counts it as a failed attempt', async () => {
    const db = getTestDb();
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const email = `mfa-invalid-${Date.now()}@bytime.dev`;
    await db.insert(schema.users).values({
      email, fullName: 'MFA User', role: 'employee', passwordHash: hash, isActive: true,
      totpEnabled: true, totpSecret: encrypt('JBSWY3DPEHPK3PXP'),
    });

    await expect(
      authorizeCredentials({ email, password: PASSWORD, mfaCode: '000000' })
    ).rejects.toMatchObject({ code: 'mfa_invalid' });

    const attempts = await db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.email, email));
    expect(attempts.some((a) => !a.successful)).toBe(true);
  });

  it('9c. accepts a valid TOTP code and completes sign-in', async () => {
    const db = getTestDb();
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const secret = 'JBSWY3DPEHPK3PXP';
    const email = `mfa-valid-${Date.now()}@bytime.dev`;
    const [user] = await db.insert(schema.users).values({
      email, fullName: 'MFA User', role: 'employee', passwordHash: hash, isActive: true,
      totpEnabled: true, totpSecret: encrypt(secret),
    }).returning();

    const result = await authorizeCredentials({ email, password: PASSWORD, mfaCode: currentTotpCode(secret) });
    expect(result?.id).toBe(user.id);
  });

  // R2-12 ---------------------------------------------------------------
  it('rejects a reused TOTP code — the same code cannot sign in twice, even within its own window', async () => {
    const db = getTestDb();
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const secret = 'JBSWY3DPEHPK3PXP';
    const email = `mfa-replay-${Date.now()}@bytime.dev`;
    await db.insert(schema.users).values({
      email, fullName: 'MFA User', role: 'employee', passwordHash: hash, isActive: true,
      totpEnabled: true, totpSecret: encrypt(secret),
    });

    const code = currentTotpCode(secret);
    const first = await authorizeCredentials({ email, password: PASSWORD, mfaCode: code });
    expect(first?.email).toBe(email);

    // Same code, immediately replayed — still within its validity window, but must be rejected.
    await expect(
      authorizeCredentials({ email, password: PASSWORD, mfaCode: code })
    ).rejects.toMatchObject({ code: 'mfa_invalid' });
  });

  it('9d. a recovery code signs in and is consumed — a second use of the same code fails', async () => {
    const db = getTestDb();
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const secret = 'JBSWY3DPEHPK3PXP';
    const recoveryCode = 'ABCD1234';
    const email = `mfa-recovery-${Date.now()}@bytime.dev`;
    await db.insert(schema.users).values({
      email, fullName: 'MFA User', role: 'employee', passwordHash: hash, isActive: true,
      totpEnabled: true, totpSecret: encrypt(secret),
      totpRecoveryCodes: encrypt(JSON.stringify([hashRecoveryCode(recoveryCode)])),
    });

    const result = await authorizeCredentials({ email, password: PASSWORD, mfaCode: recoveryCode });
    expect(result?.email).toBe(email);

    const [updated] = await db.select({ totpRecoveryCodes: schema.users.totpRecoveryCodes }).from(schema.users).where(eq(schema.users.email, email));
    const remaining: string[] = JSON.parse(decrypt(updated.totpRecoveryCodes!));
    expect(remaining).toHaveLength(0);

    await expect(
      authorizeCredentials({ email, password: PASSWORD, mfaCode: recoveryCode })
    ).rejects.toMatchObject({ code: 'mfa_invalid' });
  });

  // 10. --------------------------------------------------------------------
  it('10. an admin on a suspended workspace can still complete sign-in (so they can reach billing)', async () => {
    const db = getTestDb();
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const email = `suspended-admin-${Date.now()}@bytime.dev`;
    const [admin] = await db.insert(schema.users).values({
      email, fullName: 'Suspended Workspace Admin', role: 'admin', passwordHash: hash, isActive: true,
    }).returning();

    tenantStatus = 'suspended';

    const result = await authorizeCredentials({ email, password: PASSWORD });
    expect(result?.id).toBe(admin.id);
    expect(result?.role).toBe('admin');
  });
});
