import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const env = vi.hoisted(() => {
  process.env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_month';
  process.env.STRIPE_PRICE_STANDARD_ANNUAL = 'price_std_year';
  process.env.OPS_ALERT_EMAIL = 'ops@cadenzpoint.test';
  return { month: 'price_std_month', year: 'price_std_year' };
});

/**
 * S43 instrumentation: pass-through wrappers that record whether an alert write happens while a `withSeatLock`
 * section is open, and can make the next post-commit alert write throw. Everything else is the real code.
 */
const probe = vi.hoisted(() => ({ inSeatSection: 0, alertsInSection: [] as string[], throwNextRaise: false }));
vi.mock('@/db/control-plane/locked', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/control-plane/locked')>();
  return {
    ...real,
    withSeatLock: async <T,>(tenantId: string, fn: (tx: Parameters<Parameters<typeof real.withSeatLock>[1]>[0]) => Promise<T>) =>
      real.withSeatLock(tenantId, async (tx) => {
        probe.inSeatSection++;
        try { return await fn(tx); } finally { probe.inSeatSection--; }
      }),
  };
});
vi.mock('@/lib/tenant/lifecycle-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/tenant/lifecycle-store')>();
  return {
    ...real,
    raiseAlert: async (...a: Parameters<typeof real.raiseAlert>) => {
      if (probe.inSeatSection > 0) probe.alertsInSection.push(`raise:${a[1].kind}`);
      if (probe.throwNextRaise) { probe.throwNextRaise = false; throw new Error('alert write failed (test)'); }
      return real.raiseAlert(...a);
    },
    resolveAlertsOfKind: async (...a: Parameters<typeof real.resolveAlertsOfKind>) => {
      if (probe.inSeatSection > 0) probe.alertsInSection.push(`resolveKind:${a[2]}`);
      return real.resolveAlertsOfKind(...a);
    },
  };
});
vi.mock('@/lib/tenant/ops-alert-email', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/tenant/ops-alert-email')>();
  return {
    ...real,
    raiseAlertWithEmail: async (...a: Parameters<typeof real.raiseAlertWithEmail>) => {
      if (probe.inSeatSection > 0) probe.alertsInSection.push(`email:${a[0].kind}`);
      return real.raiseAlertWithEmail(...a);
    },
  };
});
vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import bcrypt from 'bcryptjs';
import { controlDb } from '@/db/control-plane';
import { opsAlerts, tenantSeatBilling, tenants } from '@/db/control-plane/schema';
import * as schema from '@/db/schema';
import { encrypt } from '@/lib/encryption';
import { markSeatSyncDue, runSeatSyncCron, syncSeatQuantity } from '@/lib/billing/seat-sync';
import { seatSyncCommand } from '@/lib/tenant/admin-commands';
import { sendOpsDigest } from '@/lib/tenant/ops-digest';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { cleanupTestData, getTestDb } from './helpers';
import { allAlertsOf, auditOf, cleanupLifecycleTenants, cpReady, daysFrom, makeTenant, openAlertsOf, setTenant } from './lifecycle-helpers';

/**
 * feature-plan-per-user-billing.md §6.4–§6.6 / §11: the seat-sync integration scenarios. Stripe and Resend are
 * in-memory fakes; the control plane and the tenant database are real. Every test tenant points at the shared test
 * database, so each test sets the active-user count there itself.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const GLOBAL_KINDS = ['stripe-prices-missing', 'cron-incomplete'];
let passwordHash = '';

/** Exactly `n` active users (and `inactive` inactive ones) in the tenant database. */
async function setUsers(n: number, inactive = 0): Promise<void> {
  await cleanupTestData();
  passwordHash ||= await bcrypt.hash('TestPass123!', 4);
  const rows = [...Array(n + inactive)].map((_, i) => ({
    email: `seat-${i}-${Math.random().toString(36).slice(2, 8)}@bytime.dev`, fullName: `Seat ${i}`, role: 'employee' as const,
    passwordHash, isActive: i < n,
  }));
  if (rows.length) await getTestDb().insert(schema.users).values(rows);
}

