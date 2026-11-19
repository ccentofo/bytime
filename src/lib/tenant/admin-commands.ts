import 'server-only';
import { and, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { exportDeliveries, opsAlerts, signups, tenantNotices, tenants } from '@/db/control-plane/schema';
import { withLockedPool, withTenantLock, type ControlTx } from '@/db/control-plane/locked';
import { addDays, cycleAnchor, deletionDateFrom, getTenantAccess, hasSubscribed, type LifecycleFacts } from './lifecycle';
import { DELETION_NOTICE_DAYS, POST_END_RETENTION_DAYS } from './lifecycle-config';
import { invalidateTenant, toLifecycleFacts } from './registry';
import { readTenant, recordAudit, resolveAlertsOfKind, updateTenantGuarded, type TenantRow } from './lifecycle-store';
import { enqueueNotice, LEASE_MINUTES, redactExportPayload } from './notices';

/**
 * Founder commands behind `tenant:admin` (feature-plan-terms-compliance-fixes.md §5.6, F1, F2, F4). Each change is
 * planned from the row re-read under the tenant lock, applied with the lifecycle_version guard, and audited.
 */

export class AdminCommandError extends Error {}

type TenantPatch = Parameters<typeof updateTenantGuarded>[2];

export interface AdminPlan {
  describe: string;
  patch: TenantPatch;
  auditKind: string;
  auditDetail: string;
  /** Extra statements in the same locked transaction. */
  after?: (tx: ControlTx, now: Date) => Promise<void>;
}

export type Planner = (row: TenantRow, f: LifecycleFacts, now: Date) => AdminPlan;

const iso = (d: Date | null) => d?.toISOString() ?? '(none)';

function requireLifecycleStatus(row: TenantRow) {
  if (row.status !== 'active' && row.status !== 'suspended') throw new AdminCommandError(`Tenant is ${row.status}; refusing.`);
}

export const plans = {
  /** Refused once subscribed or while suspended; T = max(now, T) + N; a never-subscribed tenant's D is cleared. */
  extendTrial: (days: number): Planner => (row, f, now) => {
    if (!Number.isInteger(days) || days <= 0) throw new AdminCommandError('extend-trial requires a positive whole number of days.');
    requireLifecycleStatus(row);
    if (hasSubscribed(f)) throw new AdminCommandError('This workspace has subscribed; trial dates no longer apply.');
    if (row.status === 'suspended') throw new AdminCommandError('This workspace is suspended; refusing.');
    const base = row.trialEndsAt && row.trialEndsAt.getTime() > now.getTime() ? row.trialEndsAt : now;
    const trialEndsAt = addDays(base, days);
    return {
      describe: `extend the trial by ${days} day(s) to ${trialEndsAt.toISOString()}`,
      patch: { trialEndsAt, deletionScheduledFor: null },
      auditKind: 'trial-extended',
      auditDetail: `from=${iso(row.trialEndsAt)} to=${trialEndsAt.toISOString()}`,
    };
  },

  endTrial: (): Planner => (row, f, now) => {
    requireLifecycleStatus(row);
    if (hasSubscribed(f)) throw new AdminCommandError('This workspace has subscribed; trial dates no longer apply.');
    return {
      describe: 'end the trial now (read-only from now; the next cron run sends trial-ended)',
      patch: { trialEndsAt: now },
      auditKind: 'trial-ended-by-founder',
      auditDetail: `from=${iso(row.trialEndsAt)}`,
    };
  },

  /** Policy suspension (Terms §17.3). Replacing a non-payment suspension stops the D9 termination path. */
  suspend: (reason: string): Planner => (row, _f, now) => {
    if (!reason.trim()) throw new AdminCommandError('suspend requires --reason.');
    requireLifecycleStatus(row);
    if (row.suspensionReason === 'policy') throw new AdminCommandError('Already suspended for policy.');
    return {
      describe: `suspend for a POLICY breach: ${reason} (export blocked; admins are emailed)`,
      // F5: export is blocked by default for a policy hold.
      patch: { status: 'suspended', suspendedAt: now, suspensionReason: 'policy', policyExportAllowed: false },
      auditKind: 'policy-suspended',
      auditDetail: `${reason}${row.suspensionReason === 'nonpayment' ? ' (replaces a non-payment suspension)' : ''}`,
      // Terms §17.3 "notify you promptly": the admins' email, enqueued in the same transaction (anchor = suspended_at).
      after: async (tx, t) => { await enqueueNotice(tx, row.id, 'policy-suspended', t); },
    };
  },

  /** F5: allow or block export for ONE policy-suspended workspace, with a written reason (audited: who, when, why). */
  setPolicyExport: (allow: boolean, reason: string): Planner => (row) => {
    if (!reason.trim()) throw new AdminCommandError('set-policy-export requires --reason.');
    if (row.status !== 'suspended' || row.suspensionReason !== 'policy') {
      throw new AdminCommandError('Only a workspace suspended for a policy breach has export controls (non-payment suspensions can always export).');
    }
    return {
      describe: `${allow ? 'ALLOW' : 'BLOCK'} export for this policy-suspended workspace: ${reason}`,
      patch: { policyExportAllowed: allow },
      auditKind: allow ? 'policy-export-allowed' : 'policy-export-blocked',
      auditDetail: reason,
    };
  },

  unsuspend: (): Planner => (row) => {
    if (row.status !== 'suspended' || row.suspensionReason !== 'policy') {
      throw new AdminCommandError('Only a policy suspension can be lifted here (a non-payment suspension lifts when the customer pays).');
    }
    return {
      describe: 'lift the POLICY suspension',
      patch: { status: 'active', suspendedAt: null, suspensionReason: null, policyExportAllowed: false },
      auditKind: 'policy-unsuspended',
      auditDetail: '',
    };
  },

  /**
   * F1. on: clears D (closed precedes exempt) and supersedes every pending notice. off: re-applies the deletion
   * clock to an ended or trial-lapsed workspace (deletion-date rule: never in the past, room for notice).
   */
  setExempt: (on: boolean, reason: string): Planner => (row, f, now) => {
    if (!reason.trim()) throw new AdminCommandError('set-exempt requires --reason.');
    requireLifecycleStatus(row);
    if (on) {
      return {
        describe: 'set lifecycle_exempt ON (no expiry, no lifecycle emails, never scheduled for deletion)',
        patch: { lifecycleExempt: true, deletionScheduledFor: null },
        auditKind: 'exempt-on',
        auditDetail: reason,
        after: async (tx, t) => {
          // feature-plan-cloud-export.md §6.5: an export email is not a lifecycle email; set-exempt never supersedes it.
          await tx.update(tenantNotices).set({ supersededAt: t }).where(and(
            eq(tenantNotices.tenantId, row.id), isNull(tenantNotices.sentAt), isNull(tenantNotices.forcedAt), isNull(tenantNotices.supersededAt),
            ne(tenantNotices.kind, 'export-ready'),
          ));
        },
      };
    }
    const lapsed = !hasSubscribed(f) && f.trialEndsAt !== null && now.getTime() >= f.trialEndsAt.getTime();
    const A = cycleAnchor(f);
    const D = (f.subscriptionEndedAt !== null || lapsed) && A !== null
      ? deletionDateFrom(addDays(A, POST_END_RETENTION_DAYS), now)
      : null;
    return {
      describe: `set lifecycle_exempt OFF${D ? ` (deletion date ${D.toISOString()})` : ''}`,
      patch: { lifecycleExempt: false, ...(D ? { deletionScheduledFor: D } : {}) },
      auditKind: 'exempt-off',
      auditDetail: `${reason}${D ? ` (deletion date ${D.toISOString()}, at least ${DELETION_NOTICE_DAYS} days out)` : ''}`,
    };
  },

  /**
   * feature-plan-certified-outputs.md C1 (CO-D1 escape hatch): reopen timesheet-history import for ONE workspace for
   * 1–30 days, with a logged reason (a support action). The lock and overlap guards still apply while reopened.
   */
  reopenImportWindow: (days: number, reason: string): Planner => (row, _f, now) => {
    if (!reason.trim()) throw new AdminCommandError('reopen-import-window requires --reason.');
    if (!Number.isInteger(days) || days < 1 || days > MAX_IMPORT_WINDOW_REOPEN_DAYS) {
      throw new AdminCommandError(`reopen-import-window requires --days between 1 and ${MAX_IMPORT_WINDOW_REOPEN_DAYS}.`);
    }
    requireLifecycleStatus(row);
    const until = addDays(now, days);
    return {
      describe: `reopen timesheet-history import until ${until.toISOString()} (${days} day(s)): ${reason}`,
      patch: { importWindowUntil: until },
      auditKind: 'import-window-reopened',
      auditDetail: `until=${until.toISOString()} previous=${iso(row.importWindowUntil)} reason=${reason}`,
    };
  },
};

export const MAX_IMPORT_WINDOW_REOPEN_DAYS = 30;

/**
 * feature-plan-per-user-billing.md §6.2 (Q3): `set-plan <slug> enterprise|standard`. Enterprise lifts the user limit,
 * and the app never overwrites it (reconcile skips `plan` while it's enterprise); `standard` only undoes it (the
 * interval comes from the next reconcile).
 */
export function setPlanPlanner(target: string): Planner {
  if (target !== 'enterprise' && target !== 'standard') throw new AdminCommandError('set-plan needs enterprise|standard.');
  return (row) => {
    if (target === 'enterprise') {
      requireLifecycleStatus(row);
      return {
        describe: 'set the plan to ENTERPRISE (no user limit; the seat sync never touches a custom price)',
        patch: { plan: 'enterprise', planInterval: null },
        auditKind: 'plan-set',
        auditDetail: `${row.plan}→enterprise`,
        after: async (tx, t) => { await resolveAlertsOfKind(tx, row.id, 'seat-sync-unmanaged-price', t, 'plan set to enterprise'); },
      };
    }
    if (row.plan !== 'enterprise') throw new AdminCommandError('set-plan standard only undoes an enterprise plan; this workspace is not enterprise.');
    return {
      describe: 'set the plan back to STANDARD (the interval comes from the next Stripe reconcile)',
      patch: { plan: 'standard' },
      auditKind: 'plan-set',
      auditDetail: 'enterprise→standard',
    };
  };
}

export type StripeMode = 'live' | 'test';

/** The Stripe mode of a secret or restricted key, from its prefix; null when it isn't recognizable. */
export function stripeKeyMode(key: string | undefined): StripeMode | null {
  if (!key) return null;
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  return null;
}

/**
 * The Stripe-mode guard (§6.2) for commands that call Stripe: refused unless `--stripe-mode live|test` is given and
 * matches the key in STRIPE_SECRET_KEY, so a test key can never be used on a production workspace (or vice versa).
 */
export function checkStripeMode(requested: string | undefined, key: string | undefined): StripeMode {
  const actual = stripeKeyMode(key);
  if (actual === null) throw new AdminCommandError('STRIPE_SECRET_KEY is missing or not a recognizable Stripe key (sk_live_, sk_test_, rk_live_, rk_test_).');
  if (requested !== 'live' && requested !== 'test') {
    throw new AdminCommandError(`This command calls Stripe. Pass --stripe-mode live|test (the key in STRIPE_SECRET_KEY is ${actual} mode).`);
  }
  if (requested !== actual) throw new AdminCommandError(`--stripe-mode ${requested} doesn't match the key in STRIPE_SECRET_KEY (${actual} mode); refusing.`);
  return actual;
}

/** `ensure-customer` (§6.2, §6.7): link (or reuse) the workspace's Stripe customer; audited with livemode. */
export async function ensureCustomerCommand(tenantId: string, mode: StripeMode, actor: string): Promise<string> {
  const [row] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  if (!row) throw new AdminCommandError('Tenant disappeared.');
  if (getTenantAccess(toLifecycleFacts(row), new Date()) === 'closed') throw new AdminCommandError(`Tenant is closed (${row.status}); refusing.`);
  const { ensureStripeCustomer } = await import('@/lib/billing/tenant-billing');
  const customerId = await ensureStripeCustomer(tenantId);
  await withLockedPool((db) => recordAudit(db, { tenantId, kind: 'stripe-customer-ensured', actor, detail: `customer=${customerId} livemode=${mode === 'live'}` }));
  return customerId;
}

/** `seat-sync` (§6.2): one manual sync (or a dry run that writes nothing); the applied run is audited with livemode. */
export async function seatSyncCommand(tenantId: string, opts: { mode: StripeMode; dryRun: boolean; actor: string }) {
  const { randomUUID } = await import('node:crypto');
  const { syncSeatQuantity } = await import('@/lib/billing/seat-sync');
  const result = await syncSeatQuantity(tenantId, { runId: randomUUID(), reason: 'manual', dryRun: opts.dryRun });
  if (!opts.dryRun) {
    await withLockedPool((db) => recordAudit(db, {
      tenantId, kind: 'seat-sync-manual', actor: opts.actor,
      detail: `outcome=${result.outcome}${result.from !== undefined ? ` from=${result.from}` : ''}${result.to !== undefined ? ` to=${result.to}` : ''} livemode=${opts.mode === 'live'}`,
    }));
  }
  return result;
}

/** Apply a plan under the tenant lock, re-planned from the re-read row (so a concurrent change is never lost). */
export async function applyAdminPlan(tenantId: string, planner: Planner, actor: string): Promise<TenantRow> {
  const updated = await withTenantLock(tenantId, async (tx) => {
    const row = await readTenant(tx, tenantId);
    if (!row) throw new AdminCommandError('Tenant disappeared.');
    const now = new Date();
    const p = planner(row, toLifecycleFacts(row), now);
    const after = await updateTenantGuarded(tx, row, p.patch, now);
    await recordAudit(tx, { tenantId: row.id, kind: p.auditKind, actor, detail: p.auditDetail });
    if (p.after) await p.after(tx, now);
    return after;
  });
  invalidateTenant(updated.slug);
  return updated;
}

/** The one pending notice `force-notice-sent` may mark. Refuses missing, superseded, ambiguous, sent or forced. */
export async function findForceableNotice(tenantId: string, kind: string, anchor?: Date) {
  if (kind === 'export-ready') throw new AdminCommandError('An export-ready notice can\'t be forced; use export-revoke.');
  const candidates = await withLockedPool((db) => db.select().from(tenantNotices)
    .where(and(eq(tenantNotices.tenantId, tenantId), eq(tenantNotices.kind, kind))).orderBy(desc(tenantNotices.createdAt)));
  const live = candidates.filter((n) => n.supersededAt === null && (!anchor || n.scheduledFor.getTime() === anchor.getTime()));
  if (live.length === 0) throw new AdminCommandError(`No non-superseded "${kind}" notice${anchor ? ` with anchor ${anchor.toISOString()}` : ''} exists; refusing.`);
  if (live.length > 1) throw new AdminCommandError(`Several "${kind}" notices exist; pass --anchor <iso> (anchors: ${live.map((n) => n.scheduledFor.toISOString()).join(', ')}).`);
  const notice = live[0];
  if (notice.sentAt) throw new AdminCommandError('That notice was actually delivered; nothing to force.');
  if (notice.forcedAt) throw new AdminCommandError('That notice is already forced.');
  return notice;
}

/** forced_at (never sent_at) + reason + audit id; unblocks transitions waiting on the notice. */
export async function forceNoticeSent(tenantId: string, noticeId: string, reason: string, actor: string): Promise<void> {
  if (!reason.trim()) throw new AdminCommandError('force-notice-sent requires --reason.');
  await withTenantLock(tenantId, async (tx) => {
    const row = await readTenant(tx, tenantId);
    if (!row) throw new AdminCommandError('Tenant disappeared.');
    const [current] = await tx.select().from(tenantNotices).where(eq(tenantNotices.id, noticeId));
    if (current?.kind === 'export-ready') throw new AdminCommandError('An export-ready notice can\'t be forced; use export-revoke.');
    if (!current || current.tenantId !== tenantId || current.supersededAt || current.sentAt || current.forcedAt) {
      throw new AdminCommandError('The notice changed meanwhile; re-run.');
    }
    const now = new Date();
    const auditId = await recordAudit(tx, { tenantId, kind: 'force-notice-sent', actor, detail: `${current.kind} anchor=${current.scheduledFor.toISOString()}: ${reason}` });
    await tx.update(tenantNotices).set({ forcedAt: now, forcedReason: reason, forcedAuditId: auditId }).where(eq(tenantNotices.id, noticeId));
    await updateTenantGuarded(tx, row, {}, now); // version bump: any concurrent evaluation re-reads
  });
}

export interface ExportRevokePlan {
  deliveryId: string;
  tenantId: string;
  slug: string;
  expiresAt: Date;
  /** The notice is claimed by a send in flight (its lease is live): the email may already be going out. */
  sendInFlight: boolean;
  noticePending: boolean;
}

type PlanReader = Pick<ControlTx, 'select'>;

/** The plan, read through `db` (the pool for the dry run, the locked transaction for the revoke itself). */
async function readRevokePlan(db: PlanReader, deliveryId: string, now: Date): Promise<ExportRevokePlan> {
  const [d] = await db.select({ d: exportDeliveries, slug: tenants.slug, n: tenantNotices }).from(exportDeliveries)
    .innerJoin(tenants, eq(tenants.id, exportDeliveries.tenantId))
    .innerJoin(tenantNotices, eq(tenantNotices.id, exportDeliveries.noticeId))
    .where(eq(exportDeliveries.id, deliveryId)).limit(1);
  if (!d) throw new AdminCommandError('No export delivery has that id.');
  if (d.d.erasedAt) throw new AdminCommandError('That delivery\'s copy is already erased; nothing to revoke.');
  if (d.d.revokedAt) throw new AdminCommandError('That delivery is already revoked.');
  const noticePending = d.n.sentAt === null && d.n.supersededAt === null && d.n.forcedAt === null;
  // notices.ts's claim lease (audit round 1, FR4: one constant).
  const leaseLive = d.n.lastAttemptAt !== null && now.getTime() - d.n.lastAttemptAt.getTime() < LEASE_MINUTES * 60_000;
  return { deliveryId, tenantId: d.d.tenantId, slug: d.slug, expiresAt: d.d.expiresAt, sendInFlight: noticePending && leaseLive, noticePending };
}

/** `export-revoke` (feature-plan-cloud-export.md §6.5): what it would revoke. Refuses an unknown, revoked or erased delivery. */
export async function planExportRevoke(deliveryId: string, now: Date = new Date()): Promise<ExportRevokePlan> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deliveryId)) throw new AdminCommandError('export-revoke takes a delivery id (uuid).');
  return withLockedPool((db) => readRevokePlan(db, deliveryId, now));
}

