import 'server-only';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import * as Sentry from '@sentry/nextjs';
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { opsAlerts, tenants, tenantSeatBilling } from '@/db/control-plane/schema';
import { SeatLockTimeoutError, withLockedPool, withSeatLock, type ControlTx } from '@/db/control-plane/locked';
import { getDbForUrl } from '@/db';
import { users } from '@/db/schema';
import { decrypt } from '@/lib/encryption';
import { getTenantAccess, isGood, isLive } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { raiseAlert, recordAudit, resolveAlert, resolveAlertsOfKind, type AlertInput, type TenantRow } from '@/lib/tenant/lifecycle-store';
import { raiseAlertWithEmail } from '@/lib/tenant/ops-alert-email';
import { stripe } from './stripe';
import { priceInfo, standardPriceIds, type BillingInterval } from './plans';
import { STANDARD_FLAT_TIER_USERS } from './plan-copy';

/**
 * The Stripe quantity sync (feature-plan-per-user-billing.md §6.4–§6.5).
 *
 * Principle (Q1): during a term the Stripe quantity only RISES (prorated per rule 3); in the last day before renewal it
 * comes DOWN to the real count, so the renewal bills the active users. Stripe's own quantity is the term's paid level,
 * so the app keeps no billing state of its own that a lost write could corrupt: every run re-reads Stripe and plans
 * from it.
 *
 * Locking: `withSeatLock` (`seats:` advisory lock, its own transaction on the dedicated pool). Inside it the only
 * writes to `tenant_seat_billing` are the final ones (step 7), after every Stripe call. Alerts are collected in memory
 * and written after the transaction ends (never an ops_alerts row lock or a Resend call inside the locked section).
 */

// ---------------------------------------------------------------------------
// The pure quantity plan (§6.4 step 5, §7.2)
// ---------------------------------------------------------------------------

export type ProrationBehavior = 'always_invoice' | 'create_prorations' | 'none';

export interface PlannedCall {
  /** A: rise inside the flat tier; B: prorated rise above it; D: the drop before renewal. */
  label: 'A' | 'B' | 'D';
  quantity: number;
  proration: ProrationBehavior;
}

/**
 * The Stripe updates that move `current` toward `desired` (§6.4 step 5). Rises at any time (A inside the flat tier with
 * no proration, then B prorated: `create_prorations` monthly, `always_invoice` annually); a drop only inside the
 * renewal window (D, no proration); otherwise the held quantity stays.
 */
export function planSeatUpdates(current: number, desired: number, window: boolean, interval: BillingInterval): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (desired > current) {
    if (current < STANDARD_FLAT_TIER_USERS) {
      calls.push({ label: 'A', quantity: Math.min(desired, STANDARD_FLAT_TIER_USERS), proration: 'none' });
    }
    if (desired > Math.max(current, STANDARD_FLAT_TIER_USERS)) {
      calls.push({ label: 'B', quantity: desired, proration: interval === 'year' ? 'always_invoice' : 'create_prorations' });
    }
  } else if (desired < current && window) {
    calls.push({ label: 'D', quantity: desired, proration: 'none' });
  }
  return calls;
}

/** §6.4 step 4: the last day before renewal, ending 5 minutes early. Epoch seconds. */
export function inRenewalWindow(nowS: number, periodEnd: number): boolean {
  return periodEnd - 86_400 <= nowS && nowS < periodEnd - 300;
}

// ---------------------------------------------------------------------------
// Due marks (§6.5)
// ---------------------------------------------------------------------------

const MARK_TIMEOUT_MS = 3000;

/** The mark statement, behind a seam so tests can inject failures and delays below the protection (S18). */
export const seatMarkStore = {
  async upsert(tenantId: string): Promise<void> {
    await controlDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '1s'`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '2s'`));
      await tx.insert(tenantSeatBilling).values({ tenantId, syncDueAt: sql`now()`, markSeq: 1 })
        .onConflictDoUpdate({
          target: tenantSeatBilling.tenantId,
          set: {
            syncDueAt: sql`COALESCE(${tenantSeatBilling.syncDueAt}, now())`,
            markSeq: sql`${tenantSeatBilling.markSeq} + 1`,
            updatedAt: sql`now()`,
          },
        });
    });
  },
};

/**
 * Mark the tenant's seat sync due (§6.5). Called after a user change commits. NEVER throws to its caller: a failure or
 * a timeout (Postgres cancels after 1 s / 2 s; a 3-second race is the last guard) is logged and sent to Sentry, and
 * the daily check is the backstop (F1).
 */