/** A Standard subscriber: Stripe quantity `quantity`, the mirror active and syncable. */
async function subscriber(o: {
  quantity: number; interval?: 'month' | 'year'; periodEnd?: Date; collection?: string; status?: string;
  priceId?: string | null; schedule?: string | null; extraItems?: Array<{ id: string; priceId: string; quantity: number }>;
  tenant?: Partial<typeof tenants.$inferInsert>;
} = { quantity: 1 }) {
  const interval = o.interval ?? 'month';
  const periodEnd = o.periodEnd ?? daysFrom(new Date(), 15);
  const customer = stripeState.addCustomer();
  const sub = stripeState.addSub(customer, o.status ?? 'active', {
    priceId: o.priceId === undefined ? env[interval] : o.priceId, interval, quantity: o.quantity, periodEnd,
    collection_method: o.collection ?? 'charge_automatically', schedule: o.schedule ?? null, extraItems: o.extraItems ?? [],
  });
  const tenant = await makeTenant({
    plan: 'standard', planInterval: interval, stripeCustomerId: customer, stripeSubscriptionId: sub,
    subscriptionStatus: o.status ?? 'active', firstGoodAt: daysFrom(new Date(), -60), currentPeriodEnd: periodEnd,
    collectionMethod: o.collection ?? 'charge_automatically', trialEndsAt: daysFrom(new Date(), -90), ...o.tenant,
  });
  return { tenant, customer, sub };
}

const seatRow = async (tenantId: string) =>
  (await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, tenantId)))[0];
const updatesOf = (sub: string) => stripeState.updates.filter((u) => u.id === sub)
  .map((u) => ({ quantity: (u.params.items as Array<{ quantity: number }>)[0].quantity, proration: u.params.proration_behavior }));
const quantityOf = (sub: string) => stripeState.subs.get(sub)!.quantity;
const corrections = async (tenantId: string) => (await auditOf(tenantId)).filter((e) => e.kind === 'seat-quantity-corrected');
const openKinds = async (tenantId: string) => (await openAlertsOf(tenantId)).map((a) => a.kind);
const run = (tenantIds: string[], o: { now?: Date; budgetMs?: number } = {}) =>
  runSeatSyncCron({ onlyTenantIds: tenantIds, now: o.now ? () => o.now! : undefined, budgetMs: o.budgetMs });
const sync = (tenantId: string, reason: 'due' | 'daily' | 'renewal' | 'manual' = 'due', now?: Date) =>
  syncSeatQuantity(tenantId, { runId: `run-${Math.random().toString(36).slice(2)}`, reason, now });
