import 'server-only';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
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

/** One login_attempts row, as the lockout arithmetic needs it. */
export interface AttemptRow { successful: boolean; attemptedAt: Date }

/**
 * Pure: the lockout state from one email's attempts (feature-plan-ux-people-codes.md §5.1 — the ONE arithmetic shared by
 * getLockoutInfo and getLockoutsForEmails). Failures inside the window that came after the latest success count; at
 * MAX_FAILED_ATTEMPTS the lock runs LOCKOUT_DURATION_MINUTES from the oldest of them. `minutesRemaining` is truncated
 * (dayjs diff), and the account is locked only while it is > 0. A success older than the window filters nothing, so
 * the rows may be just the window's (getLockoutsForEmails) or the window's failures plus the latest success ever.
 */
export function lockoutFromRows(rows: readonly AttemptRow[], now: Date): LockoutInfo {
  const windowStart = dayjs(now).subtract(LOCKOUT_DURATION_MINUTES, 'minute').toDate();
  let lastSuccess: Date | null = null;
  for (const r of rows) if (r.successful && (!lastSuccess || r.attemptedAt > lastSuccess)) lastSuccess = r.attemptedAt;
  // Newest first, like the query this replaced.
  const relevantFailures = rows
    .filter((r) => !r.successful && r.attemptedAt >= windowStart && (!lastSuccess || r.attemptedAt > lastSuccess))
    .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime());
  const failedCount = relevantFailures.length;

  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    // Account is locked — calculate when the lockout expires
    const oldestRelevantFailure = relevantFailures[relevantFailures.length - 1];
    const lockoutExpiresAt = dayjs(oldestRelevantFailure.attemptedAt).add(LOCKOUT_DURATION_MINUTES, 'minute').toDate();
    const minutesRemaining = Math.max(0, dayjs(lockoutExpiresAt).diff(dayjs(now), 'minute'));
    return { isLocked: minutesRemaining > 0, failedAttempts: failedCount, lockoutExpiresAt, minutesRemaining };
  }
  return { isLocked: false, failedAttempts: failedCount, lockoutExpiresAt: null, minutesRemaining: 0 };
}

/**
 * Lockout state for an email: locked after MAX_FAILED_ATTEMPTS failures (since the last success) within the
 * window. Callers pass the auth client (getDbForAuth) so a suspended tenant's admin still sees an accurate state (F10).
 */
export async function getLockoutInfo(db: Pick<ReadDb, 'select'> | AttemptsWriter, email: string): Promise<LockoutInfo> {
  const normalizedEmail = email.toLowerCase().trim();
  const now = new Date();
  const windowStart = dayjs(now).subtract(LOCKOUT_DURATION_MINUTES, 'minute').toDate();

  // Recent failed attempts within the lockout window
  const recentFailures = await db
    .select({ successful: loginAttempts.successful, attemptedAt: loginAttempts.attemptedAt })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, normalizedEmail), eq(loginAttempts.successful, false), gte(loginAttempts.attemptedAt, windowStart)))
    .orderBy(desc(loginAttempts.attemptedAt));

  // The latest success (it resets the counter)
  const lastSuccess = await db
    .select({ successful: loginAttempts.successful, attemptedAt: loginAttempts.attemptedAt })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, normalizedEmail), eq(loginAttempts.successful, true)))
    .orderBy(desc(loginAttempts.attemptedAt))
    .limit(1);

  return lockoutFromRows([...recentFailures, ...lastSuccess], now);
}

/**
 * The lock state of many emails in ONE bounded query (the Users page, §5.1): every attempt in the last 15 minutes for
 * the lowercased emails, then lockoutFromRows per email — the same arithmetic as getLockoutInfo. Keyed by the
 * lowercased, trimmed email; only locked emails are present.
 */
export async function getLockoutsForEmails(db: Pick<ReadDb, 'select'>, emails: readonly string[], now = new Date()): Promise<Map<string, LockoutInfo>> {
  const keys = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  const out = new Map<string, LockoutInfo>();
  if (keys.length === 0) return out;
  const windowStart = dayjs(now).subtract(LOCKOUT_DURATION_MINUTES, 'minute').toDate();
  const rows = await db
    .select({ email: loginAttempts.email, successful: loginAttempts.successful, attemptedAt: loginAttempts.attemptedAt })
    .from(loginAttempts)
    .where(and(gte(loginAttempts.attemptedAt, windowStart), inArray(sql`lower(${loginAttempts.email})`, keys)));
  const byEmail = new Map<string, AttemptRow[]>();
  for (const r of rows) {
    const k = r.email.toLowerCase().trim();
    byEmail.set(k, [...(byEmail.get(k) ?? []), r]);
  }
  for (const [email, list] of byEmail) {
    const info = lockoutFromRows(list, now);
    if (info.isLocked) out.set(email, info);
  }
  return out;
}

/**
 * Re-authentication for account-security changes (changePassword, disableMFA, completeMFASetup) —
 * feature-plan-launch-blockers.md P3. The lockout is checked BEFORE bcrypt, and a wrong password is recorded in
 * login_attempts: the SAME counter as sign-in, intentionally — a stolen session can't be used to guess the password
 * without also locking the account's sign-in. `reason` lets a caller word a case its own way without matching the message
 * (UX-4C1-AUDIT.md L2).
 */
export async function verifyCurrentPassword(
  db: AttemptsWriter,
  email: string,
  passwordHash: string | null,
  candidate: string,
): Promise<{ ok: true } | { ok: false; reason: 'wrong' | 'locked' | 'no_password'; error: string }> {
  if (!passwordHash) {
    return { ok: false, reason: 'no_password', error: 'Set a password first.' };
  }
  const lockout = await getLockoutInfo(db, email);
  if (lockout.isLocked) {
    return {
      ok: false,
      reason: 'locked',
      error: `Too many failed attempts. Try again in ${lockout.minutesRemaining} minute${lockout.minutesRemaining !== 1 ? 's' : ''}.`,
    };
  }
  if (typeof candidate !== 'string' || !(await bcrypt.compare(candidate, passwordHash))) {
    await recordFailedAttempt(db, email);
    return { ok: false, reason: 'wrong', error: 'Current password is incorrect.' };
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
