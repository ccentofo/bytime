/**
 * Founder tooling for tenant lifecycle facts (feature-plan-terms-compliance-fixes.md §5.6, F1, F2, F4). Logic:
 * src/lib/tenant/admin-commands.ts — every write takes the tenant advisory lock, bumps lifecycle_version and is
 * audited.
 *
 * Usage (npm run tenant:admin -- <command> ...):
 *   show <slug>
 *   extend-trial <slug> <days> --yes
 *   end-trial <slug> --yes
 *   suspend <slug> --reason "<why>" --yes          (policy suspension, Terms §17.3)
 *   unsuspend <slug> --yes                          (lifts a POLICY suspension only)
 *   set-policy-export <slug> on|off --reason "<why>" --yes  (F5: export for a policy-suspended workspace)
 *   set-exempt <slug> on|off --reason "<why>" --yes (F1 demo/internal workspaces only)
 *   force-notice-sent <slug> <kind> --reason "<why>" [--anchor <iso>] --yes
 *   export-destroyed <slug> [--legal-hold "<reason>"] --yes
 *   resolve-alert <alert-id> --note "<text>" --yes
 *   audit-note <slug> --note "<text>" --yes        (append a founder note to the audit trail, e.g. RESTORE.md)
 *   reopen-import-window <slug> --days <1-30> --reason "<why>" --yes  (certified-outputs C1: let one workspace import a
 *                                                   missed period of timesheet history; lock/overlap guards still apply)
 *   set-plan <slug> enterprise|standard --yes      (per-user billing §6.2: Enterprise = no user limit, never overwritten;
 *                                                   `standard` only undoes enterprise)
 *   ensure-customer <slug> --stripe-mode live|test --yes   (link the workspace's Stripe customer; prints cus_…)
 *   seat-sync <slug> --stripe-mode live|test [--yes]       (one quantity sync; without --yes: planned calls only, no writes)
 *   stripe-resync --since <iso> --stripe-mode live|test [--yes]
 *                                                   (feature-plan-control-plane-disaster.md §6.10, runbook B.8: re-link the
 *                                                   window's completed checkouts and refresh every paying workspace from
 *                                                   live Stripe; without --yes: the plan only. Prints slugs, never emails)
 *   window-signup <slug>                            (§6.10b, runbook B.9: the restored signups rows for an open window
 *                                                   address, to find the person; read-only)
 *   waitlist list                                   (LB-D2: verified signups held back by the daily cap)
 *   waitlist provision <signup-id> --yes            (provision one, bypassing the cap; emails the set-password link)
 *
 * Writes print what they would do and refuse to run without --yes. Running app instances cache the tenant
 * registry for up to 60 seconds, so a change can take a minute to show in the app.
 *
 * Runs under Node's react-server condition (package.json) so server-only modules load.
 * Required env (.env.local then .env): CONTROL_PLANE_DATABASE_URL. `show` also reads the workspace's own database for
 * the import-window state and the live active-user count when ENCRYPTION_KEY is set (otherwise it prints "unknown").
 * The commands that call Stripe (`ensure-customer`, `seat-sync`) also need STRIPE_SECRET_KEY of the intended mode, and
 * `seat-sync` needs ENCRYPTION_KEY (it counts users in the workspace database). They refuse unless --stripe-mode matches
 * the key.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { opsAlerts, tenantAuditEvents, tenantNotices, tenants, tenantSeatBilling } from '../src/db/control-plane/schema';
import { withLockedPool } from '../src/db/control-plane/locked';
import { getTenantAccess } from '../src/lib/tenant/lifecycle';
import { toLifecycleFacts } from '../src/lib/tenant/registry';
import type { TenantRow } from '../src/lib/tenant/lifecycle-store';
import { deliverPendingNotices } from '../src/lib/tenant/notices';
import {
  AdminCommandError, applyAdminPlan, checkStripeMode, ensureCustomerCommand, findForceableNotice, forceNoticeSent, plans,
  recordFounderExportDisposal, recordFounderNote, resolveAlertById, seatSyncCommand, setPlanPlanner, stripeKeyMode, stripeResyncCommand,
  windowSignupCommand, type Planner,
} from '../src/lib/tenant/admin-commands';
import { printTargetBanner } from './lib/target';
import { listWaitlist, provisionWaitlistedSignup, WaitlistError } from '../src/lib/tenant/waitlist';
import { apexBaseUrl } from '../src/lib/tenant/host';
import { SIGNUP_DAILY_WORKSPACE_CAP } from '../src/lib/tenant/lifecycle-config';
import { getDbForUrl } from '../src/db';
import { periodEvents, users, workspaceSettings } from '../src/db/schema';
import { describeImportWindowState } from './lib/import-window-state';
import { decrypt } from '../src/lib/encryption';

const ACTOR = `founder:${process.env.USER ?? 'unknown'}`;
const CACHE_NOTE = 'Note: running app instances may show the old state for up to 60 seconds (registry cache).';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} needs a value.`);
  return v;
}

const iso = (d: Date | null) => d?.toISOString() ?? '(none)';

function printTenant(label: string, t: TenantRow) {
  console.log(`${label}:`);
  console.log(`  id:                         ${t.id}`); // RESTORE.md runbook A.3: the Disaster restore button takes ids
  console.log(`  access mode now:            ${getTenantAccess(toLifecycleFacts(t), new Date())}`);
  console.log(`  status:                     ${t.status}${t.suspensionReason ? ` (${t.suspensionReason})` : ''}`);
  console.log(`  lifecycle_exempt:           ${t.lifecycleExempt ? 'YES (demo/internal)' : 'no'}`);
  if (t.suspensionReason === 'policy') {
    console.log(`  policy hold export:         ${t.policyExportAllowed ? 'ALLOWED by founder' : 'blocked (default)'}`);
  }
  console.log(`  plan:                       ${t.plan}${t.planInterval ? ` (${t.planInterval})` : ''}`);
  console.log(`  collection_method:          ${t.collectionMethod ?? '(none)'}${t.subscriptionCancelAtPeriodEnd ? ' — cancels at period end' : ''}`);
  console.log(`  stripe customer:            ${t.stripeCustomerId ?? '(none)'}${t.stripeCustomerDeletedAt ? ` (deleted ${iso(t.stripeCustomerDeletedAt)})` : ''}`);
  console.log(`  subscription:               ${t.stripeSubscriptionId ?? '(none)'} ${t.subscriptionStatus ?? ''}`);
  console.log(`  current_period_end:         ${iso(t.currentPeriodEnd)}`);
  console.log(`  first_good_at:              ${iso(t.firstGoodAt)}`);
  console.log(`  trial_ends_at:              ${iso(t.trialEndsAt)}`);
  console.log(`  past_due_since:             ${iso(t.pastDueSince)}`);
  console.log(`  suspended_at:               ${iso(t.suspendedAt)}`);
  console.log(`  subscription_ended_at:      ${iso(t.subscriptionEndedAt)}`);
  console.log(`  deletion_scheduled_for:     ${iso(t.deletionScheduledFor)}`);
  console.log(`  deleted_at:                 ${iso(t.deletedAt)}`);
  console.log(`  lifecycle checked/failures: ${iso(t.lifecycleCheckedAt)} / ${t.lifecycleFailures}`);
  console.log(`  lifecycle_version:          ${t.lifecycleVersion}`);
  console.log(`  import window reopened to:  ${t.importWindowUntil ? `${iso(t.importWindowUntil)}${t.importWindowUntil.getTime() > Date.now() ? ' (in force)' : ' (expired)'}` : '(never reopened)'}`);
}

/** C1: the workspace's own history-import state (tenant DB). Never fails `show`. */
async function printImportWindow(t: TenantRow) {
  let closed: string;
  try {
    if (!process.env.ENCRYPTION_KEY || !t.dbUrlEncrypted) throw new Error('ENCRYPTION_KEY not set or no database');
    const db = getDbForUrl(decrypt(t.dbUrlEncrypted));
    const [row] = await db.select({ closedAt: workspaceSettings.historyImportClosedAt }).from(workspaceSettings).where(eq(workspaceSettings.id, 1)).limit(1);
    const [submitted] = await db.select({ id: periodEvents.id }).from(periodEvents)
      .where(and(eq(periodEvents.event, 'submitted'), eq(periodEvents.source, 'app'))).limit(1);
    closed = describeImportWindowState({ settingsRowExists: !!row, closedAt: row?.closedAt ?? null, hasAppSubmittedEvent: !!submitted });
  } catch (err) {
    closed = `unknown (tenant DB not reachable: ${err instanceof Error ? err.message : String(err)})`;
  }
  console.log(`  history import (tenant DB): ${closed}`);
}