export async function markSeatSyncDue(tenantId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = Promise.resolve().then(() => seatMarkStore.upsert(tenantId));
    work.catch(() => {}); // the losing branch of the race must never become an unhandled rejection
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('markSeatSyncDue timed out')), MARK_TIMEOUT_MS);
    });
    timeout.catch(() => {});
    await Promise.race([work, timeout]);
  } catch (err) {
    console.error(`[seat-sync] could not mark tenant ${tenantId} due (the daily check will catch it):`, err);
    Sentry.captureException(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// One tenant's sync (§6.4)
// ---------------------------------------------------------------------------

export type SeatSyncReason = 'due' | 'daily' | 'renewal' | 'manual';
export type SeatSyncOutcomeKind =
  | 'in-sync' | 'held' | 'updated' | 'lowered' | 'corrected' | 'term-race'
  | 'not-applicable' | 'not-standard' | 'dry-run' | 'failed' | 'busy';

export interface SeatSyncOutcome {
  outcome: SeatSyncOutcomeKind;
  /** Dry runs: what the run decided ('not-applicable', 'not-standard', 'in-sync', 'held', …) and the planned calls. */
  decision?: SeatSyncOutcomeKind;
  planned?: PlannedCall[];
  /** Stripe's quantity at the read, and after the run (when known). */
  from?: number;
  to?: number;
  billable?: number;
  error?: string;
  /** Step 8: the proration invoice sent this run, if any. */
  invoiceSent?: string;
  /** A `seat-quantity-corrected` audit event was written this run (with or without a Stripe call; audit FR8). */
  corrected?: boolean;
}

const STRIPE_OPTS = { timeout: 10_000, maxNetworkRetries: 1 } as const;
const STRIPE_READ_OPTS = { timeout: 10_000, maxNetworkRetries: 0 } as const;
const COUNT_STATEMENT_TIMEOUT = '5s';
const FAILING_ALERT_THRESHOLD = 3;
const BACKOFF_BASE_MS = 10 * 60_000;
const STEP8_RETRY_MS = 10 * 60_000;
const STEP8_STUCK_OCCURRENCES = 3;

type PendingAlert =
  | { op: 'raise'; alert: AlertInput }
  | { op: 'email'; alert: AlertInput & { summary: string } }
  | { op: 'resolve'; tenantId: string; kind: string; dedupKey?: string }
  | { op: 'resolveKind'; tenantId: string; kind: string };

/** Written after the seat transaction ends, on the dedicated pool (§6.4). A failure is logged, never rethrown. */
async function flushAlerts(alerts: PendingAlert[], now: Date): Promise<void> {
  for (const a of alerts) {
    try {
      if (a.op === 'raise') await withLockedPool((db) => raiseAlert(db, a.alert, now));
      else if (a.op === 'email') await raiseAlertWithEmail(a.alert, now);
      else if (a.op === 'resolve') await withLockedPool((db) => resolveAlert(db, { tenantId: a.tenantId, kind: a.kind, dedupKey: a.dedupKey }, now));
      else await withLockedPool((db) => resolveAlertsOfKind(db, a.tenantId, a.kind, now));
    } catch (err) {
      console.error(`[seat-sync] alert write (${a.op} ${'alert' in a ? a.alert.kind : a.kind}) failed:`, err);
      Sentry.captureException(err);
    }
  }
}

function errText(err: unknown): string {
  const e = err as { message?: string; code?: string; type?: string };
  const msg = (e?.message ?? String(err)).slice(0, 300);
  return e?.code ? `${msg} (code ${e.code})` : msg;
}

function isResourceMissing(err: unknown): boolean {
  return (err as { code?: string })?.code === 'resource_missing';
}

/** What the run learned before it stopped, for the failure record and step 8. */
interface RunContext {
  row?: TenantRow;
  subId?: string;
  periodEnd?: number;
  /** Step 3 read the subscription: its status and collection method. */
  stripeStatus?: string;
  collection?: string | null;
}

/** §6.4 step 2: the active-user count on the tenant's own database, with a 5 s statement timeout. */
async function countBillable(row: TenantRow): Promise<number> {
  if (!row.dbUrlEncrypted) throw new Error('No database URL for this workspace.');
  const db = getDbForUrl(decrypt(row.dbUrlEncrypted));
  return db.transaction(async (t) => {
    await t.execute(sql.raw(`SET LOCAL statement_timeout = '${COUNT_STATEMENT_TIMEOUT}'`));
    const [r] = await t.select({ value: count() }).from(users).where(eq(users.isActive, true));
    return Number(r.value);
  });
}

/** The quantity of the next schedule phase's Standard (or only) item, or null when there is no next phase. */
function nextPhaseQuantity(schedule: Stripe.SubscriptionSchedule, nowS: number): number | null {
  const after = schedule.current_phase?.end_date ?? nowS;
  const next = [...(schedule.phases ?? [])]
    .filter((p) => p.start_date >= after)
    .sort((a, b) => a.start_date - b.start_date)[0];
  if (!next) return null;
  const items = next.items ?? [];
  const priceIdOf = (i: (typeof items)[number]) => (typeof i.price === 'string' ? i.price : i.price?.id ?? null);
  const item = items.find((i) => priceInfo(priceIdOf(i)) !== null) ?? items[0];
  return item ? (item.quantity ?? 1) : null;
}

interface StepResult {
  outcome: SeatSyncOutcome;
  /** The seat row's mark_seq at step 1: step 7 clears the due mark only if no mark arrived during the run. */
  markSeq0: number;
  /** Step 7 values. `record: false` = dry run (write nothing at all). */
  record: boolean;
  billable?: number;
  /** The final Stripe values (left unchanged for not-applicable / not-standard). */
  subId?: string;
  quantity?: number;
}

/**
 * One sync of a tenant's Stripe quantity (§6.4). Called by the seat-sync cron and `tenant:admin seat-sync`. Never
 * throws: failures are recorded with backoff and reported as `failed`; a lock timeout is `busy`.
 */
export async function syncSeatQuantity(tenantId: string, opts: {
  runId: string;
  reason: SeatSyncReason;
  dryRun?: boolean;
  now?: Date;
}): Promise<SeatSyncOutcome> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const alerts: PendingAlert[] = [];
  const ctx: RunContext = {};
  let outcome: SeatSyncOutcome;

  try {
    outcome = await withSeatLock(tenantId, async (tx) => {
      const r = await syncInSection(tx, tenantId, opts.runId, opts.reason, dryRun, now, alerts, ctx);
      if (r.record) await recordSuccess(tx, tenantId, r, now, alerts);
      return r.outcome;
    });
  } catch (err) {
    if (err instanceof SeatLockTimeoutError) return { outcome: 'busy' };
    console.error(`[seat-sync] tenant ${tenantId} failed:`, err);
    outcome = { outcome: 'failed', error: errText(err) };
    if (!dryRun) {
      try {
        await recordFailure(tenantId, err, ctx, now, alerts);
      } catch (writeErr) {
        console.error(`[seat-sync] could not record the failure of tenant ${tenantId}:`, writeErr);
        Sentry.captureException(writeErr);
      }
    }
  }

  if (!dryRun) await flushAlerts(alerts, now);

  // Step 8: send-invoice proration invoices, in their own locked section, whatever step 3 decided.
  if (!dryRun && step8Eligible(ctx, now)) {
    try {
      const sent = await sendProrationInvoices(tenantId, ctx.subId!, opts.reason, now);
      if (sent) outcome.invoiceSent = sent;
    } catch (err) {
      if (!(err instanceof SeatLockTimeoutError)) {
        console.error(`[seat-sync] step 8 for tenant ${tenantId} failed:`, err);
        Sentry.captureException(err);
      }
    }
  }
  return outcome;
}

/** Step 8 runs for a LIVE send_invoice subscription of a tenant that isn't ended or closed. */
function step8Eligible(ctx: RunContext, now: Date): boolean {
  const row = ctx.row;
  if (!row || !ctx.subId || row.subscriptionEndedAt !== null) return false;
  if (getTenantAccess(toLifecycleFacts(row), now) === 'closed') return false;
  // Stripe's own values when step 3 read them; otherwise the mirror.
  const status = ctx.stripeStatus ?? row.subscriptionStatus;
  const collection = ctx.stripeStatus !== undefined ? ctx.collection : row.collectionMethod;
  return collection === 'send_invoice' && isLive(status);
}

async function syncInSection(
  tx: ControlTx,
  tenantId: string,
  runId: string,
  reason: SeatSyncReason,
  dryRun: boolean,
  now: Date,
  alerts: PendingAlert[],
  ctx: RunContext,
): Promise<StepResult> {
  const alert = (a: PendingAlert) => { if (!dryRun) alerts.push(a); };

  // 1. Read the tenant row and the seat row; keep the mark sequence seen NOW (§6.4 step 1).
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [seat] = await tx.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenantId)).limit(1);
  const markSeq0 = seat?.markSeq ?? 0;
  const stored = seat?.stripeQuantity ?? null;
  const notApplicable = (billable?: number): StepResult => (dryRun
    ? { outcome: { outcome: 'dry-run', decision: 'not-applicable', planned: [], billable }, record: false, markSeq0 }
    : { outcome: { outcome: 'not-applicable', billable }, record: true, billable, markSeq0 });
  const notStandard = (billable: number): StepResult => (dryRun
    ? { outcome: { outcome: 'dry-run', decision: 'not-standard', planned: [], billable }, record: false, markSeq0 }
    : { outcome: { outcome: 'not-standard', billable }, record: true, billable, markSeq0 });
  if (!row) return notApplicable();
  ctx.row = row;
  ctx.subId = row.stripeSubscriptionId ?? undefined;
  if (row.status !== 'active' || !row.stripeSubscriptionId || row.subscriptionEndedAt !== null
      || getTenantAccess(toLifecycleFacts(row), now) === 'closed') {
    return notApplicable();
  }
  const subId = row.stripeSubscriptionId;

  // 2. Count (never a guessed count: a failure here is `failed`).
  const desired = Math.max(1, await countBillable(row));

  // 3. Read Stripe.
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subId, {}, STRIPE_READ_OPTS);
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
    alert({ op: 'raise', alert: { tenantId, kind: 'seat-sync-subscription-missing', dedupKey: subId } });
    return notApplicable(desired);
  }
  alert({ op: 'resolve', tenantId, kind: 'seat-sync-subscription-missing', dedupKey: subId });
  ctx.stripeStatus = sub.status;
  ctx.collection = sub.collection_method ?? null;
  ctx.periodEnd = sub.current_period_end;
  const nowS = Math.floor(now.getTime() / 1000);
  const periodStart = sub.current_period_start;
  const periodEnd = sub.current_period_end;
  const window = inRenewalWindow(nowS, periodEnd);

  if (isGood(sub.status)) alert({ op: 'resolveKind', tenantId, kind: 'subscription-status-drift' });
  const syncable = row.pastDueSince === null
    && (sub.status === 'active' || (sub.status === 'past_due' && sub.collection_method === 'send_invoice'));
  if (!syncable) {
    if (!isGood(sub.status) && isGood(row.subscriptionStatus)) {
      alert({ op: 'raise', alert: { tenantId, kind: 'subscription-status-drift', dedupKey: subId, detail: { stripe: sub.status, mirror: row.subscriptionStatus } } });
    }
    return notApplicable(desired);
  }

  // Schedule attached: its next phase can reset the quantity at renewal.
  const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id ?? null;
  if (scheduleId) {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, STRIPE_OPTS);
    const q = nextPhaseQuantity(schedule, nowS);
    if (q !== null && q !== desired) {
      const detail = { schedule: scheduleId, nextPhaseQuantity: q, activeUsers: desired };
      // Mid-term: a digest alert under the subscription id. Inside the renewal window: the emailed variant under a key
      // per renewal (`${subId}:${periodEnd}`, like renewal-at-risk), so a schedule first seen mid-term still emails
      // once the window opens (raiseAlertWithEmail emails only when it opens an alert; audit FR1).
      alert(window
        ? { op: 'email', alert: { tenantId, kind: 'seat-sync-schedule-attached', dedupKey: `${subId}:${periodEnd}`, detail,
          summary: `A subscription schedule on ${row.slug} will set the quantity to ${q} at renewal; ${desired} users are active.` } }
        : { op: 'raise', alert: { tenantId, kind: 'seat-sync-schedule-attached', dedupKey: subId, detail } });
    } else {
      alert({ op: 'resolveKind', tenantId, kind: 'seat-sync-schedule-attached' }); // both keys
    }
  } else {
    alert({ op: 'resolveKind', tenantId, kind: 'seat-sync-schedule-attached' }); // both keys
  }

  // Items: exactly one item, on a Standard price.
  const items = sub.items?.data ?? [];
  if (items.length > 1) {
    alert({ op: 'raise', alert: { tenantId, kind: 'seat-sync-unexpected-items', dedupKey: subId, detail: { items: items.length } } });
    return notStandard(desired);
  }
  const item = items[0];
  const info = item ? priceInfo(item.price?.id ?? null) : null;
  if (!item || !info) {
    if (row.plan !== 'enterprise') {
      alert({ op: 'raise', alert: { tenantId, kind: 'seat-sync-unmanaged-price', dedupKey: subId, detail: { price: item?.price?.id ?? null } } });
    } else {
      alert({ op: 'resolveKind', tenantId, kind: 'seat-sync-unmanaged-price' });
    }
    return notStandard(desired);
  }
  alert({ op: 'resolveKind', tenantId, kind: 'seat-sync-unmanaged-price' });
  alert({ op: 'resolveKind', tenantId, kind: 'seat-sync-unexpected-items' });

  const current = item.quantity ?? 1;

  // 4–5. Plan.
  const planned = planSeatUpdates(current, desired, window, info.interval);
  if (dryRun) {
    const decision: SeatSyncOutcomeKind = planned.length > 0 ? (planned[0].label === 'D' ? 'lowered' : 'updated')
      : desired < current ? 'held' : 'in-sync';
    return { outcome: { outcome: 'dry-run', decision, planned, from: current, billable: desired }, record: false, markSeq0 };
  }

  // 6. Execute, in order.
  let quantity = current;
  let termRace = false;
  for (const call of planned) {
    const from = quantity;
    const resp = await stripe.subscriptions.update(subId,
      { items: [{ id: item.id, quantity: call.quantity }], proration_behavior: call.proration, payment_behavior: 'allow_incomplete' },
      { idempotencyKey: `seat:${subId}:${periodStart}:${from}->${call.quantity}:${runId}`, ...STRIPE_OPTS });
    quantity = resp.items?.data?.find((i) => i.id === item.id)?.quantity ?? call.quantity;
    if (call.label === 'D' && resp.current_period_start !== periodStart) {
      // Term race: Stripe renewed between the read and this write, so the renewal billed `from`. Put it back.
      termRace = true;
      const newPeriodStart = resp.current_period_start;
      let restored = false;
      let restoreError: string | null = null;
      try {
        const back = await stripe.subscriptions.update(subId,
          { items: [{ id: item.id, quantity: from }], proration_behavior: 'none', payment_behavior: 'allow_incomplete' },
          { idempotencyKey: `restore:${subId}:${newPeriodStart}:${runId}`, ...STRIPE_OPTS });
        quantity = back.items?.data?.find((i) => i.id === item.id)?.quantity ?? from;
        restored = true;
      } catch (err) {
        restoreError = errText(err);
        console.error(`[seat-sync] term-race restore for ${row.slug} failed:`, err);
      }
      const detail = { from, to: call.quantity, periodStart, newPeriodStart, restored, ...(restoreError ? { restoreError } : {}) };
      // The durable record (inside the transaction); the alert is the notification (after it).
      await recordAudit(tx, {
        tenantId, kind: 'seat-sync-term-race', actor: 'seat-sync',
        detail: `${from}->${call.quantity} periods ${periodStart}->${newPeriodStart} restore=${restored ? 'ok' : `failed: ${restoreError}`}`,
      });
      alert({ op: 'raise', alert: { tenantId, kind: 'seat-sync-term-race', dedupKey: subId, detail } });
      break;
    }
  }

  // 7 (corrections for the digest, rule 2).
  let corrected = false;
  if (stored !== null && seat?.stripeSubscriptionId === subId && current !== stored) {
    await recordAudit(tx, { tenantId, kind: 'seat-quantity-corrected', actor: 'seat-sync', detail: `${stored}→${current} (billable ${desired}, changed outside the sync)` });
    corrected = true;
  }
  if (reason === 'daily' && planned.some((c) => c.label === 'A' || c.label === 'B')) {
    await recordAudit(tx, { tenantId, kind: 'seat-quantity-corrected', actor: 'seat-sync', detail: `${current}→${quantity} (billable ${desired}, daily)` });
    corrected = true;
  }

  const kind: SeatSyncOutcomeKind = termRace ? 'term-race'
    : corrected && planned.length > 0 ? 'corrected'
    : planned.some((c) => c.label === 'D') ? 'lowered'
    : planned.length > 0 ? 'updated'
    : desired < current ? 'held'
    : 'in-sync';
  return { outcome: { outcome: kind, from: current, to: quantity, billable: desired, ...(corrected ? { corrected: true } : {}) }, record: true, billable: desired, subId, quantity, markSeq0 };
}

