import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-navigation-home.md §4.5.1 / T21: per-day hours over latest revisions; a cleared (0-hour) cell is not
 * a day with entries; workdaysFilled counts Mon–Fri days up to today with hours > 0 (never weekends or future days).
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
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000e1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));

import { currentPeriodSummary } from '@/server/internal/employee-dashboard';

describe('currentPeriodSummary (T21)', () => {
  const db = () => getTestDb();
  let emp: Awaited<ReturnType<typeof createTestUser>>;
  let a: string; let b: string; let clinId: string;
  const entry = (chargeCodeId: string, entryDate: string, hours: string, revisionNumber = 1) =>
    db().insert(schema.timesheetEntries).values({ userId: emp.id, chargeCodeId, clinId, entryDate, hours, revisionNumber, createdBy: emp.id, ...(revisionNumber > 1 ? { changeReasonCode: 'CORRECTION', comment: 'x' } : {}) });

  beforeEach(async () => {
    await cleanupTestData();
    emp = await createTestUser({ role: 'employee' });
    const clin = await createTestClin((await createTestContract()).id);
    clinId = clin.id;
    a = (await createTestChargeCode(clin.id)).id;
    b = (await createTestChargeCode(clin.id)).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('dailyHours per date; daysWithEntries ignores a 0-hour cell; workdaysFilled ignores weekends and days after today', async () => {
    await entry(a, '2026-10-01', '8');            // Thu
    await entry(a, '2026-10-02', '8');            // Fri, then cleared
    await entry(a, '2026-10-02', '0', 2);
    await entry(a, '2026-10-03', '4');            // Sat (weekend)
    await entry(a, '2026-10-05', '2');            // Mon, two codes
    await entry(b, '2026-10-05', '3');
    await entry(a, '2026-10-09', '8');            // Fri after "today"
    await entry(a, '2026-10-20', '8');            // next period — excluded
    const s = await currentPeriodSummary(db(), emp.id, { start: '2026-10-01' as CalendarDate, numDays: 15, config: DEFAULT_PERIOD_CONFIG }, '2026-10-07' as CalendarDate);
    expect(s.dailyHours).toEqual({ '2026-10-01': 8, '2026-10-02': 0, '2026-10-03': 4, '2026-10-05': 5, '2026-10-09': 8 });
    expect(s.totalHoursEntered).toBe(25);
    expect(s.daysWithEntries).toBe(4);       // 01, 03, 05, 09 — the cleared 02 does not count
    expect(s.expectedWorkdays).toBe(5);      // Oct 1, 2, 5, 6, 7
    expect(s.workdaysFilled).toBe(2);        // Oct 1 and 5 (not Sat 3, not future 9, not cleared 2)
    expect(s.workdaysFilled).toBeLessThanOrEqual(s.expectedWorkdays);
    expect(s).toMatchObject({ periodLabel: 'Oct 1 – Oct 15, 2026', status: 'draft' });
  });
});
