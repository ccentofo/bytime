import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-G18 (second half): a crashed provisioning is resumed ONLY by the signer who started it — the
 * tenant row's signupEmail must match the verify link's email (case-insensitive). Another signer, a missing signup
 * email, or a workspace that isn't provisioning is "already exists", and no database work starts. The migration
 * step is a sentinel: reaching it proves the resume passed the gate.
 */

const h = vi.hoisted(() => ({ tenant: null as null | Record<string, unknown>, migrated: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async () => h.tenant, createTenantRecord: async () => { throw new Error('must not create a second record'); }, invalidateTenant: () => {} }));
vi.mock('@/lib/tenant/window-slugs', () => ({ isOpenWindowSlug: async () => false }));
vi.mock('@/lib/tenant/neon', () => ({ createNeonDatabase: async () => { throw new Error('must not create a database'); } }));
vi.mock('@/lib/tenant/migrate-tenant', () => ({ migrateTenantDatabase: async (url: string) => { h.migrated.push(url); throw new Error('MIGRATE_REACHED'); } }));
vi.mock('@/db/control-plane/locked', () => ({ withTenantLock: async () => { throw new Error('unreachable'); } }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({ readTenant: async () => null, updateTenantGuarded: async () => {} }));
vi.mock('@/server/internal/approval-rules', () => ({ lockUserRulesExclusive: async () => {}, recomputeSelfApproval: async () => {} }));

import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { provisionTenant, ProvisionConflictError } from '@/lib/tenant/provision';

const db = controlDb as unknown as FakeControlDb;
const input = { slug: 'newco', name: 'NewCo', adminEmail: 'Founder@NewCo.com ', adminName: 'Founder' };

beforeEach(() => {
  db.reset();
  h.tenant = { slug: 'newco', status: 'provisioning', dbUrl: 'postgresql://app@db/newco', plan: 'trial' };
  h.migrated = [];
});

describe('A1-G18: a provisioning resume is bound to the signer (signupEmail)', () => {
  it('the same signer (any case) resumes: the recorded database is reused', async () => {
    db.onSelect(tenants, [{ signupEmail: 'founder@newco.COM' }]);
    await expect(provisionTenant(input)).rejects.toThrow('MIGRATE_REACHED');
    expect(h.migrated).toEqual(['postgresql://app@db/newco']);
  });

  it.each([
    ['another signer', { signupEmail: 'attacker@evil.test' }],
    ['no signup email recorded', { signupEmail: null }],
  ])('%s → "already exists", nothing migrated', async (_label, owner) => {
    db.onSelect(tenants, [owner]);
    const err = await provisionTenant(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisionConflictError);
    expect((err as Error).message).toBe('Workspace "newco" already exists.');
    expect(h.migrated).toEqual([]);
  });

  it('the right signer but a workspace that is not provisioning (active) → "already exists"', async () => {
    h.tenant = { ...h.tenant, status: 'active' };
    db.onSelect(tenants, [{ signupEmail: 'founder@newco.com' }]);
    await expect(provisionTenant(input)).rejects.toBeInstanceOf(ProvisionConflictError);
    expect(h.migrated).toEqual([]);
  });
});
