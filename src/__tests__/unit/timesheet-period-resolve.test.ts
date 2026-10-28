import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-ux-timesheet.md A4.6 (A-T7, unit half; the Postgres half is integration/timesheet-period-resolve):
 * resolveRequestedPeriod never throws — garbage → current, mid-period → canonical start, future → clamped to current,
 * arrays take their first element; getNeighborPeriod("next") stops at the current period and reports isCurrent.
 * The schedule is the default semi-monthly one (no pay_period_config rows in the fake database).
 */

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ today: '2026-10-20' }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});
vi.mock('@/lib/session', () => ({ requireSession: async () => ({ id: 'u1', role: 'employee' }), requireAdmin: async () => ({}), requireAdminFresh: async () => ({}) }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => h.today, getWorkspaceTimezone: async () => 'UTC' }));

import { getDb } from '@/db';
import { resolveRequestedPeriod } from '@/server/internal/timesheet-period';
import { getNeighborPeriod } from '@/server/actions/pay-period-config';

const resolve = async (raw: string | string[] | undefined) => resolveRequestedPeriod(await getDb() as never, raw, h.today as never);

beforeEach(() => { h.today = '2026-10-20'; });

describe('resolveRequestedPeriod', () => {
  it('garbage, empty or missing → the current period', async () => {
    for (const raw of [undefined, '', 'nope', '2026-02-30', '2026-10-01T00:00:00Z', '<script>']) {
      expect(await resolve(raw), String(raw)).toMatchObject({ start: '2026-10-16', numDays: 16, isCurrent: true });
    }
  });

  it('a mid-period date snaps to its period\'s start; a period start stays', async () => {
    expect(await resolve('2026-09-20')).toMatchObject({ start: '2026-09-16', numDays: 15, isCurrent: false });
    expect(await resolve('2026-10-01')).toMatchObject({ start: '2026-10-01', isCurrent: false });
    expect(await resolve('2026-10-19')).toMatchObject({ start: '2026-10-16', isCurrent: true });
  });

  it('a future period is clamped to the current one', async () => {
    expect(await resolve('2026-11-01')).toMatchObject({ start: '2026-10-16', isCurrent: true });
    expect(await resolve('2031-01-01')).toMatchObject({ start: '2026-10-16', isCurrent: true });
  });

  it('an array takes its first element', async () => {
    expect(await resolve(['2026-09-20', '2026-10-16'])).toMatchObject({ start: '2026-09-16' });
    expect(await resolve([])).toMatchObject({ start: '2026-10-16', isCurrent: true });
  });
});

describe('getNeighborPeriod (A4.6 clamp, same return shape + isCurrent)', () => {
  it('"next" from the current period stays on it; from the previous one it reaches it; "prev" is unbounded', async () => {
    expect(await getNeighborPeriod('2026-10-16' as never, 'next')).toMatchObject({ periodStart: '2026-10-16', numDays: 16, isCurrent: true });
    expect(await getNeighborPeriod('2026-10-01' as never, 'next')).toMatchObject({ periodStart: '2026-10-16', isCurrent: true });
    expect(await getNeighborPeriod('2026-10-16' as never, 'prev')).toMatchObject({ periodStart: '2026-10-01', numDays: 15, isCurrent: false });
    expect(Object.keys(await getNeighborPeriod('2026-10-01' as never, 'prev')).sort()).toEqual(['isCurrent', 'numDays', 'periodConfig', 'periodStart']);
  });
});
