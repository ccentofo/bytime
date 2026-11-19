import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-launch-blockers.md P3 / §9 "Roles" (LB-D4), unit form: each of the 43 admin-only writes (incl. the
 * 2 OAuth-token-refreshing mapping readers) authorizes with requireAdminFresh(), never the cached requireAdmin().
 * The session is a stale JWT-admin: requireAdmin() admits it, requireAdminFresh() — which re-reads the DB role —
 * refuses it (DB role is now supervisor). The integration form against a real users row is
 * src/__tests__/integration/fresh-admin-writes.test.ts.
 */

vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
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
import * as rates from '@/server/actions/labor-category-rates';
import * as ccats from '@/server/actions/charge-code-categories';
import * as qbo from '@/server/actions/qbo';
import * as gusto from '@/server/actions/gusto';
import * as slins from '@/server/actions/slins';
import * as users from '@/server/actions/users';
import * as importActions from '@/server/actions/import';
import * as apiKeys from '@/server/actions/api-keys';
import * as billing from '@/server/actions/billing';
import * as migration from '@/server/actions/migration';
import * as mfa from '@/server/actions/mfa';
import * as password from '@/server/actions/password';
import * as payPeriodConfig from '@/server/actions/pay-period-config';
import * as workspaceSettings from '@/server/actions/workspace-settings';

type AnyAction = (...args: never[]) => Promise<unknown>;
const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args);

/** Refused by the fresh role check: every one of the 43 returns { ok: false, code: 'forbidden' } (launch-blockers P4). */
async function expectRefused(pending: Promise<unknown>): Promise<void> {
  expect(await pending).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringMatching(/access has changed/i) });
}

/** The 43 (feature-plan-launch-blockers.md §1 "Roles" + §4 P3; feature-plan-ux-integrations-billing.md I3–I5: −5 fetches, +3). */
const ADMIN_WRITES: Array<[string, AnyAction | unknown, unknown[]]> = [
  ['grantApprovalScope', assignments.grantApprovalScope, [{ supervisorId: 'u2', clinIds: ['c1'] }]],
  ['revokeApprovalScope', assignments.revokeApprovalScope, [{ supervisorId: 'u2', clinId: 'c1' }]],
  ['reviewMigratedScopes', assignments.reviewMigratedScopes, [{ keep: ['s1'], remove: [] }]],
  ['createCostClass', chargeCodes.createCostClass, ['Gov']],
  ['createChargeCode', chargeCodes.createChargeCode, [{ code: 'X', name: 'X', clinId: 'c1' }]],
  ['updateChargeCode', chargeCodes.updateChargeCode, ['cc1', { name: 'Y' }]],
  ['deactivateChargeCode', chargeCodes.deactivateChargeCode, ['cc1']],
  ['assignChargeCodesToUser', chargeCodes.assignChargeCodesToUser, [{ userId: 'u2', chargeCodeIds: ['cc1'] }]],
  ['unassignChargeCodeFromUser', chargeCodes.unassignChargeCodeFromUser, ['u2', 'cc1']],
  ['autobridgeChargeCodesFromClins', chargeCodes.autobridgeChargeCodesFromClins, []],
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
  // feature-plan-ux-integrations-billing.md I3: one token-refreshing load replaces the four per-list fetches.
  ['loadQboMappingData', qbo.loadQboMappingData, ['conn1']],
  ['fetchQBOClassesForMapping', qbo.fetchQBOClassesForMapping, ['conn1']],
  ['triggerGustoSync', gusto.triggerGustoSync, [{ connectionId: 'conn1' }]],
  // I4, I5: one QuickBooks match per person.
  ['setPersonMapping', integrations.setPersonMapping, [{ connectionId: 'conn1', userId: 'u2', match: null }]],
  ['matchPeopleByEmail', integrations.matchPeopleByEmail, [{ connectionId: 'conn1', pairs: [] }]],
  ['createSlin', slins.createSlin, [{ clinId: 'c1', slinNumber: 'AA' }]],
  ['updateSlin', slins.updateSlin, ['s1', { slinNumber: 'AB' }]],
  ['unlockUserAccount', users.unlockUserAccount, ['locked@acme.com']],
  // feature-plan-dated-rates.md D1.5
  ['addLaborCategoryRateChange', rates.addLaborCategoryRateChange, [{ laborCategoryId: 'l1', effectiveDate: '2027-01-01', hourlyRate: '110', ceilingRate: null }]],
  ['correctLaborCategoryRate', rates.correctLaborCategoryRate, [{ laborCategoryId: 'l1', target: 'starting', hourlyRate: '105', ceilingRate: null }]],
  ['removeLaborCategoryRateChange', rates.removeLaborCategoryRateChange, [{ laborCategoryId: 'l1', changeId: 'x' }]],
  // feature-plan-dated-rates.md D3
  ['addChargeCodeCategoryChange', ccats.addChargeCodeCategoryChange, [{ chargeCodeId: 'cc1', effectiveDate: '2027-01-01', laborCategoryId: 'l1' }]],
  ['correctChargeCodeCategory', ccats.correctChargeCodeCategory, [{ chargeCodeId: 'cc1', target: 'starting', laborCategoryId: null }]],
  ['removeChargeCodeCategoryChange', ccats.removeChargeCodeCategoryChange, [{ chargeCodeId: 'cc1', changeId: 'x' }]],
  // feature-plan-ux-setup-import.md §4.3: the two new import types
  ['bulkImportChargeCodes', importActions.bulkImportChargeCodes, [[{ code: 'X', name: 'X', contractNumber: 'K', clinNumber: '0001' }]]],
  ['bulkImportChargeCodeAccess', importActions.bulkImportChargeCodeAccess, [[{ email: 'a@x.dev', chargeCode: 'X' }]]],
];

