import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport, getEmployeeSummaryReport } from '@/server/actions/reports';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { getSessionUser } from '@/lib/session';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');
  const format = searchParams.get('format');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  const dateRange = `${startDate} to ${endDate}`;
  let buffer: Buffer;

  try {
    if (format === 'summary') {
      // Hours + cost summary — approver-scoped (getEmployeeSummaryReport omits cost for supervisors).
      const data = await getEmployeeSummaryReport(
        new Date(startDate),
        new Date(endDate)
      );
      // R2-5: the Excel sheet itself must not have a cost column for supervisors — this is a
      // presentation check only; the data is already scoped by the guarded action above.
      const sessionUser = await getSessionUser();
      buffer = await generateEmployeeSummaryExcel(data, dateRange, sessionUser?.role === 'admin');
    } else {
      // Detailed cost report — dollar data, admin-only (enforced by requireAdmin()).
      const data = await getDetailedCostReport(
        new Date(startDate),
        new Date(endDate),
        contractId ?? undefined
      );
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
