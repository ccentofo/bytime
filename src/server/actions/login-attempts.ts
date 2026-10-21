'use server';

import { getDbForAuth } from '@/db';
import { loginAttempts } from '@/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 5;         // Lock after 5 consecutive failures
const LOCKOUT_DURATION_MINUTES = 15;   // Lock for 15 minutes

/**
 * Check if an email is currently locked out due to too many failed attempts.
 * Returns lockout info if locked, null if not locked.
 *
 * PUBLIC — intentionally callable without a session: it's the pre-login lockout banner, and the
 * client needs it before any authentication has happened. Read-only. Uses getDbForAuth so a
 * suspended tenant's admin can still see an accurate lockout state while trying to sign in (F10).
 */
export async function checkLockout(email: string): Promise<{
  isLocked: boolean;
  failedAttempts: number;
  lockoutExpiresAt: Date | null;
  minutesRemaining: number;
} | null> {
  const db = await getDbForAuth();
  const normalizedEmail = email.toLowerCase().trim();
  const windowStart = dayjs().subtract(LOCKOUT_DURATION_MINUTES, 'minute').toDate();

  // Get recent failed attempts within the lockout window
  const recentFailures = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalizedEmail),
        eq(loginAttempts.successful, false),
        gte(loginAttempts.attemptedAt, windowStart),
      )
    )
    .orderBy(desc(loginAttempts.attemptedAt));

  // Check if there was a successful login after the failures (which would reset the counter)
  const lastSuccess = await db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalizedEmail),
        eq(loginAttempts.successful, true),
      )
    )
    .orderBy(desc(loginAttempts.attemptedAt))
    .limit(1);

  // Only count failures that happened AFTER the last successful login
  let relevantFailures = recentFailures;
  if (lastSuccess.length > 0) {
    const lastSuccessTime = lastSuccess[0].attemptedAt;
    relevantFailures = recentFailures.filter(
      (f) => f.attemptedAt > lastSuccessTime
    );
  }

  const failedCount = relevantFailures.length;

  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    // Account is locked — calculate when the lockout expires
    const oldestRelevantFailure = relevantFailures[relevantFailures.length - 1];
    const lockoutExpiresAt = dayjs(oldestRelevantFailure.attemptedAt)
      .add(LOCKOUT_DURATION_MINUTES, 'minute')
      .toDate();
    const minutesRemaining = Math.max(0, dayjs(lockoutExpiresAt).diff(dayjs(), 'minute'));

    return {
      isLocked: minutesRemaining > 0,
      failedAttempts: failedCount,
      lockoutExpiresAt,
      minutesRemaining,
    };
  }

  return {
    isLocked: false,
    failedAttempts: failedCount,
    lockoutExpiresAt: null,
    minutesRemaining: 0,
  };
}
