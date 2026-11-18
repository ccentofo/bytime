import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('@/lib/billing/stripe', async () => (await import('./fakes/fake-stripe')).stripeModule);
vi.mock('@/lib/email/client', async () => (await import('./fakes/fake-resend')).clientModule);
const seatDue: string[] = [];
vi.mock('@/lib/billing/seat-sync', async (orig) => ({
  ...(await orig<typeof import('@/lib/billing/seat-sync')>()),
  markSeatSyncDue: async (id: string) => { seatDue.push(id); },
}));

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { opsAlerts, signups } from '@/db/control-plane/schema';
import { AdminCommandError, checkStripeMode, stripeResyncCommand, windowSignupCommand } from '@/lib/tenant/admin-commands';
import { stripeState } from './fakes/fake-stripe';
import { resendState } from './fakes/fake-resend';
import { auditOf, cleanupLifecycleTenants, cpReady, getTenantRow, makeTenant, openAlertsOf } from './lifecycle-helpers';

/**
 * feature-plan-control-plane-disaster.md §11 T27 (`tenant:admin stripe-resync`) and T28b (`window-signup`): against the
 * local control plane's throwaway `test-lc-*` rows and the fake Stripe API. No notice is delivered, no workspace database
 * is read, and nothing prints an email address.
 */

const SINCE = new Date(Date.now() - 6 * 3600_000);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

