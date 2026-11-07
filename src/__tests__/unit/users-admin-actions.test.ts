import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §5.1, R5–R7 — US-1 and unit companions to integration US-3 … US-6 (a scripted database):
 * US-1 getUsersForAdminPage: mfaEnabled (a boolean, never a secret), the lock from ONE login_attempts query, the
 *      server-computed approver; getUsers runs no lock query.
 * US-3 adminResetMfa: yourself refused before any read (no attempt used); a wrong admin password → "That password isn't
 *      right." and a failed attempt recorded; success clears the secret, recovery codes and last step, turns it off,
 *      bumps the session in SQL and logs mfa_reset once; already off → { changed: false }, no write.
 * US-4 updateUser logs only what changed (a promotion to supervisor lists the active CLIN ids); a name-only edit logs nothing.
 * US-5 createUserWithPassword: no overtime choice, a short password, an approver for an employee → refused before any
 *      read; logs created (+ approver_changed with an approver).
 * US-6 adminResetPassword bumps the session in SQL and logs password_reset; bulkImportEmployees logs created per user.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  // UX-4C1-AUDIT.md M2: the callback gets a DISTINCT tx whose writes are tagged `via: 'tx'`, so a change or log written
  // through `db` (outside the transaction, surviving a rollback) is caught.
  type W = { values: (v: Record<string, unknown>) => unknown };
  type U = { set: (v: Record<string, unknown>) => unknown };
  const tagged = (list: () => object[], write: () => unknown) => { const r = write(); (list()[list().length - 1] as { via?: string }).via = 'tx'; return r; };
  const tx = {
    select: (f?: unknown) => db.select(f),
    execute: (q: unknown) => db.execute(q),
    insert: (t: unknown) => ({ values: (v: Record<string, unknown>) => tagged(() => db.inserts, () => (db.insert(t) as W).values(v)) }),
    update: (t: unknown) => ({ set: (v: Record<string, unknown>) => tagged(() => db.updates, () => (db.update(t) as U).set(v)) }),
    delete: (t: unknown) => tagged(() => db.deletes, () => db.delete(t)),
    transaction: async (cb: (t: unknown) => unknown) => cb(tx),
  };
  db.transaction = async (cb) => cb(tx);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'abcdef00-0000-4000-8000-000000000099', email: 'stale@x', fullName: 'Ann', role: 'admin' });   // hex letters: L1
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});
// UX-4C1-AUDIT.md L2: a test can replace the re-auth result (e.g. a reworded message with the same reason).
const reauth = vi.hoisted(() => ({ override: null as null | (() => Promise<unknown>) }));
vi.mock('@/server/internal/login-attempts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/internal/login-attempts')>();
  return { ...real, verifyCurrentPassword: (...a: Parameters<typeof real.verifyCurrentPassword>) => (reauth.override ? reauth.override() : real.verifyCurrentPassword(...a)) };
});
vi.mock('@/server/internal/seats', () => ({ assertSeatsAvailable: async () => {}, getSeatUsage: async () => ({ limit: null, currentActive: 1, planLabel: 'x' }) }));
vi.mock('@/server/internal/submission-notify', () => ({ notifyReroutedApprovals: async () => {} }));

import bcrypt from 'bcryptjs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import * as dbModule from '@/db';
import { adminChangeLog, loginAttempts, userAssignments, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { createUserWithPassword, getUsers, getUsersForAdminPage, updateUser } from '@/server/actions/users';
import { adminResetMfa } from '@/server/actions/mfa';
import { adminResetPassword } from '@/server/actions/password';
import { bulkImportEmployees } from '@/server/actions/import';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => { db.reset(); reauth.override = null; });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = 'abcdef00-0000-4000-8000-000000000099';
const logs = () => db.inserts.filter((i) => i.table === adminChangeLog).map((i) => i.values as { action: string; entityId: string; oldValue: unknown; newValue: unknown });
/** M2: every admin_change_log insert and every users update went through the transaction's tx. */
const viaTx = () => [...db.inserts.filter((i) => i.table === adminChangeLog), ...db.updates.filter((u) => u.table === users)].map((w) => (w as { via?: string }).via ?? 'db');
const sqlText = (v: unknown) => (v instanceof SQL ? new PgDialect().sqlToQuery(v).sql : String(v));
let adminHash = '';
beforeAll(async () => { adminHash = await bcrypt.hash('right-password', 4); });

