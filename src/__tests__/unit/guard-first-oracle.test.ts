import { describe, it, expect, vi } from 'vitest';

/**
 * Launch-blockers audit A1 (security): an UNAUTHENTICATED call to a mutation against a `billing_only` workspace must
 * answer `unauthenticated` — never the write gate's state-specific message ("suspended… update billing", "read-only").
 * Action ids are identical across workspaces, so that message would let an anonymous POST to victim.<root> learn the
 * workspace's billing state. Here the session is absent and the write gate refuses as for a suspended workspace.
 */

const h = vi.hoisted(() => ({ writeGateCalls: 0 }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const noSession = async () => { throw new AuthorizationError('unauthenticated', 'Unauthorized: No active session'); };
  return {
    AuthorizationError,
    getSessionUser: async () => null,
    requireSession: noSession,
    requireAdmin: noSession,
    requireApprover: noSession,
    requireAdminFresh: noSession,
    requireApproverFresh: noSession,
  };
});
vi.mock('@/db', async () => {
  const { WorkspaceReadOnlyError } = await import('@/lib/errors');
  const suspended = async () => {
    h.writeGateCalls++;
    throw new WorkspaceReadOnlyError('This workspace is suspended. An admin can update billing to restore access.');
  };
  return { getDb: suspended, getDbForWrite: suspended, getDbForAuth: suspended, getDbForUrl: () => { throw new Error('unexpected'); } };
});

import * as apiKeys from '@/server/actions/api-keys';
import * as clins from '@/server/actions/clins';
import * as importActions from '@/server/actions/import';
import * as indirectCodes from '@/server/actions/indirect-codes';
import * as integrations from '@/server/actions/integrations';
import * as laborCategories from '@/server/actions/labor-categories';
import * as laborCategoryRates from '@/server/actions/labor-category-rates';
import * as chargeCodeCategories from '@/server/actions/charge-code-categories';
import * as migration from '@/server/actions/migration';
import * as payPeriodConfig from '@/server/actions/pay-period-config';
import * as slins from '@/server/actions/slins';
import * as users from '@/server/actions/users';

type AnyAction = (...args: unknown[]) => Promise<unknown>;
const a = (fn: unknown) => fn as AnyAction;

// The 22 mutations that awaited getDbForWrite() before their guard (audit A1), with throwaway arguments — the guard
// must refuse before any argument is looked at.
const CASES: Array<[string, AnyAction, unknown[]]> = [
  ['revokeApiKey', a(apiKeys.revokeApiKey), ['k']],
  ['deleteApiKey', a(apiKeys.deleteApiKey), ['k']],
  ['createClin', a(clins.createClin), [{}]],
  ['updateClin', a(clins.updateClin), ['c', {}]],
  ['bulkImportEmployees', a(importActions.bulkImportEmployees), [[]]],
  ['createIndirectCode', a(indirectCodes.createIndirectCode), [{}]],
  ['updateIndirectCode', a(indirectCodes.updateIndirectCode), ['i', {}]],
  ['seedIndirectCodes', a(indirectCodes.seedIndirectCodes), []],
  ['disconnectIntegration', a(integrations.disconnectIntegration), ['c']],
  ['toggleAutoSync', a(integrations.toggleAutoSync), ['c', true]],
  ['saveMapping', a(integrations.saveMapping), [{}]],
  ['deleteMapping', a(integrations.deleteMapping), ['m']],
  ['createLaborCategory', a(laborCategories.createLaborCategory), [{}]],
  ['updateLaborCategory', a(laborCategories.updateLaborCategory), ['l', {}]],
  ['endUserLaborCategoryAssignment', a(laborCategories.endUserLaborCategoryAssignment), ['u']],
  ['importMigrationData', a(migration.importMigrationData), [{}]],
  ['importMigrationPeriods', a(migration.importMigrationPeriods), [[]]],
  ['updatePayPeriodConfig', a(payPeriodConfig.updatePayPeriodConfig), [{}]],
  ['createSlin', a(slins.createSlin), [{}]],
  ['updateSlin', a(slins.updateSlin), ['s', {}]],
  ['createUser', a(users.createUser), [{}]],
  ['createUserWithPassword', a(users.createUserWithPassword), [{}]],
  // feature-plan-dated-rates.md D1.5 (guard first; the preview's read client is refused the same way)
  ['addLaborCategoryRateChange', a(laborCategoryRates.addLaborCategoryRateChange), [{}]],
  ['correctLaborCategoryRate', a(laborCategoryRates.correctLaborCategoryRate), [{}]],
  ['removeLaborCategoryRateChange', a(laborCategoryRates.removeLaborCategoryRateChange), [{}]],
  ['previewRateChangeImpact', a(laborCategoryRates.previewRateChangeImpact), [{}]],
  // feature-plan-dated-rates.md D3
  ['addChargeCodeCategoryChange', a(chargeCodeCategories.addChargeCodeCategoryChange), [{}]],
  ['correctChargeCodeCategory', a(chargeCodeCategories.correctChargeCodeCategory), [{}]],
  ['removeChargeCodeCategoryChange', a(chargeCodeCategories.removeChargeCodeCategoryChange), [{}]],
  ['previewChargeCodeCategoryImpact', a(chargeCodeCategories.previewChargeCodeCategoryImpact), [{}]],
];

describe('anonymous mutation against a billing_only workspace (audit A1)', () => {
  for (const [name, action, args] of CASES) {
    it(`${name} → unauthenticated, and the write gate is never reached`, async () => {
      h.writeGateCalls = 0;
      const result = await action(...args);
      expect(result).toEqual({ ok: false, code: 'unauthenticated', error: 'Unauthorized: No active session' });
      expect(h.writeGateCalls).toBe(0);
    });
  }
});
