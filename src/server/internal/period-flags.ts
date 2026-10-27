import 'server-only';
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { timesheetEntries } from '@/db/schema';
import { addDays, type CalendarDate } from '@/lib/calendar-date';

export interface PeriodFlags {
  /** Correction rows (revision > 1) recorded in the app during the period. */
  corrections: number;
  /** Late entries: revision 1 with a reason code — a reason is stored on revision 1 only when the entry was late. */
  lateEntries: number;
  /** Submitted more than once (returned, fixed, resubmitted). */
  resubmitted: boolean;
}

export interface FlagRow { id: string; userId: string; periodStart: CalendarDate; periodNumDays: number; submissionCount: number }

/**
 * "Worth a look" flags for the Approvals Waiting view (feature-plan-ux-navigation-home.md §4.6): ONE grouped query
 * over timesheet_entries for the given (decidable) rows' users and date ranges, app-recorded only (imported history is
 * excluded). INTERNAL, no guard: getScopedPeriods passes only rows the session user may decide.
 */
export async function periodFlags(db: Pick<ReadDb, 'select'>, rows: FlagRow[]): Promise<Map<string, PeriodFlags>> {
  const out = new Map<string, PeriodFlags>();
  if (rows.length === 0) return out;
  const ranges = rows.map((r) => and(
    eq(timesheetEntries.userId, r.userId),
    gte(timesheetEntries.entryDate, r.periodStart),
    lt(timesheetEntries.entryDate, addDays(r.periodStart, r.periodNumDays)),
  ));
  const counts = await db
    .select({
      userId: timesheetEntries.userId,
      entryDate: timesheetEntries.entryDate,
      corrections: sql<number>`COUNT(*) FILTER (WHERE ${timesheetEntries.revisionNumber} > 1)`.mapWith(Number),
      late: sql<number>`COUNT(*) FILTER (WHERE ${timesheetEntries.revisionNumber} = 1 AND ${timesheetEntries.changeReasonCode} IS NOT NULL)`.mapWith(Number),
    })
    .from(timesheetEntries)
    .where(and(eq(timesheetEntries.source, 'app'), or(...ranges)))
    .groupBy(timesheetEntries.userId, timesheetEntries.entryDate);

  for (const r of rows) {
    const end = addDays(r.periodStart, r.periodNumDays);
    let corrections = 0;
    let lateEntries = 0;
    for (const c of counts) {
      if (c.userId !== r.userId || c.entryDate < r.periodStart || c.entryDate >= end) continue;
      corrections += c.corrections;
      lateEntries += c.late;
    }
    out.set(r.id, { corrections, lateEntries, resubmitted: r.submissionCount > 1 });
  }
  return out;
}