/** Per-user billing §6.2: the seat row and the live active-user count (the quantity for hand-made subscriptions). */
async function printSeats(t: TenantRow) {
  const [seat] = await withLockedPool((db) => db.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, t.id)).limit(1));
  if (seat) {
    console.log(`  seat sync:                  quantity ${seat.stripeQuantity ?? '(unknown)'} on ${seat.stripeSubscriptionId ?? '(none)'}, billable ${seat.billableCount ?? '?'}, checked ${iso(seat.checkedAt)}`);
    console.log(`                              due ${iso(seat.syncDueAt)} (mark ${seat.markSeq}), failures ${seat.failures}${seat.lastError ? ` — ${seat.lastError}` : ''}, next attempt ${iso(seat.nextAttemptAt)}`);
  } else {
    console.log('  seat sync:                  (no row yet)');
  }
  let live: string;
  try {
    if (!process.env.ENCRYPTION_KEY || !t.dbUrlEncrypted) throw new Error('ENCRYPTION_KEY not set or no database');
    const db = getDbForUrl(decrypt(t.dbUrlEncrypted));
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.isActive, true));
    live = String(r.n);
  } catch (err) {
    live = `unknown (${err instanceof Error ? err.message : String(err)})`;
  }
  console.log(`  active users (live count):  ${live}`);
}

