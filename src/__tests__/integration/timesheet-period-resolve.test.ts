import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPeriodStartForDate, DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import { todayIn, type CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-timesheet.md A-T7 (A4.6): `?period=` garbage → the current period; a mid-period date → its canonical
 * start; a future date → the current period; getTimesheetPeriod returns the canonical start and isCurrent;
 * getNeighborPeriod('next') at the current period stays there.
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000a7', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
type FakeUser = { id: string; role: 'admin' | 'supervisor' | 'employee'; email: string; fullName: string };
const session = vi.hoisted(() => ({ user: null as null | FakeUser }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = () => {
    if (!session.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized: No active session');
    return session.user;
  };
  return { ...actual, getSessionUser: async () => current(), requireSession: async () => current(), assertCanAccessEmployee: async () => {}, getEmployeeScope: async () => 'all' };
});

import { getTimesheetPeriod } from '@/server/actions/timesheet';
import { getNeighborPeriod } from '@/server/actions/pay-period-config';

describe('period resolution (UX-3 A-T7)', () => {
  let current: CalendarDate;
  beforeEach(async () => {
    await cleanupTestData();
    const emp = await createTestUser({ role: 'employee' });
    session.user = { id: emp.id, role: 'employee', email: emp.email, fullName: emp.fullName };
    current = getPeriodStartForDate(todayIn('America/New_York'), DEFAULT_PERIOD_CONFIG);
  });
  afterEach(async () => { session.user = null; await cleanupTestData(); });

  it('garbage (or nothing, or an array of garbage) → the current period, isCurrent', async () => {
    for (const raw of [undefined, 'garbage', '2026-13-01', ['nope', '2026-03-01']]) {
      expect(await getTimesheetPeriod(raw as never), JSON.stringify(raw)).toMatchObject({ periodStart: current, isCurrent: true });
    }
  });

  it('a mid-period date → its canonical start (not current); an array takes the first element', async () => {
    expect(await getTimesheetPeriod('2026-03-10')).toMatchObject({ periodStart: '2026-03-01', numDays: 15, isCurrent: false });
    expect(await getTimesheetPeriod(['2026-03-20', 'x'])).toMatchObject({ periodStart: '2026-03-16', numDays: 16, isCurrent: false });
  });

  it('a future date → the current period', async () => {
    expect(await getTimesheetPeriod('2099-01-01')).toMatchObject({ periodStart: current, isCurrent: true });
  });

  it('getNeighborPeriod("next") at the current period stays current; "prev" leaves it', async () => {
    expect(await getNeighborPeriod(current, 'next')).toMatchObject({ periodStart: current, isCurrent: true });
    const prev = await getNeighborPeriod(current, 'prev');
    expect(prev.isCurrent).toBe(false);
    expect(prev.periodStart < current).toBe(true);
  });
});
