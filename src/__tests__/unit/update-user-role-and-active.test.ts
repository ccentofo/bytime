import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-blockers audit R4: `updateUser` refuses a role change and an active-status change in the same call. Together
 * (e.g. `{ isActive: true, role: 'employee' }`) the reactivation branch locks the target row before the admin rows —
 * the opposite of the last-admin lock order (A3). The UI never sends both. The refusal happens before any transaction.
 */

const h = vi.hoisted(() => ({ transactions: 0 }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'pat@acme.com', fullName: 'Pat', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin, requireApprover: admin, requireApproverFresh: admin };
});
// feature-plan-per-user-billing.md §10.1: the seat-taking actions read the plan fresh and the tenant id before their
// transaction, and mark the seat sync due after it (top-level mocks: vitest hoists vi.mock to the file top).
vi.mock('@/lib/tenant/context', () => ({ getTenantOrThrow: async () => ({ id: 'test-tenant-id', plan: 'enterprise' }) }));
vi.mock('@/server/internal/plan-source', () => ({ readPlanFresh: async () => 'enterprise' }));
vi.mock('@/lib/billing/seat-sync', () => ({ markSeatSyncDue: vi.fn(async () => {}) }));
vi.mock('@/db', () => {
  const db = { transaction: async () => { h.transactions++; throw new Error('transaction reached'); } };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

import { updateUser } from '@/server/actions/users';

beforeEach(() => { h.transactions = 0; });

describe('updateUser: role and isActive in one call (audit R4)', () => {
  it.each([
    [{ isActive: true, role: 'employee' as const }],
    [{ isActive: false, role: 'supervisor' as const }],
    [{ isActive: true, role: 'admin' as const }],
  ])('%j → refused (validation), no transaction', async (data) => {
    expect(await updateUser('00000000-0000-4000-8000-000000000002', data)).toEqual({ ok: false, code: 'validation', error: 'Change the role and the active status separately.' });
    expect(h.transactions).toBe(0);
  });

  it('either change alone still reaches the transaction', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await updateUser('00000000-0000-4000-8000-000000000002', { role: 'employee' }).catch(() => undefined);
    await updateUser('00000000-0000-4000-8000-000000000002', { isActive: true }).catch(() => undefined);
    spy.mockRestore();
    expect(h.transactions).toBe(2);
  });
});