/**
 * Revoke a delivery, under the tenant lock: `revoked_at`, an `export-revoked` audit, and the pending notice superseded
 * (its token nulled and the link redacted from the frozen message), in one transaction. The link is dead at once; the
 * hourly sweep erases the copy. The plan returned (and audited) is re-read INSIDE the lock (audit round 1, FR3), so the
 * in-flight warning reflects a claim that landed after the dry run. `beforeLock` is a test seam.
 */
export async function exportRevoke(deliveryId: string, actor: string, now: Date = new Date(), hooks: { beforeLock?: () => Promise<void> } = {}): Promise<ExportRevokePlan> {
  const first = await planExportRevoke(deliveryId, now);
  await hooks.beforeLock?.();
  return withTenantLock(first.tenantId, async (tx) => {
    const plan = await readRevokePlan(tx, deliveryId, now);
    const updated = await tx.update(exportDeliveries).set({ revokedAt: now, tokenEncrypted: null })
      .where(and(eq(exportDeliveries.id, deliveryId), isNull(exportDeliveries.revokedAt), isNull(exportDeliveries.erasedAt)))
      .returning({ noticeId: exportDeliveries.noticeId });
    if (updated.length === 0) throw new AdminCommandError('The delivery changed meanwhile; re-run.');
    const [notice] = await tx.select().from(tenantNotices).where(eq(tenantNotices.id, updated[0].noticeId));
    if (notice && notice.sentAt === null && notice.supersededAt === null && notice.forcedAt === null) {
      await tx.update(tenantNotices).set({ supersededAt: now, payload: redactExportPayload(notice.payload as { html?: unknown } | null) })
        .where(eq(tenantNotices.id, notice.id));
    }
    await recordAudit(tx, { tenantId: plan.tenantId, kind: 'export-revoked', actor, detail: JSON.stringify({ deliveryId, noticeWasPending: plan.noticePending, sendInFlight: plan.sendInFlight }) });
    return plan;
  });
}

