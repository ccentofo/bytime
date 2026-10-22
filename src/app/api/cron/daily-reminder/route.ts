import { NextRequest, NextResponse } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetEntries, notificationPreferences, workspaceSettings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { sendDailyReminderEmail } from '@/lib/email/send';
import { checkCronRateLimit } from '@/lib/rate-limit';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { dayOfWeek, formatCalendarDate, isValidTimeZone, todayIn } from '@/lib/calendar-date';

const FALLBACK_TIMEZONE = 'America/New_York';

/**
 * Cron endpoint: Send daily time entry reminders.
 * Should be called once per day (e.g., 4:00 PM local time) on weekdays.
 *
 * Iterates all active tenants and sends reminders to employees who have
 * NOT entered time for today.
 *
 * Protect this endpoint with a CRON_SECRET header in production.
 */
export async function GET(request: NextRequest) {
  const rateLimited = checkCronRateLimit(request);
  if (rateLimited) return rateLimited;

  // Verify cron secret — accepts x-cron-secret (GitHub Actions) or
  // Authorization: Bearer (Vercel native crons).
  const cronSecret = request.headers.get('x-cron-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load all active tenants from the control plane
  // Only workspaces in `full` mode get reminders (read-only / billing-only / closed can't enter time).
  const now = new Date();
  const activeTenants = (await controlDb.select().from(tenants).where(eq(tenants.status, 'active')))
    .filter((t) => getTenantAccess(toLifecycleFacts(t), now) === 'full');

  let totalSent = 0;

  // One unreachable or unmigrated tenant must not stop reminders for every tenant after it.
  const failedTenants: string[] = [];

  for (const tenant of activeTenants) {
    try {
      // T7: dbUrlEncrypted is only null for a tombstoned ('deleted') tenant; this query is
      // filtered to status='active', which a deleted tenant never has.
      const db = getDbForUrl(decrypt(tenant.dbUrlEncrypted!));

      // D7: "today" and the weekend skip are evaluated per-tenant, in THAT tenant's workspace
      // timezone — never the cron process's own (UTC) clock, which would call it Saturday for a
      // tenant where it's already Monday morning, or vice versa.
      const [settingsRow] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
      const timezone = settingsRow?.timezone && isValidTimeZone(settingsRow.timezone) ? settingsRow.timezone : FALLBACK_TIMEZONE;
      const today = todayIn(timezone);
      const dow = dayOfWeek(today);
      if (dow === 0 || dow === 6) continue;

      // Get all active employees for this tenant
      const allEmployees = await db
        .select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        .where(and(eq(users.isActive, true), eq(users.role, 'employee')));

      // Find who has entered time today
      const entriesForToday = await db
        .select({ userId: timesheetEntries.userId })
        .from(timesheetEntries)
        .where(eq(timesheetEntries.entryDate, today));

      const usersWithEntries = new Set(entriesForToday.map((e) => e.userId));

      for (const emp of allEmployees) {
        if (usersWithEntries.has(emp.id)) continue;

        const prefs = await db
          .select({ enabled: notificationPreferences.emailDailyReminder })
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, emp.id));

        const enabled = prefs.length === 0 ? true : prefs[0].enabled;

        if (enabled) {
          await sendDailyReminderEmail({
            employeeEmail: emp.email,
            employeeName: emp.fullName,
            todayDate: formatCalendarDate(today, 'dddd, MMM D, YYYY'),
          });
          totalSent++;
        }
      }
    } catch (err) {
      failedTenants.push(tenant.slug);
      console.error(`Cron: tenant ${tenant.slug} failed:`, err);
    }
  }

  return NextResponse.json({ message: 'Daily reminders sent', sent: totalSent, failedTenants });
}
