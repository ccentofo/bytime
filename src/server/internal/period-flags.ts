import 'server-only';
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { timesheetEntries } from '@/db/schema';
import { addDays, type CalendarDate } from '@/lib/calendar-date';

export interface PeriodFlags {
  /** Cells (app-recorded) whose latest revision is > 1 — a cell revised twice is one correction. */
  corrections: number;
  /**
   * Late cells: revision 1 carries a reason (a reason is stored on revision 1 only when the entry was late) AND the
   * cell was never revised — a late cell that was later corrected counts as a correction (A4).
   */
  lateEntries: number;
  /** Submitted more than once (returned, fixed, resubmitted). */
  resubmitted: boolean;
  /** Latest-revision hours in the period, imported rows included (A6: shown on Waiting rows). */
  hours: number;
}

export interface FlagRow { id: string; userId: string; periodStart: CalendarDate; periodNumDays: number; submissionCount: number }

/**
 * "Worth a look" flags and hours for the Approvals Waiting view (feature-plan-ux-approvals-payroll.md §3.1.2, A4): ONE
 * query, grouped per cell COALESCE(charge_code_id, indirect_code_id, clin_id) inside, then per (user, day) — the same
 * row count as before. The flags count app-recorded rows only (source = 'app' in the aggregates, not the WHERE), so
 * the hours include imported rows. Per-period totals are summed in JS. INTERNAL, no guard: getScopedPeriods passes
 * only rows the session user may decide.
 */
export async function periodFlags(db: Pick<ReadDb, 'select'>, rows: FlagRow[]): Promise<Map<string, PeriodFlags>> {
  const out = new Map<string, PeriodFlags>();
  if (rows.length === 0) return out;
  const ranges = rows.map((r) => and(
    eq(timesheetEntries.userId, r.userId),
    gte(timesheetEntries.entryDate, r.periodStart),
    lt(timesheetEntries.entryDate, addDays(r.periodStart, r.periodNumDays)),
  ));
  const cells = db
    .select({
      userId: timesheetEntries.userId,
      entryDate: timesheetEntries.entryDate,
      maxAppRev: sql<number | null>`MAX(${timesheetEntries.revisionNumber}) FILTER (WHERE ${timesheetEntries.source} = 'app')`.as('max_app_rev'),
      late1: sql<boolean>`BOOL_OR(${timesheetEntries.revisionNumber} = 1 AND ${timesheetEntries.source} = 'app' AND ${timesheetEntries.changeReasonCode} IS NOT NULL)`.as('late1'),
      latestHours: sql<string>`(ARRAY_AGG(${timesheetEntries.hours} ORDER BY ${timesheetEntries.revisionNumber} DESC))[1]`.as('latest_hours'),
    })
    .from(timesheetEntries)
    .where(or(...ranges))
    .groupBy(timesheetEntries.userId, timesheetEntries.entryDate,
      sql`COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})`)
    .as('c');
  const counts = await db
    .select({
      userId: cells.userId,
      entryDate: cells.entryDate,
      corrections: sql<number>`COUNT(*) FILTER (WHERE max_app_rev > 1)`.mapWith(Number),
      late: sql<number>`COUNT(*) FILTER (WHERE late1 AND max_app_rev = 1)`.mapWith(Number),
      hours: sql<number>`COALESCE(SUM(latest_hours::numeric), 0)`.mapWith(Number),
    })
    .from(cells)
    .groupBy(cells.userId, cells.entryDate);

  for (const r of rows) {
    const end = addDays(r.periodStart, r.periodNumDays);
    let corrections = 0;
    let lateEntries = 0;
    let cents = 0;
    for (const c of counts) {
      if (c.userId !== r.userId || c.entryDate < r.periodStart || c.entryDate >= end) continue;
      corrections += c.corrections;
      lateEntries += c.late;
      cents += Math.round(c.hours * 100);
    }
    out.set(r.id, { corrections, lateEntries, resubmitted: r.submissionCount > 1, hours: cents / 100 });
  }
  return out;
}
