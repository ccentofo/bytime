import 'server-only';
import { getDb } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * The switchable email preferences. The daily time-entry reminder is not one of them: it always goes to employees
 * (feature-plan-launch-hardening.md H1), so `email_daily_reminder` is unused.
 */
export type NotificationPrefs = {
  emailOnSubmit: boolean;
  emailOnApprove: boolean;
  emailOnReject: boolean;
  emailDeadlineReminder: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  emailOnSubmit: true,
  emailOnApprove: true,
  emailOnReject: true,
  emailDeadlineReminder: true,
};

/**
 * Get notification preferences for an arbitrary user. Returns defaults if no record exists.
 *
 * INTERNAL — not a server action. Used by trusted server code (email senders deciding whether to
 * notify a REVIEWER or EMPLOYEE, who is never the session user) and by the self-only
 * getNotificationPreferences() action in src/server/actions/notifications.ts.
 */
export async function getNotificationPreferencesFor(userId: string): Promise<NotificationPrefs> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  if (rows.length === 0) return { ...DEFAULT_NOTIFICATION_PREFS };

  const row = rows[0];
  return {
    emailOnSubmit: row.emailOnSubmit,
    emailOnApprove: row.emailOnApprove,
    emailOnReject: row.emailOnReject,
    emailDeadlineReminder: row.emailDeadlineReminder,
  };
}

/** Check if an arbitrary user has a specific notification enabled. */
export async function isNotificationEnabled(
  userId: string,
  notificationType: keyof NotificationPrefs
): Promise<boolean> {
  const prefs = await getNotificationPreferencesFor(userId);
  return prefs[notificationType];
}
