'use server';

import { getDb, getDbForAuth } from '@/db';
import { users } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { requireSession, requireAdminFresh } from '@/lib/session';
import { verifyCurrentPassword } from '@/server/internal/login-attempts';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { validatePassword } from '@/lib/password-rules';
import { logAdminChange } from '@/server/internal/admin-change-log';

// ---------------------------------------------------------------------------
// Self-Service Password Change
// ---------------------------------------------------------------------------

/**
 * Change the session user's own password. Requires the current password for verification.
 */
export async function changePassword(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    const actor = await requireSession();
    const db = await getDbForAuth();
    // Validate new password
    const validationError = validatePassword(data.newPassword);
    if (validationError) {
      throw new UserFacingError(validationError);
    }

    // Get current user
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.id));

    if (!user) {
      throw new UserFacingError('User not found.', 'not_found');
    }

    if (!user.passwordHash) {
      throw new UserFacingError('Account has no password set. Contact your administrator.');
    }

    // Verify current password — lockout checked before bcrypt; a wrong password counts toward the sign-in lockout
    // (shared login_attempts counter, intended: a stolen session can't be used to guess the password freely).
    const reauth = await verifyCurrentPassword(db, actor.email, user.passwordHash, data.currentPassword);
    if (!reauth.ok) {
      throw new UserFacingError(reauth.error);
    }

    // Check new password is different from current
    const isSame = await bcrypt.compare(data.newPassword, user.passwordHash);
    if (isSame) {
      throw new UserFacingError('New password must be different from your current password.');
    }

    // Hash and save new password + increment session version
    const newHash = await bcrypt.hash(data.newPassword, 12);

    // Get current session version
    const [currentUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, actor.id));

    await db.update(users)
      .set({
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
        sessionVersion: (currentUser?.sessionVersion ?? 1) + 1,
      })
      .where(eq(users.id, actor.id));

    return;
  });
}

// ---------------------------------------------------------------------------
// Admin Password Reset
// ---------------------------------------------------------------------------

/**
 * Reset a user's password (admin action). Does NOT require the current password.
 * Bumps the target's sessionVersion (in SQL) so their existing sessions end, and logs `password_reset` in the same
 * transaction (feature-plan-ux-people-codes.md R5). The hash is computed before the transaction opens.
 */
export async function adminResetPassword(data: {
  targetUserId: string;
  newPassword: string;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const db = await getDbForAuth();
    // Validate new password
    const validationError = validatePassword(data.newPassword);
    if (validationError) {
      throw new UserFacingError(validationError);
    }

    // Hash first: bcrypt never runs inside a transaction.
    const newHash = await bcrypt.hash(data.newPassword, 12);

    await db.transaction(async (tx) => {
      // Save the new password and increment the session version in SQL (invalidates all existing sessions).
      const updated = await tx.update(users)
        .set({
          passwordHash: newHash,
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
          sessionVersion: sql`${users.sessionVersion} + 1`,
        })
        .where(eq(users.id, data.targetUserId))
        .returning({ id: users.id });
      if (updated.length === 0) throw new UserFacingError('User not found.', 'not_found');
      await logAdminChange(tx, { actorId: actor.id, entity: 'user', entityId: data.targetUserId, action: 'password_reset', oldValue: null, newValue: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Password Info Query
// ---------------------------------------------------------------------------

/**
 * Get password metadata for the session user (last changed date).
 */
export async function getPasswordInfo(): Promise<{
  hasPassword: boolean;
  lastChangedAt: Date | null;
}> {
  const actor = await requireSession();
  const db = await getDb();
  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(eq(users.id, actor.id));

  return {
    hasPassword: Boolean(user?.passwordHash),
    lastChangedAt: user?.passwordChangedAt ?? null,
  };
}