/**
 * A free-text founder note on the workspace's audit trail (feature-plan-launch-blockers.md P6 §2, LB-D6): e.g. the
 * written record of what an in-place restore erased and why, referencing the customer's consent. Append-only;
 * changes no lifecycle state.
 */
export async function recordFounderNote(tenantId: string, note: string, actor: string): Promise<string> {
  if (!note.trim()) throw new AdminCommandError('audit-note requires --note "<text>".');
  return withLockedPool((db) => recordAudit(db, { tenantId, kind: 'founder-note', actor, detail: note.trim() }));
}

/**
 * `provision:tenant` (launch-blockers audit §5): audit where a founder-provisioned workspace's Terms record came from —
 * the customer's signed agreement (version + acceptance time, also written to the tenant row by provisionTenant) — or
 * that it was provisioned without one (a founder note, as `tenant:admin audit-note` would write).
 */
export async function recordProvisionTerms(
  tenantId: string,
  terms: { version: string; acceptedAt: Date } | 'none',
  actor: string,
): Promise<string> {
  if (terms === 'none') return recordFounderNote(tenantId, 'provisioned without a Terms record', actor);
  return withLockedPool((db) => recordAudit(db, {
    tenantId,
    kind: 'terms-recorded',
    actor,
    detail: `Terms ${terms.version} accepted ${terms.acceptedAt.toISOString()} (from the customer's signed agreement; provision:tenant)`,
  }));
}

