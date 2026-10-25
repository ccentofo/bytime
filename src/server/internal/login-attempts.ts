import 'server-only';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { AuthDb, ReadDb, TenantWriter } from '@/db';
import { loginAttempts } from '@/db/schema';

const MAX_FAILED_ATTEMPTS = 5;         // Lock after 5 consecutive failures
const LOCKOUT_DURATION_MINUTES = 15;   // Lock for 15 minutes

export interface LockoutInfo {
  isLocked: boolean;
  failedAttempts: number;
  lockoutExpiresAt: Date | null;
  minutesRemaining: number;
}

/** The auth client (works in billing_only/read_only — F10) or a write-gated one. */
type AttemptsWriter = AuthDb | TenantWriter;

/**
 * Lockout state for an email: locked after MAX_FAILED_ATTEMPTS failures (since the last success) within the
 * window. Callers pass the auth client (getDbForAuth) so a suspended tenant's admin still sees an accurate state (F10).
 */
export async function getLockoutInfo(db: Pick<ReadDb, 'select'> | AttemptsWriter, email: string): Promise<LockoutInfo> {
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

/**
 * Re-authentication for account-security changes (changePassword, disableMFA, completeMFASetup) —
 * feature-plan-launch-blockers.md P3. The lockout is checked BEFORE bcrypt, and a wrong password is recorded in
 * login_attempts: the SAME counter as sign-in, intentionally — a stolen session can't be used to guess the password
 * without also locking the account's sign-in.
 */
export async function verifyCurrentPassword(
  db: AttemptsWriter,
  email: string,
  passwordHash: string | null,
  candidate: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!passwordHash) {
    return { ok: false, error: 'Set a password first.' };
  }
  const lockout = await getLockoutInfo(db, email);
  if (lockout.isLocked) {
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${lockout.minutesRemaining} minute${lockout.minutesRemaining !== 1 ? 's' : ''}.`,
    };
  }
  if (typeof candidate !== 'string' || !(await bcrypt.compare(candidate, passwordHash))) {
    await recordFailedAttempt(db, email);
    return { ok: false, error: 'Current password is incorrect.' };
  }
  return { ok: true };
}

/**
 * Record a failed login attempt.
 * INTERNAL — called from auth.ts's authorize(), before any session exists, with the getDbForAuth client
 * (tolerates suspended tenants — F10) rather than the strict getDb().
 */
export async function recordFailedAttempt(
  db: AttemptsWriter,
  email: string,
  ipAddress?: string
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    ipAddress: ipAddress ?? null,
    successful: false,
  });
}

/**
 * Record a successful login (resets the failure counter).
 */
export async function recordSuccessfulLogin(
  db: AttemptsWriter,
  email: string,
  ipAddress?: string
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    ipAddress: ipAddress ?? null,
    successful: true,
  });
}

/**
 * Clear all login attempts for an email (admin unlock).
 * This inserts a successful login record, which resets the counter.
 * Called from the admin-guarded unlockUserAccount() action in users.ts.
 */
export async function unlockAccount(db: AttemptsWriter, email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    successful: true,
  });
}
