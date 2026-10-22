import 'server-only';
import { sql } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { cronRuns } from '@/db/control-plane/schema';

/**
 * LB-D7 free cron heartbeat (feature-plan-launch-blockers.md P6 §3): each of the four crons records its start and its
 * success in `cron_runs`; the daily digest (always sent) lists any cron that is overdue by its own limit or has never
 * run. No paid Sentry cron monitors unless SENTRY_CRON_MONITORS=1 (src/lib/cron/run-cron.ts).
 */

const HOUR = 3_600_000;

export const CRON_NAMES = ['notice-delivery', 'tenant-lifecycle', 'submission-deadline', 'daily-reminder'] as const;
export type CronName = (typeof CRON_NAMES)[number];

/** Schedules (UTC) — must match vercel.json (a unit test checks). Used for the optional Sentry monitor config. */
export const CRON_SCHEDULES: Record<CronName, string> = {
  'notice-delivery': '*/10 * * * *',
  'tenant-lifecycle': '0 13 * * *',
  'submission-deadline': '0 20 * * *',
  'daily-reminder': '0 20 * * 1-5',
};

/**
 * How long after its last success a cron counts as overdue. daily-reminder runs Mon–Fri, so 74 h: Friday 20:00 →
 * Monday's digest (13:00) is 65 h and must not raise a false alarm.
 */
export const CRON_STALE_AFTER_MS: Record<CronName, number> = {
  'notice-delivery': 1 * HOUR,
  'tenant-lifecycle': 26 * HOUR,
  'submission-deadline': 26 * HOUR,
  'daily-reminder': 74 * HOUR,
};

export interface CronRunRow {
  name: string;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastSummary: unknown;
}

export interface CronProblem {
  name: CronName;
  /** never-ran: no cron_runs row at all. stale: no success within its limit (or none yet). */
  problem: 'never-ran' | 'stale';
  lastSucceededAt: Date | null;
  limitHours: number;
}

/** Pure: every cron that has no row, or whose last success is older than its limit at `now`. */
export function cronProblems(rows: CronRunRow[], now: Date): CronProblem[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const problems: CronProblem[] = [];
  for (const name of CRON_NAMES) {
    const limit = CRON_STALE_AFTER_MS[name];
    const row = byName.get(name);
    if (!row) {
      problems.push({ name, problem: 'never-ran', lastSucceededAt: null, limitHours: limit / HOUR });
    } else if (!row.lastSucceededAt || now.getTime() - row.lastSucceededAt.getTime() > limit) {
      problems.push({ name, problem: 'stale', lastSucceededAt: row.lastSucceededAt, limitHours: limit / HOUR });
    }
  }
  return problems;
}

export async function recordCronStart(name: CronName, now: Date = new Date()): Promise<void> {
  await controlDb.insert(cronRuns).values({ name, lastStartedAt: now })
    .onConflictDoUpdate({ target: cronRuns.name, set: { lastStartedAt: now } });
}

export async function recordCronSuccess(name: CronName, summary: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  await controlDb.insert(cronRuns).values({ name, lastSucceededAt: now, lastSummary: summary })
    .onConflictDoUpdate({ target: cronRuns.name, set: { lastSucceededAt: now, lastSummary: summary } });
}

export async function readCronRuns(): Promise<CronRunRow[]> {
  return controlDb.select().from(cronRuns);
}

/** The reminder crons' fair-rotation cursor: the last fully processed tenant slug of the previous run. */
export async function readCronCursor(name: CronName): Promise<string | null> {
  const [row] = await controlDb.select({ cursor: sql<string | null>`${cronRuns.lastSummary} ->> 'cursor'` })
    .from(cronRuns).where(sql`${cronRuns.name} = ${name}`).limit(1);
  return row?.cursor ?? null;
}