/** Step 7: the last statements of the section, after every Stripe call. Never touches `mark_seq` or `sync_due_at` (except the compare-and-clear). */
async function recordSuccess(tx: ControlTx, tenantId: string, r: StepResult, now: Date, alerts: PendingAlert[]): Promise<void> {
  const set: Partial<typeof tenantSeatBilling.$inferInsert> = {
    checkedAt: now, failures: 0, lastError: null, nextAttemptAt: null, updatedAt: now,
    ...(r.billable !== undefined ? { billableCount: r.billable } : {}),
    ...(r.subId !== undefined ? { stripeSubscriptionId: r.subId, stripeQuantity: r.quantity ?? null } : {}),
  };
  await tx.insert(tenantSeatBilling).values({ tenantId, ...set })
    .onConflictDoUpdate({ target: tenantSeatBilling.tenantId, set });
  await tx.update(tenantSeatBilling).set({ syncDueAt: null })
    .where(and(eq(tenantSeatBilling.tenantId, tenantId), eq(tenantSeatBilling.markSeq, r.markSeq0)));
  alerts.push({ op: 'resolveKind', tenantId, kind: 'seat-sync-failing' });
  alerts.push({ op: 'resolveKind', tenantId, kind: 'seat-sync-renewal-at-risk' });
}

