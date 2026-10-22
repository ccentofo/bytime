import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireAdminFresh } from '@/lib/session';
import { ExportNotAllowedError, getTenantForExport } from '@/lib/tenant/context';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createWorkspaceZipStream, openExportSnapshot } from '@/lib/export/workspace-export';

/**
 * R8/T6: full workspace export, streamed (feature-plan-terms-compliance-fixes.md §5.2). Every Customer Data table
 * and every timesheet revision from one REPEATABLE READ snapshot. Admin-only, in every non-closed mode.
 * Streaming keeps memory flat and avoids Vercel's 4.5 MB buffered-response cap.
 */
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  const actor = await requireAdminFresh();
  let tenant;
  try {
    tenant = await getTenantForExport();
  } catch (err) {
    // F5: a policy hold blocks export unless the founder allowed it; closed workspaces never export.
    if (err instanceof ExportNotAllowedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }

  const rate = checkRateLimit(`export:${tenant.slug}`, 5, 60 * 60 * 1000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs);

  let snapshot;
  try {
    snapshot = await openExportSnapshot(tenant.dbUrl);
  } catch (err) {
    Sentry.captureException(err);
    return NextResponse.json({ error: 'Could not start the export. Please try again.' }, { status: 503 });
  }

  const stream = createWorkspaceZipStream(snapshot, {
    tenantSlug: tenant.slug,
    signal: request.signal,
    onError: (err) => {
      console.error(`workspace export failed: tenant=${tenant.slug} admin=${actor.id}`, err);
      Sentry.captureException(err);
    },
    onComplete: (rowCounts) => {
      console.log(`workspace export: tenant=${tenant.slug} admin=${actor.id} rows=${JSON.stringify(rowCounts)}`);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${tenant.slug}-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
