import { NextRequest, NextResponse } from 'next/server';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt } from '@/lib/encryption';
import { users, timesheetPeriods, notificationPreferences, workspaceSettings, payPeriodConfig } from '@/db/schema';
import { eq, and, lte, desc } from 'drizzle-orm';
import { sendSubmissionDeadlineEmail } from '@/lib/email/send';
import { DEFAULT_PERIOD_CONFIG, getCurrentPeriodStart, getLastWeekdayInPeriod, getNumDaysInPeriod, type PeriodConfig, type PeriodType } from '@/lib/date-utils';
import { checkCronRateLimit } from '@/lib/rate-limit';
import { addDays, diffDays, formatCalendarDate, isValidTimeZone, todayIn, type CalendarDate } from '@/lib/calendar-date';

const FALLBACK_TIMEZONE = 'America/New_York';

/** Lightweight per-tenant-db equivalent of getEffectiveConfigAt — the real one requires a user
 * session, which a cron iterating every tenant's own db connection doesn't have. */
async function getEffectiveConfigAtForDb(db: ReturnType<typeof getDbForUrl>, date: CalendarDate): Promise<PeriodConfig> {
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .where(lte(payPeriodConfig.effectiveFrom, date))
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt))
    .limit(1);
  if (rows.length === 0) return DEFAULT_PERIOD_CONFIG;
  const row = rows[0];
  return {
    periodType: row.periodType as PeriodType,
    anchorDate: row.anchorDate as CalendarDate,
    weekStartDay: row.weekStartDay,
  };
}

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
  if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Load all active tenants from the control plane
  const activeTenants = await controlDb.select().from(tenants).where(eq(tenants.status, 'active'));

  let totalSent = 0;

  for (const tenant of activeTenants) {
    const db = getDbForUrl(decrypt(tenant.dbUrlEncrypted));

    // D7: "today", the effective pay-period config, and the actual deadline (the last WEEKDAY
    // of the period — the same rule submitPeriod enforces, not just the period's calendar end,
    // which can land on a weekend) are all resolved per-tenant, never from a global clock or a
    // single hard-coded schedule shared by every tenant.
    const [settingsRow] = await db.select({ timezone: workspaceSettings.timezone }).from(workspaceSettings).limit(1);
    const timezone = settingsRow?.timezone && isValidTimeZone(settingsRow.timezone) ? settingsRow.timezone : FALLBACK_TIMEZONE;
    const today = todayIn(timezone);
    const periodConfig = await getEffectiveConfigAtForDb(db, today);
    const periodStart = getCurrentPeriodStart(today, periodConfig);
    const numDays = getNumDaysInPeriod(periodStart, periodConfig);
    const periodEnd = addDays(periodStart, numDays - 1);
    const lastWeekday = getLastWeekdayInPeriod(periodStart, periodConfig);
    const daysUntilDeadline = diffDays(today, lastWeekday);

    // Only send reminders 2 days before and on the deadline itself
    if (daysUntilDeadline !== 2 && daysUntilDeadline !== 0) continue;

    const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;
    const deadlineDate = formatCalendarDate(lastWeekday, 'dddd, MMM D, YYYY');

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
