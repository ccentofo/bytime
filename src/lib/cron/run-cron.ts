import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { NextResponse, type NextRequest } from 'next/server';
import { isProbe, rejectUnauthorizedCron } from '@/lib/cron-auth';
import { CRON_SCHEDULES, recordCronStart, recordCronSuccess, type CronName } from './heartbeat';

/**
 * Shared shell of the four cron routes (feature-plan-launch-blockers.md P6 §3, §6):
 *  1. auth (rejectUnauthorizedCron);
 *  2. `?probe=1` → 200 {"probe":"ok"} — no work, no monitor, no cron_runs write (smoke-tenancy.sh);
 *  3. heartbeat: cron_runs start, the work, cron_runs success (with the summary). A throw leaves last_succeeded_at
 *     untouched (the digest flags it) and reaches Sentry through instrumentation's onRequestError;
 *  4. optional SENTRY_CRON_MONITORS=1 (LB-D7: off; revisit at ~10 paying customers) → Sentry.withMonitor + flush.
 */
export async function runCron(
  request: NextRequest,
  name: CronName,
  work: () => Promise<Record<string, unknown>>,
  opts: { maxRuntimeMinutes: number },
): Promise<Response> {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;
  if (isProbe(request)) return NextResponse.json({ probe: 'ok' });

  const execute = async () => {
    await recordCronStart(name);
    const summary = await work();
    await recordCronSuccess(name, summary);
    return summary;
  };

  if (process.env.SENTRY_CRON_MONITORS !== '1') return NextResponse.json(await execute());

  try {
    const summary = await Sentry.withMonitor(name, execute, {
      schedule: { type: 'crontab', value: CRON_SCHEDULES[name] },
      maxRuntime: opts.maxRuntimeMinutes,
      checkinMargin: 5,
      timezone: 'UTC',
    });
    return NextResponse.json(summary);
  } finally {
    await Sentry.flush(2000); // serverless: deliver the check-in before the function freezes
  }
}