/** Manual resolution (bookkeeping only — never changes lifecycle state). */
export async function resolveAlertById(alertId: string, note: string, actor: string): Promise<void> {
  if (!note.trim()) throw new AdminCommandError('resolve-alert requires --note.');
  const [alert] = await withLockedPool((db) => db.select().from(opsAlerts).where(eq(opsAlerts.id, alertId)).limit(1));
  if (!alert) throw new AdminCommandError(`No alert ${alertId}.`);
  if (alert.resolvedAt) throw new AdminCommandError('Already resolved.');
  // feature-plan-disaster-restore.md §6.8: the disaster checks close only on the facts (a watch can't be ended by hand).
  if (alert.kind.startsWith('rebuild-') || alert.kind.startsWith('disaster-')) {
    throw new AdminCommandError(`${alert.kind} closes only when its condition clears (feature-plan-disaster-restore.md §6.8); it can't be resolved by hand.`);
  }
  await withLockedPool((db) => db.update(opsAlerts).set({ resolvedAt: new Date(), resolutionNote: `${note} (${actor})` }).where(eq(opsAlerts.id, alertId)));
}

// ---- feature-plan-control-plane-disaster.md §6.10, §6.10b ----------------------------------------------------------------

export interface StripeResyncResult {
  /** Workspaces whose window checkout would be (or was) re-linked. Slugs only: never an email address. */
  links: string[];
  /** Completed checkouts whose live customer belongs to another workspace (a re-signup can reuse a slug). */
  notThisWorkspace: string[];
  /** Paying workspaces to refresh from live Stripe. */
  refresh: string[];
  /** Fix round 1, FR3: workspaces whose current customer couldn't be read (they fail with --yes; exit 1). */
  readFailed: string[];
  /** `conflict`: the checkout couldn't be linked (alert raised), and the workspace was refreshed against its CURRENT customer (FR1). */
  outcomes?: { linked: string[]; refreshed: string[]; conflict: string[]; failed: Array<{ slug: string; error: string }> };
}

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : x?.id ?? null);
const LIVE_STATUSES = new Set(['active', 'suspended']);

