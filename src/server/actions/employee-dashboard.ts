'use server';

import { getDb } from '@/db';
import { timesheetEntries, timesheetPeriods } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import { getCurrentPeriodStart, getLastWeekdayInPeriod } from '@/lib/date-utils';
import { getCurrentEffectiveConfigInternal } from '@/server/internal/pay-period-config';
import { resolvePeriod } from '@/server/internal/periods';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { getWorkspaceToday, getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { requireSession } from '@/lib/session';
import {
  addDays,
  calendarDayOf,
  dayOfWeek,
  formatCalendarDate,
  isAfter,
  isBefore,
  type CalendarDate,
} from '@/lib/calendar-date';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmployeeDashboardData {
  currentPeriod: {
    periodStart: CalendarDate;
    periodEnd: CalendarDate;
    periodLabel: string;
    status: string;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    reviewComment: string | null;
    totalHoursEntered: number;
    expectedWorkdays: number;
    daysWithEntries: number;
    daysRemaining: number;
    submissionDeadline: string;
    canSubmitToday: boolean;
  };
  recentPeriods: Array<{
    periodStart: CalendarDate;
    periodLabel: string;
    status: string;
    totalHours: number;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    /** `submittedAt` / `reviewedAt` as a day label in the workspace timezone (formatted on the
     *  server so server render and browser hydration agree). */
    submittedLabel: string | null;
    reviewedLabel: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Dashboard Query
// ---------------------------------------------------------------------------

export async function getEmployeeDashboardData(): Promise<EmployeeDashboardData> {
  const actor = await requireSession();
  const userId = actor.id;
  const db = await getDb();
  const today = await getWorkspaceToday();
  const landingConfig = await getCurrentEffectiveConfigInternal();
  const periodStart = getCurrentPeriodStart(today, landingConfig);
  // D3/§0.6: resolve this period's REAL config/length (handles a pending schedule change),
  // never the landing config assumed by default.
  const { config: periodConfig, numDays } = await resolvePeriod(periodStart);
  const periodEnd = addDays(periodStart, numDays - 1);
  const periodLabel = `${formatCalendarDate(periodStart, 'MMM D')} – ${formatCalendarDate(periodEnd, 'MMM D, YYYY')}`;
  const periodEndExclusive = addDays(periodStart, numDays);

  // Parallel fetch: current period status + hours + recent periods
  const [periodRows, hoursResult, recentRows] = await Promise.all([
    db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.userId, userId),
          eq(timesheetPeriods.periodStart, periodStart),
        )
      ),
    db
      .select({
        totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
        distinctDays: sql<number>`COUNT(DISTINCT ${timesheetEntries.entryDate})`,
      })
      .from(timesheetEntries)
      .where(
        and(
          eq(timesheetEntries.userId, userId),
          gte(timesheetEntries.entryDate, periodStart),
          lt(timesheetEntries.entryDate, periodEndExclusive),
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
                AND te2.entry_date = ${timesheetEntries.entryDate}
            )`
          ),
        )
      ),
    db
      .select({
        periodStart: timesheetPeriods.periodStart,
        status: timesheetPeriods.status,
        submittedAt: timesheetPeriods.submittedAt,
        reviewedAt: timesheetPeriods.reviewedAt,
        periodNumDays: timesheetPeriods.periodNumDays,
      })
      .from(timesheetPeriods)
      .where(eq(timesheetPeriods.userId, userId))
      .orderBy(desc(timesheetPeriods.periodStart))
      .limit(5),
  ]);

  const period = periodRows[0];

  // Count expected workdays (Mon-Fri) up to today
  let expectedWorkdays = 0;
  let daysRemaining = 0;
  for (let i = 0; i < numDays; i++) {
    const date = addDays(periodStart, i);
    const dow = dayOfWeek(date);
    const isWeekday = dow >= 1 && dow <= 5;
    if (isWeekday) {
      if (isAfter(date, today)) {
        daysRemaining++;
      } else {
        expectedWorkdays++;
      }
    }
  }

  // Mirrors submitPeriod's actual gate (lastWeekday, not periodEnd) so the dashboard never
  // claims a submission is allowed when the server would reject it.
  const lastWeekday = getLastWeekdayInPeriod(periodStart, periodConfig);
  const canSubmitToday = !isBefore(today, lastWeekday);

  // Build recent periods with hours
  const timeZone = await getWorkspaceTimezone();
  const recentNumDays = await Promise.all(
    recentRows.map((rp) => existingPeriodLength(db, rp.periodStart as CalendarDate, rp.periodNumDays))
  );
  const recentPeriods = recentRows.map((rp, i) => {
    const rpStart = rp.periodStart as CalendarDate;
    const rpNumDays = recentNumDays[i];
    const rpEnd = addDays(rpStart, rpNumDays - 1);
    return {
      periodStart: rpStart,
      periodLabel: `${formatCalendarDate(rpStart, 'MMM D')} – ${formatCalendarDate(rpEnd, 'MMM D, YYYY')}`,
      status: rp.status,
      totalHours: 0, // Will be populated below
      submittedAt: rp.submittedAt,
      reviewedAt: rp.reviewedAt,
      submittedLabel: rp.submittedAt ? formatCalendarDate(calendarDayOf(rp.submittedAt, timeZone), 'MMM D') : null,
      reviewedLabel: rp.reviewedAt ? formatCalendarDate(calendarDayOf(rp.reviewedAt, timeZone), 'MMM D') : null,
    };
  });

  // Parallel fetch: get hours for all recent periods concurrently
  const recentHoursResults = await Promise.all(
    recentPeriods.map((rp, i) => {
      const endExclusive = addDays(rp.periodStart, recentNumDays[i]);
      return db
        .select({
          total: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
        })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, userId),
            gte(timesheetEntries.entryDate, rp.periodStart),
            lt(timesheetEntries.entryDate, endExclusive),
            eq(
              timesheetEntries.revisionNumber,
              sql`(
                SELECT MAX(te2.revision_number)
                FROM timesheet_entries te2
                WHERE te2.user_id = ${timesheetEntries.userId}
                  AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
                  AND te2.entry_date = ${timesheetEntries.entryDate}
              )`
            ),
          )
        );
    })
  );

  // Assign results back to periods
  for (let i = 0; i < recentPeriods.length; i++) {
    recentPeriods[i].totalHours = Math.round(Number(recentHoursResults[i][0]?.total ?? 0) * 100) / 100;
  }

  return {
    currentPeriod: {
      periodStart,
      periodEnd,
      periodLabel,
      status: period?.status ?? 'draft',
      submittedAt: period?.submittedAt ?? null,
      reviewedAt: period?.reviewedAt ?? null,
      reviewComment: period?.reviewComment ?? null,
      totalHoursEntered: Math.round(Number(hoursResult[0]?.totalHours ?? 0) * 100) / 100,
      expectedWorkdays,
      daysWithEntries: Number(hoursResult[0]?.distinctDays ?? 0),
      daysRemaining,
      submissionDeadline: formatCalendarDate(lastWeekday, 'MMM D, YYYY'),
      canSubmitToday,
    },
    recentPeriods,
  };
}
