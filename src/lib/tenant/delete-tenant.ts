import 'server-only';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  opsAlerts, paymentPendingObservations, tenantAuditEvents, tenantNotices, tenants,
} from '@/db/control-plane/schema';
import { withLockedPool, withTenantLock } from '@/db/control-plane/locked';
import { decrypt } from '@/lib/encryption';
import { reconcileInLock } from '@/lib/billing/reconcile';
import {
  cancelSubscriptionIdempotent, closeOpenInvoice, readCustomerSubscriptions, readOpenInvoices, retrieveSubscription,
  type OpenInvoiceState,
} from '@/lib/billing/stripe-state';
import type { StripeSubSnapshot } from '@/lib/billing/subscription-transitions';
import { addDays, cycleAnchor, isDunning, isGood, noticeGivenAt, type NoticeState } from './lifecycle';
import { BACKUP_RETENTION_DAYS, DELETION_NOTICE_DAYS } from './lifecycle-config';
import { hasPaymentProcessing, voidSubscriptionInvoices } from './lifecycle-runner';
import { raiseAlert, readTenant, recordAudit, updateTenantGuarded, type TenantRow } from './lifecycle-store';
import { databaseExists, deleteNeonProjectVerified, directNeonHost, dropDatabaseVerified, neonProjectExists } from './neon';
import { invalidateTenant } from './registry';
import type { FounderExportDetail } from './ops-digest';

/**
 * Permanent workspace deletion (feature-plan-terms-compliance-fixes.md §5.3). Steps are ordered, idempotent, and
 * resumable while `status='deleting'`. Every abort in steps 3–5 while deleting RESTORES the tenant (committed),
 * so a tenant is never left stuck in `deleting` by a payment that arrived mid-run.
 *
 * Irreversible once step 5 runs. Only ever run against a throwaway local tenant in development.
 */

export interface DeleteTenantOptions {
  slug: string;
  /** false = dry run: preconditions, database classification and a read-only Stripe summary; no changes. */
  apply: boolean;
  forceWithReason?: string;
  includeExempt?: boolean;
  dropSharedDatabase?: boolean;
  actor: string;
  log?: (line: string) => void;
}

export type DatabaseClass =
  | { kind: 'local'; dbName: string; adminUrl: string }
  | { kind: 'shared-project'; dbName: string; adminUrl: string }
  | { kind: 'neon-project'; projectId: string; tenantHost: string; controlPlaneHost: string };

export interface DeletionReceipt {
  slug: string;
  name: string;
  status: string;
  deletionScheduledFor: Date | null;
  deletedAt: Date | null;
  database: string;
  forcedReason: string | null;
  founderExportDestroyBy: Date | null;
  notices: Array<{ kind: string; anchor: Date; sentAt: Date | null; forcedAt: Date | null; supersededAt: Date | null }>;
}

export type DeleteTenantResult =
  | { outcome: 'deleted' | 'already-deleted'; receipt: DeletionReceipt }
  | { outcome: 'dry-run'; database: DatabaseClass; problems: string[] }
  | { outcome: 'refused' | 'aborted' | 'stopped'; reason: string };

class Refusal extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostKey = (u: URL) => `${LOOPBACK.has(u.hostname) ? 'loopback' : u.hostname}:${u.port || '5432'}`;
const dbNameOf = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ''));

/** §5.3 step 2, in order: local → shared-project → dedicated Neon project; anything else fails before any change. */
export function classifyDatabase(tenantDbUrl: string, row: Pick<TenantRow, 'neonProjectId'>, opts: { dropSharedDatabase?: boolean }): DatabaseClass {
  const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlUrl) throw new Refusal('CONTROL_PLANE_DATABASE_URL is not set.');
  const t = new URL(tenantDbUrl);
  const c = new URL(controlUrl);
  const dbName = dbNameOf(t);
  const protectedNames = new Set([dbNameOf(c), 'postgres', 'template0', 'template1']);

  if (LOOPBACK.has(t.hostname)) {
    const adminUrl = process.env.DEV_TENANT_ADMIN_DATABASE_URL ?? controlUrl;
    const a = new URL(adminUrl);
    protectedNames.add(dbNameOf(a));
    if (hostKey(a) !== hostKey(t)) throw new Refusal(`Tenant database server ${hostKey(t)} differs from the admin connection's ${hostKey(a)}.`);
    if (protectedNames.has(dbName)) throw new Refusal(`Refusing: "${dbName}" is a protected database.`);
    return { kind: 'local', dbName, adminUrl };
  }

  if (directNeonHost(t.hostname) === directNeonHost(c.hostname)) {
    if (!opts.dropSharedDatabase) {
      throw new Refusal('This tenant database lives inside the CONTROL PLANE\'s Neon project. Pass --drop-shared-database to drop only that database (Neon keeps history for the PITR window).');
    }
    if (protectedNames.has(dbName)) throw new Refusal(`Refusing: "${dbName}" is a protected database.`);
    // Connect with the tenant's credentials to the control-plane database on the DIRECT host, then drop the tenant DB.
    const admin = new URL(tenantDbUrl);
    admin.hostname = directNeonHost(t.hostname);
    admin.pathname = `/${dbNameOf(c)}`;
    return { kind: 'shared-project', dbName, adminUrl: admin.toString() };
  }

  if (row.neonProjectId) {
    return { kind: 'neon-project', projectId: row.neonProjectId, tenantHost: t.hostname, controlPlaneHost: c.hostname };
  }
  throw new Refusal('Cannot classify the tenant database (not local, not in the control plane\'s project, no neon_project_id). Nothing was changed.');
}

