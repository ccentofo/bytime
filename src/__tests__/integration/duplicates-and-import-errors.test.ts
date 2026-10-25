import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  cleanupTestData,
  expectFailure,
  expectOk,
} from './helpers';

/**
 * Launch-blockers audit A5 + A6 against real Postgres: duplicates of the common unique constraints come back as
 * `{ ok:false, code:'conflict' }` with a specific message; a bulk-import row that overflows a varchar returns the
 * generic row message — never the SQL text or its parameters.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  // requireAdminFresh (feature-plan-launch-blockers.md P3) re-reads the role through getDbForAuth.
  getDbForAuth: async () => getTestDb(),
}));

// R2-1: getSessionUser() now checks session.user.tenantSlug against the request's tenant
// (getTenantSlug()). Keep them matching here so existing tests exercise authorization, not
// the tenant-binding check — that check gets its own dedicated test files.
const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
  // createUser checks the seat limit, which reads the tenant's plan (as mass-assignment.test.ts does).
  getTenantOrThrow: async () => ({
    id: 'test-tenant-id',
    slug: tenantState.requestSlug,
    name: 'Test Tenant',
    status: 'active',
    plan: 'trial',
    dbUrl: 'unused-in-this-test',
  }),
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
}));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

// No outbound email. List every export explicitly — do NOT use a catch-all Proxy here: a Proxy
// that returns a function for every key also answers `then`, so vitest's `await factory()` treats
// the mock as a never-resolving thenable and the whole run hangs during module loading.

import { createUser } from '@/server/actions/users';
import { createContract } from '@/server/actions/contracts';
import { createChargeCode } from '@/server/actions/charge-codes';
import { bulkImportContracts } from '@/server/actions/import';

describe('duplicate and import error messages (audit A5/A6)', () => {
  beforeEach(async () => {
    await cleanupTestData();
    const admin = await createTestUser({ role: 'admin' });
    sessionState.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('duplicate email → conflict "A user with that email already exists."', async () => {
    const existing = await createTestUser({ role: 'employee' });
    await expectFailure(createUser({ email: existing.email, fullName: 'Second Person' }), 'conflict', /^A user with that email already exists\.$/);
  });

  it('duplicate contract number → conflict "A contract with that number already exists."', async () => {
    const contract = await createTestContract();
    await expectFailure(createContract({ contractNumber: contract.contractNumber, name: 'Again' }), 'conflict', /^A contract with that number already exists\.$/);
  });

  it('duplicate charge code → conflict "A charge code with that code already exists."', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const code = await createTestChargeCode(clin.id);
    await expectFailure(createChargeCode({ code: code.code, name: 'Dup', clinId: clin.id }), 'conflict', /^A charge code with that code already exists\.$/);
  });

  it('a varchar overflow in a bulk-import row → the generic message, no SQL or params', async () => {
    const result = await expectOk(bulkImportContracts([
      { contractNumber: 'OVERFLOW-' + 'X'.repeat(80), name: 'Too long', type: 'prime', fundedValue: '', ceilingValue: '', startDate: '', endDate: '' },
    ]));
    expect(result.created).toBe(0);
    expect(result.errors).toEqual([{ row: 1, message: 'Could not import this row.' }]);
    expect(JSON.stringify(result)).not.toMatch(/insert into|params|OVERFLOW-X/i);
    void getTestDb;
  });
});
