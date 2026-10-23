import { NextRequest } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { tenants } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { runCron } from '@/lib/cron/run-cron';
import { runLifecycleCron } from '@/lib/tenant/lifecycle-runner';
import { sendOpsDigest } from '@/lib/tenant/ops-digest';
import { runSignupMaintenance } from '@/lib/signup/maintenance';

/**
 * Daily tenant lifecycle cron (feature-plan-terms-compliance-fixes.md §4.4): reconcile, apply due transitions,
 * deliver new notices, then the founder digest. The work itself lives in src/lib/tenant/lifecycle-runner.ts.
 * Heartbeat + probe + optional Sentry monitor via runCron (feature-plan-launch-blockers.md P6 §3).
 */
export const maxDuration = 800;
const START_BUDGET_MS = 600_000;

export async function GET(request: NextRequest) {
  return runCron(request, 'tenant-lifecycle', runLifecycle, { maxRuntimeMinutes: Math.ceil(maxDuration / 60) });
}

async function runLifecycle(): Promise<Record<string, unknown>> {
  const { results, candidates, incomplete } = await runLifecycleCron({ budgetMs: START_BUDGET_MS });
  // feature-plan-launch-blockers.md P5: signup cleanup + Neon quota BEFORE the digest, even when the tenant loop
  // stopped early (never throws; each step is isolated).
  const signupMaintenance = await runSignupMaintenance(new Date());
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
    signupMaintenance,
    digest,
  };
  console.log('[tenant-lifecycle] run summary', JSON.stringify(summary));
  return { message: 'Tenant lifecycle processed', ...summary };
}
