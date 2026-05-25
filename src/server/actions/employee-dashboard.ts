'use server';

import { db } from '@/db';
import { timesheetEntries, timesheetPeriods } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { getNumDaysInPeriod, getCurrentPeriodStart } from '@/lib/date-utils';

dayjs.extend(isSameOrAfter);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmployeeDashboardData {
  currentPeriod: {
    periodStart: Date;
    periodEnd: Date;
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
    periodStart: Date;
    periodLabel: string;
    status: string;
    totalHours: number;
    submittedAt: Date | null;
    reviewedAt: Date | null;
  }>;
}

// ---------------------------------------------------------------------------
// Dashboard Query
// ---------------------------------------------------------------------------

export async function getEmployeeDashboardData(userId: string): Promise<EmployeeDashboardData> {
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);
  const periodEnd = dayjs(periodStart).add(numDays - 1, 'day');
  const periodLabel = `${dayjs(periodStart).format('MMM D')} – ${periodEnd.format('MMM D, YYYY')}`;

  // Get current period status
  const periodRows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  const period = periodRows[0];

  // Get total hours entered in current period
  const hoursResult = await db
    .select({
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      distinctDays: sql<number>`COUNT(DISTINCT ${timesheetEntries.entryDate})`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, periodStart),
        lt(timesheetEntries.entryDate, dayjs(periodStart).add(numDays, 'day').toDate()),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    );

  // Count expected workdays (Mon-Fri) up to today
  let expectedWorkdays = 0;
  let daysRemaining = 0;
  const today = dayjs();
  for (let i = 0; i < numDays; i++) {
    const date = dayjs(periodStart).add(i, 'day');
    const dow = date.day();
    const isWeekday = dow >= 1 && dow <= 5;
    if (isWeekday) {
      if (date.isAfter(today, 'day')) {
        daysRemaining++;
      } else {
        expectedWorkdays++;
      }
    }
  }

  const canSubmitToday = dayjs().isSameOrAfter(periodEnd, 'day');

  // Get recent periods (last 5)
  const recentRows = await db
    .select({
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.userId, userId))
    .orderBy(desc(timesheetPeriods.periodStart))
    .limit(5);

  // For each recent period, get total hours
  const recentPeriods = await Promise.all(
    recentRows.map(async (rp) => {
      const rpNumDays = getNumDaysInPeriod(rp.periodStart);
      const rpEnd = dayjs(rp.periodStart).add(rpNumDays - 1, 'day');

      const rpHours = await db
        .select({
          total: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
        })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, userId),
            gte(timesheetEntries.entryDate, rp.periodStart),
            lt(timesheetEntries.entryDate, dayjs(rp.periodStart).add(rpNumDays, 'day').toDate()),
            eq(
              timesheetEntries.revisionNumber,
              sql`(
                SELECT MAX(te2.revision_number)
                FROM timesheet_entries te2
                WHERE te2.user_id = ${timesheetEntries.userId}
                  AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
                  AND te2.entry_date = ${timesheetEntries.entryDate}
              )`
            ),
          )
        );

      return {
        periodStart: rp.periodStart,
        periodLabel: `${dayjs(rp.periodStart).format('MMM D')} – ${rpEnd.format('MMM D, YYYY')}`,
        status: rp.status,
        totalHours: Math.round(Number(rpHours[0]?.total ?? 0) * 100) / 100,
        submittedAt: rp.submittedAt,
        reviewedAt: rp.reviewedAt,
      };
    })
  );

  return {
    currentPeriod: {
      periodStart,
      periodEnd: periodEnd.toDate(),
      periodLabel,
      status: period?.status ?? 'draft',
      submittedAt: period?.submittedAt ?? null,
      reviewedAt: period?.reviewedAt ?? null,
      reviewComment: period?.reviewComment ?? null,
      totalHoursEntered: Math.round(Number(hoursResult[0]?.totalHours ?? 0) * 100) / 100,
      expectedWorkdays,
      daysWithEntries: Number(hoursResult[0]?.distinctDays ?? 0),
      daysRemaining,
      submissionDeadline: periodEnd.format('MMM D, YYYY'),
      canSubmitToday,
    },
    recentPeriods,
  };
}
