import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport, getEmployeeSummaryReport } from '@/server/actions/reports';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';

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
      // Hours + cost summary — approver-scoped (getEmployeeSummaryReport redacts cost for supervisors).
      const data = await getEmployeeSummaryReport(
        new Date(startDate),
        new Date(endDate)
      );
      buffer = await generateEmployeeSummaryExcel(data, dateRange);
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
    return guardErrorResponse(error) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.xlsx"`,
    },
  });
}
