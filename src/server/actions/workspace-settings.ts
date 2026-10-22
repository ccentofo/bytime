'use server';

import { getDb, getDbForWrite } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { requireAdminFresh, requireSession } from '@/lib/session';
import { canonicalTimeZone } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';

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
export async function updateWorkspaceTimezone(timezone: string): Promise<string> {
  await requireAdminFresh();
  const canonical = canonicalTimeZone(timezone);
  if (!canonical) {
    throw new UserFacingError('Choose a timezone from the list (an IANA name such as America/New_York).');
  }
  const db = await getDbForWrite();
  // Upsert: an UPDATE alone would silently do nothing if the settings row were missing.
  await db.insert(workspaceSettings)
    .values({ id: 1, timezone: canonical, updatedAt: new Date() })
    .onConflictDoUpdate({ target: workspaceSettings.id, set: { timezone: canonical, updatedAt: new Date() } });
  return canonical;
}