function describe(db: DatabaseClass): string {
  if (db.kind === 'neon-project') return `Neon project ${db.projectId} (endpoint ${directNeonHost(db.tenantHost)})`;
  return `${db.kind === 'local' ? 'local' : 'shared-project'} database "${db.dbName}"`;
}

type ControlReader = Pick<Parameters<Parameters<typeof withTenantLock>[1]>[0], 'select'>;

async function readNoticeStates(db: ControlReader, tenantId: string): Promise<NoticeState[]> {
  return (await db.select().from(tenantNotices).where(eq(tenantNotices.tenantId, tenantId)))
    .map((n) => ({ kind: n.kind, anchor: n.scheduledFor, sentAt: n.sentAt, forcedAt: n.forcedAt, supersededAt: n.supersededAt, createdAt: n.createdAt }));
}

const noticeStates = (tenantId: string) => withLockedPool((db) => readNoticeStates(db, tenantId));

/** Step 1 preconditions (re-evaluated on reconciled facts in step 3). Returns the problems; empty = eligible. */
function preconditionProblems(row: TenantRow, notices: NoticeState[], now: Date, opts: DeleteTenantOptions): string[] {
  const problems: string[] = [];
  if (row.lifecycleExempt && !opts.includeExempt) problems.push('the workspace is lifecycle-exempt (demo/internal); pass --include-exempt to override');
  if (opts.forceWithReason) return problems;
  const D = row.deletionScheduledFor;
  if (!D) problems.push('no deletion date is set');
  else if (now.getTime() < D.getTime()) problems.push(`the deletion date ${D.toISOString()} has not passed`);
  const A = cycleAnchor(row);
  const givenAt = noticeGivenAt(notices, 'deletion-notice', A);
  if (!givenAt) problems.push(`no deletion-notice was given for the current anchor ${A?.toISOString() ?? '(none)'}`);
  else if (D && givenAt.getTime() > addDays(D, -DELETION_NOTICE_DAYS).getTime()) {
    problems.push(`the deletion-notice (${givenAt.toISOString()}) was given less than ${DELETION_NOTICE_DAYS} days before the deletion date`);
  }
  return problems;
}

/**
 * The payment-activity abort rule. Steps 3–5: a GOOD/incomplete subscription or a payment processing. Steps 4–5 only
 * (`checkPendingVoid`, after step 4 retried the voids): an invoice void still pending. Null = no activity.
 */
async function paymentActivity(
  tenantId: string,
  subs: StripeSubSnapshot[],
  invoices: OpenInvoiceState[],
  now: Date,
  opts: { checkPendingVoid: boolean },
): Promise<string | null> {
  const obs = await withLockedPool(async (db) => {
    // Observations are written in the same pass (insert-if-absent; order-safe without the lock).
    for (const i of invoices) {
      if (i.processing) await db.insert(paymentPendingObservations).values({ tenantId, invoiceId: i.invoiceId, kind: 'processing', firstSeenAt: now }).onConflictDoNothing();
      if (i.microdeposit) await db.insert(paymentPendingObservations).values({ tenantId, invoiceId: i.invoiceId, kind: 'microdeposit', firstSeenAt: now }).onConflictDoNothing();
    }
    return db.select().from(paymentPendingObservations).where(eq(paymentPendingObservations.tenantId, tenantId));
  });
  const good = subs.find((s) => isGood(s.status) || s.status === 'incomplete');
  if (good) return `subscription ${good.id} is ${good.status}`;
  if (hasPaymentProcessing(invoices, obs, now)) return 'a payment is processing on an open invoice';
  if (!opts.checkPendingVoid) return null;
  const [pendingVoid] = await withLockedPool((db) => db.select({ id: opsAlerts.id }).from(opsAlerts)
    .where(and(eq(opsAlerts.scope, tenantId), eq(opsAlerts.kind, 'pending-invoice-void'), isNull(opsAlerts.resolvedAt))).limit(1));
  if (pendingVoid) return 'an invoice void is still pending (pending-invoice-void alert)';
  return null;
}

