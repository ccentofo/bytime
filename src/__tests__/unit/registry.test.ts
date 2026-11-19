import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-G11: the tenant registry cache (src/lib/tenant/registry.ts). A found workspace is cached for 60
 * seconds; an unknown slug is never cached (a just-provisioned workspace must not look "Unknown" for a minute);
 * invalidateTenant forces a fresh read; a tombstoned workspace (no stored URL) comes back with dbUrl ''.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/lib/encryption', () => ({ decrypt: (v: string) => `decrypted:${v}`, encrypt: (v: string) => `enc:${v}` }));

import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { getTenantBySlug, invalidateTenant } from '@/lib/tenant/registry';
import type { FakeControlDb } from '../helpers/fake-control-db';

const db = controlDb as unknown as FakeControlDb;
const selects = () => db.ops.filter((o) => o === 'select').length;
const row = (slug: string, o: Record<string, unknown> = {}) => ({
  id: `id-${slug}`, slug, name: slug, plan: 'standard', status: 'active', dbUrlEncrypted: `url-${slug}`, neonProjectId: null,
  stripeCustomerId: null, stripeCustomerDeletedAt: null, currentPeriodEnd: null, lifecycleVersion: 0,
  subscriptionStatus: 'active', stripeSubscriptionId: 'sub', trialEndsAt: null, pastDueSince: null, suspendedAt: null,
  suspensionReason: null, subscriptionEndedAt: null, deletionScheduledFor: null, firstGoodAt: null, lifecycleExempt: false,
  policyExportAllowed: false, collectionMethod: null, ...o,
});

let n = 0;
let slug = '';
beforeEach(() => {
  db.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  slug = `ws-${++n}`; // a fresh slug per case: the cache is module state
});
afterEach(() => { vi.useRealTimers(); });

describe('A1-G11: the registry cache', () => {
  it('an unknown slug is not cached: the next call reads again and finds the new workspace', async () => {
    expect(await getTenantBySlug(slug)).toBeNull();
    db.onSelect(tenants, [row(slug)]);
    expect(await getTenantBySlug(slug)).toMatchObject({ slug, dbUrl: `decrypted:url-${slug}` });
    expect(selects()).toBe(2);
  });

  it('a found workspace is served from the cache for 60 s, then read again', async () => {
    db.onSelect(tenants, [row(slug, { status: 'active' })]);
    expect(await getTenantBySlug(slug)).toMatchObject({ status: 'active' });
    db.onSelect(tenants, [row(slug, { status: 'suspended' })]);
    vi.setSystemTime(new Date('2026-11-19T12:00:59.999Z'));
    expect(await getTenantBySlug(slug)).toMatchObject({ status: 'active' }); // still cached
    expect(selects()).toBe(1);
    vi.setSystemTime(new Date('2026-11-19T12:01:00.001Z'));
    expect(await getTenantBySlug(slug)).toMatchObject({ status: 'suspended' });
    expect(selects()).toBe(2);
  });

  it('invalidateTenant forces a fresh read within the minute', async () => {
    db.onSelect(tenants, [row(slug, { status: 'active' })]);
    await getTenantBySlug(slug);
    db.onSelect(tenants, [row(slug, { status: 'deleting' })]);
    invalidateTenant(slug);
    expect(await getTenantBySlug(slug)).toMatchObject({ status: 'deleting' });
    expect(selects()).toBe(2);
  });

  it('the cache is per slug: invalidating one leaves another cached', async () => {
    const other = `${slug}-b`;
    db.onSelect(tenants, [row(slug)]);
    db.onSelect(tenants, [row(other)]);
    await getTenantBySlug(slug);
    await getTenantBySlug(other);
    invalidateTenant(slug);
    await getTenantBySlug(other);
    expect(selects()).toBe(2);
  });

  it('a tombstoned workspace (no stored URL) → dbUrl "", never a decrypt of null', async () => {
    db.onSelect(tenants, [row(slug, { status: 'deleted', dbUrlEncrypted: null })]);
    expect(await getTenantBySlug(slug)).toMatchObject({ status: 'deleted', dbUrl: '' });
  });
});
