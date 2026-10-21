'use server';

import { getDb } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/session';
import {
  getNotificationPreferencesFor,
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from '@/server/internal/notifications';

/** Get the session user's own notification preferences. */
export async function getNotificationPreferences(): Promise<NotificationPrefs> {
  const actor = await requireSession();
  return getNotificationPreferencesFor(actor.id);
}

const NOTIFICATION_PREF_KEYS = [
  'emailOnSubmit',
  'emailOnApprove',
  'emailOnReject',
  'emailDailyReminder',
  'emailDeadlineReminder',
] as const satisfies readonly (keyof NotificationPrefs)[];

/**
 * Update the session user's own notification preferences (upsert).
 *
 * R2-6: builds the write from an explicit allowlist of the five boolean preference keys,
 * each required to be a real boolean, with `userId` always `actor.id` — the caller-supplied preferences
 * object is never spread wholesale into the write. Previously it was spread after `userId:
 * actor.id`, so a caller sending an extra `userId` field in the request body could create or
 * retarget another user's notification row.
 */
export async function updateNotificationPreferences(
  prefs: Partial<NotificationPrefs>
): Promise<void> {
  const actor = await requireSession();
  const db = await getDb();

  const allowedUpdates: Partial<NotificationPrefs> = {};
  for (const key of NOTIFICATION_PREF_KEYS) {
    if (prefs[key] !== undefined) {
      // A real boolean only: Boolean("false") would be true.
      if (typeof prefs[key] !== 'boolean') throw new Error(`Invalid value for ${key}.`);
      allowedUpdates[key] = prefs[key];
    }
  }

  const existing = await db
    .select({ userId: notificationPreferences.userId })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, actor.id));

  if (existing.length === 0) {
    await db.insert(notificationPreferences).values({
      ...DEFAULT_NOTIFICATION_PREFS,
      ...allowedUpdates,
      userId: actor.id,
    });
  } else {
    await db.update(notificationPreferences)
      .set({ ...allowedUpdates, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, actor.id));
  }
}
