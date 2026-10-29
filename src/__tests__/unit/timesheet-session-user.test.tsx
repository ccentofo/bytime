// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * UX-TIMESHEET-B-AUDIT H3 (client): the provider sends the page's userId as `expectedUserId` with every save and submit;
 * when the server answers SESSION_USER_CHANGED (a different person signed in from another tab) the edits stay dirty, the
 * message is announced assertively and shown in the session alert with NO sign-in link, a ReasonModal or SubmitModal
 * closes, and nothing is marked saved or submitted.
 */

const actions = vi.hoisted(() => ({ saveTimesheetBatch: vi.fn(), submitPeriod: vi.fn() }));
const toasts = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: actions.submitPeriod, getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: toasts }));
vi.mock('@/components/timesheet/ReasonModal', () => ({
  ReasonModal: ({ opened, onConfirm }: { opened: boolean; onConfirm: (r: string, c: string) => Promise<void> }) => (opened ? (
    <button type="button" data-testid="reason-modal" onClick={() => { void onConfirm('LATE_ENTRY', 'late'); }}>MOCK_REASON_CONFIRM</button>
  ) : null),
}));
vi.mock('@/components/timesheet/SubmitModal', () => ({
  SubmitModal: ({ opened, onConfirm }: { opened: boolean; onConfirm: (c?: string) => Promise<void> }) => (opened ? (
    <button type="button" data-testid="submit-modal" onClick={() => { void onConfirm(); }}>MOCK_SUBMIT_CONFIRM</button>
  ) : null),
}));

import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import { SESSION_USER_CHANGED } from '@/lib/timesheet/copy';
import { CC, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { actions.saveTimesheetBatch.mockReset(); actions.submitPeriod.mockReset(); toasts.show.mockReset(); });
afterEach(() => cleanup());

const CHANGED = { ok: false, code: 'validation', error: SESSION_USER_CHANGED };
// Jan 1–15, 2026; today Wed Jan 7 (index 6). The page belongs to Jane ('jane-id').
const setup = () => renderTimesheet(pageData({ today: '2026-01-07' as CalendarDate, submitOpensOn: '2026-01-01' as CalendarDate, chargeCodes: [chargeCode()] }, { userId: 'jane-id' }), <TimesheetPage />);
const edit = (dayIndex: number) => act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex, value: 4 }));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });
const alertBox = () => document.querySelector('[data-testid="session-expired"]');
const assertive = () => document.querySelector('[data-testid="ts-announce-assertive"]')!.textContent;

describe('the page user is sent with every write (H3)', () => {
  it('a save sends expectedUserId = the page userId', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: { [`${CC}-6`]: 1 }, noteRevisions: {} } });
    setup();
    await edit(6);
    await act(async () => { await live.ctx!.requestSave(); });
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    expect(actions.saveTimesheetBatch.mock.calls[0][0].expectedUserId).toBe('jane-id');
  });

  it('a submit sends expectedUserId = the page userId', async () => {
    actions.submitPeriod.mockResolvedValue({ ok: true, data: {} });
    setup();
    await act(async () => { await live.ctx!.submitTimesheet(); });
    expect(actions.submitPeriod).toHaveBeenCalledWith(expect.objectContaining({ expectedUserId: 'jane-id', periodStart: '2026-01-01' }));
  });
});

describe('SESSION_USER_CHANGED (H3)', () => {
  it('a save: false, edits stay dirty, announced assertively, the session alert has no sign-in link, no failure toast', async () => {
    actions.saveTimesheetBatch.mockResolvedValue(CHANGED);
    setup();
    await edit(6);
    let result: boolean | undefined;
    await act(async () => { result = await live.ctx!.requestSave(); });
    await settle();
    expect(result).toBe(false);
    expect(live.ctx!.hasUnsaved).toBe(true);
    expect(live.ctx!.dirtyCells).toHaveLength(1);
    expect(live.ctx!.state.savedEntries[0].hours[6]).toBe(0);
    expect(alertBox()!.textContent).toBe(SESSION_USER_CHANGED);
    expect(alertBox()!.querySelector('a')).toBeNull();
    expect(assertive()).toBe(SESSION_USER_CHANGED);
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('through the ReasonModal: it closes, the save resolves false, the edits stay dirty', async () => {
    actions.saveTimesheetBatch.mockResolvedValue(CHANGED);
    const user = userEvent.setup();
    setup();
    await edit(2);                                    // a late entry: needs a reason
    let result: boolean | undefined;
    act(() => { void live.ctx!.requestSave().then((r) => { result = r; }); });
    await settle();                                   // requestSave opens the ReasonModal after a microtask
    await user.click(document.querySelector('[data-testid="reason-modal"]')!);
    await settle();
    expect(document.querySelector('[data-testid="reason-modal"]')).toBeNull();
    expect(result).toBe(false);
    expect(live.ctx!.hasUnsaved).toBe(true);
    expect(alertBox()!.textContent).toBe(SESSION_USER_CHANGED);
  });

  it('a submit: the SubmitModal closes, nothing is submitted, the session alert explains', async () => {
    actions.submitPeriod.mockResolvedValue(CHANGED);
    const user = userEvent.setup();
    setup();
    act(() => live.ctx!.openSubmit());
    await user.click(document.querySelector('[data-testid="submit-modal"]')!);
    await settle();
    expect(document.querySelector('[data-testid="submit-modal"]')).toBeNull();
    expect(live.ctx!.state.periodStatus).toBe('draft');
    expect(alertBox()!.textContent).toBe(SESSION_USER_CHANGED);
    expect(alertBox()!.querySelector('a')).toBeNull();
    expect(assertive()).toBe(SESSION_USER_CHANGED);
  });
});
