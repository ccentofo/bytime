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
    expect(await updateUser('user-2', data)).toEqual({ ok: false, code: 'validation', error: 'Change the role and the active status separately.' });
    expect(h.transactions).toBe(0);
  });

  it('either change alone still reaches the transaction', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await updateUser('user-2', { role: 'employee' }).catch(() => undefined);
    await updateUser('user-2', { isActive: true }).catch(() => undefined);
    spy.mockRestore();
    expect(h.transactions).toBe(2);
  });
});
