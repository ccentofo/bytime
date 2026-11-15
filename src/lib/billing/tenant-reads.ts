import 'server-only';
import { eq, count } from 'drizzle-orm';
import { getDbForUrl } from '@/db';
import { users, workspaceSettings } from '@/db/schema';
import { decrypt } from '@/lib/encryption';
import { canonicalTimeZone } from '@/lib/calendar-date';

/**
 * Billing infrastructure reads through a workspace's own database URL (feature-plan-per-user-billing.md §6.8, §6.10):
 * read-only, and they work in `billing_only`, where getDb() refuses, and from crons. They live here (not in
 * src/server/internal, which must never use the unrestricted getDbForUrl() client) like the notices' recipient read.
 */

export const DEFAULT_TIME_ZONE = 'America/New_York';

/** The workspace's active-user count. */
export async function countActiveUsers(row: { dbUrlEncrypted: string | null }): Promise<number> {
  if (!row.dbUrlEncrypted) throw new Error('No database URL for this workspace.');
  const db = getDbForUrl(decrypt(row.dbUrlEncrypted));
  const [result] = await db.select({ value: count() }).from(users).where(eq(users.isActive, true));
  return Number(result.value);
}

/** The workspace's time zone (mirrors notices.ts resolveRecipientsAndTimezone). */
export async function readWorkspaceTimeZone(row: { dbUrlEncrypted: string | null }): Promise<string> {
  if (!row.dbUrlEncrypted) return DEFAULT_TIME_ZONE;
  const db = getDbForUrl(decrypt(row.dbUrlEncrypted));
  const [settings] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
  return canonicalTimeZone(settings?.timezone) ?? DEFAULT_TIME_ZONE;
}
