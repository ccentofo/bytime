import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * UX-2 fix round 1 (L6, L7): the sidebar's getWaitingCount skips the oldest-period label (no schedule lookup on every
 * page). feature-plan-ux-approvals-payroll.md A3 / A-1: no SQL ORDER BY any more — the queue sorts with compareWaiting
 * (period, then submission with never-stamped last, then name, then id), the list's own order.
 */

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const fakeDb = {
  // No .orderBy in the chain: a SQL sort would throw here (A3 — the order is JS's).
  select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => h.rows }) }) }),
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

beforeEach(() => { vi.clearAllMocks(); h.rows = ROWS; });

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

  it('A-1: rows come back in compareWaiting order — period first, even when submission order differs', async () => {
    h.rows = [
      { id: 'p3', userId: 'u3', periodStart: '2026-10-01', periodNumDays: 16, submittedAt: new Date('2026-10-17T10:00:00Z'), fullName: 'Cy' },
      { id: 'p4', userId: 'u4', periodStart: '2026-09-16', periodNumDays: 15, submittedAt: new Date('2026-10-20T10:00:00Z'), fullName: 'Di' },  // submitted last, oldest period
      { id: 'p5', userId: 'u5', periodStart: '2026-10-01', periodNumDays: 16, submittedAt: null, fullName: 'Al' },
      { id: 'p6', userId: 'u6', periodStart: '2026-10-01', periodNumDays: 16, submittedAt: new Date('2026-10-17T10:00:00Z'), fullName: 'bea' },
    ];
    const q = await approvalQueue(fakeDb as never, 'a', {} as never);
    expect(q.names).toEqual(['Di', 'bea', 'Cy', 'Al']);
    expect(q.oldestPeriodLabel).toBe('Sep 16 – Sep 30, 2026');
  });
});
