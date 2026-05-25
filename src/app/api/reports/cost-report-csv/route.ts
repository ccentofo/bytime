import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDetailedCostReport } from '@/server/actions/reports';
import { generateCsv } from '@/lib/reports/csv-generator';
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

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'Missing startDate or endDate' }, { status: 400 });
  }

  const data = await getDetailedCostReport(
    new Date(startDate),
    new Date(endDate),
    contractId ?? undefined
  );

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
