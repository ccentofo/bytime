// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';

/**
 * UX-TIMESHEET-B-AUDIT LOWs in the provider: L4 (the SubmitModal is tied to syncGen; SET_PERIOD_STATUS applies only to
 * the period and sync it was for), L5 (a late ReasonModal save can't resolve or close a newer modal), L8 (the session
 * alert clears on Discard and on a period change or re-sync), L9 (SET_TODAY past the period's end clears isCurrent, and
 * the URL gains ?period=).
 */

const actions = vi.hoisted(() => ({ saveTimesheetBatch: vi.fn(), submitPeriod: vi.fn(), getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: actions.submitPeriod, getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/components/timesheet/ReasonModal', () => ({
  ReasonModal: ({ opened, onConfirm }: { opened: boolean; onConfirm: (r: string, c: string) => Promise<boolean> }) => (opened ? (
    <button type="button" data-testid="reason-modal" onClick={() => { void onConfirm('LATE_ENTRY', 'late'); }}>MOCK_REASON_CONFIRM</button>
  ) : null),
}));
vi.mock('@/components/timesheet/SubmitModal', () => ({
  SubmitModal: ({ opened, onConfirm }: { opened: boolean; onConfirm: (c?: string) => Promise<void> }) => (opened ? (
    <button type="button" data-testid="submit-modal" onClick={() => { void onConfirm(); }}>MOCK_SUBMIT_CONFIRM</button>
  ) : null),
}));

import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import { timesheetReducer, initialTimesheetState, SESSION_EXPIRED, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { CC, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { for (const f of Object.values(actions)) f.mockReset(); window.history.replaceState(null, '', '/timesheet?period=2026-01-01'); });
afterEach(() => cleanup());

// Jan 1–15, 2026; today Wed Jan 7 (index 6).
const data = (o = {}) => pageData({ today: '2026-01-07' as CalendarDate, submitOpensOn: '2026-01-01' as CalendarDate, chargeCodes: [chargeCode()], ...o });
const DEC16 = periodData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 });
const setup = (d = data()) => ({ user: userEvent.setup(), view: renderTimesheet(d, <TimesheetPage />) });
const edit = (dayIndex: number, value = 4) => act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex, value }));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const shown = (id: string) => document.querySelector(`[data-testid="${id}"]`);

describe('L4: the SubmitModal and SET_PERIOD_STATUS follow the period', () => {
  it('a re-sync closes an open SubmitModal', async () => {
    const { view } = setup();
    act(() => live.ctx!.openSubmit());
    expect(shown('submit-modal')).not.toBeNull();
    view.rerenderWith(data());
    expect(shown('submit-modal')).toBeNull();
  });

  it('a submit that lands after the user moved to another period leaves the new period\'s status alone', async () => {
    const submit = deferred<unknown>();
    actions.submitPeriod.mockReturnValue(submit.promise);
    actions.getTimesheetPeriod.mockResolvedValue(DEC16);
    setup();
    let result: { ok: boolean } | undefined;
    act(() => { void live.ctx!.submitTimesheet().then((r) => { result = r; }); });
    await act(async () => { await live.ctx!.loadPeriodByDate('2025-12-16' as CalendarDate); });
    await act(async () => { submit.resolve({ ok: true, data: {} }); });
    expect(result?.ok).toBe(true);
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
    expect(live.ctx!.state.periodStatus).toBe('draft');
    expect(live.ctx!.state.submittedOn).toBeNull();
  });

  it('the reducer: SET_PERIOD_STATUS for another period or sync is ignored', () => {
    const s = initialTimesheetState(data());
    expect(timesheetReducer(s, { type: 'SET_PERIOD_STATUS', status: 'submitted', periodStart: '2025-12-16' as CalendarDate, syncGen: 0 })).toBe(s);
    expect(timesheetReducer(s, { type: 'SET_PERIOD_STATUS', status: 'submitted', periodStart: s.periodStart, syncGen: 1 })).toBe(s);
    expect(timesheetReducer(s, { type: 'SET_PERIOD_STATUS', status: 'submitted', periodStart: s.periodStart, syncGen: 0 }).periodStatus).toBe('submitted');
  });
});

