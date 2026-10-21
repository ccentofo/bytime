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

export type { NotificationPrefs };

/** Get the session user's own notification preferences. */
export async function getNotificationPreferences(): Promise<NotificationPrefs> {
  const actor = await requireSession();
  return getNotificationPreferencesFor(actor.id);
}

/**
 * Update the session user's own notification preferences (upsert).
 */
export async function updateNotificationPreferences(
  prefs: Partial<NotificationPrefs>
): Promise<void> {
  const actor = await requireSession();
  const db = await getDb();
  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, actor.id));

  if (existing.length === 0) {
    await db.insert(notificationPreferences).values({
      userId: actor.id,
      ...DEFAULT_NOTIFICATION_PREFS,
      ...prefs,
    });
  } else {
    await db.update(notificationPreferences)
      .set({ ...prefs, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, actor.id));
  }
}