/**
 * Abort of a run that had set `deleting`: reconcile + transition table, put the status back, audit, alert — and
 * COMMIT. The audit and alert are always written: a GOOD transition may already have restored the status itself.
 */
async function restore(tenantId: string, reason: string, actor: string): Promise<void> {
  const now = new Date();
  await withTenantLock(tenantId, async (tx) => {
    let row = await readTenant(tx, tenantId);
    if (!row) return;
    if (row.status === 'deleted') return; // nothing to restore (a previous run finished)
    if (row.status === 'deleting') {
      try {
        row = (await reconcileInLock(tx, row, now, { allowDeleting: true })).row;
      } catch (err) {
        // Never stay stuck in 'deleting' because Stripe is down: the cron reconciles after a deletion-aborted event.
        console.error('[tenant:delete] restore reconcile failed (the next cron run reconciles):', err);
      }
    }
    if (row.status === 'deleting') {
      // Back to what it was: suspended if a suspension (policy or non-payment) is still recorded, else active.
      row = await updateTenantGuarded(tx, row, { status: row.suspensionReason ? 'suspended' : 'active' }, now, eq(tenants.status, 'deleting'));
    }
    await recordAudit(tx, { tenantId, kind: 'deletion-aborted', actor, detail: reason });
    await raiseAlert(tx, { tenantId, kind: 'deletion-aborted', detail: { reason } }, now);
  });
}

async function stripeState(row: TenantRow): Promise<{ subs: StripeSubSnapshot[]; invoices: OpenInvoiceState[] }> {
  if (!row.stripeCustomerId) return { subs: [], invoices: [] };
  const known = row.stripeCustomerDeletedAt !== null;
  const { subs, customerDeleted } = await readCustomerSubscriptions(row.stripeCustomerId, row.stripeSubscriptionId, known);
  const invoices = await readOpenInvoices(row.stripeCustomerId, known || customerDeleted);
  return { subs, invoices };
}

async function loadRow(slug: string): Promise<TenantRow | null> {
  const [row] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
  return row ?? null;
}

