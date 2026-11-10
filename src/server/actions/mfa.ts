'use server';

import { getDb, getDbForAuth } from '@/db';
import { users } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAdminFresh, requireSession } from '@/lib/session';
import { encrypt, decrypt } from '@/lib/encryption';
import { verifyCurrentPassword } from '@/server/internal/login-attempts';
import {
  generateTOTPSecret,
  verifyTOTPCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/totp';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { validateUUID } from '@/lib/validation';
import { logAdminChange } from '@/server/internal/admin-change-log';

// ---------------------------------------------------------------------------
// MFA Setup — all self-only. MFA login verification itself lives in auth.ts's
// authorize() (see the blueprint's "MFA inside sign-in" change) — there is no
// separate verifyMFALogin action anymore; no session exists until it passes.
// ---------------------------------------------------------------------------

/**
 * Initialize MFA setup — generates a new TOTP secret and returns the QR code URI.
 * The secret is NOT saved until the user verifies a code.
 * Returns the secret (to be stored temporarily in session/state) and the QR URI.
 */
export async function initMFASetup(): Promise<ActionResult<{ secret: string; uri: string }>> {
  // Launch-blockers audit A12: a result, so a refusal (e.g. signed out) reaches the page instead of a redacted digest.
  return userAction(async () => {
    const actor = await requireSession();
    return generateTOTPSecret(actor.email);
  });
}

/**
 * Complete MFA setup — re-authenticates with the current password (a stolen session alone must not be able to
 * bind its own authenticator to the account — feature-plan-launch-blockers.md P3), verifies the code against the
 * pending secret, then saves the encrypted secret + hashed recovery codes to the DB.
 * Returns the plaintext recovery codes (shown once to the user).
 */
export async function completeMFASetup(data: {
  pendingSecret: string;
  code: string;
  currentPassword: string;
}): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return userAction(async () => {
    const actor = await requireSession();
    const db = await getDbForAuth();

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.id));
    const reauth = await verifyCurrentPassword(db, actor.email, user?.passwordHash ?? null, data.currentPassword);
    if (!reauth.ok) {
      throw new UserFacingError(reauth.error);
    }

    // Verify the code against the pending secret
    const isValid = verifyTOTPCode(data.pendingSecret, data.code);
    if (!isValid) {
      throw new UserFacingError('Invalid code. Please try again.');
    }

    // Generate recovery codes
    const plainCodes = generateRecoveryCodes();
    const hashedCodes = plainCodes.map(hashRecoveryCode);

    // Encrypt and save
    const encryptedSecret = encrypt(data.pendingSecret);
    const encryptedRecoveryCodes = encrypt(JSON.stringify(hashedCodes));

    await db.update(users)
      .set({
        totpSecret: encryptedSecret,
        totpEnabled: true,
        totpRecoveryCodes: encryptedRecoveryCodes,
        updatedAt: new Date(),
      })
      .where(eq(users.id, actor.id));

    return { recoveryCodes: plainCodes };
  });
}

/**
 * Disable MFA — requires current password confirmation.
 */
export async function disableMFA(currentPassword: string): Promise<ActionResult<void>> {
  return userAction(async () => {
    const actor = await requireSession();
    const db = await getDbForAuth();

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.id));

    // Lockout checked before bcrypt; a wrong password counts toward the sign-in lockout (shared counter, intended).
    const reauth = await verifyCurrentPassword(db, actor.email, user?.passwordHash ?? null, currentPassword);
    if (!reauth.ok) {
      throw new UserFacingError(reauth.error);
    }

    await db.update(users)
      .set({
        totpSecret: null,
        totpEnabled: false,
        totpRecoveryCodes: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, actor.id));

    return;
  });
}

const ADMIN_MFA_SELF = 'Use your profile to turn off two-step sign-in.';
const ADMIN_MFA_WRONG_PASSWORD = "That password isn't right.";

/**
 * An admin turns off another user's two-step sign-in (feature-plan-ux-people-codes.md R6, §5.1). Needs the ACTING
 * admin's current password (verifyCurrentPassword: lockout first, a wrong one recorded as a failed attempt), refuses
 * yourself before any password check, and in one transaction (target FOR UPDATE) clears the secret, the recovery codes
 * and the last used step, turns two-step off, bumps the session in SQL (the user is signed out within about a minute —
 * the session check interval) and logs `mfa_reset`. Already off (a stale screen) → { changed: false }, no log.
 */
export async function adminResetMfa(data: { userId: string; currentPassword: string }): Promise<ActionResult<{ changed: boolean }>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const userId = validateUUID(data?.userId, 'User');
    if (userId === actor.id) throw new UserFacingError(ADMIN_MFA_SELF); // before the password: no attempt used up
    const db = await getDbForAuth();
    // The acting admin's email from the database (the session's email isn't refreshed when it changes).
    const [admin] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.id, actor.id));
    if (!admin) throw new UserFacingError('User not found.', 'not_found');
    const reauth = await verifyCurrentPassword(db, admin.email, admin.passwordHash, data.currentPassword);
    if (!reauth.ok) throw new UserFacingError(reauth.reason === 'wrong' ? ADMIN_MFA_WRONG_PASSWORD : reauth.error);

    return db.transaction(async (tx) => {
      const [target] = await tx.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId)).for('update');
      if (!target) throw new UserFacingError('User not found.', 'not_found');
      if (!target.totpEnabled) return { changed: false };
      await tx.update(users).set({
        totpSecret: null,
        totpRecoveryCodes: null,
        totpLastUsedStep: null,
        totpEnabled: false,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      }).where(eq(users.id, userId));
      await logAdminChange(tx, { actorId: actor.id, entity: 'user', entityId: userId, action: 'mfa_reset', oldValue: { mfaEnabled: true }, newValue: { mfaEnabled: false } });
      return { changed: true };
    });
  });
}

/**
 * Get MFA status for the session user.
 */
export async function getMFAStatus(): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const actor = await requireSession();
  const db = await getDb();

  const [user] = await db
    .select({ totpEnabled: users.totpEnabled, totpRecoveryCodes: users.totpRecoveryCodes })
    .from(users)
    .where(eq(users.id, actor.id));

  if (!user?.totpEnabled) return { enabled: false, recoveryCodesRemaining: 0 };

  let recoveryCodesRemaining = 0;
  if (user.totpRecoveryCodes) {
    try {
      const codes: string[] = JSON.parse(decrypt(user.totpRecoveryCodes));
      recoveryCodesRemaining = codes.length;
    } catch {
      recoveryCodesRemaining = 0;
    }
  }

  return { enabled: true, recoveryCodesRemaining };
}
