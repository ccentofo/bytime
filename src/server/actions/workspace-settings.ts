'use server';

import { getDb, getDbForWrite } from '@/db';
import { workspaceSettings } from '@/db/schema';
import { requireAdminFresh, requireSession } from '@/lib/session';
import { canonicalTimeZone } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';
import { eq } from 'drizzle-orm';
import { logAdminChange } from '@/server/internal/admin-change-log';
import { workweekStartDayInternal } from '@/server/internal/workspace-settings';

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
export async function updateWorkspaceTimezone(timezone: string): Promise<ActionResult<string>> {
  return userAction(async () => {
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
  });
}

/** admin_change_log.entity_id for workspace-wide settings (the single workspace_settings row has no uuid). */
const WORKSPACE_SETTINGS_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The workspace's FLSA workweek start day (0 = Sunday … 6), or null while unset (payroll export refuses until set).
 */
export async function getWorkweekStartDaySetting(): Promise<number | null> {
  await requireSession();
  return workweekStartDayInternal(await getDb());
}

/**
 * Set the FLSA workweek start day (feature-plan-certified-outputs.md C7, CO-D2). Admin-only (fresh). FLSA requires a
 * fixed workweek (29 CFR 778.105) — the Settings page warns before changing a set value — and every change is
 * recorded in admin_change_log (old → new), in the same transaction.
 */
export async function updateWorkweekStartDay(day: number): Promise<ActionResult<number>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new UserFacingError('Choose a workweek start day (Sunday through Saturday).');
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const [current] = await tx.select({ day: workspaceSettings.workweekStartDay }).from(workspaceSettings).where(eq(workspaceSettings.id, 1)).for('update');
      const old = current?.day ?? null;
      if (old === day) return day;
      await tx.insert(workspaceSettings)
        .values({ id: 1, workweekStartDay: day, updatedAt: new Date() })
        .onConflictDoUpdate({ target: workspaceSettings.id, set: { workweekStartDay: day, updatedAt: new Date() } });
      await logAdminChange(tx, {
        actorId: actor.id, entity: 'workspace_settings', entityId: WORKSPACE_SETTINGS_ENTITY_ID, action: 'workweek_start_day_changed',
        oldValue: { workweekStartDay: old }, newValue: { workweekStartDay: day },
      });
      return day;
    });
  });
}
