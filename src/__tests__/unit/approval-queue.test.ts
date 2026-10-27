import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

/**
 * UX-2 fix round 1 (L6, L7): the sidebar's getWaitingCount skips the oldest-period label (no schedule lookup on every
 * page); the queue orders by submission (never-stamped last), then period start, so ties are stable.
 */

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ orderBy: [] as unknown[], rows: [] as Array<Record<string, unknown>> }));
const fakeDb = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: async (...args: unknown[]) => { h.orderBy = args; return h.rows; } }) }) }) }),
};
vi.mock('@/db', () => ({ getDb: async () => fakeDb }));
vi.mock('@/server/internal/approval-rules', () => ({ loadApprovalFacts: async () => ({}), canApprove: () => true }));
vi.mock('@/server/internal/pay-period-config', () => ({ existingPeriodLength: vi.fn(async () => 15) }));

import { approvalQueue, getWaitingCount } from '@/server/internal/approval-queue';
import { existingPeriodLength } from '@/server/internal/pay-period-config';

const ROWS = [
  { id: 'p1', userId: 'u1', periodStart: '2026-09-16', periodNumDays: null, submittedAt: new Date('2026-10-01T10:00:00Z'), fullName: 'Ann' },
  { id: 'p2', userId: 'u2', periodStart: '2026-10-01', periodNumDays: null, submittedAt: new Date('2026-10-02T10:00:00Z'), fullName: 'Bob' },
];

beforeEach(() => { vi.clearAllMocks(); h.rows = ROWS; h.orderBy = []; });

describe('approval queue — label and order (L6, L7)', () => {
  it('L6: getWaitingCount returns the count without building the label (no schedule lookup)', async () => {
    expect(await getWaitingCount('actor-l6')).toBe(2);
    expect(existingPeriodLength).not.toHaveBeenCalled();
  });

  it('L6: approvalQueue builds the label by default, and skips it with { label: false }', async () => {
    expect((await approvalQueue(fakeDb as never, 'a', {} as never)).oldestPeriodLabel).toBe('Sep 16 – Sep 30, 2026');
    expect(existingPeriodLength).toHaveBeenCalledTimes(1);
    expect((await approvalQueue(fakeDb as never, 'a', {} as never, { label: false })).oldestPeriodLabel).toBeNull();
    expect(existingPeriodLength).toHaveBeenCalledTimes(1);
  });

  it('L7: ORDER BY submitted_at ASC NULLS LAST, then period_start ASC', async () => {
    await approvalQueue(fakeDb as never, 'a', {} as never);
    const text = new PgDialect().sqlToQuery(sql.join(h.orderBy.map((a) => sql`${a as SQL}`), sql`, `)).sql;
    expect(text).toBe('"timesheet_periods"."submitted_at" ASC NULLS LAST, "timesheet_periods"."period_start" asc');
  });
});
