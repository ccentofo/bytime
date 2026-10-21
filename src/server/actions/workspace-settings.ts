'use server';

import { getDb } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { requireAdminFresh, requireSession } from '@/lib/session';
import { isValidTimeZone } from '@/lib/calendar-date';

/**
 * The workspace's configured IANA timezone, for the settings page's initial value.
 */
export async function getWorkspaceTimezoneSetting(): Promise<string> {
  await requireSession();
  const db = await getDb();
  const [row] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
  return row?.timezone ?? 'America/New_York';
}

/**
 * Update the workspace's IANA timezone. Admin-only (requireAdminFresh — a sensitive,
 * tenant-wide setting that changes what "today" and every late/future-date rule mean for
 * every employee).
 */
export async function updateWorkspaceTimezone(timezone: string): Promise<void> {
  await requireAdminFresh();
  if (!isValidTimeZone(timezone)) {
    throw new Error(`"${timezone}" is not a valid IANA timezone.`);
  }
  const db = await getDb();
  await db.update(workspaceSettings).set({ timezone, updatedAt: new Date() });
}
