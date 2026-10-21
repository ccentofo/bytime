import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { getTimesheetReportData } from '@/server/actions/reports';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import React from 'react';
import { isCalendarDate } from '@/lib/calendar-date';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const periodStart = searchParams.get('periodStart');

  if (!userId || !periodStart || !isCalendarDate(periodStart)) {
    return NextResponse.json({ error: 'Missing or invalid userId/periodStart (expected YYYY-MM-DD)' }, { status: 400 });
  }

  let data;
  let workspaceTimezone: string;
  try {
    [data, workspaceTimezone] = await Promise.all([
      getTimesheetReportData(userId, periodStart),
      getWorkspaceTimezone(),
    ]);
  } catch (error) {
    return guardErrorResponse(error);
  }
  if (!data) {
    return NextResponse.json({ error: 'No data found' }, { status: 404 });
  }

  const element = React.createElement(TimesheetPdfDocument, { data, workspaceTimezone }) as any;
  const pdfBuffer = await renderToBuffer(element);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="timesheet-${data.employee.fullName.replace(/\s+/g, '-')}-${periodStart}.pdf"`,
    },
  });
}
