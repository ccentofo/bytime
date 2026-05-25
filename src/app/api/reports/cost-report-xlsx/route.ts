import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDetailedCostReport, getEmployeeSummaryReport } from '@/server/actions/reports';
import { generateCostReportExcel, generateEmployeeSummaryExcel } from '@/lib/reports/cost-report-excel';
import { checkReportRateLimit } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const role = (session.user as any).role;
  if (role !== 'admin' && role !== 'supervisor') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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

  if (format === 'summary') {
    const data = await getEmployeeSummaryReport(
      new Date(startDate),
      new Date(endDate)
    );
    buffer = await generateEmployeeSummaryExcel(data, dateRange);
  } else {
    const data = await getDetailedCostReport(
      new Date(startDate),
      new Date(endDate),
      contractId ?? undefined
    );
    buffer = await generateCostReportExcel(data, 'Cost Report', dateRange);
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.xlsx"`,
    },
  });
}
