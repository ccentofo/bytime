import 'server-only';
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { opsAlerts, tenantAuditEvents, tenantNotices, tenants } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { resend, EMAIL_FROM } from '@/lib/email/client';
import { BACKUP_RETENTION_DAYS } from './lifecycle-config';
import { addDays } from './lifecycle';
import { raiseAlert, resolveAlert } from './lifecycle-store';
import type { TenantRunResult } from './lifecycle-runner';
import { cronProblems, readCronRuns, type CronProblem } from '@/lib/cron/heartbeat';
import { signupsDueForDeletion, waitlistedSignups } from '@/lib/signup/maintenance';

/**
 * Founder digest (feature-plan-terms-compliance-fixes.md §4.4, D4): sent to OPS_ALERT_EMAIL by the daily lifecycle
 * cron. Its own send requires a provider message id; a failure raises an alert and the next run retries.
 *
 * LB-D7 (feature-plan-launch-blockers.md P6 §3): ALWAYS sent — a short "all quiet" version when there is no news — so
 * its absence is itself the alarm ("no digest by 15:00 UTC → the lifecycle cron is down"). Lists every cron whose
 * last success is older than its own limit, or that has never run (cron_runs heartbeat).
 */

const MS_PER_HOUR = 3600_000;

/** Founder export audit detail (written by scripts/tenant-export.ts). */
export interface FounderExportDetail {
  path: string;
  destroyBy: string; // ISO instant
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Raise/resolve the "founder export past its destroy-by date" alert for every taken export (F2). */
async function checkFounderExports(now: Date): Promise<void> {
  await withLockedPool(async (db) => {
    const events = await db.select().from(tenantAuditEvents)
      .where(inArray(tenantAuditEvents.kind, ['founder-export-taken', 'founder-export-destroyed', 'founder-export-legal-hold']))
      .orderBy(desc(tenantAuditEvents.createdAt));
    const deleted = new Map((await db.select({ id: tenants.id, deletedAt: tenants.deletedAt }).from(tenants)
      .where(isNotNull(tenants.deletedAt))).map((t) => [t.id, t.deletedAt!]));
    for (const taken of events.filter((e) => e.kind === 'founder-export-taken')) {
      const closed = events.some((e) => e.tenantId === taken.tenantId && e.kind !== 'founder-export-taken'
        && e.createdAt.getTime() >= taken.createdAt.getTime());
      let destroyBy: Date;
      try {
        destroyBy = new Date((JSON.parse(taken.detail ?? '{}') as FounderExportDetail).destroyBy);
      } catch {
        destroyBy = addDays(taken.createdAt, BACKUP_RETENTION_DAYS);
      }
      const deletedAt = deleted.get(taken.tenantId);
      if (deletedAt) {
        const byDeletion = addDays(deletedAt, BACKUP_RETENTION_DAYS);
        if (byDeletion.getTime() < destroyBy.getTime()) destroyBy = byDeletion;
      }
      const alert = { tenantId: taken.tenantId, kind: 'founder-export-overdue', dedupKey: taken.id };
      if (!closed && now.getTime() > destroyBy.getTime()) {
        await raiseAlert(db, { ...alert, detail: { destroyBy: destroyBy.toISOString() } }, now);
      } else {
        await resolveAlert(db, alert, now);
      }
    }
  });
}

/** One line per overdue / never-run cron (exported for tests). */
export function cronProblemLines(problems: CronProblem[]): string[] {
  return problems.map((p) => p.problem === 'never-ran'
    ? `${esc(p.name)} — <strong>never ran</strong> (no heartbeat recorded)`
    : `${esc(p.name)} — last success ${p.lastSucceededAt ? esc(p.lastSucceededAt.toISOString()) : '<strong>never</strong>'} (limit ${p.limitHours} h)`);
}

export async function sendOpsDigest(results: TenantRunResult[], now: Date, incomplete: boolean): Promise<'sent' | 'failed' | 'disabled'> {
  await checkFounderExports(now);

  const data = await withLockedPool(async (db) => {
    const alerts = await db.select({ a: opsAlerts, slug: tenants.slug }).from(opsAlerts)
      .leftJoin(tenants, eq(opsAlerts.tenantId, tenants.id))
      .where(isNull(opsAlerts.resolvedAt)).orderBy(desc(opsAlerts.lastSeenAt));
    const deleting = await db.select({ slug: tenants.slug, updatedAt: tenants.updatedAt }).from(tenants).where(eq(tenants.status, 'deleting'));
    const stalePending = await db.select({ slug: tenants.slug, kind: tenantNotices.kind, createdAt: tenantNotices.createdAt, lastError: tenantNotices.lastError })
      .from(tenantNotices).innerJoin(tenants, eq(tenantNotices.tenantId, tenants.id))
      .where(and(isNull(tenantNotices.sentAt), isNull(tenantNotices.forcedAt), isNull(tenantNotices.supersededAt),
        lt(tenantNotices.createdAt, new Date(now.getTime() - 24 * MS_PER_HOUR))));
    const forced = await db.select({ slug: tenants.slug, kind: tenantNotices.kind, forcedAt: tenantNotices.forcedAt, reason: tenantNotices.forcedReason })
      .from(tenantNotices).innerJoin(tenants, eq(tenantNotices.tenantId, tenants.id))
      .where(and(isNotNull(tenantNotices.forcedAt), isNull(tenantNotices.supersededAt), ne(tenants.status, 'deleted')));
    const exempt = await db.select({ slug: tenants.slug, name: tenants.name }).from(tenants)
      .where(and(eq(tenants.lifecycleExempt, true), ne(tenants.status, 'deleted')));
    return { alerts, deleting, stalePending, forced, exempt };
  });
  const crons = cronProblems(await readCronRuns(), now);
  const waitlisted = await waitlistedSignups();
  const signupDeletions = await signupsDueForDeletion(now);

  const ready = results.filter((r) => r.readyForDeletion);
  const blocked = results.filter((r) => r.blockedDeletion);
  const hasNews = data.alerts.length > 0 || ready.length > 0 || blocked.length > 0 || data.deleting.length > 0
    || data.stalePending.length > 0 || incomplete || crons.length > 0 || waitlisted.length > 0 || signupDeletions.length > 0;

  const to = process.env.OPS_ALERT_EMAIL;
  if (!to || !resend) {
    console.error('[ops digest] OPS_ALERT_EMAIL or RESEND_API_KEY not set — digest not sent.');
    if (process.env.NODE_ENV === 'production') {
      await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'digest-disabled' }, now));
    }
    return 'disabled';
  }

  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`<h3>${esc(title)}</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  };
  if (!hasNews) lines.push('<p>All quiet — nothing needs action today. Every cron has run within its limit.</p>');
  if (incomplete) lines.push('<p><strong>The lifecycle run stopped early (time budget); remaining tenants run next time.</strong></p>');
  section('Crons overdue or never run (cron_runs heartbeat)', cronProblemLines(crons));
  section('Waitlisted signups (npm run tenant:admin -- waitlist provision <id> --yes)', waitlisted.map((w) =>
    `${esc(w.slug)} — ${esc(w.email)}, waitlisted ${esc(w.waitlistedAt!.toISOString())} [id ${esc(w.id)}]`));
  section('Verified signups never provisioned — deleted within 3 days (LB-D5)', signupDeletions.map((d) =>
    `${esc(d.slug)} — ${esc(d.email)}, verified ${esc(d.verifiedAt!.toISOString())}${d.waitlistedAt ? ' (waitlisted)' : ''} [id ${esc(d.id)}]`));
  section('Ready for deletion (D4: run tenant:delete)', ready.map((r) =>
    `${esc(r.slug)} — deletion date ${esc(r.readyForDeletion!.deletionScheduledFor.toISOString())}${r.readyForDeletion!.overdue ? ' <strong>OVERDUE</strong>' : ''}`));
  section('Deletion blocked by payment activity', blocked.map((r) => `${esc(r.slug)}: ${esc(r.blockedDeletion)}`));
  section('Stuck in "deleting" (abandoned deletion run — resume tenant:delete)', data.deleting.map((d) => `${esc(d.slug)} since ${esc(d.updatedAt.toISOString())}`));
  section('Unresolved alerts', data.alerts.map(({ a, slug }) =>
    `${esc(slug ?? a.scope)} — <strong>${esc(a.kind)}</strong>${a.dedupKey ? ` (${esc(a.dedupKey)})` : ''} × ${a.occurrences}, last ${esc(a.lastSeenAt.toISOString())}${a.detail ? ` — ${esc(JSON.stringify(a.detail))}` : ''} [id ${esc(a.id)}]`));
  section('Notices pending more than 24 hours', data.stalePending.map((n) =>
    `${esc(n.slug)} — ${esc(n.kind)} since ${esc(n.createdAt.toISOString())}${n.lastError ? `: ${esc(n.lastError)}` : ''}`));
  section('Notices marked sent by founder override (force-notice-sent)', data.forced.map((n) =>
    `${esc(n.slug)} — ${esc(n.kind)} at ${esc(n.forcedAt!.toISOString())}: ${esc(n.reason ?? '')}`));
  section('Lifecycle-exempt workspaces (F1)', data.exempt.map((t) => `${esc(t.slug)} (${esc(t.name)})`));

  try {
    const { data: sent, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `CadenzPoint ops digest — ${now.toISOString().slice(0, 10)}${hasNews ? '' : ' (all quiet)'}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px">${lines.join('')}</div>`,
    });
    if (!sent?.id) throw new Error(error?.message ?? 'no message id');
    await withLockedPool(async (db) => {
      await resolveAlert(db, { tenantId: null, kind: 'digest-send-failed' }, now);
      await resolveAlert(db, { tenantId: null, kind: 'digest-disabled' }, now);
    });
    return 'sent';
  } catch (err) {
    console.error('[ops digest] send failed:', err);
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'digest-send-failed', detail: { error: String(err) } }, now));
    return 'failed';
  }
}
