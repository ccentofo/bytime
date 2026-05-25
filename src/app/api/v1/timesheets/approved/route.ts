import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetEntries, timesheetPeriods, users, clins, contracts, indirectChargeCodes } from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate) {
    return apiError('startDate and endDate are required.');
  }

  try {
    const start = new Date(startDate);
    const end = dayjs(endDate).add(1, 'day').toDate();

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
            gte(timesheetEntries.entryDate, period.periodStart),
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
