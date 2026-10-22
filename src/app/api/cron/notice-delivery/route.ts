import { NextRequest, NextResponse } from 'next/server';
import { rejectUnauthorizedCron } from '@/lib/cron-auth';
import { deliverPendingNotices } from '@/lib/tenant/notices';

/**
 * Notice delivery cron, every 10 minutes (feature-plan-terms-compliance-fixes.md §4.4/§4.5): retries every
 * pending lifecycle notice well within Resend's 24-hour idempotency window, throttled under its rate limit.
 */
export const maxDuration = 300;
const BUDGET_MS = 240_000;

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;
  const counts = await deliverPendingNotices(BUDGET_MS);
  return NextResponse.json({ message: 'Notice delivery processed', ...counts });
}
