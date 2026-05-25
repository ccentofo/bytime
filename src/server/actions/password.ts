'use server';

import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

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
 * Change the current user's password.
 * Requires the current password for verification.
 */
export async function changePassword(data: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; error?: string }> {
  // Validate new password
  const validationError = validatePassword(data.newPassword);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Get current user
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, data.userId));

  if (!user) {
    return { success: false, error: 'User not found.' };
  }

  if (!user.passwordHash) {
    return { success: false, error: 'Account has no password set. Contact your administrator.' };
  }

  // Verify current password
  const isValid = await bcrypt.compare(data.currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Current password is incorrect.' };
  }

  // Check new password is different from current
  const isSame = await bcrypt.compare(data.newPassword, user.passwordHash);
  if (isSame) {
    return { success: false, error: 'New password must be different from your current password.' };
  }

  // Hash and save new password + increment session version
  const newHash = await bcrypt.hash(data.newPassword, 12);

  // Get current session version
  const [currentUser] = await db
    .select({ sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, data.userId));

  await db.update(users)
    .set({
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
      sessionVersion: (currentUser?.sessionVersion ?? 1) + 1,
    })
    .where(eq(users.id, data.userId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Admin Password Reset
// ---------------------------------------------------------------------------

/**
 * Reset a user's password (admin action).
 * Does NOT require the current password — only admins can call this.
 */
export async function adminResetPassword(data: {
  targetUserId: string;
  newPassword: string;
  adminUserId: string;
}): Promise<{ success: boolean; error?: string }> {
  // Validate new password
  const validationError = validatePassword(data.newPassword);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Verify the admin exists and has the right role
  const [admin] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, data.adminUserId));

  if (!admin || (admin.role !== 'admin' && admin.role !== 'supervisor')) {
    return { success: false, error: 'Unauthorized: Only admins can reset passwords.' };
  }

  // Verify target user exists
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, data.targetUserId));

  if (!target) {
    return { success: false, error: 'User not found.' };
  }

  // Hash and save new password + increment session version (invalidates all existing sessions)
  const newHash = await bcrypt.hash(data.newPassword, 12);

  // Get current session version
  const [targetUser] = await db
    .select({ sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, data.targetUserId));

  await db.update(users)
    .set({
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
      sessionVersion: (targetUser?.sessionVersion ?? 1) + 1,
    })
    .where(eq(users.id, data.targetUserId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Password Info Query
// ---------------------------------------------------------------------------

/**
 * Get password metadata for a user (last changed date).
 */
export async function getPasswordInfo(userId: string): Promise<{
  hasPassword: boolean;
  lastChangedAt: Date | null;
}> {
  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  return {
    hasPassword: Boolean(user?.passwordHash),
    lastChangedAt: user?.passwordChangedAt ?? null,
  };
}