/** The Stripe-mode banner and guard (per-user billing §6.2) for commands that call Stripe. */
function stripeModeOrExit(rest: string[]) {
  const key = process.env.STRIPE_SECRET_KEY;
  console.log(`Stripe mode (from STRIPE_SECRET_KEY): ${stripeKeyMode(key) ?? 'unknown'}`);
  return checkStripeMode(flag(rest, '--stripe-mode'), key);
}

async function loadBySlug(slug: string): Promise<TenantRow> {
  const [t] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
  if (!t) fail(`No tenant with slug "${slug}".`);
  return t;
}

/** Preview the plan on the current row (validates), then apply it under the lock only with --yes. */
async function change(slug: string, yes: boolean, planner: Planner) {
  const before = await loadBySlug(slug);
  const preview = planner(before, toLifecycleFacts(before), new Date());
  printTenant('Before', before);
  console.log(`\nWould: ${preview.describe}`);
  if (!yes) {
    console.log('\nDry run — pass --yes to apply.');
    return;
  }
  const after = await applyAdminPlan(before.id, planner, ACTOR);
  console.log('');
  printTenant('After', after);
  console.log(`\n${CACHE_NOTE}`);
}

function confirmOrExit(yes: boolean) {
  if (!yes) {
    console.log('\nDry run — pass --yes to apply.');
    process.exit(0);
  }
}

async function show(slug: string) {
  const t = await loadBySlug(slug);
  printTenant(`Tenant "${slug}"`, t);
  await printImportWindow(t);
  await printSeats(t);
  await withLockedPool(async (db) => {
    const notices = await db.select().from(tenantNotices).where(eq(tenantNotices.tenantId, t.id)).orderBy(desc(tenantNotices.createdAt));
    console.log(`\nNotices (${notices.length}):`);
    for (const n of notices) {
      const state = n.sentAt ? `SENT ${iso(n.sentAt)} (${n.providerMessageId})`
        : n.forcedAt ? `FORCED ${iso(n.forcedAt)}: ${n.forcedReason}`
        : n.supersededAt ? `superseded ${iso(n.supersededAt)}`
        : `PENDING (attempts ${n.attempts}${n.lastError ? `, last error: ${n.lastError}` : ''})`;
      console.log(`  ${n.kind.padEnd(24)} anchor ${iso(n.scheduledFor)}  ${state}`);
    }
    const alerts = await db.select().from(opsAlerts).where(and(eq(opsAlerts.scope, t.id), isNull(opsAlerts.resolvedAt)));
    console.log(`\nUnresolved alerts (${alerts.length}):`);
    for (const a of alerts) console.log(`  [${a.id}] ${a.kind}${a.dedupKey ? ` (${a.dedupKey})` : ''} ×${a.occurrences} last ${iso(a.lastSeenAt)} ${a.detail ? JSON.stringify(a.detail) : ''}`);
    const audit = await db.select().from(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, t.id)).orderBy(desc(tenantAuditEvents.createdAt)).limit(50);
    console.log(`\nAudit events (latest ${audit.length}):`);
    for (const e of audit) console.log(`  ${iso(e.createdAt)} ${e.kind} by ${e.actor}${e.detail ? `: ${e.detail}` : ''}`);
    const exempt = await db.select({ slug: tenants.slug }).from(tenants).where(and(eq(tenants.lifecycleExempt, true), ne(tenants.status, 'deleted')));
    console.log(`\nAll lifecycle-exempt workspaces (F1): ${exempt.map((e) => e.slug).join(', ') || '(none)'}`);
  });
}