describe('getUsersForAdminPage (US-1)', () => {
  it('mfaEnabled, lock (one login_attempts query) and approverName; getUsers runs no lock query', async () => {
    const row = (id: string, fullName: string, o: Record<string, unknown> = {}) => ({ id, email: `${id}@x`, fullName, role: 'employee', isActive: true, flsaExempt: false, approverId: null, createdAt: new Date(), updatedAt: new Date(), mfaEnabled: false, ...o });
    db.onSelect(users, [row('a', 'Ann', { role: 'admin', mfaEnabled: true }), row('s', 'Sam', { role: 'supervisor', approverId: 'a' }), row('j', 'John')]);
    const now = Date.now();
    db.onSelect(loginAttempts, Array.from({ length: 5 }, (_, i) => ({ email: 'j@x', successful: false, attemptedAt: new Date(now - 60_000 - i * 1000) })));
    const out = await getUsersForAdminPage();
    expect(out.map((u) => [u.fullName, u.mfaEnabled, u.lock?.minutesRemaining ?? null, u.approverName])).toEqual([
      ['Ann', true, null, null], ['Sam', false, null, 'Ann'], ['John', false, 13, null],
    ]);
    expect(db.ops.filter((o) => o === 'select')).toHaveLength(2);
    expect(Object.keys(out[0])).not.toContain('totpSecret');
    db.reset();
    db.onSelect(users, [row('j', 'John')]);
    await getUsers();
    expect(db.ops.filter((o) => o === 'select')).toHaveLength(1);
  });
});

describe('getUsersForAdminPage approver (M4)', () => {
  it('the approvals rule: an inactive or non-approver designee → null ("admins"); an employee never shows one', async () => {
    const row = (id: string, role: string, approverId: string | null, isActive = true) => ({ id, email: `${id}@x`, fullName: id.toUpperCase(), role, isActive, flsaExempt: false, approverId, createdAt: new Date(), updatedAt: new Date(), mfaEnabled: false });
    db.onSelect(users, [
      row('ann', 'admin', null), row('gone', 'admin', null, false), row('emp', 'employee', 'ann'),
      row('s1', 'supervisor', 'gone'), row('s2', 'supervisor', 'emp'), row('s3', 'supervisor', 'ann'), row('a2', 'admin', 'a2'),
    ]);
    const out = await getUsersForAdminPage();
    expect(Object.fromEntries(out.map((u) => [u.id, u.approverName]))).toEqual({ ann: null, gone: null, emp: null, s1: null, s2: null, s3: 'ANN', a2: null });
  });
});

