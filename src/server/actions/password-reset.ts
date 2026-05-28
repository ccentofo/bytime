'use server';

import { db } from '@/db';
import { users, passwordResetTokens } from '@/db/schema';
import { eq, and, gte, isNull } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { sendPasswordResetEmail } from '@/lib/email/send';

const TOKEN_EXPIRY_HOURS = 1;
const MAX_REQUESTS_PER_HOUR = 3;

// ---------------------------------------------------------------------------
// Request Password Reset (sends email with reset link)
// ---------------------------------------------------------------------------

export async function requestPasswordReset(email: string): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  // Rate limit: max 3 requests per email per hour
  const oneHourAgo = dayjs().subtract(1, 'hour').toDate();
  const recentRequests = await db
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.email, normalizedEmail),
        gte(passwordResetTokens.createdAt, oneHourAgo),
      )
    );

  if (recentRequests.length >= MAX_REQUESTS_PER_HOUR) {
    // Don't reveal that rate limit was hit — same generic message
    return { success: true };
  }

  // Check if user exists (but don't reveal this to the caller)
  const [user] = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.email, normalizedEmail), eq(users.isActive, true)));

  if (!user) {
    // Return success even if user doesn't exist — prevents email enumeration
    return { success: true };
  }

  // Generate a secure random token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = dayjs().add(TOKEN_EXPIRY_HOURS, 'hour').toDate();

  // Store hashed token in DB
  await db.insert(passwordResetTokens).values({
    email: normalizedEmail,
    tokenHash,
    expiresAt,
  });

  // Send reset email with the raw token in the URL
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const resetUrl = `${appUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;

  sendPasswordResetEmail({
    employeeEmail: normalizedEmail,
    employeeName: user.fullName,
    resetUrl,
    expiresIn: `${TOKEN_EXPIRY_HOURS} hour`,
  }); // Fire-and-forget — don't await

  return { success: true };
}

// ---------------------------------------------------------------------------
// Verify Reset Token (check if token is valid before showing form)
// ---------------------------------------------------------------------------

export async function verifyResetToken(email: string, token: string): Promise<{ valid: boolean }> {
  const normalizedEmail = email.toLowerCase().trim();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const [record] = await db
    .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.email, normalizedEmail),
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt), // Not yet used
      )
    );

  if (!record) {
    return { valid: false };
  }

  // Check expiry
  if (dayjs().isAfter(dayjs(record.expiresAt))) {
    return { valid: false };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Reset Password (consume token + set new password)
// ---------------------------------------------------------------------------

export async function resetPassword(data: {
  email: string;
  token: string;
  newPassword: string;
}): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = data.email.toLowerCase().trim();

  // Validate password
  if (!data.newPassword || data.newPassword.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters.' };
  }
  if (data.newPassword.length > 128) {
    return { success: false, error: 'Password must not exceed 128 characters.' };
  }

  // Verify token
  const tokenHash = crypto.createHash('sha256').update(data.token).digest('hex');

  const [record] = await db
    .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.email, normalizedEmail),
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
      )
    );

  if (!record) {
    return { success: false, error: 'Invalid or expired reset link. Please request a new one.' };
  }

  if (dayjs().isAfter(dayjs(record.expiresAt))) {
    return { success: false, error: 'This reset link has expired. Please request a new one.' };
  }

  // Find the user
  const [user] = await db
    .select({ id: users.id, sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.email, normalizedEmail));

  if (!user) {
    return { success: false, error: 'Account not found.' };
  }

  // Hash the new password
  const newHash = await bcrypt.hash(data.newPassword, 12);

  // Update password + increment session version (invalidates all existing sessions)
  await db.update(users)
    .set({
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
      sessionVersion: (user.sessionVersion ?? 1) + 1,
    })
    .where(eq(users.id, user.id));

  // Mark token as used (single-use enforcement)
  await db.update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, record.id));

  return { success: true };
}
