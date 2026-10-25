import { NextRequest } from 'next/server';
import { runCron } from '@/lib/cron/run-cron';
import { deliverPendingNotices } from '@/lib/tenant/notices';
import { nullExpiredSignupIpHashes, resolveSignupSignals } from '@/lib/signup/signals';

/**
 * Notice delivery cron, every 10 minutes (feature-plan-terms-compliance-fixes.md §4.4/§4.5): retries every
 * pending lifecycle notice well within Resend's 24-hour idempotency window, throttled under its rate limit.
 * Heartbeat + probe + optional Sentry monitor via runCron (feature-plan-launch-blockers.md P6 §3).
 */
export const maxDuration = 300;
const BUDGET_MS = 240_000;

export async function GET(request: NextRequest) {
  return runCron(request, 'notice-delivery', async () => {
    const counts = await deliverPendingNotices(BUDGET_MS);
    // feature-plan-launch-blockers.md P5 (runs whatever the signup-controls flag): drop signup IP hashes older than
    // 24 h (LB-D5: ≤ ~24 h 10 min), and resolve turnstile-outage / signup-config-missing once their condition cleared.
    const ipHashesCleared = await nullExpiredSignupIpHashes();
    await resolveSignupSignals();
    return { message: 'Notice delivery processed', ...counts, ipHashesCleared };
  }, { maxRuntimeMinutes: Math.ceil(maxDuration / 60) });
}
