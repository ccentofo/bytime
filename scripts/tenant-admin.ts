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
 *   waitlist list                                   (LB-D2: verified signups held back by the daily cap)
 *   waitlist provision <signup-id> --yes            (provision one, bypassing the cap; emails the set-password link)
 *
 * Writes print what they would do and refuse to run without --yes. Running app instances cache the tenant
 * registry for up to 60 seconds, so a change can take a minute to show in the app.
 *
 * Runs under Node's react-server condition (package.json) so server-only modules load.
 * Required env (.env.local then .env): CONTROL_PLANE_DATABASE_URL. `show` also reads the workspace's own database for
 * the import-window state when ENCRYPTION_KEY is set (otherwise it prints "unknown").
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { opsAlerts, tenantAuditEvents, tenantNotices, tenants } from '../src/db/control-plane/schema';
import { withLockedPool } from '../src/db/control-plane/locked';
import { getTenantAccess } from '../src/lib/tenant/lifecycle';
import { toLifecycleFacts } from '../src/lib/tenant/registry';
import type { TenantRow } from '../src/lib/tenant/lifecycle-store';
import { deliverPendingNotices } from '../src/lib/tenant/notices';
import {
  AdminCommandError, applyAdminPlan, findForceableNotice, forceNoticeSent, plans, recordFounderExportDisposal,
  recordFounderNote, resolveAlertById, type Planner,
} from '../src/lib/tenant/admin-commands';
import { printTargetBanner } from './lib/target';
import { listWaitlist, provisionWaitlistedSignup, WaitlistError } from '../src/lib/tenant/waitlist';
import { apexBaseUrl } from '../src/lib/tenant/host';
import { SIGNUP_DAILY_WORKSPACE_CAP } from '../src/lib/tenant/lifecycle-config';
import { getDbForUrl } from '../src/db';
import { periodEvents, workspaceSettings } from '../src/db/schema';
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
  console.log(`  access mode now:            ${getTenantAccess(toLifecycleFacts(t), new Date())}`);
  console.log(`  status:                     ${t.status}${t.suspensionReason ? ` (${t.suspensionReason})` : ''}`);
  console.log(`  lifecycle_exempt:           ${t.lifecycleExempt ? 'YES (demo/internal)' : 'no'}`);
  if (t.suspensionReason === 'policy') {
    console.log(`  policy hold export:         ${t.policyExportAllowed ? 'ALLOWED by founder' : 'blocked (default)'}`);
  }
  console.log(`  plan:                       ${t.plan}`);
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

async function main() {
  printTargetBanner();
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
