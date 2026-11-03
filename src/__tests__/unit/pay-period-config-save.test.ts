import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * feature-plan-ux-page-fixes.md C7 (R1), unit companion to integration/period-lock-integrity.test.ts (T-C7d/e), runnable
 * without Postgres: updatePayPeriodConfig takes the advisory lock as the transaction's first statement and reads on it;
 * refuses a stale expectedPendingId; cancels (idempotently, without validating schedule fields); refuses or cancels on a
 * save of the current schedule; writes nothing when re-saving the pending change; returns the new pendingId; and runs
 * those checks before the immediate (null) branch.
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
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-01-15' }));

import * as dbModule from '@/db';
import { payPeriodConfig, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { updatePayPeriodConfig } from '@/server/actions/pay-period-config';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());

const D = (s: string) => s as CalendarDate;
const CURRENT = { periodType: 'semimonthly' as const, anchorDate: D('2026-01-01'), weekStartDay: 1 };
const BIWEEKLY = { periodType: 'biweekly' as const, anchorDate: D('2025-01-06'), weekStartDay: 1 };
const PENDING = { id: 'p2', ...BIWEEKLY, effectiveFrom: '2026-02-16', createdAt: new Date() };
/** The two payPeriodConfig reads, in order: the pending row (on tx, first), then the current config. */
const script = (pending: typeof PENDING | null) => {
  db.onSelect(payPeriodConfig, pending ? [pending] : []);
  db.onSelect(payPeriodConfig, [{ ...CURRENT, effectiveFrom: '1900-01-01', createdAt: new Date() }]);
};
const writes = () => db.ops.filter((o) => o === 'insert' || o === 'delete' || o === 'update');
const STALE = 'The scheduled change was updated by someone else. Reload the page to see it.';

describe('updatePayPeriodConfig (C7)', () => {
  it('the advisory lock on hashtext(pay_period_config) is the first statement, before any read', async () => {
    script(null);
    db.onReturning('insert', payPeriodConfig, [{ id: 'new' }]);
    await updatePayPeriodConfig({ ...BIWEEKLY, effectiveFrom: D('2026-02-16') });
    expect(db.ops[0]).toBe('execute');
    const q = new PgDialect().sqlToQuery(db.executes[0] as never);
    expect(q.sql).toBe("SELECT pg_advisory_xact_lock(hashtext('pay_period_config'))");
  });

  it('the scheduled path returns the new pending row id', async () => {
    script(null);
    db.onReturning('insert', payPeriodConfig, [{ id: 'new-id' }]);
    expect(await updatePayPeriodConfig({ ...BIWEEKLY, effectiveFrom: D('2026-02-16'), expectedPendingId: null }))
      .toEqual({ ok: true, data: { effectiveFrom: '2026-02-16', pendingId: 'new-id' } });
  });

  it('a stale expectedPendingId is refused with no writes (a different id, or null while one is pending)', async () => {
    script(PENDING);
    expect(await updatePayPeriodConfig({ ...BIWEEKLY, effectiveFrom: D('2026-03-16'), expectedPendingId: 'p1' })).toEqual({ ok: false, code: 'validation', error: STALE });
    expect(writes()).toEqual([]);
    db.reset();
    script(PENDING);
    expect(await updatePayPeriodConfig({ ...CURRENT, effectiveFrom: null, cancelPending: true, expectedPendingId: null })).toEqual({ ok: false, code: 'validation', error: STALE });
    expect(writes()).toEqual([]);
  });

  it('cancelPending skips schedule validation, deletes the pending change, and is idempotent', async () => {
    const cancel = { periodType: 'nonsense' as never, anchorDate: D('x'), weekStartDay: 99, effectiveFrom: null, cancelPending: true };
    script(PENDING);
    expect(await updatePayPeriodConfig({ ...cancel, expectedPendingId: 'p2' })).toEqual({ ok: true, data: { effectiveFrom: null, cancelledPending: true } });
    expect(writes()).toEqual(['delete']);
    db.reset();
    script(null);
    expect(await updatePayPeriodConfig(cancel)).toEqual({ ok: true, data: { effectiveFrom: null, cancelledPending: true } });
    expect(writes()).toEqual([]);                            // nothing pending: nothing deleted
  });

  it('cancelPending must be exactly true', async () => {
    script(null);
    const r = await updatePayPeriodConfig({ periodType: 'nonsense' as never, anchorDate: D('x'), weekStartDay: 99, effectiveFrom: null, cancelPending: 'yes' as never });
    expect(r).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/Period type must be one of/) });
  });

  it('saving the current schedule: refused with nothing pending; cancels a pending change', async () => {
    script(null);
    expect(await updatePayPeriodConfig({ ...CURRENT, anchorDate: D('2024-07-09'), effectiveFrom: D('2026-02-01') }))
      .toEqual({ ok: false, code: 'validation', error: 'This is already your pay schedule. Change a setting before saving.' });
    expect(writes()).toEqual([]);
    db.reset();
    script(PENDING);
    expect(await updatePayPeriodConfig({ ...CURRENT, effectiveFrom: D('2026-02-16') })).toEqual({ ok: true, data: { effectiveFrom: null, cancelledPending: true } });
    expect(writes()).toEqual(['delete']);
  });

  it('re-saving the pending change (an equivalent anchor) for its own date writes nothing', async () => {
    script(PENDING);
    expect(await updatePayPeriodConfig({ ...BIWEEKLY, anchorDate: D('2025-01-20'), effectiveFrom: D('2026-02-16'), expectedPendingId: 'p2' }))
      .toEqual({ ok: true, data: { effectiveFrom: '2026-02-16' } });
    expect(writes()).toEqual([]);
  });

  it('the checks run before the immediate branch: with timesheets, saving the current schedule still cancels', async () => {
    script(PENDING);
    db.onSelect(timesheetEntries, [{ id: 'e1' }]);           // would make the immediate path refuse
    expect(await updatePayPeriodConfig({ ...CURRENT, effectiveFrom: null })).toEqual({ ok: true, data: { effectiveFrom: null, cancelledPending: true } });
    expect(writes()).toEqual(['delete']);
  });

  it('the immediate path reads timesheets on the transaction and still refuses once they exist', async () => {
    script(null);
    db.onSelect(timesheetEntries, [{ id: 'e1' }]);
    expect(await updatePayPeriodConfig({ ...BIWEEKLY, effectiveFrom: null }))
      .toEqual({ ok: false, code: 'validation', error: 'Timesheets already exist, so a schedule change must start on a future date.' });
    expect(db.ops.indexOf('execute')).toBe(0);
  });
});
