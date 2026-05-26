import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { auth } from '@/auth';
import { getTimesheetReportData } from '@/server/actions/reports';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import { checkReportRateLimit } from '@/lib/rate-limit';
import React from 'react';
import dayjs from 'dayjs';

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

  // Parse with dayjs to avoid timezone offset: new Date('2026-05-16') parses as UTC midnight,
  // which shifts to May 15 in US timezones. dayjs().startOf('day') ensures local midnight.
  const data = await getTimesheetReportData(userId, dayjs(periodStart).startOf('day').toDate());
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