/**
 * `failed` (§6.4): the section rolled back, so the failure is recorded in a separate upsert. Backoff 10 min × 2^(n−1),
 * at most 6 h, but at most 10 min inside the renewal window (from the step 3 values, or the mirror's period end).
 */
async function recordFailure(tenantId: string, err: unknown, ctx: RunContext, now: Date, alerts: PendingAlert[]): Promise<void> {
  const [mirror] = ctx.row ? [ctx.row] : await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  const nowS = Math.floor(now.getTime() / 1000);
  const periodEnd = ctx.periodEnd ?? (mirror?.currentPeriodEnd ? Math.floor(mirror.currentPeriodEnd.getTime() / 1000) : null);
  const window = periodEnd !== null && inRenewalWindow(nowS, periodEnd);
  const subId = ctx.subId ?? mirror?.stripeSubscriptionId ?? null;
  const lastError = errText(err);

  const [row] = await withLockedPool((db) => db.insert(tenantSeatBilling)
    .values({ tenantId, failures: 1, lastError, checkedAt: now, syncDueAt: now, nextAttemptAt: new Date(now.getTime() + BACKOFF_BASE_MS), updatedAt: now })
    .onConflictDoUpdate({
      target: tenantSeatBilling.tenantId,
      set: {
        failures: sql`${tenantSeatBilling.failures} + 1`,
        lastError, checkedAt: now, updatedAt: now,
        syncDueAt: sql`COALESCE(${tenantSeatBilling.syncDueAt}, ${now.toISOString()}::timestamptz)`,
        nextAttemptAt: window
          ? new Date(now.getTime() + BACKOFF_BASE_MS)
          : sql`${now.toISOString()}::timestamptz + LEAST(interval '10 minutes' * power(2, ${tenantSeatBilling.failures}), interval '6 hours')`,
      },
    })
    .returning({ failures: tenantSeatBilling.failures }));

  if ((row?.failures ?? 0) >= FAILING_ALERT_THRESHOLD) {
    alerts.push({ op: 'raise', alert: { tenantId, kind: 'seat-sync-failing', detail: { consecutiveFailures: row.failures, lastError } } });
  }
  if (window && subId && periodEnd !== null) {
    alerts.push({ op: 'email', alert: {
      tenantId, kind: 'seat-sync-renewal-at-risk', dedupKey: `${subId}:${periodEnd}`,
      detail: { subscription: subId, renewsAt: new Date(periodEnd * 1000).toISOString(), lastError },
      summary: `The seat sync for ${mirror?.slug ?? tenantId} is failing inside its renewal window; the renewal may bill removed users.`,
    } });
  }
}

