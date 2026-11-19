import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md §5 A2-D4: `openBillingPortal` refuses a closed workspace exactly as `startCheckout` does (same
 * words), before any Stripe call. Session, tenant context, control plane and Stripe are faked (no database).
 */

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  portalCalls: [] as unknown[],
}));

vi.mock('server-only', () => ({}));
// userAction maps errors by instanceof, so the partial mock carries a real-shaped AuthorizationError.
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); }
  }
  const admin = async () => ({ id: 'a1', role: 'admin' });
  return { AuthorizationError, requireAdmin: admin, requireAdminFresh: admin };
});
vi.mock('@/lib/tenant/context', () => ({ getTenantForBilling: async () => ({ slug: 'portal-co' }) }));
vi.mock('@/db/control-plane', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => (h.row ? [h.row] : []) };
  return { controlDb: { select: () => chain } };
});
vi.mock('@/lib/billing/stripe', () => ({
  stripe: { billingPortal: { sessions: { create: async (p: unknown) => { h.portalCalls.push(p); return { url: 'https://billing.example/portal' }; } } } },
}));
vi.mock('@/lib/billing/tenant-billing', () => ({ ensureStripeCustomer: async () => 'cus_x' }));
vi.mock('@/server/internal/billing-reads', () => ({ billingTenantReads: {}, DEFAULT_TIME_ZONE: 'America/New_York' }));

import { openBillingPortal } from '@/server/actions/billing';

const NOW = Date.now();
const day = 86_400_000;
function tenantRow(o: Record<string, unknown> = {}) {
  return {
    id: 't1', slug: 'portal-co', status: 'active', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1',
    trialEndsAt: new Date(NOW - 200 * day), pastDueSince: null, suspendedAt: null, suspensionReason: null,
    subscriptionEndedAt: null, deletionScheduledFor: null, firstGoodAt: new Date(NOW - 100 * day), lifecycleExempt: false,
    policyExportAllowed: false, collectionMethod: 'charge_automatically', stripeCustomerId: 'cus_1', stripeCustomerDeletedAt: null,
    ...o,
  };
}

beforeEach(() => {
  h.row = null;
  h.portalCalls = [];
});

describe('A2-D4: openBillingPortal refuses a closed workspace', () => {
  it('past its deletion date → refused with startCheckout\'s words; no portal session created', async () => {
    h.row = tenantRow({ subscriptionStatus: 'canceled', subscriptionEndedAt: new Date(NOW - 100 * day), deletionScheduledFor: new Date(NOW - day) });
    expect(await openBillingPortal()).toEqual({ ok: false, code: 'validation', error: 'This workspace is closed and can no longer be subscribed.' });
    expect(h.portalCalls).toEqual([]);
  });

  it('a workspace in deletion (status deleting) → refused the same way', async () => {
    h.row = tenantRow({ status: 'deleting' });
    expect(await openBillingPortal()).toMatchObject({ ok: false, error: 'This workspace is closed and can no longer be subscribed.' });
    expect(h.portalCalls).toEqual([]);
  });

  it('a paying workspace still gets its portal link', async () => {
    h.row = tenantRow();
    expect(await openBillingPortal()).toEqual({ ok: true, data: { url: 'https://billing.example/portal' } });
    expect(h.portalCalls).toHaveLength(1);
  });

  it('read-only (ended, before the deletion date) is not closed: the portal still opens', async () => {
    h.row = tenantRow({ subscriptionStatus: 'canceled', subscriptionEndedAt: new Date(NOW - 10 * day), deletionScheduledFor: new Date(NOW + 80 * day) });
    expect(await openBillingPortal()).toMatchObject({ ok: true });
  });
});
