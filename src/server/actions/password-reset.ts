'use server';

import { getDbForAuth } from '@/db';
import { users, passwordResetTokens } from '@/db/schema';
import { eq, and, gt, gte, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { sendPasswordResetEmail } from '@/lib/email/send';
import { scheduleEmail } from '@/lib/email/schedule';
import { getTenantSlug } from '@/lib/tenant/context';
import { tenantBaseUrl } from '@/lib/tenant/host';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

const TOKEN_EXPIRY_HOURS = 1;
const MAX_REQUESTS_PER_HOUR = 3;
const INVALID_LINK_MESSAGE = 'Invalid or expired reset link. Please request a new one.';

/**
 * The request's workspace slug, or '' when there is none: the apex host, or a host/header mismatch
 * (`getTenantSlug` throws on possible tampering). Password reset only ever works on a workspace host.
 */
async function requestSlugOrEmpty(): Promise<string> {
  try {
    return await getTenantSlug();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Request Password Reset (sends email with reset link)
// ---------------------------------------------------------------------------

export async function requestPasswordReset(email: string): Promise<ActionResult<void>> {
  return userAction(async () => {
    const normalizedEmail = email.toLowerCase().trim();

    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new UserFacingError('Please enter a valid email address.');
    }

    // No workspace on this host → nothing to reset; same generic answer, no email.
    const slug = await requestSlugOrEmpty();
    if (!slug) return;

    const db = await getDbForAuth();

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
      return;
    }

    // Check if user exists (but don't reveal this to the caller)
    const [user] = await db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(and(eq(users.email, normalizedEmail), eq(users.isActive, true)));

    if (!user) {
      // Return success even if user doesn't exist — prevents email enumeration
      return;
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

    // The link goes to THIS workspace's host — the reset page only works where the tenant is resolvable.
    const appUrl = tenantBaseUrl(slug);
    const resetUrl = `${appUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;
    const employeeName = user.fullName;

    scheduleEmail('password-reset', () => sendPasswordResetEmail({
      employeeEmail: normalizedEmail,
      employeeName,
      resetUrl,
      expiresIn: `${TOKEN_EXPIRY_HOURS} hour`,
      appUrl,
    }));

    return;
  });
}

// ---------------------------------------------------------------------------
// Verify Reset Token (check if token is valid before showing form)
// ---------------------------------------------------------------------------

export async function verifyResetToken(email: string, token: string): Promise<{ valid: boolean }> {
  // Explicit pre-check (not catch-by-message): no workspace on this host → the link can't be valid here.
  const slug = await requestSlugOrEmpty();
  if (!slug) return { valid: false };

  // getDbForAuth, not getDb: a billing_only (suspended) workspace's admin must still be able to reset.
  const db = await getDbForAuth();
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

class AccountMissingError extends Error {}

export async function resetPassword(data: {
  email: string;
  token: string;
  newPassword: string;
}): Promise<ActionResult<void>> {
  return userAction(async () => {
    const db = await getDbForAuth();
    const normalizedEmail = data.email.toLowerCase().trim();

    // Validate password
    if (!data.newPassword || data.newPassword.length < 8) {
      throw new UserFacingError('Password must be at least 8 characters.');
    }
    if (data.newPassword.length > 128) {
      throw new UserFacingError('Password must not exceed 128 characters.');
    }

    const tokenHash = crypto.createHash('sha256').update(data.token).digest('hex');

    // Cheap pre-check so an invalid token never costs a bcrypt hash. NOT the authority — the conditional consume
    // below is (a concurrent request can pass this check too).
    const [record] = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.email, normalizedEmail),
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        )
      );
    if (!record) {
      throw new UserFacingError(INVALID_LINK_MESSAGE);
    }

    const newHash = await bcrypt.hash(data.newPassword, 12);

    try {
      const consumed = await db.transaction(async (tx) => {
        const now = new Date();
        // Single-use, atomically: only one concurrent request can flip used_at from NULL.
        const claimed = await tx.update(passwordResetTokens)
          .set({ usedAt: now })
          .where(and(
            eq(passwordResetTokens.id, record.id),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, now),
          ))
          .returning({ id: passwordResetTokens.id });
        if (claimed.length === 0) return false;

        // Same transaction; SQL increment (not read-modify-write) invalidates every existing session.
        const updated = await tx.update(users)
          .set({
            passwordHash: newHash,
            passwordChangedAt: now,
            updatedAt: now,
            sessionVersion: sql`${users.sessionVersion} + 1`,
          })
          .where(eq(users.email, normalizedEmail))
          .returning({ id: users.id });
        if (updated.length === 0) throw new AccountMissingError(); // rolls back the token claim
        return true;
      });
      if (!consumed) throw new UserFacingError(INVALID_LINK_MESSAGE);
    } catch (err) {
      if (err instanceof AccountMissingError) throw new UserFacingError('Account not found.', 'not_found');
      throw err;
    }

    return;
  });
}
