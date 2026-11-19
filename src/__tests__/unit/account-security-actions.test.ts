import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

/**
 * SWEEP-FINDINGS.md §4 (session S1), with a scripted database (the users-admin-actions.test.ts harness):
 * A1-D2  adminResetPassword refuses the acting admin's own account (product owner, 2026-11-19, decision 1), in any case,
 *        before any read or write; another user is still reset.
 * A1-D3  changePassword, disableMFA and completeMFASetup key the lockout on the email READ FROM THE DATABASE, not the
 *        session's (stale after an email change): a wrong current password is recorded against the current email.
 * A1-G13 changePassword bumps sessionVersion (so other sessions end).
 * A1-G14 updateUser bumps sessionVersion in SQL on a role-only and on an active-only change; a name-only edit doesn't.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
const ADMIN = 'abcdef00-0000-4000-8000-000000000099';
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  // The session still carries the OLD email (the JWT isn't refreshed when the email changes).
  const admin = async () => ({ id: 'abcdef00-0000-4000-8000-000000000099', email: 'old@acme.test', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});
const reauthCalls = vi.hoisted(() => [] as string[]);
vi.mock('@/server/internal/login-attempts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/internal/login-attempts')>();
  return { ...real, verifyCurrentPassword: (...a: Parameters<typeof real.verifyCurrentPassword>) => { reauthCalls.push(a[1]); return real.verifyCurrentPassword(...a); } };
});
vi.mock('@/server/internal/seats', () => ({ assertSeatsAvailable: async () => {}, getSeatUsage: async () => ({ limit: null, currentActive: 1, plan: 'enterprise' }) }));
vi.mock('@/server/internal/submission-notify', () => ({ notifyReroutedApprovals: async () => {} }));
vi.mock('@/lib/tenant/context', () => ({ getTenantOrThrow: async () => ({ id: 'test-tenant-id', plan: 'enterprise' }) }));
vi.mock('@/server/internal/plan-source', () => ({ readPlanFresh: async () => 'enterprise' }));
vi.mock('@/lib/billing/seat-sync', () => ({ markSeatSyncDue: vi.fn(async () => {}) }));

import bcrypt from 'bcryptjs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import * as dbModule from '@/db';
import { loginAttempts, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { adminResetPassword, changePassword } from '@/server/actions/password';
import { completeMFASetup, disableMFA } from '@/server/actions/mfa';
import { updateUser } from '@/server/actions/users';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sqlText = (v: unknown) => (v instanceof SQL ? new PgDialect().sqlToQuery(v).sql : String(v));
const failedFor = () => db.inserts.filter((i) => i.table === loginAttempts).map((i) => [i.values.email, i.values.successful]);
const userUpdates = () => db.updates.filter((u) => u.table === users).map((u) => u.set);
let hash = '';
beforeAll(async () => { hash = await bcrypt.hash('right-password', 4); });
beforeEach(() => { db.reset(); reauthCalls.length = 0; });

describe('A1-D2: the admin password reset refuses your own account', () => {
  const OWN = 'To change your own password, use Change Password under Profile and security.';

  it('your own id → refused before any read or write (no session bump, no log)', async () => {
    expect(await adminResetPassword({ targetUserId: ADMIN, newPassword: 'brand-new-pass' })).toEqual({ ok: false, error: OWN, code: 'validation' });
    expect(db.ops).toEqual([]);
  });

  it('your own id in UPPER case is still yours (the id is validated and lower-cased first)', async () => {
    expect(await adminResetPassword({ targetUserId: ADMIN.toUpperCase(), newPassword: 'brand-new-pass' })).toMatchObject({ ok: false, error: OWN });
    expect(db.ops).toEqual([]);
  });

  it('a malformed id is refused as such; another user is still reset', async () => {
    expect(await adminResetPassword({ targetUserId: 'not-a-uuid', newPassword: 'brand-new-pass' })).toMatchObject({ ok: false, error: 'User is not a valid identifier.' });
    db.onReturning('update', users, [{ id: ID(8) }]);
    expect(await adminResetPassword({ targetUserId: ID(8), newPassword: 'brand-new-pass' })).toEqual({ ok: true, data: undefined });
    expect(userUpdates()).toHaveLength(1);
  });
});

describe('A1-D3: re-authentication counts failures against the email in the database', () => {
  // The row's email changed since sign-in: the session says old@acme.test, the database says new@acme.test.
  const row = () => ({ id: ADMIN, email: 'new@acme.test', passwordHash: hash });

  it('changePassword: a wrong current password is recorded against the current email', async () => {
    db.onSelect(users, [row()]);
    expect(await changePassword({ currentPassword: 'wrong-password', newPassword: 'another-pass-1' })).toMatchObject({ ok: false });
    expect(reauthCalls).toEqual(['new@acme.test']);
    expect(failedFor()).toEqual([['new@acme.test', false]]);
  });

  it('disableMFA: the same', async () => {
    db.onSelect(users, [row()]);
    expect(await disableMFA('wrong-password')).toMatchObject({ ok: false });
    expect(reauthCalls).toEqual(['new@acme.test']);
    expect(failedFor()).toEqual([['new@acme.test', false]]);
  });

  it('completeMFASetup: the same', async () => {
    db.onSelect(users, [row()]);
    expect(await completeMFASetup({ pendingSecret: 'JBSWY3DPEHPK3PXP', code: '000000', currentPassword: 'wrong-password' })).toMatchObject({ ok: false });
    expect(reauthCalls).toEqual(['new@acme.test']);
    expect(failedFor()).toEqual([['new@acme.test', false]]);
  });
});

describe('A1-G13: changePassword bumps sessionVersion', () => {
  it('the new hash and sessionVersion + 1 are written together', async () => {
    db.onSelect(users, [{ id: ADMIN, email: 'new@acme.test', passwordHash: hash }]);
    db.onSelect(users, [{ sessionVersion: 4 }]);
    expect(await changePassword({ currentPassword: 'right-password', newPassword: 'another-pass-1' })).toEqual({ ok: true, data: undefined });
    const [set] = userUpdates();
    expect(set.sessionVersion).toBe(5);
    expect(await bcrypt.compare('another-pass-1', set.passwordHash as string)).toBe(true);
  });
});

describe('A1-G14: updateUser bumps sessionVersion on a role or active change only', () => {
  const safe = (o: Record<string, unknown>) => ({ id: ID(3), email: 'p@x', fullName: 'Pat', role: 'employee', isActive: true, flsaExempt: false, approverId: null, createdAt: new Date(), updatedAt: new Date(), ...o });

  it('role only (employee → admin): sessionVersion = session_version + 1, in SQL', async () => {
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: false }]);
    db.onReturning('update', users, [safe({ role: 'admin' })]);
    expect(await updateUser(ID(3), { role: 'admin' })).toMatchObject({ ok: true });
    expect(sqlText(userUpdates()[0].sessionVersion)).toMatch(/"session_version" \+ 1/);
  });

  it('active only (deactivate): the same', async () => {
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: false }]);
    db.onReturning('update', users, [safe({ isActive: false })]);
    expect(await updateUser(ID(3), { isActive: false })).toMatchObject({ ok: true });
    expect(sqlText(userUpdates()[0].sessionVersion)).toMatch(/"session_version" \+ 1/);
  });

  it('a name-only edit leaves sessionVersion alone', async () => {
    db.onSelect(users, [{ role: 'employee', isActive: true, flsaExempt: false }]);
    db.onReturning('update', users, [safe({ fullName: 'Pat Dee' })]);
    expect(await updateUser(ID(3), { fullName: 'Pat Dee' })).toMatchObject({ ok: true });
    expect(userUpdates()[0]).not.toHaveProperty('sessionVersion');
  });
});