/** `stripe-resync` (feature-plan-control-plane-disaster.md §6.10): it takes no slug. Exit 1 if any workspace failed. */
async function stripeResync(args: string[]) {
  const since = flag(args, '--since') ?? fail('stripe-resync requires --since <iso> (the window start from the email).');
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) fail('--since must be an ISO date-time, e.g. 2026-11-18T03:00:00Z.');
  const mode = stripeModeOrExit(args);
  const yes = args.includes('--yes');
  const r = await stripeResyncCommand({ since: sinceDate, dryRun: !yes, actor: ACTOR });
  console.log(`Stripe resync (${mode} mode) since ${sinceDate.toISOString()} (checkouts from one hour earlier).`);
  console.log(`Window checkouts to re-link: ${r.links.length}${r.links.length ? ` (${r.links.join(', ')})` : ''}`);
  if (r.notThisWorkspace.length) console.log(`Not this workspace's checkout (left alone; a re-signup can reuse a slug): ${r.notThisWorkspace.join(', ')}`);
  console.log(`Paying workspaces to refresh from live Stripe: ${r.refresh.length}${r.refresh.length ? ` (${r.refresh.join(', ')})` : ''}`);
  if (r.readFailed.length) console.log(`Current customer couldn't be read (these fail with --yes): ${r.readFailed.join(', ')}`);
  if (!yes) {
    console.log('\nDry run — nothing was written. Pass --yes to apply.');
    return;
  }
  const out = r.outcomes!;
  console.log(`\nLinked: ${out.linked.length}${out.linked.length ? ` (${out.linked.join(', ')})` : ''}`);
  console.log(`Refreshed: ${out.refreshed.length}`);
  if (out.conflict.length) console.log(`Conflict (refreshed against the current customer; checkout-customer-conflict raised, see the digest): ${out.conflict.join(', ')}`);
  for (const f of out.failed) console.error(`✗ ${f.slug}: ${f.error}`);
  console.log('Notices this queued are delivered by the notice cron once the crons are re-enabled (runbook B.10).');
  if (out.failed.length) process.exit(1);
}

