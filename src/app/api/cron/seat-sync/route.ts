import { NextRequest } from 'next/server';
import { runCron } from '@/lib/cron/run-cron';
import { runSeatSyncCron } from '@/lib/billing/seat-sync';

/**
 * Seat-sync cron, every 10 minutes (feature-plan-per-user-billing.md §6.5): serves due marks, the renewal window and
 * the daily check, one tenant at a time; no new tenant after 100 s. Heartbeat + probe via runCron.
 */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return runCron(request, 'seat-sync', async () => {
    const summary = await runSeatSyncCron();
    return { message: 'Seat sync processed', ...summary };
  }, { maxRuntimeMinutes: Math.ceil(maxDuration / 60) });
}
