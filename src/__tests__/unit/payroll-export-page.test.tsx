import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §4.1.4, §4.2.2: the Payroll export page resolves the presets on the server
 * (last — the default —, this and the previous pay period, from the schedule) and computes the default range's
 * preview there, so the client opens with it. Admin only (the guard first).
 */

const h = vi.hoisted(() => ({ calls: [] as string[], preview: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requirePageRole: vi.fn(async (role: string) => { h.calls.push(`guard:${role}`); return { id: 'a', role: 'admin' }; }) }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-11-04', getWorkspaceTimezone: async () => 'America/New_York' }));
vi.mock('@/db', () => ({ getDb: async () => ({}) }));
vi.mock('@/server/internal/pay-period-config', async () => {
  const { DEFAULT_PERIOD_CONFIG, getNumDaysInPeriod, getPeriodStartForDate } = await import('@/lib/date-utils');
  const { addDays } = await import('@/lib/calendar-date');
  const periodContaining = (day: string) => {
    const start = getPeriodStartForDate(day as never, DEFAULT_PERIOD_CONFIG);
    return { start, numDays: getNumDaysInPeriod(start, DEFAULT_PERIOD_CONFIG), config: DEFAULT_PERIOD_CONFIG };
  };
  return {
    loadScheduleResolver: async () => {
      h.calls.push('schedule');
      return { configOn: () => DEFAULT_PERIOD_CONFIG, periodContaining, neighbor: (start: string, dir: 'prev' | 'next') => periodContaining(addDays(start as never, dir === 'prev' ? -1 : 16)) };
    },
  };
});
vi.mock('@/server/actions/payroll-export', () => ({ getPayrollExportPreview: h.preview }));
vi.mock('@/app/(app)/admin/payroll-export/PayrollExportClient', () => ({ PayrollExportClient: () => null }));

import PayrollExportPage from '@/app/(app)/admin/payroll-export/page';

describe('Payroll export page (§4.1.4)', () => {
  it('guards first; presets last / current / previous; the initial preview is the last pay period', async () => {
    h.preview.mockResolvedValue({ ok: true, data: { status: 'refused', reason: 'workweek-unset', codes: [], message: 'x' } });
    const el = (await PayrollExportPage()) as { props: Record<string, unknown> };
    expect(h.calls[0]).toBe('guard:admin');
    expect(el.props.presets).toEqual({
      last: { start: '2026-10-16', end: '2026-10-31', label: 'Oct 16 – 31, 2026' },
      current: { start: '2026-11-01', end: '2026-11-15', label: 'Nov 1 – 15, 2026' },
      previous: { start: '2026-10-01', end: '2026-10-15', label: 'Oct 1 – 15, 2026' },
    });
    expect(h.preview).toHaveBeenCalledWith({ periodStart: '2026-10-16', periodEnd: '2026-10-31' });
    expect(el.props.initialPreview).toEqual({ ok: true, data: { status: 'refused', reason: 'workweek-unset', codes: [], message: 'x' } });
    expect(el.props.timeZone).toBe('America/New_York');
  });
});
