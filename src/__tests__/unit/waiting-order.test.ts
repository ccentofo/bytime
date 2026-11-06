import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareWaiting, type WaitingSortable } from '@/lib/approvals/waiting-order';

/**
 * feature-plan-ux-approvals-payroll.md A3 / A-1: compareWaiting — period start, then submitted-at (null last), then
 * employee name (case- and accent-insensitive), then period id. Pure (no server-only import), so the client uses it.
 */
const r = (periodId: string, periodStart: string, submittedAt: string | null, employeeName: string): WaitingSortable =>
  ({ periodId, periodStart, submittedAt: submittedAt ? new Date(submittedAt) : null, employeeName });
const order = (rows: WaitingSortable[]) => [...rows].sort(compareWaiting).map((x) => x.periodId);

describe('compareWaiting (A-1)', () => {
  it('period start first', () => {
    expect(order([r('b', '2026-10-01', '2026-10-02T00:00:00Z', 'A'), r('a', '2026-09-16', '2026-10-20T00:00:00Z', 'Z')])).toEqual(['a', 'b']);
  });
  it('then submitted-at, never-stamped last (Date or ISO string)', () => {
    expect(order([r('n', '2026-10-01', null, 'A'), r('late', '2026-10-01', '2026-10-18T00:00:00Z', 'A'), r('early', '2026-10-01', '2026-10-16T00:00:00Z', 'A')])).toEqual(['early', 'late', 'n']);
    expect(compareWaiting({ ...r('x', '2026-10-01', null, 'A'), submittedAt: '2026-10-16T00:00:00Z' }, r('y', '2026-10-01', '2026-10-17T00:00:00Z', 'A'))).toBeLessThan(0);
  });
  it('then the name, ignoring case and accents', () => {
    const at = '2026-10-16T00:00:00Z';
    expect(order([r('1', '2026-10-01', at, 'zoë'), r('2', '2026-10-01', at, 'Émile'), r('3', '2026-10-01', at, 'bob')])).toEqual(['3', '2', '1']);
    expect(compareWaiting(r('a', '2026-10-01', at, 'Ann'), r('b', '2026-10-01', at, 'ann'))).toBeLessThan(0); // equal names → id
  });
  it('then the period id', () => {
    const at = '2026-10-16T00:00:00Z';
    expect(order([r('p9', '2026-10-01', at, 'Same'), r('p1', '2026-10-01', at, 'same')])).toEqual(['p1', 'p9']);
  });
  it('is pure: no server-only import', () => {
    expect(readFileSync('src/lib/approvals/waiting-order.ts', 'utf8')).not.toMatch(/server-only|@\/db|drizzle/);
  });
});
