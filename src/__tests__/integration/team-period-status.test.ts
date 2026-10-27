import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, assignUserToClin, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.5.2 / T8: team status buckets over one period — active users only; people
 * created after the period ended aren't expected (mid-period hires are); admins only when they recorded time or have
 * a period row; a supervisor's scope excludes themselves and peers; the previous period has its own length across a
 * pay-schedule change.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000e8', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { teamPeriodStatus } from '@/server/internal/team-period-status';
import { approvableScope, loadApprovalFacts } from '@/server/internal/approval-rules';
import { loadScheduleResolver } from '@/server/internal/pay-period-config';

const START = '2026-09-16' as CalendarDate;
const EARLY = new Date('2026-01-01T12:00:00Z');
const TZ = 'America/New_York';

describe('team period status (T8)', () => {
  const db = () => getTestDb();
  let code: string; let clinId: string;
  const user = (fullName: string, o: Partial<typeof schema.users.$inferInsert> = {}) => createTestUser({ fullName, role: 'employee', createdAt: EARLY, ...o });
  const hours = (userId: string, entryDate: string, h: string, revisionNumber = 1) =>
    db().insert(schema.timesheetEntries).values({ userId, chargeCodeId: code, clinId, entryDate, hours: h, revisionNumber, createdBy: userId, ...(revisionNumber > 1 ? { changeReasonCode: 'CORRECTION', comment: 'x' } : {}) });
  const period = (userId: string, status: 'submitted' | 'approved' | 'rejected' | 'draft') =>
    db().insert(schema.timesheetPeriods).values({ userId, periodStart: START, status, periodNumDays: 15, submissionCount: 1, submittedAt: status === 'draft' ? null : new Date() });

  beforeEach(async () => {
    await cleanupTestData();
    const clin = await createTestClin((await createTestContract()).id);
    clinId = clin.id;
    code = (await createTestChargeCode(clin.id)).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('buckets: submitted/approved, returned, in progress, not started (incl. a cleared cell); inactive and late-created excluded; mid-period hire counted', async () => {
    const sub = await user('Sub Mitted'); await period(sub.id, 'submitted');
    const app = await user('App Roved'); await period(app.id, 'approved');
    const ret = await user('Re Turned'); await period(ret.id, 'rejected');
    const wip = await user('Work InProgress'); await hours(wip.id, '2026-09-17', '4');
    const draftWip = await user('Draft Row'); await period(draftWip.id, 'draft'); await hours(draftWip.id, '2026-09-18', '2');
    const cleared = await user('Cell Cleared'); await hours(cleared.id, '2026-09-17', '8'); await hours(cleared.id, '2026-09-17', '0', 2);
    await user('No Hours');
    const gone = await user('Gone Inactive', { isActive: false }); await hours(gone.id, '2026-09-17', '8');
    await user('Late Hire', { createdAt: new Date('2026-10-05T12:00:00Z') });                // after the period ended
    await user('Mid Hire', { createdAt: new Date('2026-09-22T15:00:00Z') });                 // during the period
    await user('Last Day Hire', { createdAt: new Date('2026-10-01T02:00:00Z') });            // 10:00 pm Sep 30 New York → counted
    await user('Admin Idle', { role: 'admin' });
    const adminBusy = await user('Admin Busy', { role: 'admin' }); await hours(adminBusy.id, '2026-09-19', '1');
    await user('Sup Ervisor', { role: 'supervisor' });

    const s = await teamPeriodStatus(db(), START, 15, 'all', TZ);
    expect(s.submitted).toEqual({ count: 2, names: ['App Roved', 'Sub Mitted'] });
    expect(s.returned).toEqual({ count: 1, names: ['Re Turned'] });
    expect(s.inProgress).toEqual({ count: 3, names: ['Admin Busy', 'Draft Row', 'Work InProgress'] });
    expect(s.notStarted).toEqual({ count: 5, names: ['Cell Cleared', 'Last Day Hire', 'Mid Hire', 'No Hours', 'Sup Ervisor'] });
  });

  it('M2: the created_at rule uses the WORKSPACE timezone, not the database session or UTC (Honolulu differs from both)', async () => {
    // 05:00 UTC Oct 1 = 7 pm Sep 30 in Honolulu (but Oct 1 in UTC and New York) → counted for the period ending Sep 30.
    await user('Honolulu Evening', { createdAt: new Date('2026-10-01T05:00:00Z') });
    // 11:00 UTC Oct 1 = 1 am Oct 1 in Honolulu → after the period ended, not counted.
    await user('Honolulu Next Day', { createdAt: new Date('2026-10-01T11:00:00Z') });
    const s = await teamPeriodStatus(db(), START, 15, 'all', 'Pacific/Honolulu');
    expect(s.notStarted.names).toEqual(['Honolulu Evening']);
  });

  it('supervisor scope (approvableScope): excludes self and peers; an empty scope gives nobody', async () => {
    const sup = await user('Sam Super', { role: 'supervisor' });
    const peer = await user('Pat Peer', { role: 'supervisor' });
    const e1 = await user('Eve One');
    await user('Out Side');
    for (const u of [sup, peer, e1]) await assignUserToClin(u.id, clinId);
    const scope = approvableScope(await loadApprovalFacts(db()), sup.id);
    expect(scope).toEqual([e1.id]);
    const s = await teamPeriodStatus(db(), START, 15, scope, TZ);
    expect([...s.submitted.names, ...s.returned.names, ...s.inProgress.names, ...s.notStarted.names]).toEqual(['Eve One']);
    const none = await teamPeriodStatus(db(), START, 15, [], TZ);
    expect(none.notStarted.count + none.inProgress.count + none.submitted.count + none.returned.count).toBe(0);
  });

  it('a pay-schedule change gives the previous period its own length (resolver neighbor)', async () => {
    // Semi-monthly (the default, no row) until a weekly schedule starting on Thursdays takes over on Oct 1.
    await db().insert(schema.payPeriodConfig).values({ periodType: 'weekly', anchorDate: '2026-10-01', weekStartDay: 4, effectiveFrom: '2026-10-01' });
    const resolver = await loadScheduleResolver(db());
    const cur = resolver.periodContaining('2026-10-07' as CalendarDate);
    const prev = resolver.neighbor(cur.start, 'prev');
    expect(cur).toMatchObject({ start: '2026-10-01', numDays: 7 });
    expect(prev).toMatchObject({ start: '2026-09-16', numDays: 15 });
    const late = await user('Late Month');
    await hours(late.id, '2026-09-29', '8'); // inside Sep 16–30, outside a 7-day window from Sep 16
    const s = await teamPeriodStatus(db(), prev.start, prev.numDays, 'all', TZ);
    expect(s.inProgress.names).toEqual(['Late Month']);
  });
});