/**
 * `tenant:admin stripe-resync --since <iso> --stripe-mode live|test [--yes]` (§6.10): NOT an event replay.
 *  1. Re-link window checkouts: every `complete` Checkout Session created since `since − 1 h` whose `metadata.slug` names
 *     a live workspace (active/suspended, approved detail D12) linked to another customer, and whose LIVE customer's
 *     `metadata.tenantId` is that workspace's id, goes through the webhook's own link rule (checkoutLinkPatch); the row's
 *     current customer, read live, counts as replaceable when Stripe says it's deleted.
 *  2. Refresh every paying workspace with reconcileInLock (as the daily cron does), under its tenant lock; a relinked one
 *     gets its customer passed, so its subscription is mirrored in the same run. The billing email comes from the live
 *     customer, and a null one never clears the stored one.
 * Side effects are reconcileInLock's (notices queued, delivered later by the notice cron; alerts) plus markSeatSyncDue
 * for every relink and every workspace that became good. It never delivers a notice, never reads a workspace database,
 * and re-running it converges on live Stripe.
 */
export async function stripeResyncCommand(o: { since: Date; dryRun: boolean; actor: string; now?: () => Date }): Promise<StripeResyncResult> {
  const { stripe } = await import('@/lib/billing/stripe');
  const now = o.now ?? (() => new Date());
  const rows = await withLockedPool((db) => db.select().from(tenants));
  const live = rows.filter((r) => LIVE_STATUSES.has(r.status));
  const bySlug = new Map(live.map((r) => [r.slug, r]));

  // 1. The window's completed checkouts (all pages).
  const sessions: Array<{ id: string; customer: unknown; metadata: Record<string, string> | null }> = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const list = await stripe.checkout.sessions.list({ status: 'complete', created: { gte: Math.floor((o.since.getTime() - 3600_000) / 1000) }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    sessions.push(...(list.data as unknown as typeof sessions));
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  const planned: Array<{ row: TenantRow; customerId: string; currentDeleted: boolean; email: string | null; currentEmail: string | null; readError: string | null }> = [];
  const notThisWorkspace: string[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    const slug = s.metadata?.slug;
    const customerId = idOf(s.customer as string | { id: string } | null);
    const row = slug ? bySlug.get(slug) : undefined;
    if (!row || !customerId || row.stripeCustomerId === customerId || seen.has(row.id)) continue;
    const customer = await stripe.customers.retrieve(customerId) as { deleted?: boolean; email?: string | null; metadata?: Record<string, string> };
    if (customer.deleted || customer.metadata?.tenantId !== row.id) { notThisWorkspace.push(row.slug); continue; }
    // The row's current customer, read live: deleted in Stripe → replaceable; its email refreshes a conflicting workspace
    // (FR1). A failed read is a failure (FR3), never a guess.
    let currentDeleted = false;
    let currentEmail: string | null = null;
    let readError: string | null = null;
    if (row.stripeCustomerId && row.stripeCustomerDeletedAt === null) {
      try {
        const cur = await stripe.customers.retrieve(row.stripeCustomerId) as { deleted?: boolean; email?: string | null };
        currentDeleted = Boolean(cur.deleted);
        currentEmail = cur.deleted ? null : cur.email ?? null;
      } catch (e) {
        readError = `the current customer couldn't be read (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`;
      }
    }
    seen.add(row.id);
    planned.push({ row, customerId, currentDeleted, email: customer.email ?? null, currentEmail, readError });
  }
  const linkIds = new Set(planned.map((p) => p.row.id));
  const toRefresh = live.filter((r) => r.stripeCustomerId && !linkIds.has(r.id));
  const result: StripeResyncResult = {
    links: planned.map((p) => p.row.slug).sort(), notThisWorkspace: [...new Set(notThisWorkspace)].sort(),
    refresh: [...planned.map((p) => p.row.slug), ...toRefresh.map((r) => r.slug)].sort(),
    readFailed: planned.filter((p) => p.readError).map((p) => p.row.slug).sort(),
  };
  if (o.dryRun) return result;

  const { reconcileInLock } = await import('@/lib/billing/reconcile');
  const { markSeatSyncDue } = await import('@/lib/billing/seat-sync');
  const { checkoutLinkPatch } = await import('@/lib/billing/checkout-link');
  const out: NonNullable<StripeResyncResult['outcomes']> = { linked: [], refreshed: [], conflict: [], failed: [] };
  for (const p of planned) {
    if (p.readError) { out.failed.push({ slug: p.row.slug, error: p.readError }); continue; }
    try {
      const r = await withTenantLock(p.row.id, async (tx) => {
        const fresh = await readTenant(tx, p.row.id);
        if (!fresh || !LIVE_STATUSES.has(fresh.status)) return { kind: 'skipped' as const, becameGood: false };
        let extraPatch: TenantPatch = {};
        if (fresh.stripeCustomerId !== p.customerId) {
          const link = await checkoutLinkPatch(tx, fresh, p.customerId, { actor: o.actor, now: now(), currentCustomerDeleted: p.currentDeleted });
          if (!link.ok) {
            // FR1: §6.10 step 2 refreshes EVERY paying workspace: one whose checkout conflicts is refreshed against its
            // current customer (no link patch), with that customer's live email when present.
            const patch: TenantPatch = p.currentEmail && p.currentEmail !== fresh.billingEmail ? { billingEmail: p.currentEmail } : {};
            const rc = fresh.stripeCustomerId ? await reconcileInLock(tx, fresh, now(), { extraPatch: patch }) : null;
            return { kind: 'conflict' as const, becameGood: rc?.becameGood ?? false };
          }
          extraPatch = { ...link.patch };
        }
        if (p.email) extraPatch.billingEmail = p.email;
        await reconcileInLock(tx, fresh, now(), { customerId: p.customerId, extraPatch });
        return { kind: 'linked' as const, becameGood: true };
      });
      if (r.kind === 'conflict') {
        out.conflict.push(p.row.slug);
        out.refreshed.push(p.row.slug);
        if (r.becameGood) await markSeatSyncDue(p.row.id);
      } else if (r.kind === 'linked') { out.linked.push(p.row.slug); await markSeatSyncDue(p.row.id); }
      invalidateTenant(p.row.slug);
    } catch (e) {
      out.failed.push({ slug: p.row.slug, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  for (const row of toRefresh) {
    try {
      const customer = await stripe.customers.retrieve(row.stripeCustomerId!).catch(() => null) as { deleted?: boolean; email?: string | null } | null;
      const email = customer && !customer.deleted ? customer.email ?? null : null;
      const becameGood = await withTenantLock(row.id, async (tx) => {
        const fresh = await readTenant(tx, row.id);
        if (!fresh || !LIVE_STATUSES.has(fresh.status) || !fresh.stripeCustomerId) return null;
        const extraPatch: TenantPatch = email && email !== fresh.billingEmail ? { billingEmail: email } : {};
        return (await reconcileInLock(tx, fresh, now(), { extraPatch })).becameGood;
      });
      if (becameGood !== null) out.refreshed.push(row.slug);
      if (becameGood) await markSeatSyncDue(row.id);
      invalidateTenant(row.slug);
    } catch (e) {
      out.failed.push({ slug: row.slug, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return { ...result, outcomes: out };
}

export interface WindowSignupRow { companyName: string; email: string; createdAt: Date; verifiedAt: Date | null; waitlistedAt: Date | null }

/**
 * `tenant:admin window-signup <slug>` (§6.10b, read-only): only while an open window-project alert names the slug; every
 * restored `signups` row for it created at or before the project, not consumed, and not expired then (or waitlisted),
 * newest first. The founder matches on the company name and never guesses (runbook B.9).
 */
export async function windowSignupCommand(slug: string): Promise<{ alertId: string; projectId: string; createdAt: string | null; rows: WindowSignupRow[] }> {
  const [alert] = await withLockedPool((db) => db.select({ id: opsAlerts.id, dedupKey: opsAlerts.dedupKey, detail: opsAlerts.detail }).from(opsAlerts)
    .where(and(eq(opsAlerts.kind, 'window-project'), isNull(opsAlerts.resolvedAt), sql`${opsAlerts.detail}->>'slug' = ${slug}`)).limit(1));
  if (!alert) throw new AdminCommandError(`"${slug}" is not a window signup (no open window-project alert names it).`);
  const createdAtRaw = (alert.detail as { createdAt?: string | null } | null)?.createdAt ?? null;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) throw new AdminCommandError(`The window-project alert for "${slug}" has no creation time; contact the lead.`);
  const rows = await withLockedPool((db) => db.select({
    companyName: signups.companyName, email: signups.email, createdAt: signups.createdAt, verifiedAt: signups.verifiedAt, waitlistedAt: signups.waitlistedAt,
  }).from(signups).where(and(eq(signups.slug, slug), lte(signups.createdAt, createdAt), isNull(signups.consumedAt),
    or(gte(signups.expiresAt, createdAt), isNotNull(signups.waitlistedAt)))).orderBy(desc(signups.createdAt)));
  return { alertId: alert.id, projectId: alert.dedupKey, createdAt: createdAtRaw, rows };
}
