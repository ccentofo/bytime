import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { timesheetEntries, timesheetPeriods, users, clins, contracts, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { addDays, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { resolvePeriod } from '@/server/internal/periods';

// Date format: `startDate`/`endDate` query params and every `periodStart`/`entryDate` in the
// response are plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.
export async function GET(request: NextRequest) {
  const db = await getDb();
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate || !isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return apiError('startDate and endDate are required (YYYY-MM-DD).');
  }

  try {
    const start = startDate;
    const end = addDays(endDate, 1);

    // Get approved periods in the date range
    const approvedPeriods = await db
      .select({
        userId: timesheetPeriods.userId,
        periodStart: timesheetPeriods.periodStart,
        approvedAt: timesheetPeriods.reviewedAt,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.status, 'approved'),
          gte(timesheetPeriods.periodStart, start),
          lt(timesheetPeriods.periodStart, end),
        )
      );

    // For each approved period, get the latest-revision entries
    const results = [];
    for (const period of approvedPeriods) {
      // D3/§0.6: bound the window to this period's REAL length — the original query had no
      // upper bound at all here, so it silently pulled every later period's entries too.
      const pStart = period.periodStart as CalendarDate;
      const { numDays } = await resolvePeriod(pStart);
      const pEndExclusive = addDays(pStart, numDays);
      const entries = await db
        .select({
          userId: timesheetEntries.userId,
          employeeName: users.fullName,
          clinNumber: clins.clinNumber,
          contractNumber: contracts.contractNumber,
          indirectCode: indirectChargeCodes.code,
          entryDate: timesheetEntries.entryDate,
          hours: timesheetEntries.hours,
        })
        .from(timesheetEntries)
        .innerJoin(users, eq(timesheetEntries.userId, users.id))
        .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
        .leftJoin(contracts, eq(clins.contractId, contracts.id))
        .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
        .where(
          and(
            eq(timesheetEntries.userId, period.userId),
            gte(timesheetEntries.entryDate, pStart),
            lt(timesheetEntries.entryDate, pEndExclusive),
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

      results.push({
        periodStart: period.periodStart,
        approvedAt: period.approvedAt,
        entries,
      });
    }

    return apiResponse(results, { total: results.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
