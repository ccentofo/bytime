import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §4.2, §4.4, unit companion to integration AS-3 / AS-8 (a scripted database):
 * assignChargeCodesToUser refuses an inactive person and, when one code isn't chargeable, writes nothing; codes already
 * held are skipped (assigned counts the rest, which also upsert the CLIN row); inputs are validated before any read.
 * grantApprovalScope (feature-plan-approval-scope.md AS-7 companion) takes the lock FIRST, then refuses an inactive
 * person and a non-supervisor before any write.
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
import { adminChangeLog, chargeCodes, userAssignments, userChargeCodes, users } from '@/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { assignChargeCodesToUser, unassignChargeCodeFromUser } from '@/server/actions/charge-codes';
import { grantApprovalScope } from '@/server/actions/assignments';

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
    expect(db.inserts.map((i) => [i.table === userChargeCodes ? 'ucc' : i.table === userAssignments ? 'ua' : i.table === adminChangeLog ? 'log' : '?', (i.values as { chargeCodeId?: string; clinId?: string }).chargeCodeId ?? (i.values as { clinId?: string }).clinId])).toEqual([
      ['ucc', B], ['ua', ID(21)], ['log', undefined],
    ]);
    // SWEEP-FINDINGS.md A3-D9 (PO decision 4): one log row per NEWLY assigned code (B), none for the held code (A),
    // who and what, through the same transaction client.
    expect(db.inserts.filter((i) => i.table === adminChangeLog).map((i) => i.values)).toEqual([
      { actorId: 'admin-1', entity: 'user_charge_code', entityId: U, action: 'assigned', oldValue: null, newValue: { chargeCodeId: B } },
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

describe('grantApprovalScope (AS-7 companion)', () => {
  const lockSql = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
  it('the user-rules lock comes first; an inactive person or a non-supervisor is refused after it, with nothing written', async () => {
    db.onSelect(users, []);                                                        // the eligibility snapshot's facts
    db.onSelect(users, [{ role: 'supervisor', isActive: false }]);
    expect(await grantApprovalScope({ supervisorId: U, clinIds: [A] })).toMatchObject({ ok: false, error: 'Choose an active supervisor.' });
    expect(db.ops[0]).toBe('execute');
    expect(lockSql(db.executes[0])).toContain('pg_advisory_xact_lock(');
    expect(db.inserts).toEqual([]);
    db.reset();
    db.onSelect(users, []);
    db.onSelect(users, [{ role: 'employee', isActive: true }]);
    expect(await grantApprovalScope({ supervisorId: U, clinIds: [A] })).toMatchObject({ ok: false, error: 'Choose an active supervisor.' });
    expect(db.inserts).toEqual([]);
  });

  it('inputs are validated before any read: no CLINs, too many, a bad id', async () => {
    expect(await grantApprovalScope({ supervisorId: U, clinIds: [] })).toMatchObject({ ok: false, error: 'Choose at least one CLIN.' });
    expect(await grantApprovalScope({ supervisorId: U, clinIds: Array.from({ length: 201 }, (_, i) => ID(100 + i)) })).toMatchObject({ ok: false, error: 'Choose 200 CLINs or fewer at a time.' });
    expect(await grantApprovalScope({ supervisorId: U, clinIds: ['nope'] })).toMatchObject({ ok: false });
    expect(await grantApprovalScope({ supervisorId: '', clinIds: [A] })).toMatchObject({ ok: false, error: 'Choose an active supervisor.' });
    expect(db.ops).toEqual([]);
  });
});

describe('unassignChargeCodeFromUser (SWEEP-FINDINGS.md A3-D9)', () => {
  it('ends an active assignment and logs the removal (who, person, code) in the same transaction', async () => {
    db.onReturning('update', userChargeCodes, [{ userId: U }]);
    expect(await unassignChargeCodeFromUser(U, A)).toEqual({ ok: true, data: undefined });
    expect(db.updates.map((u) => [u.table === userChargeCodes, u.set])).toEqual([[true, { isActive: false }]]);
    const where = new PgDialect().sqlToQuery(db.updates[0].where as never);
    expect(where.sql).toContain('"is_active" = $3'); // only an ACTIVE assignment counts as removed
    expect(where.params).toEqual([U, A, true]);
    expect(db.inserts.map((i) => [i.table === adminChangeLog, i.values])).toEqual([
      [true, { actorId: 'admin-1', entity: 'user_charge_code', entityId: U, action: 'removed', oldValue: { chargeCodeId: A, isActive: true }, newValue: { chargeCodeId: A, isActive: false } }],
    ]);
  });

  it('nothing to end (not assigned, or already removed) → still ok, and nothing logged', async () => {
    db.onReturning('update', userChargeCodes, []);
    expect(await unassignChargeCodeFromUser(U, A)).toEqual({ ok: true, data: undefined });
    expect(db.inserts).toEqual([]);
  });

  it('malformed ids are refused before any write (not a database error)', async () => {
    expect(await unassignChargeCodeFromUser('nope', A)).toMatchObject({ ok: false, error: 'Person is not a valid identifier.' });
    expect(await unassignChargeCodeFromUser(U, 'x')).toMatchObject({ ok: false, error: 'Charge code is not a valid identifier.' });
    expect(db.ops).toEqual([]);
  });
});
