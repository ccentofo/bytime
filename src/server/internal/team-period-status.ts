import 'server-only';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { timesheetEntries, timesheetPeriods, users } from '@/db/schema';
import { addDays, type CalendarDate } from '@/lib/calendar-date';
import { LATEST_REVISION } from './cost-basis';

/**
 * Who is expected to submit (UX2-Q1 default, pending the product owner): active employees and supervisors, plus any
 * admin who recorded hours or has a period row for that period. Change it here — one line.
 */
export const EXPECTED_SUBMITTER_ROLES = ['employee', 'supervisor'] as const;

export type TeamBucket = 'submitted' | 'returned' | 'inProgress' | 'notStarted';
export type TeamPeriodStatus = Record<TeamBucket, { count: number; names: string[] }>;

/** The bucket for a person: submitted/approved → submitted; rejected → returned; else hours > 0 → in progress. */
export function bucketOf(status: string | null, hours: number | null): TeamBucket {
  if (status === 'submitted' || status === 'approved') return 'submitted';
  if (status === 'rejected') return 'returned';
  return hours !== null && hours > 0 ? 'inProgress' : 'notStarted';
}

/**
 * Team status for one pay period (feature-plan-ux-navigation-home.md §4.5.2): one round trip. Active users only;
 * people created after the period ended aren't expected (mid-period hires are); `scope` is 'all' (admin) or the ids
 * the approver can decide (approvableScope) — an empty list gives nobody. Hours include every code (any recorded time
 * means the person has started). INTERNAL, no guard. `tz` and the dates are strings — never a raw Date in sql.
 */
export async function teamPeriodStatus(
  db: Pick<ReadDb, 'select'>,
  start: CalendarDate,
  numDays: number,
  scope: 'all' | string[],
  tz: string,
): Promise<TeamPeriodStatus> {
  const endExcl = addDays(start, numDays);
  const periodEnd = addDays(start, numDays - 1);
  const hrs = db
    .select({ userId: timesheetEntries.userId, h: sql<string>`SUM(CAST(${timesheetEntries.hours} AS NUMERIC))`.as('h') })
    .from(timesheetEntries)
    .where(and(gte(timesheetEntries.entryDate, start), lt(timesheetEntries.entryDate, endExcl), LATEST_REVISION))
    .groupBy(timesheetEntries.userId)
    .as('tps_hrs'); // unique alias (dated-rates trap T16)
  const rows = await db
    .select({ id: users.id, name: users.fullName, role: users.role, status: timesheetPeriods.status, h: hrs.h })
    .from(users)
    .leftJoin(timesheetPeriods, and(eq(timesheetPeriods.userId, users.id), eq(timesheetPeriods.periodStart, start)))
    .leftJoin(hrs, eq(hrs.userId, users.id))
    .where(and(
      eq(users.isActive, true),
      sql`(${users.createdAt} AT TIME ZONE ${tz})::date <= ${periodEnd}::date`,
      scope === 'all' ? undefined : inArray(users.id, scope),
    ));

  const out: TeamPeriodStatus = { submitted: { count: 0, names: [] }, returned: { count: 0, names: [] }, inProgress: { count: 0, names: [] }, notStarted: { count: 0, names: [] } };
  const expected = rows.filter((r) => {
    const hours = r.h === null ? null : Number(r.h);
    return (EXPECTED_SUBMITTER_ROLES as readonly string[]).includes(r.role) || (hours !== null && hours > 0) || r.status !== null;
  });
  for (const r of [...expected].sort((a, b) => a.name.localeCompare(b.name))) {
    const b = out[bucketOf(r.status, r.h === null ? null : Number(r.h))];
    b.count++;
    b.names.push(r.name);
  }
  return out;
}