/** Waits (real time) until `cond` holds. */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe.skipIf(!cpReady)('seat sync (feature-plan-per-user-billing.md §6.4)', () => {
  beforeEach(async () => {
    stripeState.reset();
    resendState.reset();
    probe.inSeatSection = 0;
    probe.alertsInSection = [];
    probe.throwNextRaise = false;
    process.env.STRIPE_PRICE_STANDARD_MONTHLY = env.month;
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = env.year;
    await cleanupLifecycleTenants();
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), inArray(opsAlerts.kind, GLOBAL_KINDS)));
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), inArray(opsAlerts.kind, GLOBAL_KINDS)));
    await cleanupTestData();
  });

  it('S1: monthly, 8 users at Stripe 8: a user added → due → one update to 9 with create_prorations; clean; no correction on the first run', async () => {
    await setUsers(9);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    await markSeatSyncDue(tenant.id);
    expect((await seatRow(tenant.id)).syncDueAt).not.toBeNull();
    const summary = await run([tenant.id]);
    expect(summary.counts.updated).toBe(1);
    expect(updatesOf(sub)).toEqual([{ quantity: 9, proration: 'create_prorations' }]);
    const seat = await seatRow(tenant.id);
    expect(seat.syncDueAt).toBeNull();
    expect(seat.stripeQuantity).toBe(9);
    expect(seat.stripeSubscriptionId).toBe(sub);
    expect(await corrections(tenant.id)).toEqual([]);
    // the idempotency key carries the subscription, the period, from->to and the run id
    expect(String(stripeState.updates[0].options?.idempotencyKey)).toMatch(new RegExp(`^seat:${sub}:\\d+:8->9:`));
  });

  it('S2: the same on annual → always_invoice', async () => {
    await setUsers(9);
    const { tenant, sub } = await subscriber({ quantity: 8, interval: 'year' });
    await markSeatSyncDue(tenant.id);
    await run([tenant.id]);
    expect(updatesOf(sub)).toEqual([{ quantity: 9, proration: 'always_invoice' }]);
  });

  it('S3: deactivating one mid-term is held (no update, Stripe stays 8); reactivating → no update (Q1)', async () => {
    await setUsers(7, 1);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    await markSeatSyncDue(tenant.id);
    expect((await run([tenant.id])).counts.held).toBe(1);
    await setUsers(8);
    await markSeatSyncDue(tenant.id);
    expect((await run([tenant.id])).counts['in-sync']).toBe(1);
    expect(updatesOf(sub)).toEqual([]);
    expect(quantityOf(sub)).toBe(8);
  });

  it('S4: a removal comes down in the renewal window (12 h before: D to 7, none); with 4 minutes left: no call', async () => {
    await setUsers(7);
    const soon = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 12 * HOUR) });
    await markSeatSyncDue(soon.tenant.id);
    await run([soon.tenant.id]);
    expect(updatesOf(soon.sub)).toEqual([{ quantity: 7, proration: 'none' }]);

    const late = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 4 * MIN) });
    await markSeatSyncDue(late.tenant.id);
    expect((await run([late.tenant.id])).counts.held).toBe(1);
    expect(updatesOf(late.sub)).toEqual([]);
  });

  it('S5: 3 → 4 users on annual → one call A with none, never always_invoice (no $0 invoice in the flat tier)', async () => {
    await setUsers(4);
    const { tenant, sub } = await subscriber({ quantity: 3, interval: 'year' });
    await markSeatSyncDue(tenant.id);
    await run([tenant.id]);
    expect(updatesOf(sub)).toEqual([{ quantity: 4, proration: 'none' }]);
  });

  it('S6: a bulk import of 30 users: from 8 → exactly one update (B, 38); from 2 → A to 5 none, then B to 32', async () => {
    await setUsers(38);
    const a = await subscriber({ quantity: 8 });
    await markSeatSyncDue(a.tenant.id); // the import marks once, after its commit
    await run([a.tenant.id]);
    expect(updatesOf(a.sub)).toEqual([{ quantity: 38, proration: 'create_prorations' }]);

    await setUsers(32);
    const b = await subscriber({ quantity: 2, interval: 'year' });
    await markSeatSyncDue(b.tenant.id);
    await run([b.tenant.id]);
    expect(updatesOf(b.sub)).toEqual([{ quantity: 5, proration: 'none' }, { quantity: 32, proration: 'always_invoice' }]);
  });

  it('S7: a change marked during a run (blocked between the read and the update) → still due after it; the next run serves it', async () => {
    await setUsers(9);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    await markSeatSyncDue(tenant.id);
    const gate = deferred();
    stripeState.blockers.set('subscriptions.update', gate.promise);
    const first = run([tenant.id]);
    await until(() => stripeState.calls.includes('subscriptions.update'));
    await setUsers(10);
    await markSeatSyncDue(tenant.id); // mark_seq moves while the run holds its read
    gate.resolve();
    await first;
    expect((await seatRow(tenant.id)).syncDueAt).not.toBeNull();
    await run([tenant.id]);
    expect((await seatRow(tenant.id)).syncDueAt).toBeNull();
    expect(quantityOf(sub)).toBe(10);
  });

  it('S8: Stripe applies 8→10 but the response is lost → failed, still due; next run in-sync with no call and "changed outside the sync"; then −2/+2 → no prorated call', async () => {
    await setUsers(8);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    expect((await sync(tenant.id)).outcome).toBe('in-sync'); // records stored = 8
    await setUsers(10);
    await markSeatSyncDue(tenant.id);
    stripeState.failAfterApply.add('subscriptions.update');
    expect((await sync(tenant.id)).outcome).toBe('failed');
    expect(quantityOf(sub)).toBe(10);
    const after = await seatRow(tenant.id);
    expect(after.syncDueAt).not.toBeNull();
    expect(after.failures).toBe(1);

    stripeState.updates = [];
    expect((await sync(tenant.id)).outcome).toBe('in-sync');
    expect(updatesOf(sub)).toEqual([]);
    expect((await corrections(tenant.id)).map((e) => e.detail)).toEqual(['8→10 (billable 10, changed outside the sync)']);

    await setUsers(8);
    expect((await sync(tenant.id)).outcome).toBe('held');
    await setUsers(10);
    expect((await sync(tenant.id)).outcome).toBe('in-sync');
    expect(updatesOf(sub)).toEqual([]);
  });

  it('S9: Stripe renews between the read and call D → a restore call to the billed quantity, the term-race alert and audit', async () => {
    await setUsers(6);
    const { tenant, sub } = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 12 * HOUR) });
    stripeState.renewOnNextUpdate = true;
    expect((await sync(tenant.id)).outcome).toBe('term-race');
    expect(updatesOf(sub)).toEqual([{ quantity: 6, proration: 'none' }, { quantity: 8, proration: 'none' }]);
    expect(String(stripeState.updates[1].options?.idempotencyKey)).toMatch(new RegExp(`^restore:${sub}:\\d+:`));
    expect(quantityOf(sub)).toBe(8);
    const alert = (await openAlertsOf(tenant.id)).find((a) => a.kind === 'seat-sync-term-race')!;
    expect(alert.detail).toMatchObject({ from: 8, to: 6, restored: true });
    expect((await auditOf(tenant.id)).map((e) => e.kind)).toContain('seat-sync-term-race');
    expect((await seatRow(tenant.id)).stripeQuantity).toBe(8);
  });

  it('S36: a term race whose restore fails → the alert detail says so', async () => {
    await setUsers(6);
    const { tenant } = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 12 * HOUR) });
    stripeState.renewOnNextUpdate = true;
    let n = 0;
    stripeState.hooks.set('subscriptions.update', () => {
      if (++n === 2) stripeState.failures.set('subscriptions.update', Object.assign(new Error('lock'), { type: 'StripeRateLimitError', code: 'lock_timeout' }));
    });
    expect((await sync(tenant.id)).outcome).toBe('term-race');
    const alert = (await openAlertsOf(tenant.id)).find((a) => a.kind === 'seat-sync-term-race')!;
    expect(alert.detail).toMatchObject({ restored: false });
    expect(String((alert.detail as { restoreError: string }).restoreError)).toContain('lock_timeout');
    expect((await auditOf(tenant.id)).find((e) => e.kind === 'seat-sync-term-race')!.detail).toMatch(/restore=failed/);
  });

  it('S17: the daily check: Stripe edited to 3 with 7 active (stored 7) → corrected to 7; audit "changed outside the sync"; the digest line', async () => {
    await setUsers(7);
    const { tenant, sub } = await subscriber({ quantity: 7 });
    await sync(tenant.id);
    stripeState.setSub(sub, { quantity: 3 });
    await controlDb.update(tenantSeatBilling).set({ checkedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(tenantSeatBilling.tenantId, tenant.id));
    const summary = await run([tenant.id]);
    expect(summary.counts.corrected).toBe(1);
    expect(summary.slugs.corrected).toEqual([tenant.slug]);
    expect(quantityOf(sub)).toBe(7);
    const details = (await corrections(tenant.id)).map((e) => e.detail);
    expect(details).toContain('7→3 (billable 7, changed outside the sync)');
    expect(details).toContain('3→7 (billable 7, daily)');
    await sendOpsDigest([], new Date(), false);
    const digest = resendState.calls.find((c) => c.subject.startsWith('CadenzPoint ops digest'))!;
    expect(digest.html).toContain('Seat quantities corrected (last 24 h)');
    expect(digest.html).toContain(`${tenant.slug} — 7→3 (billable 7, changed outside the sync)`);
  });

  it('S19: two concurrent syncs, the first held more than 5 s → the second is busy; one update in total', async () => {
    await setUsers(9);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    const gate = deferred();
    stripeState.blockers.set('subscriptions.retrieve', gate.promise);
    const first = sync(tenant.id);
    await until(() => stripeState.calls.includes('subscriptions.retrieve'));
    const second = await sync(tenant.id); // waits for the seats: lock, gives up after 5 s
    gate.resolve();
    expect(second.outcome).toBe('busy');
    expect((await first).outcome).toBe('updated');
    expect(updatesOf(sub)).toHaveLength(1);
  }, 20_000);

  it('S21: 3 consecutive failures → seat-sync-failing, backoff 10, 20, 40 min; success resolves it; inside the window: ≤ 10 min and an emailed alert', async () => {
    await setUsers(8);
    const { tenant } = await subscriber({ quantity: 8 });
    stripeState.failures.set('subscriptions.retrieve', Object.assign(new Error('down'), { type: 'StripeAPIError' }));
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      expect((await sync(tenant.id, 'due', now)).outcome).toBe('failed');
      gaps.push(Math.round(((await seatRow(tenant.id)).nextAttemptAt!.getTime() - now.getTime()) / MIN));
    }
    expect(gaps).toEqual([10, 20, 40]);
    expect(await openKinds(tenant.id)).toContain('seat-sync-failing');
    expect(await openKinds(tenant.id)).not.toContain('seat-sync-renewal-at-risk');
    stripeState.failures.clear();
    expect((await sync(tenant.id)).outcome).toBe('in-sync');
    expect(await openKinds(tenant.id)).not.toContain('seat-sync-failing');
    expect((await seatRow(tenant.id)).failures).toBe(0);

    const w = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 12 * HOUR) });
    stripeState.failures.set('subscriptions.update', Object.assign(new Error('down'), { type: 'StripeAPIError' }));
    await setUsers(9);
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      expect((await sync(w.tenant.id, 'due', now)).outcome).toBe('failed');
      expect(Math.round(((await seatRow(w.tenant.id)).nextAttemptAt!.getTime() - now.getTime()) / MIN)).toBe(10);
    }
    expect(await openKinds(w.tenant.id)).toContain('seat-sync-renewal-at-risk');
    expect(resendState.calls.filter((c) => c.subject.includes('seat-sync-renewal-at-risk'))).toHaveLength(1);
  });

  it('S34: inside the window the renewal-at-risk alert opens with an email even when seat-sync-failing is already open; a tenant-DB failure backs off ≤ 10 min (window from the mirror)', async () => {
    await setUsers(8);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    stripeState.failures.set('subscriptions.retrieve', Object.assign(new Error('down'), { type: 'StripeAPIError' }));
    for (let i = 0; i < 3; i++) await sync(tenant.id);
    expect(await openKinds(tenant.id)).toContain('seat-sync-failing');
    const end = new Date(Date.now() + 10 * HOUR);
    stripeState.setSub(sub, { current_period_end: Math.floor(end.getTime() / 1000) });
    await setTenant(tenant.id, { currentPeriodEnd: end });
    const now = new Date();
    await sync(tenant.id, 'due', now); // step 3 fails: the window comes from the mirror
    expect(await openKinds(tenant.id)).toContain('seat-sync-renewal-at-risk');
    expect(resendState.calls.some((c) => c.subject.includes('seat-sync-renewal-at-risk'))).toBe(true);
    expect(Math.round(((await seatRow(tenant.id)).nextAttemptAt!.getTime() - now.getTime()) / MIN)).toBe(10);

    stripeState.failures.clear();
    const down = await subscriber({ quantity: 8, periodEnd: end, tenant: { dbUrlEncrypted: encrypt('postgresql://bytime:bytime_dev@localhost:5432/no_such_database_seat_sync') } });
    for (let i = 0; i < 4; i++) {
      const at = new Date();
      expect((await sync(down.tenant.id, 'due', at)).outcome).toBe('failed');
      expect(Math.round(((await seatRow(down.tenant.id)).nextAttemptAt!.getTime() - at.getTime()) / MIN)).toBe(10);
    }
    expect(stripeState.updates).toEqual([]); // never a guessed count
  });

  it('S22: 10 failing due rows plus 1 healthy due row (failures 0) → the healthy row is served first', async () => {
    await setUsers(8);
    const failing = [];
    for (let i = 0; i < 10; i++) failing.push((await subscriber({ quantity: 8 })).tenant);
    const healthy = (await subscriber({ quantity: 8 })).tenant;
    const old = new Date(Date.now() - 2 * HOUR);
    for (const t of failing) {
      await controlDb.insert(tenantSeatBilling).values({ tenantId: t.id, syncDueAt: old, markSeq: 1, failures: 3, nextAttemptAt: new Date(Date.now() - MIN) });
    }
    await controlDb.insert(tenantSeatBilling).values({ tenantId: healthy.id, syncDueAt: new Date(), markSeq: 1, failures: 0 });
    const summary = await run([...failing.map((t) => t.id), healthy.id], { budgetMs: 0 });
    expect(summary.processed).toBe(1);
    expect((await seatRow(healthy.id)).syncDueAt).toBeNull();
    for (const t of failing) expect((await seatRow(t.id)).syncDueAt).not.toBeNull();
  });

  it('S25: a run stopped by the budget → cron-incomplete:seat-sync (digest only); a complete run resolves it', async () => {
    await setUsers(8);
    const a = await subscriber({ quantity: 8 });
    const b = await subscriber({ quantity: 8 });
    const stopped = await run([a.tenant.id, b.tenant.id], { budgetMs: 0 });
    expect(stopped.incomplete).toBe(true);
    const open = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), eq(opsAlerts.kind, 'cron-incomplete'), eq(opsAlerts.dedupKey, 'seat-sync')));
    expect(open.filter((x) => x.resolvedAt === null)).toHaveLength(1);
    expect(resendState.calls.filter((c) => c.subject.includes('cron-incomplete'))).toEqual([]); // raiseAlert: digest only
    const complete = await run([a.tenant.id, b.tenant.id]);
    expect(complete.incomplete).toBe(false);
    const after = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), eq(opsAlerts.kind, 'cron-incomplete'), eq(opsAlerts.dedupKey, 'seat-sync')));
    expect(after.filter((x) => x.resolvedAt === null)).toEqual([]);
  });

  it('S27: tenant:admin seat-sync without --yes (dry run) → no Stripe write and no row write; with --yes → applied and audited', async () => {
    await setUsers(9);
    const { tenant, sub } = await subscriber({ quantity: 8 });
    const dry = await seatSyncCommand(tenant.id, { mode: 'test', dryRun: true, actor: 'founder:test' });
    expect(dry).toMatchObject({ outcome: 'dry-run', decision: 'updated', planned: [{ label: 'B', quantity: 9, proration: 'create_prorations' }] });
    expect(updatesOf(sub)).toEqual([]);
    expect(await seatRow(tenant.id)).toBeUndefined();
    expect(await auditOf(tenant.id)).toEqual([]);
    expect(await allAlertsOf(tenant.id)).toEqual([]);
    const applied = await seatSyncCommand(tenant.id, { mode: 'test', dryRun: false, actor: 'founder:test' });
    expect(applied.outcome).toBe('updated');
    expect(quantityOf(sub)).toBe(9);
    expect((await auditOf(tenant.id)).find((e) => e.kind === 'seat-sync-manual')!.detail).toContain('livemode=false');
  });

  it('S28: a renewal candidate with no user change (Stripe 10 held, count 8, period end 6 h away) → picked by the next run, D to 8', async () => {
    await setUsers(8);
    const { tenant, sub } = await subscriber({ quantity: 10, periodEnd: new Date(Date.now() + 6 * HOUR) });
    await controlDb.insert(tenantSeatBilling).values({ tenantId: tenant.id, checkedAt: new Date(Date.now() - 20 * HOUR), stripeQuantity: 10, stripeSubscriptionId: sub });
    const summary = await run([tenant.id]);
    expect(summary.counts.lowered).toBe(1);
    expect(updatesOf(sub)).toEqual([{ quantity: 8, proration: 'none' }]);
  });

  it('S30 / S41: a schedule whose next phase differs from the count → seat-sync-schedule-attached (emailed in the window), the sync continues; matching → none; removed → resolved', async () => {
    await setUsers(9);
    const nowS = Math.floor(Date.now() / 1000);
    stripeState.schedules.set('sub_sched_1', {
      id: 'sub_sched_1', end_behavior: 'release', current_phase: { start_date: nowS - 86400, end_date: nowS + 12 * 3600 },
      phases: [
        { start_date: nowS - 86400, end_date: nowS + 12 * 3600, items: [{ price: env.month, quantity: 8 }] },
        { start_date: nowS + 12 * 3600, end_date: nowS + 30 * 86400, items: [{ price: env.year, quantity: 8 }] },
      ],
    });
    const { tenant, sub } = await subscriber({ quantity: 8, periodEnd: new Date(Date.now() + 12 * HOUR), schedule: 'sub_sched_1' });
    expect((await sync(tenant.id)).outcome).toBe('updated'); // the sync continues
    expect(quantityOf(sub)).toBe(9);
    expect(await openKinds(tenant.id)).toContain('seat-sync-schedule-attached');
    expect(resendState.calls.some((c) => c.subject.includes('seat-sync-schedule-attached'))).toBe(true);

    stripeState.schedules.get('sub_sched_1')!.phases[1].items[0].quantity = 9; // the next phase now matches
    await sync(tenant.id);
    expect(await openKinds(tenant.id)).not.toContain('seat-sync-schedule-attached');

    stripeState.schedules.get('sub_sched_1')!.phases[1].items[0].quantity = 4;
    await sync(tenant.id);
    expect(await openKinds(tenant.id)).toContain('seat-sync-schedule-attached');
    stripeState.setSub(sub, { schedule: null }); // released
    await sync(tenant.id);
    expect(await openKinds(tenant.id)).not.toContain('seat-sync-schedule-attached');
  });

  it('S31: two items → not-standard + seat-sync-unexpected-items; a missing subscription → seat-sync-subscription-missing; trialing → not-applicable, no drift', async () => {
    await setUsers(9);
    const two = await subscriber({ quantity: 8, extraItems: [{ id: 'si_extra', priceId: 'price_addon', quantity: 1 }] });
    expect((await sync(two.tenant.id)).outcome).toBe('not-standard');
    expect(await openKinds(two.tenant.id)).toContain('seat-sync-unexpected-items');
    expect(updatesOf(two.sub)).toEqual([]);

    const gone = await subscriber({ quantity: 8 });
    stripeState.subs.delete(gone.sub);
    expect((await sync(gone.tenant.id)).outcome).toBe('not-applicable');
    expect(await openKinds(gone.tenant.id)).toContain('seat-sync-subscription-missing');

    const trial = await subscriber({ quantity: 8, status: 'trialing' });
    expect((await sync(trial.tenant.id)).outcome).toBe('not-applicable');
    expect(await openKinds(trial.tenant.id)).not.toContain('subscription-status-drift');
    expect(updatesOf(trial.sub)).toEqual([]);
  });

  it('S32: a Standard price env emptied while an active subscription exists → stripe-prices-missing; restored → resolved', async () => {
    await subscriber({ quantity: 1 });
    const globalOpen = async () => (await controlDb.select().from(opsAlerts)
      .where(and(eq(opsAlerts.scope, 'global'), eq(opsAlerts.kind, 'stripe-prices-missing')))).filter((a) => a.resolvedAt === null);
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = '';
    await run([]);
    expect(await globalOpen()).toHaveLength(1);
    process.env.STRIPE_PRICE_STANDARD_ANNUAL = env.year;
    await run([]);
    expect(await globalOpen()).toEqual([]);
  });

  it('S43: no alert is written inside the seat section; a throwing post-commit alert write leaves the outcome unchanged', async () => {
    await setUsers(9);
    const { tenant } = await subscriber({ quantity: 8, status: 'past_due' });
    await setTenant(tenant.id, { subscriptionStatus: 'active' }); // mirror GOOD, Stripe not: drift is raised
    expect((await sync(tenant.id)).outcome).toBe('not-applicable');
    expect(await openKinds(tenant.id)).toContain('subscription-status-drift');
    expect(probe.alertsInSection).toEqual([]);

    const ok = await subscriber({ quantity: 8, status: 'past_due' });
    await setTenant(ok.tenant.id, { subscriptionStatus: 'active' });
    probe.throwNextRaise = true; // the post-commit drift alert write throws
    expect((await sync(ok.tenant.id)).outcome).toBe('not-applicable'); // not `failed`
    expect((await seatRow(ok.tenant.id)).failures).toBe(0);
    expect(probe.alertsInSection).toEqual([]);
  });

  it('a deleted / not-active tenant: the due mark gets not-applicable and clears; ended tenants are never daily candidates (S23 sync half, S45)', async () => {
    await setUsers(9);
    const deleting = await subscriber({ quantity: 8, tenant: { status: 'deleting' } });
    await markSeatSyncDue(deleting.tenant.id);
    expect((await run([deleting.tenant.id])).counts['not-applicable']).toBe(1);
    expect((await seatRow(deleting.tenant.id)).syncDueAt).toBeNull();
    expect(updatesOf(deleting.sub)).toEqual([]);

    const ended = await subscriber({ quantity: 8, tenant: { subscriptionEndedAt: daysFrom(new Date(), -3), deletionScheduledFor: daysFrom(new Date(), 87) } });
    expect((await sync(ended.tenant.id)).outcome).toBe('not-applicable');
    expect((await run([ended.tenant.id])).candidates).toBe(0);
    expect(updatesOf(ended.sub)).toEqual([]);
  });
});