export async function deleteTenant(opts: DeleteTenantOptions): Promise<DeleteTenantResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  try {
    // ---- Step 1: preconditions -------------------------------------------------------------------------------
    const first = await loadRow(opts.slug);
    if (!first) throw new Refusal(`No tenant with slug "${opts.slug}".`);
    if (first.status === 'deleted') return { outcome: 'already-deleted', receipt: await receipt(first, null) };
    if (first.status === 'provisioning') throw new Refusal('The workspace is still provisioning.');
    const resuming = first.status === 'deleting';
    const problems = preconditionProblems(first, await noticeStates(first.id), new Date(), opts);

    // ---- Step 2: classify the database (fails before any change) ---------------------------------------------
    if (!first.dbUrlEncrypted) throw new Refusal('The tenant has no database URL on record.');
    const tenantDbUrl = decrypt(first.dbUrlEncrypted);
    const database = classifyDatabase(tenantDbUrl, first, opts);
    // Never drop a database another live workspace still points at.
    const others = await withLockedPool((db) => db.select({ slug: tenants.slug, url: tenants.dbUrlEncrypted }).from(tenants)
      .where(and(ne(tenants.id, first.id), ne(tenants.status, 'deleted'))));
    const sharing = others.filter((o) => {
      if (!o.url) return false;
      try {
        return decrypt(o.url) === tenantDbUrl;
      } catch {
        throw new Refusal(`Cannot decrypt workspace ${o.slug}'s database URL, so sharing can't be ruled out; refusing.`);
      }
    }).map((o) => o.slug);
    if (sharing.length > 0) throw new Refusal(`Another workspace uses the same database (${sharing.join(', ')}); refusing.`);
    log(`Tenant ${first.slug} (${first.name}), status=${first.status}${resuming ? ' — RESUMING an interrupted deletion' : ''}`);
    log(`Database: ${describe(database)}`);
    if (opts.forceWithReason) log(`FORCED (bypasses the deletion-date and notice checks): ${opts.forceWithReason}`);

    // A first run must find the database it is about to delete: a 404 / missing database here means a wrong
    // neon_project_id, API key or URL — never "already deleted" (that is accepted only when resuming).
    if (!resuming) {
      const exists = database.kind === 'neon-project'
        ? await neonProjectExists(database.projectId)
        : await databaseExists(database.adminUrl, database.dbName);
      if (!exists) {
        throw new Refusal(`The tenant database was not found (${describe(database)}). Check neon_project_id / NEON_API_KEY / the tenant URL; nothing was changed.`);
      }
    }

    if (!opts.apply) {
      try {
        const s = await stripeState(first);
        log(`Stripe: ${s.subs.map((x) => `${x.id}=${x.status}`).join(', ') || 'no subscriptions'}; ${s.invoices.length} open invoice(s)`);
      } catch (err) {
        problems.push(`Stripe could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { outcome: 'dry-run', database, problems };
    }
    if (problems.length > 0 && !resuming) throw new Refusal(`Not eligible: ${problems.join('; ')}.`);

    // ---- Step 3: locked reconcile + transition table; re-check; set deleting --------------------------------
    const now3 = new Date();
    const step3 = await withTenantLock(first.id, async (tx) => {
      let row = await readTenant(tx, first.id);
      if (!row) throw new Refusal('Tenant disappeared.');
      if (!['active', 'suspended', 'deleting'].includes(row.status)) throw new Refusal(`Tenant is ${row.status}.`);
      const wasDeleting = row.status === 'deleting';
      const r = await reconcileInLock(tx, row, now3, { allowDeleting: true });
      row = r.row;
      const invoices = row.stripeCustomerId
        ? await readOpenInvoices(row.stripeCustomerId, row.stripeCustomerDeletedAt !== null || r.customerDeleted)
        : [];
      return { row, wasDeleting, subs: r.subs, invoices, notices: await readNoticeStates(tx, row.id) };
    });
    const abort3 = await paymentActivity(first.id, step3.subs, step3.invoices, now3, { checkPendingVoid: false })
      ?? (preconditionProblems(step3.row, step3.notices, now3, opts).join('; ') || null);
    if (abort3) {
      if (step3.wasDeleting) await restore(first.id, `step 3: ${abort3}`, opts.actor);
      return { outcome: 'aborted', reason: abort3 };
    }
    await withTenantLock(first.id, async (tx) => {
      const row = await readTenant(tx, first.id);
      if (!row) throw new Refusal('Tenant disappeared.');
      if (row.lifecycleVersion !== step3.row.lifecycleVersion) throw new Refusal('The workspace changed during step 3; re-run.');
      if (row.status !== 'deleting') {
        await updateTenantGuarded(tx, row, { status: 'deleting' }, new Date());
        await recordAudit(tx, { tenantId: row.id, kind: 'deletion-started', actor: opts.actor, detail: describe(database) });
        if (opts.forceWithReason) await recordAudit(tx, { tenantId: row.id, kind: 'forced-deletion', actor: opts.actor, detail: opts.forceWithReason });
      }
    });
    invalidateTenant(first.slug);
    log('✓ Step 3: status = deleting (all access blocked).');

    // ---- Step 4: Stripe — abort on payment activity; cancel DUNNING/paused; close open invoices ---------------
    const row4 = (await loadRow(opts.slug))!;
    try {
      await retryVoids(first.id);
      const s4 = await stripeState(row4);
      const abort4 = await paymentActivity(first.id, s4.subs, s4.invoices, new Date(), { checkPendingVoid: true });
      if (abort4) {
        await restore(first.id, `step 4: ${abort4}`, opts.actor);
        return { outcome: 'aborted', reason: abort4 };
      }
      for (const sub of s4.subs.filter((x) => isDunning(x.status) || x.status === 'paused')) {
        // Re-read right before the irreversible cancel: a customer may have paid since the listing.
        const fresh = await retrieveSubscription(sub.id);
        if (fresh && (isGood(fresh.status) || fresh.status === 'incomplete')) {
          await restore(first.id, `step 4: subscription ${sub.id} is ${fresh.status}`, opts.actor);
          return { outcome: 'aborted', reason: `subscription ${sub.id} is ${fresh.status}` };
        }
        await withLockedPool((db) => raiseAlert(db, { tenantId: first.id, kind: 'pending-invoice-void', dedupKey: sub.id, detail: { subscription: sub.id } }, new Date()));
        await cancelSubscriptionIdempotent(sub.id);
        log(`✓ Step 4: cancelled ${sub.id}.`);
        await voidSubscriptionInvoices(first.id, sub.id, new Date());
      }
      for (const inv of s4.invoices) await closeOpenInvoice(inv.invoiceId);
      log(`✓ Step 4: ${s4.invoices.length} open invoice(s) closed.`);
    } catch (err) {
      return { outcome: 'stopped', reason: `step 4 Stripe failure (status stays deleting; re-run resumes): ${err instanceof Error ? err.message : String(err)}` };
    }

    // ---- Step 5: preflight (same abort rule), then delete the database and confirm --------------------------
    try {
      const s5 = await stripeState(row4);
      const abort5 = await paymentActivity(first.id, s5.subs, s5.invoices, new Date(), { checkPendingVoid: true });
      if (abort5) {
        await restore(first.id, `step 5 preflight: ${abort5}`, opts.actor);
        return { outcome: 'aborted', reason: abort5 };
      }
      const outcome = database.kind === 'neon-project'
        ? await deleteNeonProjectVerified(database)
        : await dropDatabaseVerified(database.adminUrl, database.dbName);
      log(outcome.alreadyDeleted ? '✓ Step 5: database already gone (previous run).' : `✓ Step 5: ${describe(database)} deleted and confirmed.`);
    } catch (err) {
      return { outcome: 'stopped', reason: `step 5 failed (status stays deleting; re-run resumes): ${err instanceof Error ? err.message : String(err)}` };
    }

    // ---- Step 6: tombstone (only after step 5 is confirmed) ---------------------------------------------------
    const done = await withTenantLock(first.id, async (tx) => {
      const row = await readTenant(tx, first.id);
      if (!row) throw new Refusal('Tenant disappeared.');
      const t = new Date();
      const updated = await updateTenantGuarded(tx, row, { status: 'deleted', deletedAt: t, dbUrlEncrypted: null }, t, eq(tenants.status, 'deleting'));
      await tx.delete(paymentPendingObservations).where(eq(paymentPendingObservations.tenantId, row.id));
      // Nothing left to act on: close the workspace's open alerts so the digest doesn't carry them forever.
      await tx.update(opsAlerts).set({ resolvedAt: t, resolutionNote: 'workspace deleted' })
        .where(and(eq(opsAlerts.scope, row.id), isNull(opsAlerts.resolvedAt)));
      await recordAudit(tx, { tenantId: row.id, kind: 'deleted', actor: opts.actor, detail: describe(database) });
      return updated;
    });
    invalidateTenant(first.slug);
    return { outcome: 'deleted', receipt: await receipt(done, opts.forceWithReason ?? null) };
  } catch (err) {
    if (err instanceof Refusal) return { outcome: 'refused', reason: err.message };
    throw err;
  }
}

async function retryVoids(tenantId: string): Promise<void> {
  const pending = await withLockedPool((db) => db.select({ dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
    .where(and(eq(opsAlerts.scope, tenantId), eq(opsAlerts.kind, 'pending-invoice-void'), isNull(opsAlerts.resolvedAt))));
  for (const p of pending) await voidSubscriptionInvoices(tenantId, p.dedupKey, new Date());
}

async function receipt(row: TenantRow, forcedReason: string | null): Promise<DeletionReceipt> {
  const notices = (await noticeStates(row.id)).map(({ kind, anchor, sentAt, forcedAt, supersededAt }) => ({ kind, anchor, sentAt, forcedAt, supersededAt }));
  // F2: a founder export taken earlier must be destroyed by min(its own destroy-by, deletion + 30 days).
  const events = await withLockedPool((db) => db.select().from(tenantAuditEvents)
    .where(and(eq(tenantAuditEvents.tenantId, row.id), inArray(tenantAuditEvents.kind, ['founder-export-taken', 'founder-export-destroyed', 'founder-export-legal-hold'])))
    .orderBy(desc(tenantAuditEvents.createdAt)));
  let founderExportDestroyBy: Date | null = null;
  const latest = events[0];
  if (latest?.kind === 'founder-export-taken') {
    let destroyBy = addDays(latest.createdAt, BACKUP_RETENTION_DAYS);
    try { destroyBy = new Date((JSON.parse(latest.detail ?? '{}') as FounderExportDetail).destroyBy); } catch { /* keep default */ }
    if (row.deletedAt) {
      const byDeletion = addDays(row.deletedAt, BACKUP_RETENTION_DAYS);
      if (byDeletion.getTime() < destroyBy.getTime()) destroyBy = byDeletion;
    }
    founderExportDestroyBy = destroyBy;
  }
  return {
    slug: row.slug, name: row.name, status: row.status, deletionScheduledFor: row.deletionScheduledFor, deletedAt: row.deletedAt,
    database: row.neonProjectId ? `Neon project ${row.neonProjectId}` : 'database dropped', forcedReason, founderExportDestroyBy, notices,
  };
}