describe.skipIf(!cpReady)('T27: stripe-resync', () => {
  beforeEach(async () => {
    stripeState.reset();
    resendState.reset();
    seatDue.length = 0;
    await cleanupLifecycleTenants();
  });
  afterAll(async () => { await cleanupLifecycleTenants(); });

  const session = (o: { slug: string; customer: string; created?: Date; status?: 'complete' | 'open' | 'expired' }) => {
    stripeState.sessions.push({ id: `cs_${randomUUID().slice(0, 8)}`, status: o.status ?? 'complete', created: unix(o.created ?? new Date(SINCE.getTime() + 3600_000)), customer: o.customer, metadata: { slug: o.slug } });
  };
  const customer = (id: string, o: { tenantId?: string; email?: string | null; deleted?: boolean } = {}) => {
    stripeState.customers.set(id, { deleted: Boolean(o.deleted), email: o.email ?? null, metadata: o.tenantId ? { tenantId: o.tenantId } : {} });
  };
  const run = (dryRun: boolean) => stripeResyncCommand({ since: SINCE, dryRun, actor: 'test' });

  it('a window checkout lost in the rollback: the dry run writes nothing; --yes re-links it through the webhook rule and mirrors its subscription in the same run; markSeatSyncDue', async () => {
    const t = await makeTenant({ trialEndsAt: new Date(Date.now() + 5 * 86400_000) });
    customer('cus_win', { tenantId: t.id, email: 'billing@win.test' });
    stripeState.addSub('cus_win', 'active', { id: 'sub_win' });
    session({ slug: t.slug, customer: 'cus_win' });
    const before = await getTenantRow(t.id);
    const dry = await run(true);
    expect(dry).toMatchObject({ links: [t.slug], refresh: [t.slug] });
    expect(dry.outcomes).toBeUndefined();
    expect(await getTenantRow(t.id)).toMatchObject({ stripeCustomerId: null, lifecycleVersion: before.lifecycleVersion });
    const yes = await run(false);
    expect(yes.outcomes).toMatchObject({ linked: [t.slug], conflict: [], failed: [] });
    const after = await getTenantRow(t.id);
    expect(after).toMatchObject({ stripeCustomerId: 'cus_win', stripeSubscriptionId: 'sub_win', subscriptionStatus: 'active', billingEmail: 'billing@win.test' });
    expect(seatDue).toContain(t.id);
    expect(stripeState.sessionListParams[0]).toMatchObject({ status: 'complete', created: { gte: unix(SINCE) - 3600 } });
    // Nothing printed names an email; no notice was delivered (crons deliver later).
    expect(JSON.stringify(yes)).not.toMatch(/@/);
    expect(resendState.calls).toEqual([]);
    // A second run converges: nothing to link, nothing changes.
    const again = await run(false);
    expect(again.links).toEqual([]);
    expect((await getTenantRow(t.id)).stripeCustomerId).toBe('cus_win');
  });

  it("a re-signup reusing the slug (the live customer's tenantId is another workspace's) is never linked", async () => {
    const t = await makeTenant({});
    customer('cus_other', { tenantId: randomUUID() });
    session({ slug: t.slug, customer: 'cus_other' });
    const r = await run(false);
    expect(r.links).toEqual([]);
    expect(r.notThisWorkspace).toEqual([t.slug]);
    expect((await getTenantRow(t.id)).stripeCustomerId).toBeNull();
  });

  it('a row whose current customer was deleted in Stripe is replaceable (audited); a live other customer → checkout-customer-conflict, never overwritten', async () => {
    const replaced = await makeTenant({ stripeCustomerId: 'cus_dead' });
    customer('cus_dead', { deleted: true });
    customer('cus_new', { tenantId: replaced.id });
    session({ slug: replaced.slug, customer: 'cus_new' });
    const conflict = await makeTenant({ stripeCustomerId: 'cus_live' });
    customer('cus_live', { tenantId: conflict.id });
    customer('cus_second', { tenantId: conflict.id });
    session({ slug: conflict.slug, customer: 'cus_second' });
    const r = await run(false);
    expect(r.outcomes).toMatchObject({ linked: [replaced.slug], conflict: [conflict.slug] });
    expect((await getTenantRow(replaced.id)).stripeCustomerId).toBe('cus_new');
    expect((await auditOf(replaced.id)).some((a) => a.kind === 'stripe-customer-replaced')).toBe(true);
    expect((await getTenantRow(conflict.id)).stripeCustomerId).toBe('cus_live');
    expect((await openAlertsOf(conflict.id)).map((a) => a.kind)).toContain('checkout-customer-conflict');
  });

  it('the shared link rule: a checkout customer another workspace already owns → conflict, never linked', async () => {
    const owner = await makeTenant({ stripeCustomerId: 'cus_owned' });
    customer('cus_owned', {});
    const t = await makeTenant({});
    stripeState.customers.set('cus_owned', { deleted: false, email: null, metadata: { tenantId: t.id } });
    session({ slug: t.slug, customer: 'cus_owned' });
    const r = await run(false);
    expect(r.outcomes).toMatchObject({ linked: [], conflict: [t.slug] });
    expect((await getTenantRow(t.id)).stripeCustomerId).toBeNull();
    expect((await getTenantRow(owner.id)).stripeCustomerId).toBe('cus_owned');
  });

  it('every paying workspace is refreshed: the live billing email (a null one never clears it); markSeatSyncDue when it becomes good', async () => {
    const changed = await makeTenant({ stripeCustomerId: 'cus_e1', billingEmail: 'old@x.test' });
    customer('cus_e1', { email: 'new@x.test' });
    const kept = await makeTenant({ stripeCustomerId: 'cus_e2', billingEmail: 'keep@x.test' });
    customer('cus_e2', { email: null });
    const good = await makeTenant({ stripeCustomerId: 'cus_g', stripeSubscriptionId: 'sub_g', subscriptionStatus: 'past_due', pastDueSince: new Date(Date.now() - 2 * 86400_000) });
    customer('cus_g', {});
    stripeState.addSub('cus_g', 'active', { id: 'sub_g' });
    const r = await run(false);
    expect(r.outcomes!.refreshed.sort()).toEqual([changed.slug, kept.slug, good.slug].sort());
    expect((await getTenantRow(changed.id)).billingEmail).toBe('new@x.test');
    expect((await getTenantRow(kept.id)).billingEmail).toBe('keep@x.test');
    expect((await getTenantRow(good.id)).subscriptionStatus).toBe('active');
    expect(seatDue).toEqual([good.id]);
  });

  it('FR1 (auditor B): a conflicting window checkout still refreshes the workspace against its CURRENT customer; the conflict alert is raised', async () => {
    const t = await makeTenant({ stripeCustomerId: 'cus_cur', stripeSubscriptionId: 'sub_cur', subscriptionStatus: 'past_due', pastDueSince: new Date(Date.now() - 3 * 86400_000), billingEmail: 'old@b.test' });
    customer('cus_cur', { tenantId: t.id, email: 'current@b.test' });
    stripeState.addSub('cus_cur', 'active', { id: 'sub_cur' });
    customer('cus_second', { tenantId: t.id, email: 'second@b.test' });
    session({ slug: t.slug, customer: 'cus_second' });
    const r = await run(false);
    expect(r.outcomes).toMatchObject({ linked: [], conflict: [t.slug], failed: [] });
    expect(r.outcomes!.refreshed).toContain(t.slug);
    const after = await getTenantRow(t.id);
    expect(after).toMatchObject({ stripeCustomerId: 'cus_cur', subscriptionStatus: 'active', pastDueSince: null, billingEmail: 'current@b.test' });
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).toContain('checkout-customer-conflict');
    expect(seatDue).toContain(t.id); // it became good
  });

  it('FR3: a failed read of the current customer → that workspace failed (exit 1), never a conflict', async () => {
    const t = await makeTenant({ stripeCustomerId: 'cus_unreadable' });
    customer('cus_unreadable', {});
    customer('cus_win3', { tenantId: t.id });
    session({ slug: t.slug, customer: 'cus_win3' });
    let n = 0;
    stripeState.hooks.set('customers.retrieve', () => { n++; if (n === 2) throw Object.assign(new Error('stripe 500'), { type: 'StripeAPIError' }); });
    const dry = await run(true);
    expect(dry.readFailed).toEqual([t.slug]);
    n = 0;
    const r = await run(false);
    expect(r.outcomes!.failed.map((f) => f.slug)).toContain(t.slug);
    expect(r.outcomes!.conflict).toEqual([]);
    expect((await openAlertsOf(t.id)).map((a) => a.kind)).not.toContain('checkout-customer-conflict');
  });

  it('M25: every page of sessions is read; M34: one link per workspace (the newest checkout), no self-conflict; M35: only active/suspended workspaces', async () => {
    stripeState.pageSize = 2;
    const ts = [await makeTenant({}), await makeTenant({}), await makeTenant({})];
    ts.forEach((t, i) => { customer(`cus_p${i}`, { tenantId: t.id }); session({ slug: t.slug, customer: `cus_p${i}`, created: new Date(SINCE.getTime() + (i + 1) * 60_000) }); });
    // Two checkouts for one workspace: the newer wins and the older never produces a conflict with it.
    const dup = await makeTenant({});
    customer('cus_new', { tenantId: dup.id });
    customer('cus_older', { tenantId: dup.id });
    session({ slug: dup.slug, customer: 'cus_older', created: new Date(SINCE.getTime() + 60_000) });
    session({ slug: dup.slug, customer: 'cus_new', created: new Date(SINCE.getTime() + 10 * 60_000) });
    // Not live: never linked.
    const closed = await makeTenant({ status: 'deleting' });
    customer('cus_closed', { tenantId: closed.id });
    session({ slug: closed.slug, customer: 'cus_closed' });
    // M35: a closed workspace is never planned (D12: active/suspended only), so it isn't in the plan the founder reads.
    const plan = await run(true);
    expect(plan.links).not.toContain(closed.slug);
    expect(plan.refresh).not.toContain(closed.slug);
    const r = await run(false);
    expect(r.outcomes!.linked.sort()).toEqual([...ts.map((t) => t.slug), dup.slug].sort());
    expect(r.outcomes!.conflict).toEqual([]);
    expect((await getTenantRow(dup.id)).stripeCustomerId).toBe('cus_new');
    expect((await getTenantRow(closed.id)).stripeCustomerId).toBeNull();
    expect(stripeState.sessionListParams.length).toBeGreaterThan(2);
  });

  it('M30: a relinked workspace whose live customer has no email keeps its stored billing email', async () => {
    const t = await makeTenant({ billingEmail: 'keep@relink.test' });
    customer('cus_noemail', { tenantId: t.id, email: null });
    session({ slug: t.slug, customer: 'cus_noemail' });
    const r = await run(false);
    expect(r.outcomes!.linked).toEqual([t.slug]);
    expect(await getTenantRow(t.id)).toMatchObject({ stripeCustomerId: 'cus_noemail', billingEmail: 'keep@relink.test' });
  });

  it('a Stripe failure → that workspace is listed failed (the CLI exits 1); a mode mismatch is refused', async () => {
    const t = await makeTenant({ stripeCustomerId: 'cus_f' });
    customer('cus_f', {});
    stripeState.failures.set('subscriptions.list', Object.assign(new Error('stripe down'), { type: 'StripeAPIError' }));
    const r = await run(false);
    expect(r.outcomes!.failed.map((f) => f.slug)).toEqual([t.slug]);
    expect(() => checkStripeMode('live', 'sk_test_abc')).toThrow(AdminCommandError);
    expect(() => checkStripeMode(undefined, 'sk_live_abc')).toThrow(/--stripe-mode live\|test/);
  });
});

