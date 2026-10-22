import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { rejectUnauthorizedCron } from '@/lib/cron-auth';
import { runLifecycleCron } from '@/lib/tenant/lifecycle-runner';
import { sendOpsDigest } from '@/lib/tenant/ops-digest';

/**
 * Daily tenant lifecycle cron (feature-plan-terms-compliance-fixes.md §4.4): reconcile, apply due transitions,
 * deliver new notices, then the founder digest. The work itself lives in src/lib/tenant/lifecycle-runner.ts.
 */
export const maxDuration = 800;
const START_BUDGET_MS = 600_000;

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;

  const { results, candidates, incomplete } = await runLifecycleCron({ budgetMs: START_BUDGET_MS });
  const digest = await sendOpsDigest(results, new Date(), incomplete);
  const exempt = await withLockedPool((db) => db.select({ slug: tenants.slug }).from(tenants)
    .where(and(eq(tenants.lifecycleExempt, true), ne(tenants.status, 'deleted'))));

  const summary = {
    processed: results.length,
    candidates,
    incomplete,
    failed: results.filter((r) => r.outcome === 'failed' || r.outcome === 'lock-timeout').map((r) => r.slug),
    suspended: results.filter((r) => r.suspended).map((r) => r.slug),
    terminated: results.filter((r) => r.terminated).map((r) => r.slug),
    readyForDeletion: results.filter((r) => r.readyForDeletion).map((r) => r.slug),
    blockedDeletion: results.filter((r) => r.blockedDeletion).map((r) => r.slug),
    noticesEnqueued: results.reduce((n, r) => n + r.noticesEnqueued, 0),
    noticesSent: results.reduce((n, r) => n + r.noticesSent, 0),
    exempt: exempt.map((t) => t.slug), // F1: always listed, never hidden
    digest,
  };
  console.log('[tenant-lifecycle] run summary', JSON.stringify(summary));
  return NextResponse.json({ message: 'Tenant lifecycle processed', ...summary });
}
