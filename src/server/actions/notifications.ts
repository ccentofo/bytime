'use server';

import { db } from '@/db';
import { notificationPreferences, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Notification Preferences CRUD
// ---------------------------------------------------------------------------

export type NotificationPrefs = {
  emailOnSubmit: boolean;
  emailOnApprove: boolean;
  emailOnReject: boolean;
  emailDailyReminder: boolean;
  emailDeadlineReminder: boolean;
};

const DEFAULT_PREFS: NotificationPrefs = {
  emailOnSubmit: true,
  emailOnApprove: true,
  emailOnReject: true,
  emailDailyReminder: true,
  emailDeadlineReminder: true,
};

/**
 * Get notification preferences for a user.
 * Returns defaults if no record exists.
 */
export async function getNotificationPreferences(userId: string): Promise<NotificationPrefs> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  if (rows.length === 0) return { ...DEFAULT_PREFS };

  const row = rows[0];
  return {
    emailOnSubmit: row.emailOnSubmit,
    emailOnApprove: row.emailOnApprove,
    emailOnReject: row.emailOnReject,
    emailDailyReminder: row.emailDailyReminder,
    emailDeadlineReminder: row.emailDeadlineReminder,
  };
}

/**
 * Update notification preferences for a user.
 * Creates the record if it doesn't exist (upsert).
 */
export async function updateNotificationPreferences(
  userId: string,
  prefs: Partial<NotificationPrefs>
): Promise<void> {
  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  if (existing.length === 0) {
    await db.insert(notificationPreferences).values({
      userId,
      ...DEFAULT_PREFS,
      ...prefs,
    });
  } else {
    await db.update(notificationPreferences)
      .set({ ...prefs, updatedAt: new Date() })
      .where(eq(notificationPreferences.userId, userId));
  }
}

/**
 * Check if a user has a specific notification enabled.
 */
export async function isNotificationEnabled(
  userId: string,
  notificationType: keyof NotificationPrefs
): Promise<boolean> {
  const prefs = await getNotificationPreferences(userId);
  return prefs[notificationType];
}
