import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §4.2, §4.4, unit companion to integration AS-3 / AS-8 (a scripted database):
 * assignChargeCodesToUser refuses an inactive person and, when one code isn't chargeable, writes nothing; codes already
 * held are skipped (assigned counts the rest, which also upsert the CLIN row); inputs are validated before any read.
 * assignUserToClin refuses an inactive person and a non-supervisor, and never writes a SLIN.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
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
import { chargeCodes, clins, userAssignments, userChargeCodes, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { assignChargeCodesToUser } from '@/server/actions/charge-codes';
import { assignUserToClin } from '@/server/actions/assignments';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = ID(1), A = ID(11), B = ID(12), C = ID(13);

describe('assignChargeCodesToUser (AS-3 companion)', () => {
  it('an inactive person is refused before any code is read', async () => {
    db.onSelect(users, [{ isActive: false }]);
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: [A] })).toMatchObject({ ok: false, error: 'Choose an active person.' });
    expect(db.inserts).toEqual([]);
  });

  it('one code that can\'t be charged → nothing written, the code named', async () => {
    db.onSelect(users, [{ isActive: true }]);
    db.onSelect(chargeCodes, [{ id: A, code: 'NAV-1', chargeable: true }, { id: B, code: 'OLD-9', chargeable: false }]);
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: [A, B] })).toMatchObject({ ok: false, error: "OLD-9 can't be charged right now. Refresh and try again." });
    db.onSelect(users, [{ isActive: true }]);
    db.onSelect(chargeCodes, [{ id: A, code: 'NAV-1', chargeable: true }]);          // C no longer exists
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: [A, C] })).toMatchObject({ ok: false, error: "A charge code can't be charged right now. Refresh and try again." });
    expect(db.inserts).toEqual([]);
  });

  it('codes already held are skipped; the rest are assigned (with their CLIN row); assigned counts them; ids deduped', async () => {
    db.onSelect(users, [{ isActive: true }]);
    db.onSelect(chargeCodes, [{ id: A, code: 'NAV-1', chargeable: true }, { id: B, code: 'NAV-2', chargeable: true }]);
    db.onSelect(userChargeCodes, [{ chargeCodeId: A }]);
    db.onSelect(chargeCodes, [{ clinId: ID(21), slinId: null }]);                      // assignChargeCodeToUserInternal(B)
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: [A, B, B] })).toEqual({ ok: true, data: { assigned: 1 } });
    expect(db.inserts.map((i) => [i.table === userChargeCodes ? 'ucc' : i.table === userAssignments ? 'ua' : '?', (i.values as { chargeCodeId?: string; clinId?: string }).chargeCodeId ?? (i.values as { clinId?: string }).clinId])).toEqual([
      ['ucc', B], ['ua', ID(21)],
    ]);
  });

  it('validation before any read: no person, no codes, non-UUIDs, more than 200', async () => {
    expect(await assignChargeCodesToUser({ userId: '', chargeCodeIds: [A] })).toMatchObject({ ok: false, error: 'Choose a person.' });
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: [] })).toMatchObject({ ok: false, error: 'Choose at least one charge code.' });
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: ['nope'] })).toMatchObject({ ok: false });
    expect(await assignChargeCodesToUser({ userId: U, chargeCodeIds: Array.from({ length: 201 }, (_, i) => ID(1000 + i)) })).toMatchObject({ ok: false, error: 'Choose 200 charge codes or fewer at a time.' });
    expect(db.ops).toEqual([]);
  });
});

describe('assignUserToClin (AS-8 companion)', () => {
  it('refuses an inactive person and a non-supervisor; a missing CLIN is not found; writes no SLIN', async () => {
    db.onSelect(users, [{ role: 'supervisor', isActive: false }]);
    expect(await assignUserToClin({ userId: U, clinId: A })).toMatchObject({ ok: false, error: 'Choose an active supervisor.' });
    db.onSelect(users, [{ role: 'employee', isActive: true }]);
    expect(await assignUserToClin({ userId: U, clinId: A })).toMatchObject({ ok: false, error: 'Choose an active supervisor.' });
    db.onSelect(users, [{ role: 'supervisor', isActive: true }]);
    db.onSelect(clins, []);
    expect(await assignUserToClin({ userId: U, clinId: A })).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.inserts).toEqual([]);
    db.onSelect(users, [{ role: 'supervisor', isActive: true }]);
    db.onSelect(clins, [{ id: A }]);
    db.onReturning('insert', userAssignments, [{ id: 'ua' }]);
    expect(await assignUserToClin({ userId: U, clinId: A, slinId: B } as never)).toMatchObject({ ok: true });
    expect(db.inserts[0].values).toMatchObject({ userId: U, clinId: A, slinId: null });
  });
});
