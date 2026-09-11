import { NextRequest, NextResponse } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetEntries, notificationPreferences } from '@/db/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import dayjs from 'dayjs';
import { sendDailyReminderEmail } from '@/lib/email/send';
import { checkCronRateLimit } from '@/lib/rate-limit';

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
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = dayjs().startOf('day');
  const tomorrow = today.add(1, 'day');

  // Skip weekends
  const dow = today.day();
  if (dow === 0 || dow === 6) {
    return NextResponse.json({ message: 'Weekend — no reminders sent', sent: 0 });
  }

  // Load all active tenants from the control plane
  const activeTenants = await controlDb.select().from(tenants).where(eq(tenants.status, 'active'));

  let totalSent = 0;

  for (const tenant of activeTenants) {
    const db = getDbForUrl(decrypt(tenant.dbUrlEncrypted));

    // Get all active employees for this tenant
    const allEmployees = await db
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.role, 'employee')));

    // Find who has entered time today
    const entriesForToday = await db
      .select({ userId: timesheetEntries.userId })
      .from(timesheetEntries)
      .where(
        and(
          gte(timesheetEntries.entryDate, today.toDate()),
          lt(timesheetEntries.entryDate, tomorrow.toDate()),
        )
      );

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
          todayDate: today.format('dddd, MMM D, YYYY'),
        });
        totalSent++;
      }
    }
  }

  return NextResponse.json({ message: 'Daily reminders sent', sent: totalSent });
}
