'use server';

import { getLockoutInfo, type LockoutInfo } from '@/server/internal/login-attempts';

/**
 * Check if an email is currently locked out due to too many failed attempts.
 *
 * PUBLIC — intentionally callable without a session: it's the pre-login lockout banner, and the
 * client needs it before any authentication has happened. Read-only. The logic lives in
 * src/server/internal/login-attempts.ts (getLockoutInfo), shared with sign-in and the
 * current-password checks (changePassword, disableMFA, completeMFASetup).
 */
export async function checkLockout(email: string): Promise<LockoutInfo | null> {
  return getLockoutInfo(email);
}