describe('L5: a late ReasonModal save can\'t resolve a newer modal', () => {
  it('confirm → slow save → re-sync → a new save opens a new modal → the old save lands: the new modal stays open, its save unresolved', async () => {
    const slow = deferred<unknown>();
    actions.saveTimesheetBatch.mockReturnValueOnce(slow.promise);
    const { user, view } = setup();
    await edit(2);                                           // late: needs a reason
    let first: boolean | undefined;
    act(() => { void live.ctx!.requestSave().then((r) => { first = r; }); });
    await settle();
    await user.click(shown('reason-modal')!);                // the slow save starts
    view.rerenderWith(data());                               // a re-sync settles the first modal (false)
    await settle();
    expect(first).toBe(false);
    await edit(3);                                           // a new late entry, a new save, a new modal
    let second: boolean | undefined;
    act(() => { void live.ctx!.requestSave().then((r) => { second = r; }); });
    await settle();
    expect(shown('reason-modal')).not.toBeNull();
    await act(async () => { slow.resolve({ ok: true, data: { revisions: { [`${CC}-2`]: 1 }, noteRevisions: {} } }); });
    await settle();
    expect(shown('reason-modal')).not.toBeNull();             // still the newer modal
    expect(second).toBeUndefined();
  });
});

describe('L8: the session alert clears on Discard and on a period change', () => {
  const expire = async () => {
    actions.saveTimesheetBatch.mockResolvedValueOnce({ ok: false, code: 'unauthenticated', error: 'Unauthorized' });
    await edit(6);
    await act(async () => { await live.ctx!.requestSave(); });
    expect(shown('session-expired')!.textContent).toContain(SESSION_EXPIRED);
  };

  it('Discard clears it', async () => {
    setup();
    await expire();
    act(() => live.ctx!.discardChanges());
    expect(shown('session-expired')).toBeNull();
  });

  it('a period change clears it (and coming back doesn\'t bring it back)', async () => {
    actions.getTimesheetPeriod.mockResolvedValueOnce(DEC16).mockResolvedValueOnce(periodData({ chargeCodes: [chargeCode()] }));
    setup();
    await expire();
    await act(async () => { await live.ctx!.loadPeriodByDate('2025-12-16' as CalendarDate); });
    expect(shown('session-expired')).toBeNull();
    await act(async () => { await live.ctx!.loadPeriodByDate('2026-01-01' as CalendarDate); });
    expect(live.ctx!.state.periodStart).toBe('2026-01-01');
    expect(shown('session-expired')).toBeNull();
  });

  it('a re-sync clears it', async () => {
    const { view } = setup();
    await expire();
    view.rerenderWith(data());
    expect(shown('session-expired')).toBeNull();
  });
});

describe('L9: SET_TODAY past the period\'s end', () => {
  it('clears isCurrent, so the URL gains ?period=; a today inside the period keeps it', async () => {
    window.history.replaceState(null, '', '/timesheet');
    setup(data({ isCurrent: true }));
    expect(window.location.pathname + window.location.search).toBe('/timesheet');
    act(() => live.ctx!.dispatch({ type: 'SET_TODAY', today: '2026-01-15' as CalendarDate }));
    expect(live.ctx!.state.isCurrent).toBe(true);
    expect(window.location.search).toBe('');
    act(() => live.ctx!.dispatch({ type: 'SET_TODAY', today: '2026-01-16' as CalendarDate }));
    expect(live.ctx!.state.isCurrent).toBe(false);
    expect(window.location.search).toBe('?period=2026-01-01');
  });
});

describe('L8 follow-up: the derived session alert keeps the state context stable', () => {
  const renders = { n: 0 };
  /** Counts its commits (an effect with no deps runs after every render of this component). */
  function StateConsumer() { useTimesheetState(); useEffect(() => { renders.n++; }); return null; }

  it('with the alert showing, a provider re-render that changes no state (opening the SubmitModal) doesn\'t re-render state consumers', async () => {
    renderTimesheet(data(), <><TimesheetPage /><StateConsumer /></>);
    actions.saveTimesheetBatch.mockResolvedValueOnce({ ok: false, code: 'unauthenticated', error: 'Unauthorized' });
    await edit(6);
    await act(async () => { await live.ctx!.requestSave(); });
    expect(shown('session-expired')).not.toBeNull();
    const before = renders.n;
    act(() => live.ctx!.openSubmit());
    expect(shown('submit-modal')).not.toBeNull();
    expect(renders.n).toBe(before);
  });
});
