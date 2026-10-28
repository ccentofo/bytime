// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';

/**
 * feature-plan-ux-timesheet-ui.md B-T6 (§4.1, §4.4). Step 1 covers initialization: the page context (userId, today,
 * readOnly, flsaExempt) survives initialization and period loads (trap T-O); first mount holds the server's notes and the
 * selected-period fields from initialData. The layout cases are added with the page layout step.
 */

const actions = vi.hoisted(() => ({ getTimesheetPeriod: vi.fn(), getNeighborPeriod: vi.fn(), saveTimesheetBatch: vi.fn(), submitPeriod: vi.fn(), getPeriodOptions: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: actions.submitPeriod, getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20' })), getPeriodOptions: actions.getPeriodOptions }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { initialTimesheetState, timesheetReducer } from '@/components/timesheet/TimesheetContext';
import { CC, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { for (const f of Object.values(actions)) f.mockReset(); actions.getPeriodOptions.mockResolvedValue([]); live.ctx = null; });
afterEach(() => cleanup());

describe('initialization and the page context (B-T6, T-O)', () => {
  it('mounting with flsaExempt: true and readOnly: true keeps both, with the server notes and the selected-period fields', () => {
    const data = pageData(
      { readOnly: true, notes: { [`${CC}-1`]: { body: 'Site visit', revision: 2 } }, submitOpensOn: '2026-01-15' as CalendarDate, reviewComment: 'Fix Tuesday',
        periodStatus: 'rejected', workweekStartDay: 1, outsideWeekHours: { '2025-12-29': 8 }, userCreatedOn: '2025-06-01' as CalendarDate, submittedOn: '2026-01-16' as CalendarDate },
      { flsaExempt: true, readOnly: true, userId: 'jane' },
    );
    renderTimesheet(data, null);
    const s = live.ctx!.state;
    expect({ userId: s.userId, flsaExempt: s.flsaExempt, readOnly: s.readOnly, today: s.today }).toEqual({ userId: 'jane', flsaExempt: true, readOnly: true, today: '2026-01-20' });
    expect(s.notes).toEqual({ [`${CC}-1`]: 'Site visit' });
    expect(s.savedNotes).toEqual({ [`${CC}-1`]: { body: 'Site visit', revision: 2 } });
    expect(s).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-15', numDays: 15, submitOpensOn: '2026-01-15', reviewComment: 'Fix Tuesday',
      periodStatus: 'rejected', workweekStartDay: 1, outsideWeekHours: { '2025-12-29': 8 }, userCreatedOn: '2025-06-01', submittedOn: '2026-01-16', syncGen: 0 });
  });

  it('SET_PERIOD_DATA never changes the page context, even when the period data carries today / readOnly', () => {
    const state = initialTimesheetState(pageData({}, { flsaExempt: true, readOnly: true, userId: 'jane' }));
    const next = timesheetReducer(state, { type: 'SET_PERIOD_DATA', ...periodData({ periodStart: '2025-12-16' as CalendarDate, numDays: 16, today: '2030-01-01' as CalendarDate, readOnly: false }) });
    expect({ userId: next.userId, flsaExempt: next.flsaExempt, readOnly: next.readOnly, today: next.today }).toEqual({ userId: 'jane', flsaExempt: true, readOnly: true, today: '2026-01-20' });
    expect(next.periodStart).toBe('2025-12-16');
    // SET_PAGE_CONTEXT is the one way to change it; flsaExempt only when given.
    const ctx = timesheetReducer(next, { type: 'SET_PAGE_CONTEXT', today: '2026-01-21' as CalendarDate, readOnly: false });
    expect({ flsaExempt: ctx.flsaExempt, readOnly: ctx.readOnly, today: ctx.today }).toEqual({ flsaExempt: true, readOnly: false, today: '2026-01-21' });
  });

  it('a period load keeps flsaExempt and userId; today / readOnly follow the server\'s view at load time', async () => {
    renderTimesheet(pageData({ chargeCodes: [chargeCode()] }, { flsaExempt: true, readOnly: true, userId: 'jane' }), null);
    actions.getNeighborPeriod.mockResolvedValue({ periodStart: '2025-12-16', numDays: 16, periodConfig: periodData().periodConfig, isCurrent: false });
    actions.getTimesheetPeriod.mockResolvedValue(periodData({ periodStart: '2025-12-16' as CalendarDate, numDays: 16, readOnly: true, today: '2026-01-21' as CalendarDate,
      notes: { [`${CC}-3`]: { body: 'December', revision: 4 } } }));
    await act(async () => { await live.ctx!.loadPeriod('prev'); });
    const s = live.ctx!.state;
    expect({ userId: s.userId, flsaExempt: s.flsaExempt, readOnly: s.readOnly, today: s.today }).toEqual({ userId: 'jane', flsaExempt: true, readOnly: true, today: '2026-01-21' });
    expect(s).toMatchObject({ periodStart: '2025-12-16', periodEnd: '2025-12-31', notes: { [`${CC}-3`]: 'December' }, loadGen: 1, isLoadingPeriod: false });
  });
});
