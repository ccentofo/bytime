import 'server-only';
import { getDbForAuth } from '@/db';
import { loginAttempts } from '@/db/schema';

/**
 * Record a failed login attempt.
 * INTERNAL — called from auth.ts's authorize(), before any session exists, so it must use
 * getDbForAuth (tolerates suspended tenants — F10) rather than the strict getDb().
 */
export async function recordFailedAttempt(
  email: string,
  ipAddress?: string
): Promise<void> {
  const db = await getDbForAuth();
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
  email: string,
  ipAddress?: string
): Promise<void> {
  const db = await getDbForAuth();
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
export async function unlockAccount(email: string): Promise<void> {
  const db = await getDbForAuth();
  const normalizedEmail = email.toLowerCase().trim();

  await db.insert(loginAttempts).values({
    email: normalizedEmail,
    successful: true,
  });
}
