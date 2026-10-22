import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-launch-blockers.md P3 / §9 "Roles" (LB-D4), unit form: each of the 37 admin-only writes (incl. the
 * 6 OAuth-token-refreshing mapping readers) authorizes with requireAdminFresh(), never the cached requireAdmin().
 * The session is a stale JWT-admin: requireAdmin() admits it, requireAdminFresh() — which re-reads the DB role —
 * refuses it (DB role is now supervisor). The integration form against a real users row is
 * src/__tests__/integration/fresh-admin-writes.test.ts.
 */

vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => {
  class AuthorizationError extends Error {
    constructor(public code: string, message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const staleAdmin = { id: 'u1', email: 'demoted@acme.com', fullName: 'Demoted', role: 'admin' as const };
  return {
    AuthorizationError,
    requireSession: vi.fn(async () => staleAdmin),
    requireAdmin: vi.fn(async () => staleAdmin), // cached JWT still says admin
    requireApprover: vi.fn(async () => staleAdmin),
    requireAdminFresh: vi.fn(async () => { throw new AuthorizationError('forbidden', 'Forbidden: Your access has changed — please sign in again.'); }),
    requireApproverFresh: vi.fn(async () => staleAdmin),
    getEmployeeScope: vi.fn(async () => 'all'),
    assertCanAccessEmployee: vi.fn(async () => {}),
  };
});
vi.mock('@/lib/session', () => session);

const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/db', () => {
  const touch = () => { writes.count++; throw new Error('DB touched after a refused guard'); };
  const db = { select: touch, insert: touch, update: touch, delete: touch, transaction: touch, execute: touch };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

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

type AnyAction = (...args: never[]) => Promise<unknown>;
const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args);

/** The 37 (feature-plan-launch-blockers.md §1 "Roles" + §4 P3). */
const ADMIN_WRITES: Array<[string, AnyAction | unknown, unknown[]]> = [
  ['assignUserToClin', assignments.assignUserToClin, ['u2', 'c1']],
  ['unassignUserFromClin', assignments.unassignUserFromClin, ['u2', 'c1']],
  ['createCostClass', chargeCodes.createCostClass, ['Gov']],
  ['createChargeCode', chargeCodes.createChargeCode, [{ code: 'X', name: 'X', clinId: 'c1' }]],
  ['updateChargeCode', chargeCodes.updateChargeCode, ['cc1', { name: 'Y' }]],
  ['deactivateChargeCode', chargeCodes.deactivateChargeCode, ['cc1']],
  ['assignChargeCodeToUser', chargeCodes.assignChargeCodeToUser, ['u2', 'cc1']],
  ['unassignChargeCodeFromUser', chargeCodes.unassignChargeCodeFromUser, ['u2', 'cc1']],
  ['autobridgeChargeCodesFromClins', chargeCodes.autobridgeChargeCodesFromClins, []],
  ['assignAllUnderClin', chargeCodes.assignAllUnderClin, ['u2', 'c1']],
  ['createClin', clins.createClin, [{ contractId: 'k1', clinNumber: '0001' }]],
  ['updateClin', clins.updateClin, ['c1', { clinNumber: '0002' }]],
  ['createContract', contracts.createContract, [{ contractNumber: 'K', name: 'K' }]],
  ['updateContract', contracts.updateContract, ['k1', { name: 'K2' }]],
  ['createIndirectCode', indirect.createIndirectCode, [{ code: 'OH', name: 'Overhead', category: 'overhead' }]],
  ['updateIndirectCode', indirect.updateIndirectCode, ['i1', { name: 'OH2' }]],
  ['seedIndirectCodes', indirect.seedIndirectCodes, []],
  ['toggleAutoSync', integrations.toggleAutoSync, ['conn1', true]],
  ['saveMapping', integrations.saveMapping, [{ connectionId: 'conn1', entityType: 'employee', bytimeEntityId: 'u2', externalEntityId: 'e1' }]],
  ['deleteMapping', integrations.deleteMapping, ['m1']],
  ['createLaborCategory', lcats.createLaborCategory, [{ clinId: 'c1', lcatCode: 'L', title: 'L', hourlyRate: '1' }]],
  ['updateLaborCategory', lcats.updateLaborCategory, ['l1', { title: 'L2' }]],
  ['assignUserToLaborCategory', lcats.assignUserToLaborCategory, [{ userId: 'u2', laborCategoryId: 'l1', effectiveDate: '2026-01-01' }]],
  ['endUserLaborCategoryAssignment', lcats.endUserLaborCategoryAssignment, ['a1', '2026-02-01']],
  ['importQboClasses', qbo.importQboClasses, ['conn1', []]],
  ['importQboChargeCodes', qbo.importQboChargeCodes, ['conn1', []]],
  ['triggerQBOSync', qbo.triggerQBOSync, [{ connectionId: 'conn1' }]],
  ['fetchQBOEmployeesForMapping', qbo.fetchQBOEmployeesForMapping, ['conn1']],
  ['fetchQBOCustomersForMapping', qbo.fetchQBOCustomersForMapping, ['conn1']],
  ['fetchQBOServiceItemsForMapping', qbo.fetchQBOServiceItemsForMapping, ['conn1']],
  ['fetchQBOVendorsForMapping', qbo.fetchQBOVendorsForMapping, ['conn1']],
  ['fetchQBOClassesForMapping', qbo.fetchQBOClassesForMapping, ['conn1']],
  ['triggerGustoSync', gusto.triggerGustoSync, [{ connectionId: 'conn1' }]],
  ['fetchGustoEmployeesForMapping', gusto.fetchGustoEmployeesForMapping, ['conn1']],
  ['createSlin', slins.createSlin, [{ clinId: 'c1', slinNumber: 'AA' }]],
  ['updateSlin', slins.updateSlin, ['s1', { slinNumber: 'AB' }]],
  ['unlockUserAccount', users.unlockUserAccount, ['locked@acme.com']],
];

describe('the 37 admin-only writes refuse a stale JWT-admin (requireAdminFresh)', () => {
  it('covers exactly 37 actions, all exported', () => {
    expect(ADMIN_WRITES).toHaveLength(37);
    for (const [name, fn] of ADMIN_WRITES) expect(typeof fn, name).toBe('function');
  });

  it.each(ADMIN_WRITES)('%s', async (_name, fn, args) => {
    writes.count = 0;
    await expect(call(fn, ...args)).rejects.toThrow(/access has changed/i);
    expect(writes.count).toBe(0);
  });
});
