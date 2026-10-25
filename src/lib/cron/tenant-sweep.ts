import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { withLockedPool } from '@/db/control-plane/locked';
import { SEED_EMAIL_DOMAINS } from '@/db/clear-tenant-data';
import { resolveAlert } from '@/lib/tenant/lifecycle-store';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { readCronState, type CronName, type CronResumes } from './heartbeat';

/**
 * Per-tenant loop of the reminder crons (feature-plan-launch-blockers.md P6 §4):
 *  - 240 s time budget inside the route's 300 s maxDuration; stopping early → `incomplete`, a Sentry message, and the
 *    ops alert `cron-incomplete:<name>` (immediate email; resolved by the next complete run);
 *  - fair rotation: tenants in slug order starting AFTER the last fully processed slug of the previous run (saved as
 *    `cursor` in cron_runs.last_summary), wrapping around — a budget stop never starves the same tail tenants daily;
 *  - one tenant failing is reported to Sentry (tenant tag), counted, and never stops the others;
 *  - audit A10: a run that stops INSIDE the first tenant of its rotation still advances the cursor past it (it is
 *    served last next time) — one oversized tenant can never stall the rotation — and the tenant a run stopped inside
 *    resumes after the last employee it finished (employees in id order);
 *  - audit R1: those positions are kept PER TENANT (`resumes: { [slug]: afterUserId }` in cron_runs.last_summary): set
 *    on a stop, deleted when the tenant finishes or fails, kept for tenants the run didn't reach (dropped for tenants no
 *    longer swept) — so two oversized tenants both make progress every time they come round.
 * Reminders a stopped run didn't reach today are not re-sent later (stated in §6).
 */

export const REMINDER_CRON_MAX_DURATION_S = 300;
export const REMINDER_CRON_BUDGET_MS = 240_000;

/** Pure: tenants sorted by slug, starting with the first slug after `cursor` (wrapping). No cursor → slug order. */
export function rotateAfterCursor<T extends { slug: string }>(tenants: T[], cursor: string | null): T[] {
  const sorted = [...tenants].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (!cursor) return sorted;
  const start = sorted.findIndex((t) => t.slug > cursor);
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * Demo/test seeders' addresses (SEED_EMAIL_DOMAINS) — domains we don't own, so never mailed. Tenant-level
 * lifecycle_exempt is deliberately NOT used to suppress reminders: it can cover comped real customers.
 */
export function isSeedRecipient(email: string): boolean {
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  return (SEED_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

export interface SweepResult {
  processed: number;
  candidates: number;
  failedTenants: string[];
  incomplete: boolean;
  cursor: string | null;
  resumes: CronResumes;
}

/** 'done', or where the tenant stopped for the time budget: after this employee id (null = before the first). */
export type TenantOutcome = 'done' | { stoppedAfter: string | null };

export async function sweepTenants<T extends { slug: string }>(opts: {
  name: CronName;
  tenants: T[];
  budgetMs?: number;
  clock?: () => number;
  /** Do one tenant, skipping employees up to and including `resumeAfter`. Stop (with where) when out of time. */
  processTenant: (tenant: T, ctx: { outOfTime: () => boolean; resumeAfter: string | null }) => Promise<TenantOutcome>;
}): Promise<SweepResult> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? REMINDER_CRON_BUDGET_MS);
  const outOfTime = () => clock() >= deadline;

  const { cursor: startCursor, resumes: startResumes } = await readCronState(opts.name);
  const order = rotateAfterCursor(opts.tenants, startCursor);
  let cursor = startCursor;
  let processed = 0;
  let incomplete = false;
  // Entries for tenants this run doesn't reach are carried over; tenants no longer swept are dropped.
  const swept = new Set(opts.tenants.map((t) => t.slug));
  const resumes: CronResumes = Object.fromEntries(Object.entries(startResumes).filter(([slug]) => swept.has(slug)));
  const failedTenants: string[] = [];

  for (const tenant of order) {
    if (outOfTime()) { incomplete = true; break; }
    const resumeAfter = resumes[tenant.slug] ?? null;
    try {
      const outcome = await opts.processTenant(tenant, { outOfTime, resumeAfter });
      if (outcome !== 'done') {
        incomplete = true;
        resumes[tenant.slug] = outcome.stoppedAfter;
        // Stopped inside the FIRST tenant of the rotation: move past it anyway, or it would stall every run.
        if (processed === 0) cursor = tenant.slug;
        break;
      }
      delete resumes[tenant.slug];
    } catch (err) {
      delete resumes[tenant.slug];
      failedTenants.push(tenant.slug);
      console.error(`Cron ${opts.name}: tenant ${tenant.slug} failed:`, err);
      Sentry.captureException(err, { tags: { tenant: tenant.slug, cron: opts.name } });
    }
    cursor = tenant.slug;
    processed++;
  }

  const alert = { tenantId: null, kind: 'cron-incomplete', dedupKey: opts.name };
  if (incomplete) {
    const detail = { processed, candidates: order.length, cursor, resumes };
    Sentry.captureMessage(`cron ${opts.name} stopped at its time budget`, { level: 'warning', extra: detail });
    await raiseAlertWithEmail({
      ...alert,
      detail,
      summary: `The ${opts.name} cron stopped at its ${Math.round((opts.budgetMs ?? REMINDER_CRON_BUDGET_MS) / 1000)} s time budget after ${processed} of ${order.length} workspaces. The next run starts after "${cursor ?? '(start)'}"${Object.keys(resumes).length ? `; resumes mid-way: ${Object.keys(resumes).join(', ')}` : ''}; reminders it didn't reach today are not re-sent.`,
    });
  } else {
    await withLockedPool((db) => resolveAlert(db, alert, new Date(), 'next run completed'));
  }

  return { processed, candidates: order.length, failedTenants, incomplete, cursor, resumes };
}
