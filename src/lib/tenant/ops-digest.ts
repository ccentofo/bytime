import 'server-only';
import { and, desc, eq, gte, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { opsAlerts, tenantAuditEvents, tenantNotices, tenants } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { resend, EMAIL_FROM } from '@/lib/email/client';
import { raiseAlert, resolveAlert } from './lifecycle-store';
import type { TenantRunResult } from './lifecycle-runner';
import { cronProblems, readCronRuns, type CronProblem } from '@/lib/cron/heartbeat';
import { signupsDueForDeletion, waitlistedSignups } from '@/lib/signup/maintenance';
import { backupDigest } from './backup-status';
import { checkExportCopies, exportDigest } from './export-status';

/**
 * Founder digest (feature-plan-terms-compliance-fixes.md §4.4, D4): sent to OPS_ALERT_EMAIL by the daily lifecycle
 * cron. Its own send requires a provider message id; a failure raises an alert and the next run retries.
 *
 * LB-D7 (feature-plan-launch-blockers.md P6 §3): ALWAYS sent — a short "all quiet" version when there is no news — so
 * its absence is itself the alarm ("no digest by 15:00 UTC → the lifecycle cron is down"). Lists every cron whose
 * last success is older than its own limit, or that has never run (cron_runs heartbeat).
 */

const MS_PER_HOUR = 3600_000;

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** feature-plan-per-user-billing.md §6.6: one line per `seat-quantity-corrected` event (exported for tests). */
export function correctionLines(rows: Array<{ slug: string; detail: string | null; createdAt: Date }>): string[] {
  return rows.map((r) => `${esc(r.slug)} — ${esc(r.detail ?? '')}, ${esc(r.createdAt.toISOString())}`);
}

/** One line per overdue / never-run cron (exported for tests). */
export function cronProblemLines(problems: CronProblem[]): string[] {
  return problems.map((p) => p.problem === 'never-ran'
    ? `${esc(p.name)} — <strong>never ran</strong> (no heartbeat recorded)`
    : `${esc(p.name)} — last success ${p.lastSucceededAt ? esc(p.lastSucceededAt.toISOString()) : '<strong>never</strong>'} (limit ${p.limitHours} h)`);
}

export async function sendOpsDigest(results: TenantRunResult[], now: Date, incomplete: boolean): Promise<'sent' | 'failed' | 'disabled'> {
  // feature-plan-cloud-export.md §6.7: the export findings, in the slot the retired F2 founder-export check left.
  await checkExportCopies(now);

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
    // feature-plan-per-user-billing.md §6.6 (rule 2): seat quantities the sync corrected in the last 24 hours.
    const corrections = await db.select({ slug: tenants.slug, detail: tenantAuditEvents.detail, createdAt: tenantAuditEvents.createdAt })
      .from(tenantAuditEvents).innerJoin(tenants, eq(tenantAuditEvents.tenantId, tenants.id))
      .where(and(eq(tenantAuditEvents.kind, 'seat-quantity-corrected'), gte(tenantAuditEvents.createdAt, new Date(now.getTime() - 24 * MS_PER_HOUR))))
      .orderBy(desc(tenantAuditEvents.createdAt));
    return { alerts, deleting, stalePending, forced, exempt, corrections };
  });
  const crons = cronProblems(await readCronRuns(), now);
  const waitlisted = await waitlistedSignups();
  const signupDeletions = await signupsDueForDeletion(now);
  // feature-plan-database-backups.md §6.9: the Backups section (backupDigest never throws; "could not be read" is news).
  const backups = await backupDigest(now);
  // feature-plan-cloud-export.md §6.7: a line every day, and the open legal holds listed on UTC day 1.
  const exportsSection = await exportDigest(now);

  const ready = results.filter((r) => r.readyForDeletion);
  const blocked = results.filter((r) => r.blockedDeletion);
  const hasNews = data.alerts.length > 0 || ready.length > 0 || blocked.length > 0 || data.deleting.length > 0
    || data.stalePending.length > 0 || incomplete || crons.length > 0 || waitlisted.length > 0 || signupDeletions.length > 0
    || data.corrections.length > 0 || backups.news
    || exportsSection.holds.length > 0; // the monthly open-hold list is news (audit round 1, FR13); the daily line alone isn't

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
  section('Seat quantities corrected (last 24 h)', correctionLines(data.corrections));
  section('Backups', backups.lines.map((l) => esc(l)));
  section('Exports', [esc(exportsSection.line)]);
  section('Open legal holds (monthly list; release each when its legal reason ends)', exportsSection.holds.map((h) =>
    `hold ${esc(h.holdId)} — workspace ${esc(h.tenantId)}, ${h.ageDays} days old: ${esc(h.reason)}`));
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