// ---------------------------------------------------------------------------
// Step 8: send-invoice proration invoices
// ---------------------------------------------------------------------------

const SENT_MARKER = 'cadenzpoint_sent';
const SEND_FAILED = 'seat-sync-invoice-send-failed';

/**
 * §6.4 step 8, in its own `withSeatLock` section, after step 7's commit. Stateless: finds unsent `subscription_update`
 * invoices by the missing metadata marker (send before marking, so a crash re-sends once, never zero). Handles one
 * invoice per run; re-marks the tenant due (10 minutes ahead) on a failure or when more remain. Returns the id sent.
 */
async function sendProrationInvoices(tenantId: string, subId: string, reason: SeatSyncReason, now: Date): Promise<string | null> {
  const alerts: PendingAlert[] = [];
  const sent = await withSeatLock(tenantId, async (tx) => {
    // Close stuck alerts whose invoice is no longer pending (sent, paid, void).
    const open = await tx.select({ dedupKey: opsAlerts.dedupKey, occurrences: opsAlerts.occurrences }).from(opsAlerts)
      .where(and(eq(opsAlerts.scope, tenantId), eq(opsAlerts.kind, SEND_FAILED), isNull(opsAlerts.resolvedAt)));
    const occurrences = new Map<string, number>();
    for (const a of open) {
      if (!a.dedupKey.endsWith(':stuck')) occurrences.set(a.dedupKey, a.occurrences);
    }
    const alertIds = new Set(open.map((a) => a.dedupKey.replace(/:stuck$/, '')));
    for (const id of alertIds) {
      try {
        const inv = await stripe.invoices.retrieve(id, STRIPE_OPTS);
        if ((inv.status !== 'open' && inv.status !== 'draft') || inv.metadata?.[SENT_MARKER]) {
          alerts.push({ op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: id }, { op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: `${id}:stuck` });
        }
      } catch (err) {
        if (isResourceMissing(err)) {
          alerts.push({ op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: id }, { op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: `${id}:stuck` });
        } else {
          console.error(`[seat-sync] could not re-check invoice ${id}:`, err);
        }
      }
    }

    // A failed list re-marks the tenant (10 minutes ahead) in its own statement, so it's retried soon (audit FR4).
    let page: Stripe.ApiList<Stripe.Invoice>;
    try {
      page = await stripe.invoices.list({ subscription: subId, limit: 20 }, STRIPE_OPTS);
    } catch (err) {
      console.error(`[seat-sync] step 8 could not list the invoices of ${subId}:`, err);
      Sentry.captureException(err);
      await remarkForStep8(tx, tenantId, now);
      return null;
    }
    const unsent = page.data.filter((inv) => (inv.status === 'draft' || inv.status === 'open')
      && inv.billing_reason === 'subscription_update'
      && !inv.metadata?.[SENT_MARKER]
      && !(inv.status === 'open' && inv.auto_advance === true)) // Stripe emails those itself
      .reverse(); // oldest first (the list is newest first)
    // An invoice that has failed 3 times is retried only on daily runs (the founder already has the alert).
    const eligible = unsent.filter((inv) => reason === 'daily' || (occurrences.get(inv.id) ?? 0) < STEP8_STUCK_OCCURRENCES);
    const target = eligible[0];
    let failed = false;
    let sentId: string | null = null;
    if (target) {
      try {
        if (target.status === 'draft') await stripe.invoices.finalizeInvoice(target.id, { auto_advance: false }, STRIPE_OPTS);
        await stripe.invoices.sendInvoice(target.id, {}, STRIPE_OPTS);
        await stripe.invoices.update(target.id, { metadata: { [SENT_MARKER]: now.toISOString() } }, STRIPE_OPTS);
        sentId = target.id;
        alerts.push({ op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: target.id }, { op: 'resolve', tenantId, kind: SEND_FAILED, dedupKey: `${target.id}:stuck` });
      } catch (err) {
        const n = (occurrences.get(target.id) ?? 0) + 1;
        const detail = { invoice: target.id, subscription: subId, error: errText(err), attempts: n };
        alerts.push({ op: 'raise', alert: { tenantId, kind: SEND_FAILED, dedupKey: target.id, detail } });
        if (n >= STEP8_STUCK_OCCURRENCES) {
          alerts.push({ op: 'email', alert: {
            tenantId, kind: SEND_FAILED, dedupKey: `${target.id}:stuck`, detail,
            summary: `A proration invoice (${target.id}) could not be sent after ${n} attempts; its due date still drives the dunning clock.`,
          } });
        }
        failed = n < STEP8_STUCK_OCCURRENCES; // after the third failure, stop forcing early retries (daily runs only)
      }
    }
    const moreRemain = eligible.length > (target ? 1 : 0);
    if (failed || moreRemain) await remarkForStep8(tx, tenantId, now);
    return sentId;
  });
  await flushAlerts(alerts, now);
  return sent;
}

