'use server';

import { headers } from 'next/headers';
import { getDbForAuth } from '@/db';
import { getLockoutInfo, type LockoutInfo } from '@/server/internal/login-attempts';
import { getClientIpFromHeaders } from '@/lib/rate-limit';
import { consume, refund } from '@/lib/rate-limit/store';
import { ipIdentifier } from '@/lib/rate-limit/identifier';

/**
 * Check if an email is currently locked out due to too many failed attempts.
 *
 * PUBLIC — intentionally callable without a session: it's the pre-login lockout banner, and the
 * client needs it before any authentication has happened. Read-only. The logic lives in
 * src/server/internal/login-attempts.ts (getLockoutInfo), shared with sign-in and the
 * current-password checks (changePassword, disableMFA, completeMFASetup).
 *
 * SWEEP-FINDINGS.md A1-D6: gated by the IP's sign-in failure budget (feature-plan-upstash-rate-limiting.md Q2) as a peek.
 * An allowed check is counted and given back at once, so it never costs a sign-in anything; once the IP has spent its
 * budget the check answers null without reading the database, and the form's sign-in then shows the existing
 * "Too many failed sign-in attempts from your network" message.
 */
export async function checkLockout(email: string): Promise<LockoutInfo | null> {
  const ipId = ipIdentifier(getClientIpFromHeaders(await headers()));
  const gate = await consume('signInFailure', ipId);
  if (!gate.allowed) return null;
  await refund('signInFailure', ipId, gate);
  return getLockoutInfo(await getDbForAuth(), email);
}
