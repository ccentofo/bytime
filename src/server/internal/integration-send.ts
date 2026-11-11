import 'server-only';
import type { ReadDb } from '@/db';
import { addDays, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { loadScheduleResolver } from '@/server/internal/pay-period-config';

/**
 * feature-plan-ux-integrations-billing.md I6: "Send hours now…" sends ONE pay period — no custom dates (QuickBooks
 * sends whole approved periods whose start falls in the range, so a custom range would mislead). The pay period
 * starting on `start`; anything that isn't a period start is refused. INTERNAL — callers authorize first.
 */
export async function payPeriodStartingOn(db: Pick<ReadDb, 'select'>, start: unknown): Promise<{ start: CalendarDate; end: CalendarDate }> {
  if (!isCalendarDate(start)) throw new UserFacingError('Choose a pay period.');
  const period = (await loadScheduleResolver(db)).periodContaining(start);
  if (period.start !== start) throw new UserFacingError('Choose a pay period.');
  return { start: period.start, end: addDays(period.start, period.numDays - 1) };
}