/**
 * Step 8's retry: due again, about 10 minutes ahead — but never EARLIER than a backoff the main run already set
 * (GREATEST; Postgres ignores a NULL argument), so a failing main sync keeps its exponential backoff (audit FR3).
 */
async function remarkForStep8(tx: ControlTx, tenantId: string, now: Date): Promise<void> {
  const retryAt = new Date(now.getTime() + STEP8_RETRY_MS);
  await tx.insert(tenantSeatBilling).values({ tenantId, syncDueAt: now, nextAttemptAt: retryAt, updatedAt: now })
    .onConflictDoUpdate({
      target: tenantSeatBilling.tenantId,
      set: {
        syncDueAt: sql`COALESCE(${tenantSeatBilling.syncDueAt}, ${now.toISOString()}::timestamptz)`,
        nextAttemptAt: sql`GREATEST(${tenantSeatBilling.nextAttemptAt}, ${retryAt.toISOString()}::timestamptz)`,
        updatedAt: now,
      },
    });
}

// ---------------------------------------------------------------------------
// The cron (§6.5)
// ---------------------------------------------------------------------------

export interface SeatSyncCronSummary {
  runId: string;
  candidates: number;
  processed: number;
  incomplete: boolean;
  counts: Partial<Record<SeatSyncOutcomeKind, number>>;
  slugs: { corrected: string[]; 'term-race': string[]; failed: string[]; busy: string[] };
}

