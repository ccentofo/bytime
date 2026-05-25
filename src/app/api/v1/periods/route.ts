import { NextRequest } from 'next/server';
import { db } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { eq, and, gte, lt } from 'drizzle-orm';
import dayjs from 'dayjs';
import { validateApiKey, apiResponse, apiError } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const authResult = await validateApiKey(request);
  if (authResult instanceof Response) return authResult;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const status = searchParams.get('status');

  try {
    const conditions = [];

    if (startDate) {
      conditions.push(gte(timesheetPeriods.periodStart, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(lt(timesheetPeriods.periodStart, dayjs(endDate).add(1, 'day').toDate()));
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
