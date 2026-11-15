import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, expectOk, expectFailure } from './helpers';

/**
 * feature-plan-per-user-billing.md §6.3, §6.5 — S13 (the 100-user cap), S14 (the plan is read fresh, never from the
 * registry cache), S18 (the due mark never fails a user change), S33 (which changes mark). The real plan-source and
 * seat-sync modules, against a real control-plane tenant row.
 */

const state = vi.hoisted(() => ({ tenantId: '', cachedPlan: 'trial' }));

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));
// The request's tenant: the registry cache's view (its `plan` is deliberately what S14 makes stale).
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: state.tenantId, slug: 'test-tenant', name: 'Test', status: 'active', plan: state.cachedPlan, dbUrl: 'unused' }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));
vi.mock('@/auth', () => ({
  auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null),
}));

import * as Sentry from '@sentry/nextjs';
import { controlDb } from '@/db/control-plane';
import { tenantSeatBilling } from '@/db/control-plane/schema';
import { createUserWithPassword, updateUser } from '@/server/actions/users';
import { bulkImportEmployees } from '@/server/actions/import';
import { seatMarkStore } from '@/lib/billing/seat-sync';
import { cleanupLifecycleTenants, cpReady, makeTenant, setTenant } from './lifecycle-helpers';

const CAP = 'Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.';
let hash = '';

async function seedActive(n: number, inactive = 0) {
  hash ||= await bcrypt.hash('TestPass123!', 4);
  const rows = [...Array(n + inactive)].map((_, i) => ({
    email: `cap-${i}-${Math.random().toString(36).slice(2, 8)}@bytime.dev`, fullName: `Cap ${i}`, role: 'employee' as const, passwordHash: hash, isActive: i < n,
  }));
  if (rows.length) await getTestDb().insert(schema.users).values(rows);
}
const newUser = (tag: string) => ({ email: `${tag}-${Math.random().toString(36).slice(2, 8)}@bytime.dev`, fullName: `New ${tag}`, role: 'employee' as const, password: 'harbor-light-9', flsaExempt: false });
const seat = async () => (await controlDb.select().from(tenantSeatBilling).where(eq(tenantSeatBilling.tenantId, state.tenantId)))[0];
const originalUpsert = seatMarkStore.upsert;

describe.skipIf(!cpReady)('per-user seat cap and due marks (§6.3, §6.5)', () => {
  let adminId = '';

  beforeEach(async () => {
    await cleanupTestData();
    await cleanupLifecycleTenants();
    seatMarkStore.upsert = originalUpsert;
    const tenant = await makeTenant({ plan: 'standard' });
    state.tenantId = tenant.id;
    state.cachedPlan = 'standard';
    const admin = await createTestUser({ role: 'admin' });
    adminId = admin.id;
    sessionState.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => {
    seatMarkStore.upsert = originalUpsert;
    sessionState.user = null;
    await cleanupLifecycleTenants();
    await cleanupTestData();
  });

  it('S13: Standard — user 100 allowed; user 101 refused with the exact message, by create, reactivate and import', async () => {
    await seedActive(98, 1); // + the admin = 99 active, 1 inactive
    await expectOk(createUserWithPassword(newUser('hundredth'))); // 100
    await expectFailure(createUserWithPassword(newUser('over')), 'validation', new RegExp(`^${CAP.replace(/\./g, '\\.')}$`));
    const [inactive] = await getTestDb().select().from(schema.users).where(eq(schema.users.isActive, false));
    await expectFailure(updateUser(inactive.id, { isActive: true }), 'validation', new RegExp(`^${CAP.replace(/\./g, '\\.')}$`));
    await expectFailure(bulkImportEmployees([{ name: 'Imp', email: `imp-${Date.now()}@bytime.dev`, role: 'employee', flsaExempt: 'no' }]), 'validation', new RegExp(`^${CAP.replace(/\./g, '\\.')}$`));
  });

  it('S13: a legacy pro row is Standard too (the cap message, at 100)', async () => {
    await setTenant(state.tenantId, { plan: 'pro' });
    await seedActive(99);
    await expectFailure(createUserWithPassword(newUser('over')), 'validation', new RegExp(`^${CAP.replace(/\./g, '\\.')}$`));
  });

  it('S13: trial unchanged — user 11 refused with the trial message', async () => {
    await setTenant(state.tenantId, { plan: 'trial' });
    state.cachedPlan = 'trial';
    await seedActive(8); // + admin = 9
    await expectOk(createUserWithPassword(newUser('tenth')));
    await expectFailure(createUserWithPassword(newUser('eleventh')), 'validation', /^Your Trial plan allows 10 active users \(you currently have 10\)\. This would add 1 more\. Upgrade in Billing to add more\.$/);
  });

  it('S14: the registry cache says trial while the row says standard → user 11 allowed', async () => {
    state.cachedPlan = 'trial'; // stale cache
    await seedActive(9); // + admin = 10
    await expectOk(createUserWithPassword(newUser('eleventh')));
  });

  it('S18: the mark store throwing, or hanging 5 s → the user is still created (within about 3 s for the hang)', async () => {
    seatMarkStore.upsert = async () => { throw new Error('control plane down'); };
    await expectOk(createUserWithPassword(newUser('throw')));
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();

    seatMarkStore.upsert = () => new Promise((r) => setTimeout(r, 5000));
    const started = Date.now();
    await expectOk(createUserWithPassword(newUser('hang')));
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(2900);
    expect(ms).toBeLessThan(4500);
  }, 15_000);

  it('S33 (action half): create, import and an active-status change mark; a rename, a role change and an import dry run don\'t', async () => {
    const target = await createTestUser({ role: 'employee' });
    await expectOk(updateUser(target.id, { fullName: 'Renamed' }));
    await expectOk(updateUser(target.id, { role: 'supervisor' }));
    expect(await seat()).toBeUndefined();
    await expectOk(bulkImportEmployees([{ name: 'Dry', email: `dry-${Date.now()}@bytime.dev`, role: 'employee', flsaExempt: 'no' }], { dryRun: true }));
    expect(await seat()).toBeUndefined();

    await expectOk(createUserWithPassword(newUser('marks')));
    expect((await seat()).markSeq).toBe(1);
    await expectOk(bulkImportEmployees([{ name: 'Real', email: `real-${Date.now()}@bytime.dev`, role: 'employee', flsaExempt: 'no' }]));
    expect((await seat()).markSeq).toBe(2);
    await expectOk(updateUser(target.id, { isActive: false }));
    expect((await seat()).markSeq).toBe(3);
    await expectOk(updateUser(target.id, { isActive: false })); // no change → no mark
    expect((await seat()).markSeq).toBe(3);
    void adminId;
  });
});
