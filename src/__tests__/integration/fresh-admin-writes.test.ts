import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';

/**
 * feature-plan-launch-blockers.md P3 / §9 "Roles" (LB-D4): each of the 37 admin-only writes (incl. the 6
 * OAuth-token-refreshing mapping readers) refuses a session whose JWT still says admin while the users row now says
 * supervisor — the real requireAdminFresh() re-reads the role from the tenant DB. Nothing is written.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => tenantState.requestSlug }));

const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; email: string; fullName: string } }));
vi.mock('@/auth', () => ({
  auth: async () => sessionState.user
    ? { user: { ...sessionState.user, role: 'admin', tenantSlug: tenantState.requestSlug } } // stale JWT: admin
    : null,
}));

import * as assignments from '@/server/actions/assignments';
import * as chargeCodes from '@/server/actions/charge-codes';
import * as clins from '@/server/actions/clins';
import * as contracts from '@/server/actions/contracts';
import * as indirect from '@/server/actions/indirect-codes';
import * as integrations from '@/server/actions/integrations';
import * as lcats from '@/server/actions/labor-categories';
import * as qbo from '@/server/actions/qbo';
import * as gusto from '@/server/actions/gusto';
import * as slins from '@/server/actions/slins';
import * as users from '@/server/actions/users';

const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args);

/** Refused by the fresh role check: every one of the 37 returns { ok: false, code: 'forbidden' } (launch-blockers P4). */
async function expectRefused(pending: Promise<unknown>): Promise<void> {
  expect(await pending).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringMatching(/access has changed/i) });
}
const ZERO = '00000000-0000-0000-0000-000000000000';

const ADMIN_WRITES: Array<[string, unknown, unknown[]]> = [
  ['assignUserToClin', assignments.assignUserToClin, [ZERO, ZERO]],
  ['unassignUserFromClin', assignments.unassignUserFromClin, [ZERO, ZERO]],
  ['createCostClass', chargeCodes.createCostClass, ['Gov']],
  ['createChargeCode', chargeCodes.createChargeCode, [{ code: 'X', name: 'X', clinId: ZERO }]],
  ['updateChargeCode', chargeCodes.updateChargeCode, [ZERO, { name: 'Y' }]],
  ['deactivateChargeCode', chargeCodes.deactivateChargeCode, [ZERO]],
  ['assignChargeCodeToUser', chargeCodes.assignChargeCodeToUser, [ZERO, ZERO]],
  ['unassignChargeCodeFromUser', chargeCodes.unassignChargeCodeFromUser, [ZERO, ZERO]],
  ['autobridgeChargeCodesFromClins', chargeCodes.autobridgeChargeCodesFromClins, []],
  ['assignAllUnderClin', chargeCodes.assignAllUnderClin, [ZERO, ZERO]],
  ['createClin', clins.createClin, [{ contractId: ZERO, clinNumber: '0001' }]],
  ['updateClin', clins.updateClin, [ZERO, { clinNumber: '0002' }]],
  ['createContract', contracts.createContract, [{ contractNumber: 'K-FRESH', name: 'K' }]],
  ['updateContract', contracts.updateContract, [ZERO, { name: 'K2' }]],
  ['createIndirectCode', indirect.createIndirectCode, [{ code: 'OH-FRESH', name: 'Overhead', category: 'overhead' }]],
  ['updateIndirectCode', indirect.updateIndirectCode, [ZERO, { name: 'OH2' }]],
  ['seedIndirectCodes', indirect.seedIndirectCodes, []],
  ['toggleAutoSync', integrations.toggleAutoSync, [ZERO, true]],
  ['saveMapping', integrations.saveMapping, [{ connectionId: ZERO, entityType: 'employee', bytimeEntityId: ZERO, externalEntityId: 'e1' }]],
  ['deleteMapping', integrations.deleteMapping, [ZERO]],
  ['createLaborCategory', lcats.createLaborCategory, [{ clinId: ZERO, lcatCode: 'L', title: 'L', hourlyRate: '1' }]],
  ['updateLaborCategory', lcats.updateLaborCategory, [ZERO, { title: 'L2' }]],
  ['assignUserToLaborCategory', lcats.assignUserToLaborCategory, [{ userId: ZERO, laborCategoryId: ZERO, effectiveDate: '2026-01-01' }]],
  ['endUserLaborCategoryAssignment', lcats.endUserLaborCategoryAssignment, [ZERO, '2026-02-01']],
  ['importQboClasses', qbo.importQboClasses, [ZERO, [{ qboId: '1', name: 'Gov' }]]],
  ['importQboChargeCodes', qbo.importQboChargeCodes, [ZERO, []]],
  ['triggerQBOSync', qbo.triggerQBOSync, [{ connectionId: ZERO }]],
  ['fetchQBOEmployeesForMapping', qbo.fetchQBOEmployeesForMapping, [ZERO]],
  ['fetchQBOCustomersForMapping', qbo.fetchQBOCustomersForMapping, [ZERO]],
  ['fetchQBOServiceItemsForMapping', qbo.fetchQBOServiceItemsForMapping, [ZERO]],
  ['fetchQBOVendorsForMapping', qbo.fetchQBOVendorsForMapping, [ZERO]],
  ['fetchQBOClassesForMapping', qbo.fetchQBOClassesForMapping, [ZERO]],
  ['triggerGustoSync', gusto.triggerGustoSync, [{ connectionId: ZERO }]],
  ['fetchGustoEmployeesForMapping', gusto.fetchGustoEmployeesForMapping, [ZERO]],
  ['createSlin', slins.createSlin, [{ clinId: ZERO, slinNumber: 'AA' }]],
  ['updateSlin', slins.updateSlin, [ZERO, { slinNumber: 'AB' }]],
  ['unlockUserAccount', users.unlockUserAccount, ['locked@acme.com']],
];

describe('the 37 admin-only writes refuse a JWT-admin whose DB role is supervisor (P3)', () => {
  beforeAll(async () => {
    await cleanupTestData();
    const demoted = await createTestUser({ role: 'supervisor' }); // DB truth: supervisor
    sessionState.user = { id: demoted.id, email: demoted.email, fullName: demoted.fullName };
  });
  afterAll(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('covers exactly 37 actions', () => {
    expect(ADMIN_WRITES).toHaveLength(37);
  });

  it.each(ADMIN_WRITES)('%s', async (_name, fn, args) => {
    await expectRefused(call(fn, ...args));
  });

  it('wrote nothing (no contract, cost class or indirect code was created)', async () => {
    const db = getTestDb();
    expect(await db.select().from(schema.contracts)).toHaveLength(0);
    expect(await db.select().from(schema.costClasses)).toHaveLength(0);
    expect(await db.select().from(schema.indirectChargeCodes)).toHaveLength(0);
  });
});
