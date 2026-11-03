import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §10 C-5, unit companion to integration/contracts-overview.test.ts, runnable without
 * Postgres (a scripted database): runtime status/type checks; unknown ids → not_found; non-UUID → validation before any
 * write; closed or inactive parents refuse new CLINs / SLINs; the saved row is returned.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import * as dbModule from '@/db';
import { contracts, clins, slins } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { updateContract, createContract } from '@/server/actions/contracts';
import { createClin, updateClin } from '@/server/actions/clins';
import { createSlin, updateSlin } from '@/server/actions/slins';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const ID = '44444444-4444-4444-8444-444444444444';
const writes = () => db.ops.filter((o) => o !== 'select');

describe('contracts hardening (C-5 companion)', () => {
  it('updateContract: invalid status and type are refused before any write; a non-UUID id → validation', async () => {
    expect(await updateContract(ID, { status: 'archived' as never })).toEqual({ ok: false, code: 'validation', error: 'Invalid contract status.' });
    expect(await updateContract(ID, { contractType: 'joint' })).toEqual({ ok: false, code: 'validation', error: 'Invalid contract type.' });
    expect(await updateContract('nope', { name: 'x' })).toEqual({ ok: false, code: 'validation', error: 'Contract is not a valid identifier.' });
    expect(writes()).toEqual([]);
    expect(await createContract({ contractNumber: 'N-1', name: 'X', contractType: 'joint' })).toEqual({ ok: false, code: 'validation', error: 'Invalid contract type.' });
  });

  it('updateContract: no row updated → not_found; otherwise the saved row', async () => {
    expect(await updateContract(ID, { name: 'x' })).toEqual({ ok: false, code: 'not_found', error: 'That contract no longer exists.' });
    db.onReturning('update', contracts, [{ id: ID, status: 'closed' }]);
    expect(await updateContract(ID, { status: 'closed' })).toEqual({ ok: true, data: { id: ID, status: 'closed' } });
  });

  it('createClin: unknown / closed / non-UUID parents refused; an active contract → the saved row', async () => {
    expect(await createClin({ contractId: 'nope', clinNumber: '0001' })).toMatchObject({ ok: false, code: 'validation' });
    db.onSelect(contracts, []);
    expect(await createClin({ contractId: ID, clinNumber: '0001' })).toEqual({ ok: false, code: 'not_found', error: 'That contract no longer exists.' });
    db.onSelect(contracts, [{ status: 'closed' }]);
    expect(await createClin({ contractId: ID, clinNumber: '0001' })).toEqual({ ok: false, code: 'validation', error: "This contract isn't active. Reopen it before adding CLINs." });
    expect(writes()).toEqual([]);
    db.onSelect(contracts, [{ status: 'active' }]);
    db.onReturning('insert', clins, [{ id: 'c1', clinNumber: '0001' }]);
    expect(await createClin({ contractId: ID, clinNumber: '0001' })).toEqual({ ok: true, data: { id: 'c1', clinNumber: '0001' } });
  });

  it('createSlin: the CLIN or its contract inactive → refused; unknown → not_found; active → the saved row', async () => {
    db.onSelect(clins, [{ clinStatus: 'active', contractStatus: 'closed' }]);
    expect(await createSlin({ clinId: ID, slinNumber: 'AA' })).toEqual({ ok: false, code: 'validation', error: "This CLIN or its contract isn't active." });
    db.onSelect(clins, [{ clinStatus: 'inactive', contractStatus: 'active' }]);
    expect(await createSlin({ clinId: ID, slinNumber: 'AA' })).toEqual({ ok: false, code: 'validation', error: "This CLIN or its contract isn't active." });
    db.onSelect(clins, []);
    expect(await createSlin({ clinId: ID, slinNumber: 'AA' })).toEqual({ ok: false, code: 'not_found', error: 'That CLIN no longer exists.' });
    expect(await createSlin({ clinId: 'nope', slinNumber: 'AA' })).toMatchObject({ ok: false, code: 'validation' });
    expect(writes()).toEqual([]);
    db.onSelect(clins, [{ clinStatus: 'active', contractStatus: 'active' }]);
    db.onReturning('insert', slins, [{ id: 's1' }]);
    expect(await createSlin({ clinId: ID, slinNumber: 'AA' })).toEqual({ ok: true, data: { id: 's1' } });
  });

  it('updateClin / updateSlin: non-UUID → validation; no row → not_found', async () => {
    expect(await updateClin('nope', { description: 'x' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await updateSlin('nope', { description: 'x' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await updateClin(ID, { description: 'x' })).toEqual({ ok: false, code: 'not_found', error: 'That CLIN no longer exists.' });
    expect(await updateSlin(ID, { description: 'x' })).toEqual({ ok: false, code: 'not_found', error: 'That SLIN no longer exists.' });
  });
});
