import 'server-only';
import { cache } from 'react';
import { getDb } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { todayIn, isValidTimeZone, type CalendarDate } from '@/lib/calendar-date';

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
  return timezone && isValidTimeZone(timezone) ? timezone : FALLBACK_TIMEZONE;
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
