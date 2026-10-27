import 'server-only';
import { cache } from 'react';
import { getDb, type ReadDb } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { todayIn, canonicalTimeZone, addMonths, daysInMonth, startOfMonth, withDayOfMonth, type CalendarDate } from '@/lib/calendar-date';

const FALLBACK_TIMEZONE = 'America/New_York';

/**
 * The workspace's IANA timezone (workspace_settings is a single row, seeded by migration 0011
 * and by tenant provisioning). Cached per request (React cache) — this is read on nearly every
 * server action that touches a calendar date, so it should cost one query per request, not one
 * per call. Falls back to America/New_York if the row is somehow missing or holds an invalid
 * zone — "today" must always resolve to something rather than throw.
 */
export const getWorkspaceTimezone = cache(async (): Promise<string> => {
  const db = await getDb();
  const [row] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
  const timezone = row?.timezone;
  return canonicalTimeZone(timezone) ?? FALLBACK_TIMEZONE;
});

/**
 * "Today" as the workspace sees it — computed on the SERVER from the workspace's timezone, never
 * the browser's (a user could spoof their browser's clock/timezone to dodge the late-entry
 * rule). Replaces every `dayjs()` / `new Date()` used as a calendar day: the future-date block,
 * the late-entry rule, submit-before-last-weekday, the landing period, dashboards, the pending
 * pay-period-config check, and the crons.
 */
export const getWorkspaceToday = cache(async (): Promise<CalendarDate> => {
  const timezone = await getWorkspaceTimezone();
  return todayIn(timezone);
});

/**
 * Default manual-sync window for QuickBooks/Gusto: the start of the month two months back
 * through the end of the current month, in the workspace's calendar (never the admin's browser).
 */
export async function getDefaultSyncWindow(): Promise<{ periodStart: CalendarDate; periodEnd: CalendarDate }> {
  const today = await getWorkspaceToday();
  const periodStart = startOfMonth(addMonths(today, -2));
  const periodEnd = withDayOfMonth(today, daysInMonth(today));
  return { periodStart, periodEnd };
}

/**
 * The workspace's FLSA workweek start day (0 = Sunday … 6), or null while unset (payroll export refuses until set).
 * INTERNAL (UX-2 §4.5): Home's "Payroll workweek isn't set" item; the getWorkweekStartDaySetting action guards + calls.
 */
export async function workweekStartDayInternal(db: Pick<ReadDb, 'select'>): Promise<number | null> {
  const [row] = await db.select({ day: workspaceSettings.workweekStartDay }).from(workspaceSettings).limit(1);
  return row?.day ?? null;
}