async function main() {
  printTargetBanner();
  if (process.argv[2] === 'stripe-resync') {
    await stripeResync(process.argv.slice(3));
    process.exit(0);
  }
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || !target) fail('Usage: tenant-admin.ts <command> <slug|alert-id> [args] [--yes] (see the header of scripts/tenant-admin.ts)');
  const yes = rest.includes('--yes');
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--yes'));

  switch (command) {
    case 'show':
      await show(target);
      break;
    case 'extend-trial':
      await change(target, yes, plans.extendTrial(Number(positional[0])));
      break;
    case 'end-trial':
      await change(target, yes, plans.endTrial());
      break;
    case 'suspend': {
      await change(target, yes, plans.suspend(flag(rest, '--reason') ?? fail('suspend requires --reason "<why>".')));
      if (yes) {
        // Deliver the §17.3 notice now; if it fails, the 10-minute delivery cron retries it.
        const t = await loadBySlug(target);
        const counts = await deliverPendingNotices(30_000, undefined, [t.id]);
        console.log(counts.sent > 0 ? '✓ Admins notified by email.' : '⚠ Notice not delivered yet — the delivery cron will retry (see `show`).');
      }
      break;
    }
    case 'set-policy-export': {
      const mode = positional[0];
      if (mode !== 'on' && mode !== 'off') fail('set-policy-export needs on|off.');
      await change(target, yes, plans.setPolicyExport(mode === 'on', flag(rest, '--reason') ?? fail('set-policy-export requires --reason "<why>".')));
      break;
    }
    case 'unsuspend':
      await change(target, yes, plans.unsuspend());
      break;
    case 'set-exempt': {
      const mode = positional[0];
      if (mode !== 'on' && mode !== 'off') fail('set-exempt needs on|off.');
      await change(target, yes, plans.setExempt(mode === 'on', flag(rest, '--reason') ?? fail('set-exempt requires --reason "<why>".')));
      break;
    }
    case 'force-notice-sent': {
      const kind = positional[0] ?? fail('force-notice-sent needs a notice kind.');
      const reason = flag(rest, '--reason') ?? fail('force-notice-sent requires --reason "<why>".');
      const anchorArg = flag(rest, '--anchor');
      const t = await loadBySlug(target);
      const notice = await findForceableNotice(t.id, kind, anchorArg ? new Date(anchorArg) : undefined);
      console.log(`Would mark "${kind}" (anchor ${notice.scheduledFor.toISOString()}) as given by founder override: ${reason}`);
      console.log('This unblocks transitions that wait on it. It is recorded as forced_at, never as sent_at, and listed in every digest.');
      confirmOrExit(yes);
      await forceNoticeSent(t.id, notice.id, reason, ACTOR);
      console.log(`✓ Forced. ${CACHE_NOTE}`);
      break;
    }
    case 'export-destroyed': {
      const hold = flag(rest, '--legal-hold');
      const t = await loadBySlug(target);
      console.log(hold ? `Would record a LEGAL HOLD: ${hold}` : 'Would record that the founder export was DESTROYED (all copies).');
      confirmOrExit(yes);
      const detail = await recordFounderExportDisposal(t.id, hold, ACTOR);
      console.log(`✓ Recorded (export: ${detail}).`);
      break;
    }
    case 'resolve-alert': {
      const note = flag(rest, '--note') ?? fail('resolve-alert requires --note "<text>".');
      console.log(`Would resolve alert ${target}: ${note}`);
      console.log('Resolving is bookkeeping only; it never changes a workspace\'s lifecycle state. A condition-based alert is raised again if the condition persists.');
      confirmOrExit(yes);
      await resolveAlertById(target, note, ACTOR);
      console.log('✓ Resolved.');
      break;
    }
    case 'audit-note': {
      const note = flag(rest, '--note') ?? fail('audit-note requires --note "<text>".');
      const t = await loadBySlug(target);
      console.log(`Would append to ${t.slug}'s audit trail: ${note}`);
      console.log('Append-only bookkeeping; it changes no lifecycle state.');
      confirmOrExit(yes);
      const id = await recordFounderNote(t.id, note, ACTOR);
      console.log(`✓ Recorded (audit event ${id}).`);
      break;
    }
    case 'reopen-import-window': {
      // Argument validation before any read or write: a missing/empty --reason or --days is refused, nothing audited.
      const days = Number(flag(rest, '--days') ?? fail('reopen-import-window requires --days <1-30>.'));
      const reason = flag(rest, '--reason') ?? fail('reopen-import-window requires --reason "<why>".');
      await change(target, yes, plans.reopenImportWindow(days, reason));
      break;
    }
    case 'set-plan':
      await change(target, yes, setPlanPlanner(positional[0] ?? fail('set-plan needs enterprise|standard.')));
      break;
    case 'ensure-customer': {
      const mode = stripeModeOrExit(rest);
      const t = await loadBySlug(target);
      console.log(`Would ensure a ${mode}-mode Stripe customer for ${t.slug} (current: ${t.stripeCustomerId ?? '(none)'}${t.stripeCustomerDeletedAt ? ', deleted' : ''}).`);
      confirmOrExit(yes);
      const customerId = await ensureCustomerCommand(t.id, mode, ACTOR);
      console.log(`✓ Stripe customer (${mode} mode): ${customerId}`);
      break;
    }
    case 'seat-sync': {
      const mode = stripeModeOrExit(rest);
      const t = await loadBySlug(target);
      if (!yes) {
        const r = await seatSyncCommand(t.id, { mode, dryRun: true, actor: ACTOR });
        console.log(`Dry run (${mode} mode), nothing written: ${r.decision ?? r.outcome}${r.from !== undefined ? `, Stripe quantity ${r.from}` : ''}${r.billable !== undefined ? `, billable ${r.billable}` : ''}`);
        for (const c of r.planned ?? []) console.log(`  would call ${c.label}: quantity ${c.quantity}, proration ${c.proration}`);
        if ((r.planned ?? []).length === 0) console.log('  no Stripe update planned');
        if (r.error) console.log(`  error: ${r.error}`);
        console.log('\nPass --yes to run it.');
        break;
      }
      const r = await seatSyncCommand(t.id, { mode, dryRun: false, actor: ACTOR });
      console.log(`Seat sync (${mode} mode): ${r.outcome}${r.from !== undefined ? ` (Stripe ${r.from} → ${r.to})` : ''}${r.billable !== undefined ? `, billable ${r.billable}` : ''}${r.error ? ` — ${r.error}` : ''}${r.invoiceSent ? `; sent invoice ${r.invoiceSent}` : ''}`);
      if (r.outcome === 'failed' || r.outcome === 'busy') process.exit(1);
      break;
    }
    case 'window-signup': {
      const r = await windowSignupCommand(target);
      console.log(`Window project ${r.projectId} for "${target}", created ${r.createdAt}; its window-project alert is ${r.alertId} (resolve-alert takes this id).`);
      if (r.rows.length === 0) {
        console.log('No restored signup for this address: use Stripe (Customers, metadata[\'slug\']) or the email log (RESTORE.md B.9).');
        break;
      }
      if (r.rows.length > 1) console.log(`${r.rows.length} signups match: don't guess. Match on the company name the customer used (ask when you email); contact the lead if it's still unclear.`);
      for (const x of r.rows) {
        console.log(`  "${x.companyName}"  ${x.email}  created ${x.createdAt.toISOString()}  ${x.verifiedAt ? `verified ${x.verifiedAt.toISOString()}` : 'not verified'}${x.waitlistedAt ? `  waitlisted ${x.waitlistedAt.toISOString()}` : ''}`);
      }
      break;
    }
    case 'waitlist': {
      console.log(`Workspace links in emails will use: ${apexBaseUrl()} (APP_ROOT_DOMAIN / NEXT_PUBLIC_APP_URL)`);
      if (target === 'list') {
        const { rows, createdLast24h } = await listWaitlist();
        console.log(`Workspaces created in the last 24 h: ${createdLast24h} (daily cap ${SIGNUP_DAILY_WORKSPACE_CAP}).`);
        if (rows.length === 0) console.log('Waitlist is empty.');
        for (const r of rows) console.log(`  ${r.id}  ${r.slug}  ${r.email}  "${r.companyName}"  waitlisted ${r.waitlistedAt!.toISOString()}`);
        break;
      }
      if (target !== 'provision') fail('Usage: waitlist list | waitlist provision <signup-id> --yes');
      const signupId = positional[0] ?? fail('waitlist provision needs a signup id (see `waitlist list`).');
      const { createdLast24h } = await listWaitlist();
      console.log(`Would provision waitlisted signup ${signupId}, bypassing the daily cap (${createdLast24h} created in the last 24 h; cap ${SIGNUP_DAILY_WORKSPACE_CAP}).`);
      confirmOrExit(yes);
      const r = await provisionWaitlistedSignup(signupId);
      console.log(`✓ Provisioned "${r.slug}" for ${r.email}.`);
      if (!r.emailed) {
        console.error(`✗ The set-password email could not be sent. Send this link to ${r.email} yourself:\n  ${r.setPasswordUrl}`);
        process.exit(1);
      }
      console.log('✓ Set-password email sent.');
      break;
    }
    default:
      fail(`Unknown command "${command}". See the header of scripts/tenant-admin.ts.`);
  }
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof AdminCommandError || err instanceof WaitlistError) fail(err.message);
  console.error('tenant-admin failed:', err?.message ?? err);
  process.exit(1);
});
