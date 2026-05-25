import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/auth';
import { getTimesheetReportData } from '@/server/actions/reports';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import { checkReportRateLimit } from '@/lib/rate-limit';
import React from 'react';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const periodStart = searchParams.get('periodStart');

  if (!userId || !periodStart) {
    return NextResponse.json({ error: 'Missing userId or periodStart' }, { status: 400 });
  }

  const data = await getTimesheetReportData(userId, new Date(periodStart));
  if (!data) {
    return NextResponse.json({ error: 'No data found' }, { status: 404 });
  }

  const element = React.createElement(TimesheetPdfDocument, { data }) as any;
  const pdfBuffer = await renderToBuffer(element);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="timesheet-${data.employee.fullName.replace(/\s+/g, '-')}-${periodStart}.pdf"`,
    },
  });
}
