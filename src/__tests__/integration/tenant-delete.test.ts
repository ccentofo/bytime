import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);

import { controlDb } from '@/db/control-plane';
import { encrypt } from '@/lib/encryption';
import { deleteTenant, type DeleteTenantOptions } from '@/lib/tenant/delete-tenant';
import { getTenantAccess } from '@/lib/tenant/lifecycle';
import { toLifecycleFacts } from '@/lib/tenant/registry';
import { recordAudit } from '@/lib/tenant/lifecycle-store';
import { stripeState } from './fakes/fake-stripe';
import {
  cpReady, auditOf, cleanupLifecycleTenants, daysFrom, getTenantRow, insertNotice, makeTenant, observationsOf, openAlertsOf,
  type TenantRow,
} from './lifecycle-helpers';

/**
 * feature-plan-terms-compliance-fixes.md §5.3 / §7 "Deletion": `deleteTenant` against THROWAWAY local databases
 * this suite creates itself (`cadenzpoint_deltest_*`). It runs only when the control plane is on localhost — it
 * never points at a demo workspace or a remote database.
 */

const CP_URL = process.env.CONTROL_PLANE_DATABASE_URL ?? '';
// deleteTenant drops local databases through this admin connection, so throwaway DBs live on that same server.
const ADMIN_URL = process.env.DEV_TENANT_ADMIN_DATABASE_URL ?? CP_URL;
const loopback = (u: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u || 'postgresql://x@remote/x').hostname);
const isLocal = cpReady && loopback(CP_URL) && loopback(ADMIN_URL);
const created: string[] = [];

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function throwawayDb(): Promise<{ name: string; url: string }> {
  const name = `cadenzpoint_deltest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await admin((sql) => sql.unsafe(`CREATE DATABASE ${name}`));
  created.push(name);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return { name, url: u.toString() };
}

const dbExists = (name: string) => admin(async (sql) => (await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`).length > 0);
const run = (slug: string, o: Partial<DeleteTenantOptions> = {}) => deleteTenant({ slug, apply: true, actor: 'test', log: () => {}, ...o });