describe('adminResetMfa (US-3 companion)', () => {
  it('yourself → refused before any read or attempt', async () => {
    expect(await adminResetMfa({ userId: ADMIN, currentPassword: 'right-password' })).toMatchObject({ ok: false, error: 'Use your profile to turn off two-step sign-in.' });
    expect(db.ops).toEqual([]);
  });

  it('L1: yourself in UPPER case is still yourself — adminResetMfa and updateUser refuse before any read', async () => {
    expect(await adminResetMfa({ userId: ADMIN.toUpperCase(), currentPassword: 'right-password' })).toMatchObject({ ok: false, error: 'Use your profile to turn off two-step sign-in.' });
    expect(await updateUser(ADMIN.toUpperCase(), { role: 'employee' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await updateUser(ADMIN.toUpperCase(), { isActive: false })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await updateUser('not-a-uuid', { fullName: 'X' })).toMatchObject({ ok: false, error: 'User is not a valid identifier.' });
    expect(db.ops).toEqual([]);
  });

  it('a wrong admin password → "That password isn\'t right." and a failed attempt recorded; nothing changed', async () => {
    db.onSelect(users, [{ email: 'admin@x', passwordHash: adminHash }]);
    expect(await adminResetMfa({ userId: ID(2), currentPassword: 'nope' })).toMatchObject({ ok: false, error: "That password isn't right." });
    expect(db.inserts.filter((i) => i.table === loginAttempts).map((i) => i.values)).toEqual([expect.objectContaining({ email: 'admin@x', successful: false })]);
    expect(db.updates).toEqual([]);
  });

  it('L2: maps on the reason, not the message — "wrong" → "That password isn\'t right."; "locked" keeps its own words', async () => {
    db.onSelect(users, [{ email: 'admin@x', passwordHash: adminHash }]);
    reauth.override = async () => ({ ok: false, reason: 'wrong', error: 'The password you typed is wrong.' });
    expect(await adminResetMfa({ userId: ID(2), currentPassword: 'x' })).toMatchObject({ ok: false, error: "That password isn't right." });
    db.onSelect(users, [{ email: 'admin@x', passwordHash: adminHash }]);
    reauth.override = async () => ({ ok: false, reason: 'locked', error: 'Too many failed attempts. Try again in 3 minutes.' });
    expect(await adminResetMfa({ userId: ID(2), currentPassword: 'x' })).toMatchObject({ ok: false, error: 'Too many failed attempts. Try again in 3 minutes.' });
  });

  it('success: clears the three fields, turns it off, bumps the session in SQL, logs mfa_reset once; already off → no write', async () => {
    db.onSelect(users, [{ email: 'admin@x', passwordHash: adminHash }]);
    db.onSelect(users, [{ totpEnabled: true }]);
    expect(await adminResetMfa({ userId: ID(2), currentPassword: 'right-password' })).toEqual({ ok: true, data: { changed: true } });
    const set = db.updates[0].set as Record<string, unknown>;
    expect(set).toMatchObject({ totpSecret: null, totpRecoveryCodes: null, totpLastUsedStep: null, totpEnabled: false });
    expect(sqlText(set.sessionVersion)).toMatch(/"session_version" \+ 1/);
    expect(logs().map((l) => [l.action, l.entityId])).toEqual([['mfa_reset', ID(2)]]);
    expect(viaTx()).toEqual(['tx', 'tx']);                                             // M2: the log and the change, in the transaction
    db.reset();
    db.onSelect(users, [{ email: 'admin@x', passwordHash: adminHash }]);
    db.onSelect(users, [{ totpEnabled: false }]);
    expect(await adminResetMfa({ userId: ID(2), currentPassword: 'right-password' })).toEqual({ ok: true, data: { changed: false } });
    expect(db.updates).toEqual([]);
    expect(logs()).toEqual([]);
  });
});

describe('updateUser logs (US-4 companion)', () => {
  const safe = (o: Record<string, unknown>) => ({ id: ID(3), email: 'p@x', fullName: 'Pat', role: 'employee', isActive: true, flsaExempt: false, approverId: null, createdAt: new Date(), updatedAt: new Date(), ...o });

  it('a promotion to supervisor logs role_changed with their active CLIN ids', async () => {
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: false }]);   // the old values
    db.onReturning('update', users, [safe({ role: 'supervisor' })]);
    db.onSelect(userAssignments, []);                                                  // loadApprovalFacts (before the update)
    db.onSelect(userAssignments, [{ clinId: 'clin-b' }, { clinId: 'clin-a' }]);
    expect(await updateUser(ID(3), { role: 'supervisor' })).toMatchObject({ ok: true });
    expect(logs().map((l) => [l.action, l.oldValue, l.newValue])).toEqual([['role_changed', { role: 'employee' }, { role: 'supervisor', clinIds: ['clin-a', 'clin-b'] }]]);
    expect(viaTx()).toEqual(['tx', 'tx']);                                             // M2
  });

  it('overtime and active state log their own action; a name-only edit logs nothing; a missing user is not_found', async () => {
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: false }]);
    db.onReturning('update', users, [safe({ flsaExempt: true })]);
    await updateUser(ID(3), { flsaExempt: true });
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: true }]);
    db.onReturning('update', users, [safe({ isActive: false })]);
    await updateUser(ID(3), { isActive: false });
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: true }]);
    db.onReturning('update', users, [safe({ fullName: 'Pat Dee' })]);
    await updateUser(ID(3), { fullName: 'Pat Dee' });
    expect(logs().map((l) => [l.action, l.oldValue, l.newValue])).toEqual([
      ['flsa_changed', { flsaExempt: false }, { flsaExempt: true }],
      ['deactivated', { isActive: true }, { isActive: false }],
    ]);
    expect(viaTx()).toEqual(['tx', 'tx', 'tx', 'tx', 'tx']);                          // M2: two logs, three updates
    expect(await updateUser(ID(9), { fullName: 'X' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('createUserWithPassword (US-5 companion)', () => {
  const base = { email: 'n@x.test', fullName: 'New Person', role: 'employee' as const, password: 'long-enough', flsaExempt: false };

  it('no overtime choice, a short password, an approver for an employee → refused before any read', async () => {
    expect(await createUserWithPassword({ ...base, flsaExempt: undefined as never })).toMatchObject({ ok: false, error: 'Choose an overtime status.' });
    expect(await createUserWithPassword({ ...base, password: 'short' })).toMatchObject({ ok: false, error: 'Password must be at least 8 characters.' });
    expect(await createUserWithPassword({ ...base, approverId: ID(4) })).toMatchObject({ ok: false, error: expect.stringContaining('Approvers can be designated for supervisors and admins only') });
    expect(db.ops).toEqual([]);
  });

  it('logs created (role, overtime) — and approver_changed when a supervisor gets an approver', async () => {
    db.onReturning('insert', users, [{ id: ID(5), fullName: 'New Person', role: 'employee', flsaExempt: true }]);
    expect(await createUserWithPassword({ ...base, flsaExempt: true })).toMatchObject({ ok: true });
    expect(logs().map((l) => [l.action, l.entityId, l.newValue])).toEqual([['created', ID(5), { role: 'employee', flsaExempt: true }]]);
    expect(viaTx()).toEqual(['tx']);                                                    // M2
    db.reset();
    db.onSelect(users, [{ role: 'admin', isActive: true }]);                         // the approver
    db.onReturning('insert', users, [{ id: ID(6), fullName: 'Sup', role: 'supervisor', flsaExempt: false }]);
    expect(await createUserWithPassword({ ...base, role: 'supervisor', approverId: ID(4) })).toMatchObject({ ok: true });
    expect(logs().map((l) => [l.action, l.newValue])).toEqual([['created', { role: 'supervisor', flsaExempt: false }], ['approver_changed', { approverId: ID(4) }]]);
    expect(db.inserts.find((i) => i.table === users)!.values).toMatchObject({ flsaExempt: false, approverId: ID(4) });
  });
});

describe('adminResetPassword and the import (US-6 companion)', () => {
  it('adminResetPassword: the session bump is SQL, password_reset is logged; a missing user is not_found', async () => {
    db.onReturning('update', users, [{ id: ID(8) }]);
    expect(await adminResetPassword({ targetUserId: ID(8), newPassword: 'brand-new-pass' })).toMatchObject({ ok: true });
    expect(sqlText((db.updates[0].set as Record<string, unknown>).sessionVersion)).toMatch(/"session_version" \+ 1/);
    expect(logs().map((l) => [l.action, l.entityId])).toEqual([['password_reset', ID(8)]]);
    expect(viaTx()).toEqual(['tx', 'tx']);                                             // M2
    db.reset();
    expect(await adminResetPassword({ targetUserId: ID(9), newPassword: 'brand-new-pass' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(logs()).toEqual([]);
  });

  it('bulkImportEmployees logs created per inserted user', async () => {
    db.onReturning('insert', users, [{ id: ID(10) }]);
    db.onReturning('insert', users, [{ id: ID(11) }]);
    const r = await bulkImportEmployees([{ email: 'a@x.test', name: 'A', role: 'employee', flsaExempt: 'yes' }, { email: 'b@x.test', name: 'B', role: 'supervisor' }] as never);
    expect(r).toMatchObject({ ok: true, data: { created: 2 } });
    expect(logs().map((l) => [l.action, l.entityId, l.newValue])).toEqual([
      ['created', ID(10), { role: 'employee', flsaExempt: true }],
      ['created', ID(11), { role: 'supervisor', flsaExempt: false }],
    ]);
  });
});
