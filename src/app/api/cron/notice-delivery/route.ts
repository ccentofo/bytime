import { NextRequest } from 'next/server';
import { runCron } from '@/lib/cron/run-cron';
import { deliverPendingNotices } from '@/lib/tenant/notices';

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
    return { message: 'Notice delivery processed', ...counts };
  }, { maxRuntimeMinutes: Math.ceil(maxDuration / 60) });
}
