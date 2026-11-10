import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData, expectOk, expectFailure } from './helpers';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-ux-setup-import.md P6 / §3.2, against Postgres (the guards run for real):
 * SU-5  — a new workspace (no pay_period_config row, no timesheet data) saves the DEFAULT schedule immediately: one row.
 * SU-10 — a future date with no row is still refused; with a pending-only row, an immediate default save cancels the
 *         pending change (C7) and inserts nothing; with timesheet data, the immediate path still refuses.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000c2', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'test-tenant.localhost' }) }));
const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/auth', () => ({ auth: async () => (sessionState.user ? { user: { ...sessionState.user, tenantSlug: 'test-tenant' } } : null) }));

import { updatePayPeriodConfig } from '@/server/actions/pay-period-config';

const DEFAULT = { periodType: 'semimonthly' as const, anchorDate: '2026-01-01' as CalendarDate, weekStartDay: 1 };
const rows = () => getTestDb().select().from(schema.payPeriodConfig);
const ALREADY = /^This is already your pay schedule\. Change a setting before saving\.$/;

describe('the first pay schedule save (P6)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    sessionState.user = { id: admin.id, role: admin.role, email: admin.email, fullName: admin.fullName };
  });
  afterEach(async () => { sessionState.user = null; await cleanupTestData(); });

  it('SU-5: no row and no timesheet data → the default schedule saves immediately (one row from 1900-01-01)', async () => {
    expect(await expectOk(updatePayPeriodConfig({ ...DEFAULT, effectiveFrom: null }))).toEqual({ effectiveFrom: null });
    expect((await rows()).map((r) => [r.periodType, r.anchorDate, r.weekStartDay, r.effectiveFrom])).toEqual([['semimonthly', '2026-01-01', 1, '1900-01-01']]);
    // Saved once, it's a real row: saving it again is the usual refusal.
    await expectFailure(updatePayPeriodConfig({ ...DEFAULT, effectiveFrom: null }), 'validation', ALREADY);
    expect(await rows()).toHaveLength(1);
  });

  it('SU-10: a future date with no row is refused; a pending-only row is cancelled by an immediate default save, nothing inserted', async () => {
    await expectFailure(updatePayPeriodConfig({ ...DEFAULT, effectiveFrom: '2030-01-01' as CalendarDate }), 'validation', ALREADY);
    expect(await rows()).toEqual([]);
    await getTestDb().insert(schema.payPeriodConfig).values({ periodType: 'weekly', anchorDate: '2030-01-07', weekStartDay: 1, effectiveFrom: '2030-01-07' });
    expect(await expectOk(updatePayPeriodConfig({ ...DEFAULT, effectiveFrom: null }))).toEqual({ effectiveFrom: null, cancelledPending: true });
    expect(await rows()).toEqual([]);
  });

  it('SU-10: with timesheet data and no row, the immediate default save still refuses', async () => {
    await getTestDb().insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2026-01-01', status: 'draft', periodNumDays: 15 });
    await expectFailure(updatePayPeriodConfig({ ...DEFAULT, effectiveFrom: null }), 'validation', /^Timesheets already exist/);
    expect(await rows()).toEqual([]);
  });
});
