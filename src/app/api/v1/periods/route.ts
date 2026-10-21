import { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';
import { addDays, isCalendarDate } from '@/lib/calendar-date';

// Date format: `startDate`/`endDate` query params and every `periodStart` in the response are
// plain 'YYYY-MM-DD' calendar-date strings — never an ISO instant/timestamp.
export async function GET(request: NextRequest) {
  const db = await getDb();
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const status = searchParams.get('status');

  if (startDate && !isCalendarDate(startDate)) {
    return apiError('startDate must be a valid date (YYYY-MM-DD).');
  }
  if (endDate && !isCalendarDate(endDate)) {
    return apiError('endDate must be a valid date (YYYY-MM-DD).');
  }

  try {
    const conditions = [];

    if (startDate && isCalendarDate(startDate)) {
      conditions.push(gte(timesheetPeriods.periodStart, startDate));
    }
    if (endDate && isCalendarDate(endDate)) {
      conditions.push(lt(timesheetPeriods.periodStart, addDays(endDate, 1)));
    }
    if (status) {
      conditions.push(eq(timesheetPeriods.status, status as any));
    }

    const rows = await db
      .select({
        id: timesheetPeriods.id,
        userId: timesheetPeriods.userId,
        employeeName: users.fullName,
        employeeEmail: users.email,
        periodStart: timesheetPeriods.periodStart,
        status: timesheetPeriods.status,
        submittedAt: timesheetPeriods.submittedAt,
        reviewedAt: timesheetPeriods.reviewedAt,
        reviewedBy: timesheetPeriods.reviewedBy,
      })
      .from(timesheetPeriods)
      .innerJoin(users, eq(timesheetPeriods.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(timesheetPeriods.periodStart);

    return apiResponse(rows, { total: rows.length });
  } catch (error) {
    return apiError('Internal server error', 500);
  }
}
