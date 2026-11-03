import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-kit-contracts.md §3.8 / K-10 against real Postgres: this / last / lastN (completed periods, across a
 * schedule change), thisMonth, contractToDate (start date / earliest entry / neither / future start clamped), allTime,
 * custom refused when start > end; a non-admin's contractToDate → forbidden.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => 'test-tenant' }));
const h = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'supervisor' }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const user = async () => ({ id: '00000000-0000-4000-8000-0000000000aa', email: 'a@x', fullName: 'A', role: h.role });
  return {
    ...actual, requireSession: user,
    requireAdmin: async () => { if (h.role !== 'admin') throw new actual.AuthorizationError('forbidden', 'Forbidden'); return user(); },
  };
});

import { resolvePeriodRange } from '@/server/actions/periods';

describe('resolvePeriodRange (K-10)', () => {
  beforeEach(async () => {
    await cleanupTestData();
    h.role = 'admin';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T17:00:00Z'));          // 2026-12-15 in New York (the seeded workspace zone)
    await getTestDb().insert(schema.payPeriodConfig).values([
      { periodType: 'weekly', anchorDate: '2026-01-05', weekStartDay: 1, effectiveFrom: '1900-01-01' },
      { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-11-16' },
    ]);
  });
  afterEach(async () => { vi.useRealTimers(); await cleanupTestData(); });

  it('this, last and lastN (completed periods, across the schedule change); thisMonth; allTime', async () => {
    expect(await resolvePeriodRange({ kind: 'thisPeriod' })).toMatchObject({ ok: true, data: { start: '2026-12-01', end: '2026-12-15' } });
    expect(await resolvePeriodRange({ kind: 'lastPeriod' })).toMatchObject({ ok: true, data: { start: '2026-11-16', end: '2026-11-30', label: 'Last pay period · Nov 16 – 30, 2026' } });
    expect(await resolvePeriodRange({ kind: 'lastN', n: 3 })).toMatchObject({ ok: true, data: { start: '2026-11-02', end: '2026-11-30' } });
    expect(await resolvePeriodRange({ kind: 'thisMonth' })).toMatchObject({ ok: true, data: { start: '2026-12-01', end: '2026-12-15' } });
    expect(await resolvePeriodRange({ kind: 'allTime' })).toEqual({ ok: true, data: { start: null, end: null, label: 'All time' } });
  });

  it('contractToDate: start date; earliest entry; neither; a future start clamped', async () => {
    const withStart = await createTestContract({ startDate: '2026-03-01' });
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: withStart.id })).toMatchObject({ ok: true, data: { start: '2026-03-01', end: '2026-12-15' } });

    const noStart = await createTestContract();
    const clin = await createTestClin(noStart.id);
    const code = await createTestChargeCode(clin.id);
    const emp = await createTestUser();
    await getTestDb().insert(schema.timesheetEntries).values([
      { userId: emp.id, chargeCodeId: code.id, clinId: clin.id, entryDate: '2026-05-04', hours: '8', revisionNumber: 1, createdBy: emp.id },
      { userId: emp.id, chargeCodeId: code.id, clinId: clin.id, entryDate: '2026-06-01', hours: '8', revisionNumber: 1, createdBy: emp.id },
    ]);
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: noStart.id })).toMatchObject({ ok: true, data: { start: '2026-05-04' } });

    const empty = await createTestContract();
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: empty.id })).toMatchObject({ ok: true, data: { start: '2026-12-15', end: '2026-12-15' } });

    const future = await createTestContract({ startDate: '2027-02-01' });
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: future.id })).toMatchObject({ ok: true, data: { start: '2026-12-15' } });
  });

  it('custom start > end is refused; a non-admin contractToDate → forbidden', async () => {
    expect(await resolvePeriodRange({ kind: 'custom', start: '2026-02-01', end: '2026-01-31' })).toMatchObject({ ok: false, code: 'validation' });
    h.role = 'supervisor';
    const c = await createTestContract({ startDate: '2026-03-01' });
    expect(await resolvePeriodRange({ kind: 'contractToDate', contractId: c.id })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
