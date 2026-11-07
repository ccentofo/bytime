import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkReportRateLimit } from '@/lib/rate-limit';
import { guardErrorResponse } from '@/lib/http-errors';
import { isCalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { AUDIT_CSV_HEADER, AUDIT_CSV_MAX_ROWS, getAuditExportCursor } from '@/server/internal/audit-export';

/**
 * The Audit trail CSV (feature-plan-ux-people-codes.md §6.5): exactly the entries the filters select, newest first.
 * Approver-guarded and scoped like the page (getAuditExportCursor). Counted first — 0 or more than 50,000 rows is a 422
 * before any streaming — then STREAMED in 1,000-row keyset batches (so Vercel's 4.5 MB buffered-response limit doesn't
 * apply and memory stays flat). Every request-bound value is resolved before the stream is built. A mid-stream failure
 * errors the stream (a failed download, never a silently short file) and is reported to Sentry.
 */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rateLimited = checkReportRateLimit(request);
  if (rateLimited) return rateLimited;

  const p = new URL(request.url).searchParams;
  const start = p.get('start');
  const end = p.get('end');
  if (!start || !end || !isCalendarDate(start) || !isCalendarDate(end)) {
    return NextResponse.json({ error: 'Missing or invalid start/end (expected YYYY-MM-DD)' }, { status: 400 });
  }

  let cursor: Awaited<ReturnType<typeof getAuditExportCursor>>;
  let total: number;
  try {
    cursor = await getAuditExportCursor({
      startDate: start, endDate: end,
      userId: p.get('user') ?? undefined,
      contractId: p.get('contract') ?? undefined,
      clinId: p.get('clin') ?? undefined,
      reasonCode: p.get('reason') ?? undefined,
      revisionsOnly: p.get('changed') === '1',
    });
    total = await cursor.count();
  } catch (err) {
    if (err instanceof UserFacingError) return NextResponse.json({ error: err.message }, { status: 400 });
    return guardErrorResponse(err);
  }
  if (total === 0) return NextResponse.json({ error: 'No entries in these dates.' }, { status: 422 });
  if (total > AUDIT_CSV_MAX_ROWS) return NextResponse.json({ error: 'More than 50,000 entries match. Choose a shorter date range.' }, { status: 422 });

  const encoder = new TextEncoder();
  let lastId: string | null = null;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (request.signal.aborted) { controller.close(); return; } // the client went away: stop fetching
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(`${AUDIT_CSV_HEADER.join(',')}\n`));
          return;
        }
        const batch = await cursor.batch(lastId);
        if (batch.lines.length > 0) controller.enqueue(encoder.encode(`${batch.lines.join('\n')}\n`));
        lastId = batch.lastId;
        if (lastId === null) controller.close();
      } catch (err) {
        Sentry.captureException(err);
        controller.error(err);
      }
    },
    cancel() {
      // The browser stopped the download: pull() is never called again, so no more batches are fetched.
    },
  }, { highWaterMark: 0 });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-trail-${start}-to-${end}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
