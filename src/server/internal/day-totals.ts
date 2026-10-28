import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '@/db';
import { timesheetEntries } from '@/db/schema';
import { formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { LATEST_REVISION } from './cost-basis';

/** A day can't exceed this across all charge codes (feature-plan-ux-timesheet.md UX3-D4). */
export const MAX_DAY_HOURS = 24;

/**
 * The latest-revision hours per date for one employee over `dates` ('YYYY-MM-DD' strings), in one grouped query —
 * read through the save's transaction (inside the employee lock; trap T-E). A date with no rows is absent (= 0).
 */
export async function latestDayTotals(tx: Pick<DbTx, 'select'>, userId: string, dates: CalendarDate[]): Promise<Record<string, number>> {
  if (dates.length === 0) return {};
  const rows = await tx
    .select({ day: timesheetEntries.entryDate, total: sql<string>`SUM(CAST(${timesheetEntries.hours} AS NUMERIC))` })
    .from(timesheetEntries)
    .where(and(eq(timesheetEntries.userId, userId), inArray(timesheetEntries.entryDate, dates), LATEST_REVISION))
    .groupBy(timesheetEntries.entryDate);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.day] = Number(r.total); // postgres-js returns SUMs as strings
  return out;
}

/**
 * UX3-D4 with the L1 exemption: a date whose new total is over 24 AND higher than before the save is refused (a day
 * already over 24 from imported history may be lowered one cell at a time). Returns the message, or null.
 */
export function dayTotalRefusal(dates: CalendarDate[], prevTotals: Record<string, number>, newTotals: Record<string, number>): string | null {
  const over = [...new Set(dates)].sort().filter((d) => {
    const prev = Number(prevTotals[d] ?? 0);
    const next = Number(newTotals[d] ?? 0);
    return next > MAX_DAY_HOURS && next > prev;
  });
  if (over.length === 0) return null;
  const first = over[0] as CalendarDate;
  const more = over.length > 1 ? ` (and ${over.length - 1} more ${over.length === 2 ? 'day' : 'days'})` : '';
  return `Hours for ${formatCalendarDate(first, 'ddd, MMM D, YYYY')} would total ${Number(newTotals[first] ?? 0)}${more}. A day can't exceed 24 hours across all charge codes.`;
}
