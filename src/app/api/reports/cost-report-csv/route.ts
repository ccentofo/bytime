import { NextRequest, NextResponse } from 'next/server';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCsv } from '@/lib/reports/csv-generator';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const contractId = searchParams.get('contractId');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  let data;
  try {
    // Dollar data — admin-only. getDetailedCostReport enforces this via requireAdmin().
    data = await getDetailedCostReport(
      new Date(startDate),
      new Date(endDate),
      contractId ?? undefined
    );
  } catch (error) {
    return guardErrorResponse(error) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const csv = generateCsv(data, [
    { key: 'employeeName', header: 'Employee' },
    { key: 'contractName', header: 'Contract' },
    { key: 'contractNumber', header: 'Contract Number' },
    { key: 'clinNumber', header: 'CLIN' },
    { key: 'slinNumber', header: 'SLIN' },
    { key: 'lcatCode', header: 'LCAT Code' },
    { key: 'lcatTitle', header: 'LCAT Title' },
    { key: 'hourlyRate', header: 'Rate ($/hr)' },
    { key: 'entryDate', header: 'Date' },
    { key: 'totalHours', header: 'Hours' },
    { key: 'totalCost', header: 'Cost ($)' },
  ]);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.csv"`,
    },
  });
}
