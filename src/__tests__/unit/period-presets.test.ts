import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §3.8 / K-10, unit companion to integration/period-presets.test.ts, runnable without
 * Postgres (a scripted schedule and contract): this / last / lastN periods (completed only, across a schedule change),
 * thisMonth, contractToDate (start date, earliest entry, neither, a future start clamped; admins only), allTime, and a
 * custom range refused when start > end.
 */

const h = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'supervisor' }));
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
  const user = async () => ({ id: 'u-1', email: 'a@x', fullName: 'Ann', role: h.role });
  return {
    AuthorizationError, requireSession: user, requireApprover: user, requireApproverFresh: user, getEmployeeScope: async () => 'all',
    requireAdmin: async () => { if (h.role !== 'admin') throw new AuthorizationError('forbidden', 'Forbidden'); return user(); },
  };
});
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-12-15', getWorkspaceTimezone: async () => 'America/New_York' }));

import * as dbModule from '@/db';
import { contracts, payPeriodConfig, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { resolvePeriodRange } from '@/server/actions/periods';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const C = '33333333-3333-4333-8333-333333333333';
/** Weekly (Mondays) until 2026-11-16, semimonthly from then on — newest first, as the resolver reads them. */
const schedule = () => db.onSelect(payPeriodConfig, [
  { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-16', createdAt: new Date() },
  { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01', createdAt: new Date() },
]);
beforeEach(() => { db.reset(); h.role = 'admin'; });
const ok = <T,>(v: T) => ({ ok: true, data: v });

describe('resolvePeriodRange (K-10 companion)', () => {
  it('thisPeriod and lastPeriod', async () => {
    schedule();
    expect(await resolvePeriodRange({ kind: 'thisPeriod' })).toEqual(ok({ start: '2026-12-01', end: '2026-12-15', label: 'This pay period · Dec 1 – 15, 2026' }));
    schedule();
    expect(await resolvePeriodRange({ kind: 'lastPeriod' })).toEqual(ok({ start: '2026-11-16', end: '2026-11-30', label: 'Last pay period · Nov 16 – 30, 2026' }));
  });

  it('lastN: the N completed periods, across a schedule change (semimonthly back into weekly)', async () => {
    schedule();
    expect(await resolvePeriodRange({ kind: 'lastN', n: 3 })).toEqual(ok({ start: '2026-11-02', end: '2026-11-30', label: 'Last 3 pay periods · Nov 2 – 30, 2026' }));
  });

  it('lastN outside 1..24 is refused', async () => {
    for (const n of [0, 25, 1.5]) expect(await resolvePeriodRange({ kind: 'lastN', n })).toMatchObject({ ok: false, code: 'validation' });
  });

  it('thisMonth: the 1st to today', async () => {
    expect(await resolvePeriodRange({ kind: 'thisMonth' })).toEqual(ok({ start: '2026-12-01', end: '2026-12-15', label: 'This month · Dec 1 – 15, 2026' }));
  });

  it('contractToDate: start date; else earliest entry; else today; a future start is clamped to today', async () => {
    db.onSelect(contracts, [{ startDate: '2026-03-01' }]);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toEqual(ok({ start: '2026-03-01', end: '2026-12-15', label: 'Contract to date · Mar 1 – Dec 15, 2026' }));
    db.onSelect(contracts, [{ startDate: null }]);
    db.onSelect(timesheetEntries, [{ d: '2026-05-04' }]);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toMatchObject(ok({ start: '2026-05-04', end: '2026-12-15' }));
    db.onSelect(contracts, [{ startDate: null }]);
    db.onSelect(timesheetEntries, [{ d: null }]);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toMatchObject(ok({ start: '2026-12-15', end: '2026-12-15' }));
    db.onSelect(contracts, [{ startDate: '2027-02-01' }]);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toMatchObject(ok({ start: '2026-12-15', end: '2026-12-15' }));
  });

  it('contractToDate: a non-admin → forbidden; a non-UUID → validation; an unknown contract → not_found', async () => {
    h.role = 'supervisor';
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toMatchObject({ ok: false, code: 'forbidden' });
    h.role = 'admin';
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: 'nope' })).toMatchObject({ ok: false, code: 'validation' });
    db.onSelect(contracts, []);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: C })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('allTime is unbounded; custom is refused when start > end', async () => {
    expect(await resolvePeriodRange({ kind: 'allTime' })).toEqual(ok({ start: null, end: null, label: 'All time' }));
    expect(await resolvePeriodRange({ kind: 'custom', start: '2025-12-16', end: '2026-01-15' })).toEqual(ok({ start: '2025-12-16', end: '2026-01-15', label: 'Dec 16, 2025 – Jan 15, 2026' }));
    expect(await resolvePeriodRange({ kind: 'custom', start: '2026-02-01', end: '2026-01-31' }))
      .toEqual({ ok: false, code: 'validation', error: 'The end date must be on or after the start date.' });
  });
});
