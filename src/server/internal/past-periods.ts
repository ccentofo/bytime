import 'server-only';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { timesheetEntries, timesheetPeriods, users } from '@/db/schema';
import { addDays, calendarDayOf, min as minDate, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import { loadScheduleResolver, type ResolvedPeriod } from './pay-period-config';
import { approvalLabels } from './approval-label';
import { LATEST_REVISION } from './cost-basis';

type Reader = Pick<ReadDb, 'select'>;

export const PAST_PERIODS_PAGE_SIZE = 26;

/**
 * One page, plus the CURRENT period's start as of this response — the client marks "(current)" from the latest response
 * only, and refreshes page 0 when it moved (a new period started since; UX-TIMESHEET-B-AUDIT L12).
 */
export interface PastPeriodsPage { rows: PastPeriodRow[]; page: number; hasMore: boolean; currentStart: CalendarDate }
const COMMENT_PREVIEW = 140;

export type PastPeriodStatus = 'notSubmitted' | 'submitted' | 'approved' | 'rejected';

export interface PastPeriodRow {
  start: CalendarDate;
  numDays: number;
  label: string;
  status: PastPeriodStatus;
  hours: number;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  /** At most 140 characters, then an ellipsis. */
  reviewComment: string | null;
  /** "Self-approved" / "Self-rejected" (approvalLabel), else null. */
  approvalBadge: string | null;
  isCurrent: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** At most 140 characters — counted in code points, so an emoji or other astral character is never split (L10). */
export function commentPreview(c: string | null): string | null {
  if (!c) return c;
  const chars = [...c];
  return chars.length > COMMENT_PREVIEW ? `${chars.slice(0, COMMENT_PREVIEW).join('')}…` : c;
}

/**
 * The session user's past timesheets, newest first, one page at a time (feature-plan-ux-timesheet.md A4.7, UX3-Q1):
 * every period from the current one back to the one containing the earliest of their creation day (workspace
 * timezone), their first entry and their first period row — imported entries create no period row, so the entry date
 * matters. Periods never submitted are listed as "notSubmitted" with their hours. Four queries per page. INTERNAL, no
 * guard: the getPastTimesheets action authorizes and passes the session user's own id.
 */
export async function pastPeriods(
  db: Reader,
  userId: string,
  page: number,
  pageSize: number,
  today: CalendarDate,
  timeZone: string,
): Promise<PastPeriodsPage> {
  // 1. The earliest bound, in one query.
  const [bounds] = await db
    .select({
      createdAt: users.createdAt,
      // The user id is a bound parameter: an interpolated column renders unqualified in a single-table select ("id"), which
      // Postgres binds to the subquery's own table (fix round 2, M3).
      firstEntry: sql<string | null>`(SELECT MIN(pp_te.entry_date)::text FROM timesheet_entries pp_te WHERE pp_te.user_id = ${userId})`,
      firstPeriod: sql<string | null>`(SELECT MIN(pp_tp.period_start)::text FROM timesheet_periods pp_tp WHERE pp_tp.user_id = ${userId})`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const resolver = await loadScheduleResolver(db);
  const current = resolver.periodContaining(today);
  const candidates = [calendarDayOf(bounds?.createdAt ?? new Date(), timeZone), bounds?.firstEntry, bounds?.firstPeriod]
    .filter((d): d is CalendarDate => typeof d === 'string');
  const earliest = minDate(...candidates);

  // 2. Walk back from the current period, in memory, to the period containing the earliest bound.
  const all: ResolvedPeriod[] = [current];
  while (all[all.length - 1].start > earliest) all.push(resolver.neighbor(all[all.length - 1].start, 'prev'));

  // 3. This page.
  const slice = all.slice(page * pageSize, (page + 1) * pageSize);
  const hasMore = all.length > (page + 1) * pageSize;
  if (slice.length === 0) return { rows: [], page, hasMore: false, currentStart: current.start };

  // 4. Latest-revision hours per day over the page's whole range (5. and the period rows), in parallel.
  const rangeStart = slice[slice.length - 1].start;
  const rangeEndExclusive = addDays(slice[0].start, slice[0].numDays);
  const [dayRows, periodRows] = await Promise.all([
    db.select({ day: timesheetEntries.entryDate, total: sql<string>`SUM(CAST(${timesheetEntries.hours} AS NUMERIC))` })
      .from(timesheetEntries)
      .where(and(eq(timesheetEntries.userId, userId), gte(timesheetEntries.entryDate, rangeStart), lt(timesheetEntries.entryDate, rangeEndExclusive), LATEST_REVISION))
      .groupBy(timesheetEntries.entryDate),
    db.select({
      id: timesheetPeriods.id, periodStart: timesheetPeriods.periodStart, status: timesheetPeriods.status, submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt, reviewedBy: timesheetPeriods.reviewedBy, reviewComment: timesheetPeriods.reviewComment,
    })
      .from(timesheetPeriods)
      .where(and(eq(timesheetPeriods.userId, userId), inArray(timesheetPeriods.periodStart, slice.map((p) => p.start)))),
  ]);
  const hoursOn = new Map(dayRows.map((r) => [r.day, Number(r.total)]));
  const rowFor = new Map(periodRows.map((r) => [r.periodStart, r]));
  const labels = periodRows.length === 0 ? new Map() : await approvalLabels(
    db,
    periodRows.map((r) => ({ id: r.id, userId, status: r.status, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt })),
    timeZone,
  );

  const rows = slice.map((p): PastPeriodRow => {
    const end = addDays(p.start, p.numDays - 1);
    let hours = 0;
    for (let i = 0; i < p.numDays; i++) hours += hoursOn.get(addDays(p.start, i)) ?? 0;
    const row = rowFor.get(p.start);
    return {
      start: p.start,
      numDays: p.numDays,
      label: periodLabel(p.start, end), // the timesheet's own format, "Oct 16 – 31, 2026" (L15)
      status: !row || row.status === 'draft' ? 'notSubmitted' : row.status,
      hours: round2(hours),
      submittedAt: row?.submittedAt ?? null,
      reviewedAt: row?.reviewedAt ?? null,
      reviewComment: commentPreview(row?.reviewComment ?? null),
      approvalBadge: row ? labels.get(row.id)?.badge ?? null : null,
      isCurrent: p.start === current.start,
    };
  });
  return { rows, page, hasMore, currentStart: current.start };
}