const DEFAULT_BUDGET_MS = 100_000;

function syncableMirror(): SQL {
  return and(
    isNull(tenants.pastDueSince),
    or(eq(tenants.subscriptionStatus, 'active'),
      and(eq(tenants.subscriptionStatus, 'past_due'), eq(tenants.collectionMethod, 'send_invoice'))),
  )!;
}

/** The three candidate lists, each one control-plane query, in run order: due, renewal, daily (de-duplicated). */
export async function seatSyncCandidates(now: Date, onlyTenantIds?: string[]): Promise<Array<{ id: string; slug: string; reason: SeatSyncReason }>> {
  const only = onlyTenantIds ? inArray(tenants.id, onlyTenantIds.length ? onlyTenantIds : ['00000000-0000-0000-0000-000000000000']) : undefined;
  const eligible = or(isNull(tenantSeatBilling.nextAttemptAt), lte(tenantSeatBilling.nextAttemptAt, now));
  return withLockedPool(async (db) => {
    const due = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenantSeatBilling)
      .innerJoin(tenants, eq(tenants.id, tenantSeatBilling.tenantId))
      .where(and(isNotNull(tenantSeatBilling.syncDueAt), eligible, only))
      .orderBy(asc(tenantSeatBilling.failures), asc(tenantSeatBilling.syncDueAt));
    const renewal = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants)
      .leftJoin(tenantSeatBilling, eq(tenantSeatBilling.tenantId, tenants.id))
      .where(and(
        eq(tenants.status, 'active'), isNull(tenants.subscriptionEndedAt), isNotNull(tenants.stripeSubscriptionId), syncableMirror(),
        gte(tenants.currentPeriodEnd, new Date(now.getTime() + 5 * 60_000)),
        lte(tenants.currentPeriodEnd, new Date(now.getTime() + 24 * 3_600_000)),
        or(isNull(tenantSeatBilling.tenantId), isNull(tenantSeatBilling.checkedAt),
          sql`${tenantSeatBilling.checkedAt} < ${tenants.currentPeriodEnd} - interval '24 hours'`),
        eligible, only,
      ))
      .orderBy(asc(tenants.currentPeriodEnd));
    const daily = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants)
      .leftJoin(tenantSeatBilling, eq(tenantSeatBilling.tenantId, tenants.id))
      .where(and(
        eq(tenants.status, 'active'), isNull(tenants.subscriptionEndedAt), isNotNull(tenants.stripeSubscriptionId), syncableMirror(),
        or(isNull(tenantSeatBilling.tenantId), isNull(tenantSeatBilling.checkedAt),
          lte(tenantSeatBilling.checkedAt, new Date(now.getTime() - 24 * 3_600_000))),
        eligible, only,
      ))
      .orderBy(sql`${tenantSeatBilling.checkedAt} asc nulls first`);
    const seen = new Set<string>();
    const out: Array<{ id: string; slug: string; reason: SeatSyncReason }> = [];
    for (const [list, reason] of [[due, 'due'], [renewal, 'renewal'], [daily, 'daily']] as const) {
      for (const t of list) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ ...t, reason });
      }
    }
    return out;
  });
}