describe.skipIf(!cpReady)('T28b: window-signup', () => {
  const slug = `test-lc-ws-${randomUUID().slice(0, 6)}`;
  const projectId = `prj-test-lc-ws-${randomUUID().slice(0, 6)}`;
  const T = new Date(Date.now() - 3 * 3600_000);
  const before = (h: number) => new Date(T.getTime() - h * 3600_000);
  afterAll(async () => {
    await controlDb.delete(signups).where(like(signups.slug, 'test-lc-ws-%'));
    await controlDb.delete(opsAlerts).where(eq(opsAlerts.dedupKey, projectId));
  });
  const signup = (o: { company: string; created: Date; expires: Date; consumed?: Date | null; waitlisted?: Date | null }) => controlDb.insert(signups).values({
    email: `${o.company.toLowerCase().replace(/\W/g, '')}@ws.test`, companyName: o.company, slug, verifyTokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32),
    createdAt: o.created, expiresAt: o.expires, consumedAt: o.consumed ?? null, waitlistedAt: o.waitlisted ?? null,
  });

  it('refused without an open window-project alert; then prints every eligible row (two → both), newest first; writes nothing', async () => {
    await expect(windowSignupCommand(slug)).rejects.toThrow(/not a window signup/);
    await controlDb.insert(opsAlerts).values({ scope: 'global', tenantId: null, kind: 'window-project', dedupKey: projectId, detail: { projectId, name: `cadenzpoint-${slug}`, createdAt: T.toISOString(), slug, type: 'signup' }, firstSeenAt: new Date(), lastSeenAt: new Date() });
    await signup({ company: 'First Co', created: before(5), expires: before(-20) });
    await signup({ company: 'Second Co', created: before(1), expires: before(-20) });
    await signup({ company: 'After Co', created: new Date(T.getTime() + 60_000), expires: before(-20) }); // created after the project
    await signup({ company: 'Consumed Co', created: before(2), expires: before(-20), consumed: before(1) });
    await signup({ company: 'Expired Co', created: before(30), expires: before(6) }); // expired before the project
    await signup({ company: 'Waitlisted Co', created: before(40), expires: before(30), waitlisted: before(35) });
    const count = async () => (await controlDb.select({ id: signups.id }).from(signups).where(eq(signups.slug, slug))).length;
    const n = await count();
    const r = await windowSignupCommand(slug);
    expect(r.projectId).toBe(projectId);
    // FR6: the alert's id, for resolve-alert.
    const [al] = await controlDb.select({ id: opsAlerts.id }).from(opsAlerts).where(eq(opsAlerts.dedupKey, projectId));
    expect(r.alertId).toBe(al.id);
    expect(r.rows.map((x) => x.companyName)).toEqual(['Second Co', 'First Co', 'Waitlisted Co']);
    expect(await count()).toBe(n);
    // Once the alert is resolved, it's refused again.
    await controlDb.update(opsAlerts).set({ resolvedAt: new Date() }).where(and(eq(opsAlerts.dedupKey, projectId), inArray(opsAlerts.kind, ['window-project'])));
    await expect(windowSignupCommand(slug)).rejects.toThrow(/not a window signup/);
  });
});
