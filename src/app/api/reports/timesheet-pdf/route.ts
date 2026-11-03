import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { getTimesheetReportData } from '@/server/actions/reports';
import { TimesheetPdfDocument } from '@/lib/reports/timesheet-pdf';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import React from 'react';
import { isCalendarDate } from '@/lib/calendar-date';
import { getWorkspaceTimezone } from '@/server/internal/workspace-settings';
import { pdfContentDisposition } from '@/lib/content-disposition';

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const periodStart = searchParams.get('periodStart');

  if (!userId || !periodStart || !isCalendarDate(periodStart)) {
    return NextResponse.json({ error: 'Missing or invalid userId/periodStart (expected YYYY-MM-DD)' }, { status: 400 });
  }

  // Rendering is inside the try too (feature-plan-ux-page-fixes.md C15): a render failure returns the JSON 500 the
  // client can explain, not Next's non-JSON error page.
  try {
    const [data, workspaceTimezone] = await Promise.all([
      getTimesheetReportData(userId, periodStart),
      getWorkspaceTimezone(),
    ]);
    if (!data) {
      return NextResponse.json({ error: 'No data found' }, { status: 404 });
    }

    const element = React.createElement(TimesheetPdfDocument, { data, workspaceTimezone }) as any;
    const pdfBuffer = await renderToBuffer(element);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': pdfContentDisposition(data.employee.fullName, periodStart),
      },
    });
  } catch (error) {
    return guardErrorResponse(error);
  }
}