/**
 * §6.5 config check: a missing Standard price while any subscription is active raises `stripe-prices-missing` (global);
 * otherwise it resolves.
 */
async function checkPriceConfig(now: Date): Promise<void> {
  const ids = standardPriceIds();
  const missing = ids.month === null || ids.year === null;
  await withLockedPool(async (db) => {
    if (missing) {
      const [any] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.subscriptionStatus, 'active')).limit(1);
      if (any) {
        await raiseAlert(db, { tenantId: null, kind: 'stripe-prices-missing', detail: { monthly: ids.month !== null, annual: ids.year !== null } }, now);
        return;
      }
    }
    await resolveAlert(db, { tenantId: null, kind: 'stripe-prices-missing' }, now);
  });
}

/**
 * The seat-sync cron run (§6.5): tenants one at a time (never two sections at once), at least one per run, no new
 * tenant after `budgetMs` (100 s by default: 100 + the ~190 s per-tenant worst case < 300 s). One failing tenant never
 * stops the others. A run that stops early raises `cron-incomplete` (dedup `seat-sync`, digest only); a complete run
 * resolves it.
 */
export async function runSeatSyncCron(opts: { budgetMs?: number; now?: () => Date; onlyTenantIds?: string[] } = {}): Promise<SeatSyncCronSummary> {
  const started = Date.now();
  const clock = opts.now ?? (() => new Date());
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const runId = randomUUID();

  try {
    await checkPriceConfig(clock());
  } catch (err) { // one failed alert write never aborts the run (audit FR7)
    console.error('[seat-sync] the price config check could not write its alert:', err);
    Sentry.captureException(err);
  }
  const candidates = await seatSyncCandidates(clock(), opts.onlyTenantIds);

  const summary: SeatSyncCronSummary = {
    runId, candidates: candidates.length, processed: 0, incomplete: false, counts: {},
    slugs: { corrected: [], 'term-race': [], failed: [], busy: [] },
  };
  for (const c of candidates) {
    if (summary.processed > 0 && Date.now() - started > budgetMs) {
      summary.incomplete = true;
      break;
    }
    summary.processed++;
    let result: SeatSyncOutcome;
    try {
      result = await syncSeatQuantity(c.id, { runId, reason: c.reason, now: clock() });
    } catch (err) {
      console.error(`[seat-sync] tenant ${c.slug} crashed:`, err);
      result = { outcome: 'failed', error: errText(err) };
    }
    // A correction with no Stripe call (Stripe changed outside the sync) is still a correction (audit FR8).
    const counted: SeatSyncOutcomeKind = result.corrected && (result.outcome === 'in-sync' || result.outcome === 'held')
      ? 'corrected' : result.outcome;
    summary.counts[counted] = (summary.counts[counted] ?? 0) + 1;
    if (counted === 'corrected' || counted === 'term-race' || counted === 'failed' || counted === 'busy') {
      summary.slugs[counted].push(c.slug);
    }
  }

  const doneAt = clock();
  try {
    await withLockedPool(async (db) => {
      if (summary.incomplete) {
        await raiseAlert(db, { tenantId: null, kind: 'cron-incomplete', dedupKey: 'seat-sync', detail: { processed: summary.processed, candidates: summary.candidates } }, doneAt);
      } else {
        await resolveAlert(db, { tenantId: null, kind: 'cron-incomplete', dedupKey: 'seat-sync' }, doneAt);
      }
    });
  } catch (err) { // the run itself completed; a failed alert write is logged (audit FR7)
    console.error('[seat-sync] could not write the cron-incomplete alert:', err);
    Sentry.captureException(err);
  }
  return summary;
}
