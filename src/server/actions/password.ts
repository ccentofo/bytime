'use server';

import { getDb, getDbForAuth } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { requireSession, requireAdminFresh } from '@/lib/session';
import { verifyCurrentPassword } from '@/server/internal/login-attempts';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

// ---------------------------------------------------------------------------
// Password Validation
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function validatePassword(password: string): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null; // Valid
}

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
 * Bumps the target's sessionVersion so their existing sessions end immediately.
 */
export async function adminResetPassword(data: {
  targetUserId: string;
  newPassword: string;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForAuth();
    // Validate new password
    const validationError = validatePassword(data.newPassword);
    if (validationError) {
      throw new UserFacingError(validationError);
    }

    // Verify target user exists
    const [target] = await db
      .select({ id: users.id, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, data.targetUserId));

    if (!target) {
      throw new UserFacingError('User not found.', 'not_found');
    }

    // Hash and save new password + increment session version (invalidates all existing sessions)
    const newHash = await bcrypt.hash(data.newPassword, 12);

    await db.update(users)
      .set({
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
        sessionVersion: (target.sessionVersion ?? 1) + 1,
      })
      .where(eq(users.id, data.targetUserId));

    return;
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
