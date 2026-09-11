import { NextRequest, NextResponse } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetPeriods, notificationPreferences } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import dayjs from 'dayjs';
import { sendSubmissionDeadlineEmail } from '@/lib/email/send';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';
import { checkCronRateLimit } from '@/lib/rate-limit';

/**
 * Cron endpoint: Send submission deadline reminders.
 * Should be called daily. Sends reminders 2 days before and on the last day of each period.
 *
 * Iterates all active tenants.
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
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day');
  const daysUntilEnd = periodEnd.diff(today, 'day');

  // Only send reminders 2 days before and on the last day
  if (daysUntilEnd !== 2 && daysUntilEnd !== 0) {
    return NextResponse.json({ message: 'Not a reminder day', sent: 0 });
  }

  const periodLabel = `${dayjs(periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;
  const deadlineDate = periodEnd.format('dddd, MMM D, YYYY');

  // Load all active tenants from the control plane
  const activeTenants = await controlDb.select().from(tenants).where(eq(tenants.status, 'active'));

  let totalSent = 0;

  for (const tenant of activeTenants) {
    const db = getDbForUrl(decrypt(tenant.dbUrlEncrypted));

    const allEmployees = await db
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .where(and(eq(users.isActive, true), eq(users.role, 'employee')));

    for (const emp of allEmployees) {
      const periods = await db
        .select({ status: timesheetPeriods.status })
        .from(timesheetPeriods)
        .where(
          and(
            eq(timesheetPeriods.userId, emp.id),
            eq(timesheetPeriods.periodStart, periodStart),
          )
        );

      const period = periods[0];
      if (period && (period.status === 'submitted' || period.status === 'approved')) {
        continue;
      }

      const prefs = await db
        .select({ enabled: notificationPreferences.emailDeadlineReminder })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, emp.id));

      const enabled = prefs.length === 0 ? true : prefs[0].enabled;

      if (enabled) {
        await sendSubmissionDeadlineEmail({
          employeeEmail: emp.email,
          employeeName: emp.fullName,
          periodLabel,
          deadlineDate,
        });
        totalSent++;
      }
    }
  }

  return NextResponse.json({ message: 'Submission deadline reminders sent', sent: totalSent });
}
