import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { withLockedPool } from '@/db/control-plane/locked';
import { SEED_EMAIL_DOMAINS } from '@/db/clear-tenant-data';
import { resolveAlert } from '@/lib/tenant/lifecycle-store';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import type { BatchStopReason } from '@/lib/email/send-batch';
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
 *
 * feature-plan-reminder-capacity.md §6.4–§6.5:
 *  - a tenant can also stop for an EMAIL reason (`email-quota`, `email-config`, `email-failing`): the run stops there,
 *    as for any stop, and `stopReason` (also in the alert's stored `detail`) and Sentry name why. A missing reason
 *    means the time budget. An email stop keeps the tenant's starting resume position (the route returns it);
 *  - `sendCutoff` (budget deadline + REMINDER_SEND_GRACE_MS) is passed to the batch helper as `notAfter`, so no
 *    batch attempt runs past 260 s;
 *  - the cron-incomplete alert call is time-boxed (ALERT_TIMEOUT_MS): a hung alert email can't cost the run its
 *    cron_runs success record.
 */

export const REMINDER_CRON_MAX_DURATION_S = 300;
export const REMINDER_CRON_BUDGET_MS = 240_000;
/** Batch attempts may run this long past the budget deadline (the `notAfter` cap), §6.4. */
export const REMINDER_SEND_GRACE_MS = 20_000;
/** The cron-incomplete alert call (with its email) gets at most this long, §6.5. */
export const ALERT_TIMEOUT_MS = 10_000;

/** Why a tenant stopped sending: Resend's quota or configuration, or three failed batches in a row. */
export type CronStopReason = BatchStopReason | 'email-failing';

const REASON_TEXT: Record<CronStopReason, string> = {
  'email-quota': "Resend's email quota ran out",
  'email-config': 'Resend rejected the API key or sender domain',
  'email-failing': 'three email batches in a row failed',
};

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
  /** Why the run is incomplete; null when it completed. */
  stopReason: 'budget' | CronStopReason | null;
}

/**
 * 'done', or where the tenant stopped: after this employee id (null = before the first). No `reason` = the time
 * budget; an email `reason` stops the run's sending.
 */
export type TenantOutcome = 'done' | { stoppedAfter: string | null; reason?: CronStopReason };

export async function sweepTenants<T extends { slug: string }>(opts: {
  name: CronName;
  tenants: T[];
  budgetMs?: number;
  clock?: () => number;
  /** Do one tenant, skipping employees up to and including `resumeAfter`. Stop (with where) when out of time. */
  processTenant: (
    tenant: T,
    ctx: { outOfTime: () => boolean; resumeAfter: string | null; sendCutoff: number },
  ) => Promise<TenantOutcome>;
}): Promise<SweepResult> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? REMINDER_CRON_BUDGET_MS);
  const outOfTime = () => clock() >= deadline;
  const sendCutoff = deadline + REMINDER_SEND_GRACE_MS;

  const { cursor: startCursor, resumes: startResumes } = await readCronState(opts.name);
  const order = rotateAfterCursor(opts.tenants, startCursor);
  let cursor = startCursor;
  let processed = 0;
  let incomplete = false;
  let stopReason: SweepResult['stopReason'] = null;
  // Entries for tenants this run doesn't reach are carried over; tenants no longer swept are dropped.
  const swept = new Set(opts.tenants.map((t) => t.slug));
  const resumes: CronResumes = Object.fromEntries(Object.entries(startResumes).filter(([slug]) => swept.has(slug)));
  const failedTenants: string[] = [];

  for (const tenant of order) {
    if (outOfTime()) { incomplete = true; stopReason = 'budget'; break; }
    const resumeAfter = resumes[tenant.slug] ?? null;
    try {
      const outcome = await opts.processTenant(tenant, { outOfTime, resumeAfter, sendCutoff });
      if (outcome !== 'done') {
        incomplete = true;
        stopReason = outcome.reason ?? 'budget';
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
  if (incomplete && stopReason) {
    // raiseAlert stores only `detail` (not the summary), so the reason goes there too.
    const detail = { processed, candidates: order.length, cursor, resumes, stopReason };
    const resumesClause = Object.keys(resumes).length ? `; resumes mid-way: ${Object.keys(resumes).join(', ')}` : '';
    let summary: string;
    if (stopReason === 'budget') {
      Sentry.captureMessage(`cron ${opts.name} stopped at its time budget`, { level: 'warning', extra: detail });
      summary = `The ${opts.name} cron stopped at its ${Math.round((opts.budgetMs ?? REMINDER_CRON_BUDGET_MS) / 1000)} s time budget after ${processed} of ${order.length} workspaces. The next run starts after "${cursor ?? '(start)'}"${resumesClause}; reminders it didn't reach today are not re-sent.`;
    } else {
      // Sentry on every occurrence: the alert's own email probably fails for the same reason.
      console.warn(`Cron ${opts.name} stopped sending: ${stopReason}`);
      Sentry.captureMessage(`cron ${opts.name} stopped sending: ${stopReason}`, { level: 'error', extra: detail });
      summary = `The ${opts.name} cron stopped sending after ${processed} of ${order.length} workspaces because ${REASON_TEXT[stopReason]}. The next run starts after "${cursor ?? '(start)'}"${resumesClause}; reminders it didn't send today are not re-sent.`;
    }
    await timeBoxedAlert(opts.name, raiseAlertWithEmail({ ...alert, detail, summary }));
  } else {
    await withLockedPool((db) => resolveAlert(db, alert, new Date(), 'next run completed'));
  }

  return { processed, candidates: order.length, failedTenants, incomplete, cursor, resumes, stopReason };
}

/** raiseAlertWithEmail never throws, but its email has no timeout: give it ALERT_TIMEOUT_MS, then carry on. */
async function timeBoxedAlert(name: CronName, call: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    call.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ALERT_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) console.error(`Cron ${name}: the cron-incomplete alert didn't finish within ${ALERT_TIMEOUT_MS / 1000} s; carrying on.`);
}