describe.skipIf(!isLocal)('deleteTenant (§5.3) — throwaway local databases only', () => {
  const NOW = new Date();
  let db: { name: string; url: string };

  /** A lapsed trial: D past, deletion notice for the current anchor sent 20 days before D. */
  async function eligibleTenant(o: Parameters<typeof makeTenant>[0] = {}): Promise<TenantRow> {
    db = await throwawayDb();
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(db.url), ...o });
    const row = await getTenantRow(t.id);
    const anchor = row.subscriptionEndedAt ?? row.trialEndsAt!;
    await insertNotice(t.id, 'deletion-notice', anchor, { sentAt: daysFrom(row.deletionScheduledFor!, -20), providerMessageId: 'msg_dn' });
    return row;
  }

  beforeEach(async () => {
    stripeState.reset();
    await cleanupLifecycleTenants();
  });
  afterEach(async () => {
    await cleanupLifecycleTenants();
  });
  afterAll(async () => {
    for (const name of created) await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('dry run reports the classification and changes nothing', async () => {
    const t = await eligibleTenant();
    const r = await deleteTenant({ slug: t.slug, apply: false, actor: 'test', log: () => {} });
    expect(r.outcome).toBe('dry-run');
    if (r.outcome === 'dry-run') {
      expect(r.database.kind).toBe('local');
      expect(r.problems).toEqual([]);
    }
    expect(await dbExists(db.name)).toBe(true);
    expect((await getTenantRow(t.id)).status).toBe('active');
  });

  it('deletes an eligible workspace: database dropped (even with an open connection), tombstoned, audited; re-run is a no-op', async () => {
    const t = await eligibleTenant();
    const holder = postgres(db.url, { max: 1 });
    await holder`SELECT 1`; // an open pooled connection — DROP … WITH (FORCE) must still succeed
    try {
      const r = await run(t.slug);
      expect(r.outcome).toBe('deleted');
    } finally {
      await holder.end({ timeout: 1 }).catch(() => {});
    }
    expect(await dbExists(db.name)).toBe(false);
    const row = await getTenantRow(t.id);
    expect(row.status).toBe('deleted');
    expect(row.deletedAt).not.toBeNull();
    expect(row.dbUrlEncrypted).toBeNull();
    expect((await auditOf(t.id)).map((e) => e.kind)).toEqual(expect.arrayContaining(['deletion-started', 'deleted']));
    const again = await run(t.slug);
    expect(again.outcome).toBe('already-deleted');
  });

  it.each([
    ['the deletion date is in the future', async () => eligibleTenant({ deletionScheduledFor: daysFrom(NOW, 5) })],
    ['no deletion notice was given', async () => {
      db = await throwawayDb();
      return makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(db.url) });
    }],
    ['the only notice is for an OLD anchor', async () => {
      db = await throwawayDb();
      const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(db.url) });
      await insertNotice(t.id, 'deletion-notice', daysFrom(NOW, -400), { sentAt: daysFrom(NOW, -30), providerMessageId: 'msg_old' });
      return t;
    }],
    ['the notice came less than 14 days before D', async () => {
      db = await throwawayDb();
      const t = await makeTenant({ trialEndsAt: daysFrom(NOW, -120), deletionScheduledFor: daysFrom(NOW, -1), dbUrlEncrypted: encrypt(db.url) });
      const row = await getTenantRow(t.id);
      await insertNotice(t.id, 'deletion-notice', row.trialEndsAt!, { sentAt: daysFrom(NOW, -5), providerMessageId: 'msg_late' });
      return t;
    }],
    ['the workspace is lifecycle-exempt (demo)', async () => eligibleTenant({ lifecycleExempt: true })],
  ])('refuses when %s — nothing changes', async (_label, setup) => {
    const t = await setup();
    const r = await run(t.slug);
    expect(r.outcome).toBe('refused');
    expect(await dbExists(db.name)).toBe(true);
    expect((await getTenantRow(t.id)).status).toBe('active');
  });

  it('--force-with-reason bypasses the date/notice checks (audited) but not the exempt check', async () => {
    db = await throwawayDb();
    const t = await makeTenant({ trialEndsAt: daysFrom(NOW, 10), dbUrlEncrypted: encrypt(db.url) });
    const r = await run(t.slug, { forceWithReason: 'customer written request' });
    expect(r.outcome).toBe('deleted');
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('forced-deletion');
    const ex = await eligibleTenant({ lifecycleExempt: true });
    expect((await run(ex.slug, { forceWithReason: 'x' })).outcome).toBe('refused');
  });

  it('cancels a past-due subscription and voids open invoices, then deletes', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const inv = stripeState.addInvoice(customer, sub, { piStatus: 'requires_payment_method' });
    const E = daysFrom(NOW, -100);
    const t = await eligibleTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'canceled', firstGoodAt: daysFrom(NOW, -300), subscriptionEndedAt: E });
    const r = await run(t.slug);
    expect(r.outcome).toBe('deleted');
    expect(stripeState.subs.get(sub)!.status).toBe('canceled');
    expect(stripeState.invoices.get(inv)!.status).toBe('void');
    expect(await dbExists(db.name)).toBe(false);
  });

  it('a lost webhook: Stripe shows an ACTIVE subscription → reconciled (D cleared, full) and aborted', async () => {
    const customer = stripeState.addCustomer();
    stripeState.addSub(customer, 'active');
    const t = await eligibleTenant({ stripeCustomerId: customer });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    const row = await getTenantRow(t.id);
    expect(row.status).toBe('active');
    expect(row.deletionScheduledFor).toBeNull();
    expect(getTenantAccess(toLifecycleFacts(row), new Date())).toBe('full');
    expect(await dbExists(db.name)).toBe(true);
  });

  it.each([
    ['an incomplete subscription', (c: string) => { stripeState.addSub(c, 'incomplete'); }],
    ['an ACH payment processing', (c: string) => { stripeState.addInvoice(c, null, { piStatus: 'processing' }); }],
    ['microdeposits pending with no observation row yet', (c: string) => { stripeState.addInvoice(c, null, { piStatus: 'requires_action', piNextAction: 'verify_with_microdeposits' }); }],
  ])('aborts on payment activity: %s', async (_label, arrange) => {
    const customer = stripeState.addCustomer();
    arrange(customer);
    const t = await eligibleTenant({ stripeCustomerId: customer });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    expect(await dbExists(db.name)).toBe(true);
    expect((await getTenantRow(t.id)).status).toBe('active');
  });

  it('a RESUMED deletion that finds a GOOD subscription restores the status, audits and alerts (full immediately)', async () => {
    const customer = stripeState.addCustomer();
    stripeState.addSub(customer, 'active');
    const t = await eligibleTenant({ stripeCustomerId: customer, status: 'deleting' });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    const row = await getTenantRow(t.id);
    expect(row.status).toBe('active');
    expect(getTenantAccess(toLifecycleFacts(row), new Date())).toBe('full');
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('deletion-aborted');
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).toContain('deletion-aborted');
  });

  it('a resumed abort restores a POLICY-suspended workspace to suspended', async () => {
    const customer = stripeState.addCustomer();
    stripeState.addSub(customer, 'incomplete');
    const t = await eligibleTenant({ stripeCustomerId: customer, status: 'deleting', suspensionReason: 'policy', suspendedAt: daysFrom(NOW, -200) });
    expect((await run(t.slug)).outcome).toBe('aborted');
    expect((await getTenantRow(t.id)).status).toBe('suspended');
  });

  it('payment activity appearing at step 4 (after deleting was set) restores and commits', async () => {
    const customer = stripeState.addCustomer();
    const t = await eligibleTenant({ stripeCustomerId: customer });
    // Step 3 sees nothing; by the time step 4 lists subscriptions, a checkout has completed.
    let lists = 0;
    stripeState.hooks.set('subscriptions.list', () => { if (++lists === 2) stripeState.addSub(customer, 'active'); });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    const row = await getTenantRow(t.id);
    expect(row.status).toBe('active');
    expect(row.deletionScheduledFor).toBeNull(); // transition table re-applied in the restore
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('deletion-aborted');
    expect(await dbExists(db.name)).toBe(true);
  });

  it('payment activity at the step-5 preflight (just before the destructive call) restores and keeps the database', async () => {
    const customer = stripeState.addCustomer();
    const t = await eligibleTenant({ stripeCustomerId: customer });
    let lists = 0; // step 3 reconcile = 1, step 4 = 2, step 5 preflight = 3
    stripeState.hooks.set('subscriptions.list', () => { if (++lists === 3) stripeState.addSub(customer, 'incomplete'); });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    expect(await dbExists(db.name)).toBe(true);
    expect((await getTenantRow(t.id)).status).toBe('active');
    expect((await auditOf(t.id)).map((e) => e.kind)).toContain('deletion-aborted');
  });

  it('an ACH payment processing on a NON-latest open invoice (page 2) blocks deletion', async () => {
    const customer = stripeState.addCustomer();
    stripeState.addInvoice(customer, null, { id: 'in_a_old', piStatus: 'processing' });
    stripeState.addInvoice(customer, null, { id: 'in_b_new', piStatus: 'requires_payment_method' });
    stripeState.pageSize = 1;
    const t = await eligibleTenant({ stripeCustomerId: customer });
    expect((await run(t.slug)).outcome).toBe('aborted');
    expect(await dbExists(db.name)).toBe(true);
  });

  it('a GOOD duplicate next to a past-due tracked subscription blocks deletion (and clears D)', async () => {
    const customer = stripeState.addCustomer();
    const dunning = stripeState.addSub(customer, 'past_due');
    stripeState.addSub(customer, 'active', { created: new Date() });
    const t = await eligibleTenant({ stripeCustomerId: customer, stripeSubscriptionId: dunning, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -300), subscriptionEndedAt: daysFrom(NOW, -100) });
    expect((await run(t.slug)).outcome).toBe('aborted');
    const row = await getTenantRow(t.id);
    expect(row.subscriptionEndedAt).toBeNull();
    expect(row.deletionScheduledFor).toBeNull();
    expect(stripeState.subs.get(dunning)!.status).toBe('past_due'); // nothing cancelled
  });

  it('an invoice that stays open after a "successful" void trips the pending-invoice-void gate (restore, no drop)', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const inv = stripeState.addInvoice(customer, sub, { piStatus: 'requires_payment_method' });
    stripeState.stuckOpen.add(inv);
    const t = await eligibleTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -300), subscriptionEndedAt: daysFrom(NOW, -100) });
    const r = await run(t.slug);
    expect(r.outcome).toBe('aborted');
    expect(r.outcome === 'aborted' && r.reason).toMatch(/pending/);
    expect(await dbExists(db.name)).toBe(true);
    expect((await getTenantRow(t.id)).status).toBe('active');
  });

  it('a Stripe failure in step 4 leaves "deleting" (blocked); the re-run resumes and completes', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    const t = await eligibleTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -300), subscriptionEndedAt: daysFrom(NOW, -100) });
    stripeState.failures.set('subscriptions.cancel', new Error('stripe down'));
    const first = await run(t.slug);
    expect(first.outcome).toBe('stopped');
    expect((await getTenantRow(t.id)).status).toBe('deleting');
    expect(await dbExists(db.name)).toBe(true);
    stripeState.failures.delete('subscriptions.cancel');
    const second = await run(t.slug);
    expect(second.outcome).toBe('deleted');
    expect(await dbExists(db.name)).toBe(false);
  });

  it('an invoice that cannot be voided blocks the database step (pending-invoice-void), then resumes', async () => {
    const customer = stripeState.addCustomer();
    const sub = stripeState.addSub(customer, 'past_due');
    stripeState.addInvoice(customer, sub, { piStatus: 'requires_payment_method' });
    const t = await eligibleTenant({ stripeCustomerId: customer, stripeSubscriptionId: sub, subscriptionStatus: 'past_due', firstGoodAt: daysFrom(NOW, -300), subscriptionEndedAt: daysFrom(NOW, -100) });
    stripeState.failures.set('invoices.voidInvoice', new Error('cannot void'));
    stripeState.failures.set('invoices.markUncollectible', new Error('cannot mark'));
    expect((await run(t.slug)).outcome).toBe('stopped');
    expect(await dbExists(db.name)).toBe(true);
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).toContain('pending-invoice-void');
    stripeState.failures.clear();
    expect((await run(t.slug)).outcome).toBe('deleted');
  });

  it('a deleted Stripe customer (lists → resource_missing) reconciles as empty and deletes', async () => {
    const customer = stripeState.addCustomer();
    stripeState.customers.get(customer)!.deleted = true;
    const t = await eligibleTenant({ stripeCustomerId: customer });
    expect((await run(t.slug)).outcome).toBe('deleted');
  });

  it('the receipt tightens a founder export destroy-by date to deletion + 30 days', async () => {
    const t = await eligibleTenant();
    await recordAudit(controlDb, { tenantId: t.id, kind: 'founder-export-taken', actor: 'test', detail: JSON.stringify({ path: '/x', destroyBy: daysFrom(NOW, 60).toISOString() }) });
    const r = await run(t.slug);
    expect(r.outcome).toBe('deleted');
    if (r.outcome === 'deleted') {
      expect(r.receipt.founderExportDestroyBy!.getTime()).toBe(daysFrom(r.receipt.deletedAt!, 30).getTime());
    }
  });

  it('observations from an aborted attempt are removed at the tombstone', async () => {
    const customer = stripeState.addCustomer();
    const inv = stripeState.addInvoice(customer, null, { piStatus: 'processing' });
    const t = await eligibleTenant({ stripeCustomerId: customer });
    expect((await run(t.slug)).outcome).toBe('aborted');
    expect((await observationsOf(t.id)).length).toBeGreaterThan(0);
    stripeState.invoices.get(inv)!.status = 'paid';
    expect((await run(t.slug)).outcome).toBe('deleted');
    expect(await observationsOf(t.id)).toHaveLength(0);
  });
});