describe('the 43 admin-only writes refuse a stale JWT-admin (requireAdminFresh)', () => {
  it('covers exactly 43 actions, all exported', () => {
    expect(ADMIN_WRITES).toHaveLength(43);
    for (const [name, fn] of ADMIN_WRITES) expect(typeof fn, name).toBe('function');
  });

  it.each(ADMIN_WRITES)('%s', async (_name, fn, args) => {
    writes.count = 0;
    await expectRefused(call(fn, ...args));
    expect(writes.count).toBe(0);
  });
});

/**
 * SWEEP-FINDINGS.md A1-G6: 27 more admin-only actions (writes, previews and validations an admin alone may run) must
 * authorize with an ADMIN-level fresh guard — not just any guard. Swapping one for requireSession() or the cached
 * requireAdmin() lets this stale JWT-admin through, and its row fails. Arguments are placeholders: nothing after the
 * refused guard may run (the DB fake throws on any touch).
 */
const ADMIN_ONLY_MORE: Array<[string, AnyAction | unknown, unknown[]]> = [
  ['createApiKey', apiKeys.createApiKey, [{ name: 'k' }]],
  ['revokeApiKey', apiKeys.revokeApiKey, ['k1']],
  ['deleteApiKey', apiKeys.deleteApiKey, ['k1']],
  ['startCheckout', billing.startCheckout, ['month']],
  ['openBillingPortal', billing.openBillingPortal, []],
  ['previewChargeCodeCategoryImpact', ccats.previewChargeCodeCategoryImpact, [{ chargeCodeId: 'cc1', effectiveDate: '2027-01-01', laborCategoryId: 'l1' }]],
  ['reactivateChargeCode', chargeCodes.reactivateChargeCode, ['cc1']],
  ['previewRateChangeImpact', rates.previewRateChangeImpact, [{ laborCategoryId: 'l1', effectiveDate: '2027-01-01', hourlyRate: '110' }]],
  ['bulkImportEmployees', importActions.bulkImportEmployees, [[{ email: 'a@x.dev', fullName: 'A' }]]],
  ['bulkImportContracts', importActions.bulkImportContracts, [[{ contractNumber: 'K', name: 'K' }]]],
  ['bulkImportClins', importActions.bulkImportClins, [[{ contractNumber: 'K', clinNumber: '0001' }]]],
  ['bulkImportLaborCategories', importActions.bulkImportLaborCategories, [[{ lcatCode: 'L', title: 'L' }]]],
  ['bulkImportAssignments', importActions.bulkImportAssignments, [[{ email: 'a@x.dev', clinNumber: '0001' }]]],
  ['disconnectIntegration', integrations.disconnectIntegration, ['conn1']],
  ['validateMigrationData', migration.validateMigrationData, [[]]],
  ['validateMigrationPeriods', migration.validateMigrationPeriods, [[]]],
  ['importMigrationData', migration.importMigrationData, [[]]],
  ['importMigrationPeriods', migration.importMigrationPeriods, [[]]],
  ['adminResetMfa', mfa.adminResetMfa, [{ userId: '00000000-0000-4000-8000-000000000002', currentPassword: 'x' }]],
  ['adminResetPassword', password.adminResetPassword, [{ targetUserId: '00000000-0000-4000-8000-000000000002', newPassword: 'brand-new-pass' }]],
  ['updateUser', users.updateUser, ['00000000-0000-4000-8000-000000000002', { fullName: 'X' }]],
  ['createUserWithPassword', users.createUserWithPassword, [{ email: 'n@x.dev', fullName: 'N', role: 'employee', password: 'brand-new-pass', flsaExempt: false }]],
  ['setUserApprover', users.setUserApprover, [{ userId: '00000000-0000-4000-8000-000000000002', approverId: null }]],
  ['updatePayPeriodConfig', payPeriodConfig.updatePayPeriodConfig, [{ type: 'weekly' }]],
  ['updateWorkspaceTimezone', workspaceSettings.updateWorkspaceTimezone, ['America/New_York']],
  ['updateWorkweekStartDay', workspaceSettings.updateWorkweekStartDay, [1]],
];

describe('A1-G6: 27 more admin-only actions refuse a stale JWT-admin (admin-level fresh guard)', () => {
  it('covers exactly the 27 (26 returning a result + startQuickBooksConnect, which redirects), all exported', () => {
    expect(ADMIN_ONLY_MORE).toHaveLength(26);
    expect(new Set([...ADMIN_ONLY_MORE.map(([n]) => n), 'startQuickBooksConnect']).size).toBe(27);
    for (const [name, fn] of ADMIN_ONLY_MORE) expect(typeof fn, name).toBe('function');
  });

  it.each(ADMIN_ONLY_MORE)('%s', async (_name, fn, args) => {
    writes.count = 0;
    await expectRefused(call(fn, ...args));
    expect(writes.count).toBe(0);
  });

  it('startQuickBooksConnect (a form action): refused → redirected to /timesheet before any state is minted', async () => {
    writes.count = 0;
    const err = await integrations.startQuickBooksConnect().then(() => null, (e: unknown) => e as { digest?: string });
    expect(err?.digest).toMatch(/^NEXT_REDIRECT;[^;]*;\/timesheet;/);
    expect(writes.count).toBe(0);
  });
});
