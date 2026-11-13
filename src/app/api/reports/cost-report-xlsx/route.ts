import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport, getEmployeeSummaryReport } from '@/server/actions/reports';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { getSessionUser } from '@/lib/session';
import { isCalendarDate } from '@/lib/calendar-date';
import { noHours, noHoursMessage } from '@/lib/reports/empty-range';
import { EXCEL_COST_MAX_ROWS, EXCEL_COST_TOO_MANY_ROWS } from '@/lib/reports/limits';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');
  const format = searchParams.get('format');

  if (!startDate || !endDate || !isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return NextResponse.json({ error: 'Missing or invalid startDate/endDate (expected YYYY-MM-DD)' }, { status: 400 });
  }

  const dateRange = `${startDate} to ${endDate}`;
  let buffer: Buffer;

  try {
    if (format === 'summary') {
      // Hours + cost summary — approver-scoped (getEmployeeSummaryReport omits cost for supervisors).
      const data = await getEmployeeSummaryReport(startDate, endDate);
      // R4/R5: the summary counts direct time only (it inner-joins CLINs), so a leave-only range is "no direct hours".
      if (noHours(data, (e) => e.totalHours)) {
        return NextResponse.json({ error: noHoursMessage(startDate, endDate, { direct: true }) }, { status: 422 });
      }
      // R2-5: the Excel sheet itself must not have a cost column for supervisors — this is a
      // presentation check only; the data is already scoped by the guarded action above.
      const sessionUser = await getSessionUser();
      buffer = await generateEmployeeSummaryExcel(data, dateRange, sessionUser?.role === 'admin');
    } else {
      // Detailed cost report — dollar data, admin-only (enforced by requireAdmin()).
      const data = await getDetailedCostReport(
        startDate,
        endDate,
        contractId ?? undefined
      );
      // R4: no hours in range (cleared-only included) → 422, shown in place.
      if (noHours(data, (e) => e.totalHours)) {
        return NextResponse.json({ error: noHoursMessage(startDate, endDate) }, { status: 422 });
      }
      // feature-plan-large-report-responses.md §6.4 (Q1/Q2): building the workbook takes ~610 MB at 25,000 rows, so more
      // than the cap is refused before building it (after the no-hours check, so an empty range keeps its own message).
      if (data.length > EXCEL_COST_MAX_ROWS) {
        return NextResponse.json({ error: EXCEL_COST_TOO_MANY_ROWS }, { status: 422 });
      }
      buffer = await generateCostReportExcel(data, 'Cost Report', dateRange);
    }
  } catch (error) {
    return guardErrorResponse(error);
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.xlsx"`,
    },
  });
}
