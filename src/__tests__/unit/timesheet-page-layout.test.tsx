// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-timesheet-ui.md B-T6 (§4.1, §4.4): initialization (the page context survives initialization and period
 * loads, trap T-O; first mount holds the server's notes and selected-period fields) and the page layout — one h1 with the
 * period control below it, the status line (follows edits; "Was due"; submittedOn / reviewedOn), the returned banner,
 * Submit's reason precedence (and no aria-describedby when available), SET_TODAY opening Submit, the SubmitModal
 * overtime figure (incomplete weeks included), the exempt-only weekly notice (complete weeks), focus kept on controls
 * that become unavailable (aria-disabled, never disabled), the missing Choose-period option, no dashboard / old panel.
 */

const actions = vi.hoisted(() => ({ getTimesheetPeriod: vi.fn(), getNeighborPeriod: vi.fn(), saveTimesheetBatch: vi.fn(), submitPeriod: vi.fn(), getPeriodOptions: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: actions.submitPeriod, getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20' })), getPeriodOptions: actions.getPeriodOptions }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/components/timesheet/SubmitModal', () => ({
  SubmitModal: ({ opened, uncompensatedHours, totalPeriodHours }: { opened: boolean; uncompensatedHours?: number; totalPeriodHours?: number }) =>
    (opened ? <div data-testid="submit-modal">OT {uncompensatedHours} of {totalPeriodHours}</div> : null),
}));

import { initialTimesheetState, timesheetReducer } from '@/components/timesheet/TimesheetContext';
import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import { CC, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';
import type { TimesheetPeriodData } from '@/types/timesheet';

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

// Jan 1–15, 2026 (Thu–Thu). Submit opens Thu Jan 15.
const page = (o: Partial<TimesheetPeriodData> = {}, ctx: Partial<{ flsaExempt: boolean; readOnly: boolean }> = {}) =>
  pageData({ chargeCodes: [chargeCode()], entries: [{ chargeCodeId: CC, hours: [8, 8, 0, 0, 8, 8, 8, ...Array(8).fill(0)] }], revisions: { [`${CC}-0`]: 1 }, ...o }, ctx);
const btn = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label && !b.closest('[role="dialog"]')) as HTMLButtonElement;
const statusLine = () => document.querySelector('[data-testid="status-line"]')!.textContent;
const submitWhy = () => { const id = btn('Submit').getAttribute('aria-describedby'); return id ? document.getElementById(id)?.textContent ?? null : null; };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('page layout (B-T6)', () => {
  it('one h1 "Timesheet"; the period control sits below it in the header band; status pill once (+ self-approval badge)', () => {
    renderTimesheet(page({ approvalBadge: 'Self-approved', periodStatus: 'approved' }), <TimesheetPage />);
    const h1s = document.querySelectorAll('h1');
    expect([...h1s].map((h) => h.textContent)).toEqual(['Timesheet']);
    const band = h1s[0].closest('.mantine-Group-root')!;
    expect(band.querySelector('button[aria-label="Previous period"]')).not.toBeNull();
    expect(band.querySelector('[aria-label="Choose period"]')).not.toBeNull();
    expect(band.compareDocumentPosition(band.querySelector('button[aria-label="Previous period"]')!) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(document.body.textContent!.match(/Approved/g)!.length).toBeGreaterThanOrEqual(1);
    expect([...document.querySelectorAll('.mantine-Badge-root')].map((b) => b.textContent)).toEqual(['Approved', 'Self-approved']);
  });

  it('M6: reading and tab order is h1 → the period control → status and Save/Submit (‹ comes before Save)', async () => {
    renderTimesheet(page({}), <TimesheetPage />);
    const h1 = document.querySelector('h1')!;
    const prev = document.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement;
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement;
    const status = [...document.querySelectorAll('.mantine-Badge-root')].find((b) => b.textContent === 'Draft')!;
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(h1, prev)).toBe(true);
    expect(before(prev, status)).toBe(true);
    expect(before(prev, save)).toBe(true);
    // Tab order from the top of the page: ‹ is reached before Save.
    const user = userEvent.setup();
    const reached: string[] = [];
    for (let i = 0; i < 20 && reached.length < 2; i++) {
      await user.tab();
      const el = document.activeElement;
      if (el === prev) reached.push('prev');
      if (el === save) reached.push('save');
    }
    expect(reached).toEqual(['prev', 'save']);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  });

  it('flsaExempt: true and readOnly: true are both kept: the FLSA notice shows (a complete week over 40) and every cell is read-only', () => {
    renderTimesheet(page({ entries: [{ chargeCodeId: CC, hours: [0, 0, 0, 0, 10, 10, 10, 10, 10, ...Array(6).fill(0)] }], workweekStartDay: 1 }, { flsaExempt: true, readOnly: true }), <TimesheetPage />);
    expect(document.querySelector('[data-testid="weekly-notice"]')!.textContent).toContain('Week of Jan 5: 10 hours over 40 (uncompensated).');
    const days = [...document.querySelectorAll('tbody td')].filter((td) => td.getAttribute('data-c') !== 'total');
    expect(days.every((td) => td.getAttribute('aria-readonly') === 'true')).toBe(true);
    expect(submitWhy()).toBe('This workspace is read-only');
  });

  it('first mount shows the server notes and the status line from initialData; the status line follows a commit', () => {
    renderTimesheet(page({ notes: { [`${CC}-1`]: { body: 'Site visit', revision: 1 } } }), <TimesheetPage />);
    expect(document.querySelector(`td[data-r="0"][data-c="1"]`)!.textContent).toContain(', note');
    expect(statusLine()).toBe('40 hours entered · 5 of 11 workdays so far are filled in · Was due Jan 15');
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 7, value: 7.5 }));
    expect(statusLine()).toBe('47.5 hours entered · 6 of 11 workdays so far are filled in · Was due Jan 15');
  });

  it('"Due {dddd, MMM D}" while due; submittedOn / reviewedOn for submitted and approved periods', () => {
    const { unmount } = renderTimesheet(page({ today: '2026-01-07' as CalendarDate }), <TimesheetPage />);
    expect(statusLine()).toBe('40 hours entered · 5 of 5 workdays so far are filled in · Due Thursday, Jan 15');
    unmount();
    const sub = renderTimesheet(page({ periodStatus: 'submitted', submittedOn: '2026-01-16' as CalendarDate }), <TimesheetPage />);
    expect(statusLine()).toBe('40 hours · Submitted Jan 16, 2026');
    sub.unmount();
    renderTimesheet(page({ periodStatus: 'approved', reviewedOn: '2026-01-19' as CalendarDate }), <TimesheetPage />);
    expect(statusLine()).toBe('40 hours · Approved Jan 19, 2026');
    expect(document.querySelector('[data-testid="status-line"]')!.tagName).toBe('P');
    expect(document.querySelector('[data-testid="status-line"]')!.closest('[aria-live], [role="status"]')).toBeNull();
  });

  it('the returned banner, once, with the review comment quoted', () => {
    renderTimesheet(page({ periodStatus: 'rejected', reviewComment: 'Split Tuesday across codes.' }), <TimesheetPage />);
    const banners = document.querySelectorAll('[data-testid="returned-banner"]');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toBe('Returned for corrections\u201cSplit Tuesday across codes.\u201d');
  });

  it('Submit reason precedence (§4.1), visible and linked; no aria-describedby and no reason element when available', () => {
    const cases: Array<[Partial<TimesheetPeriodData>, Partial<{ readOnly: boolean }>, string]> = [
      [{ periodStatus: 'submitted' }, { readOnly: true }, 'This workspace is read-only'],
      [{ periodStatus: 'submitted' }, {}, 'This timesheet is submitted'],
      [{ periodStatus: 'approved' }, {}, 'This timesheet is approved'],
      [{ today: '2026-01-07' as CalendarDate }, {}, 'Opens Thursday, Jan 15'],
      [{ entries: [{ chargeCodeId: CC, hours: Array(15).fill(0) }] }, {}, 'Add hours before submitting'],
      // Precedence: each earlier reason wins over the later ones that also apply.
      [{ today: '2026-01-07' as CalendarDate, entries: [{ chargeCodeId: CC, hours: Array(15).fill(0) }] }, { readOnly: true }, 'This workspace is read-only'],
      [{ periodStatus: 'submitted', today: '2026-01-07' as CalendarDate }, {}, 'This timesheet is submitted'],
      [{ today: '2026-01-07' as CalendarDate, entries: [{ chargeCodeId: CC, hours: Array(15).fill(0) }] }, {}, 'Opens Thursday, Jan 15'],
    ];
    for (const [period, ctx, why] of cases) {
      const view = renderTimesheet(page(period, ctx), <TimesheetPage />);
      expect(btn('Submit').getAttribute('aria-disabled'), why).toBe('true');
      expect(submitWhy(), why).toBe(why);
      view.unmount();
    }
    renderTimesheet(page(), <TimesheetPage />);
    expect(btn('Submit').hasAttribute('aria-disabled')).toBe(false);
    expect(btn('Submit').hasAttribute('aria-describedby')).toBe(false);
    expect(document.body.textContent).not.toMatch(/Save your changes first|Add hours before submitting/);
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 7, value: 2 }));
    expect(submitWhy()).toBe('Save your changes first');
    act(() => live.ctx!.dispatch({ type: 'BEGIN_PERIOD_LOAD' }));
    expect(submitWhy()).toBe('Loading…');
  });

  it('Submit becomes available when SET_TODAY passes submitOpensOn', () => {
    renderTimesheet(page({ today: '2026-01-14' as CalendarDate }), <TimesheetPage />);
    expect(submitWhy()).toBe('Opens Thursday, Jan 15');
    act(() => live.ctx!.dispatch({ type: 'SET_TODAY', today: '2026-01-15' as CalendarDate }));
    expect(btn('Submit').hasAttribute('aria-disabled')).toBe(false);
    expect(submitWhy()).toBeNull();
  });

  it('the SubmitModal overtime figure includes an incomplete final week (today\'s meaning)', async () => {
    const user = userEvent.setup();
    // Monday workweek. Week of Jan 5: 40 hours (complete). Week of Jan 12: incomplete (Jan 16–18 are outside the period and
    // unknown) but already 9 + 9 + 9 + 18 = 45 hours → its 5 hours over 40 still count, as they did before.
    const hours = [0, 0, 0, 0, 8, 8, 8, 8, 8, 0, 0, 9, 9, 9, 18];
    renderTimesheet(page({ entries: [{ chargeCodeId: CC, hours }], revisions: {}, workweekStartDay: 1, outsideWeekHours: {} }, { flsaExempt: true }), <TimesheetPage />);
    expect(live.ctx!.checks.uncompensatedHours).toBe(5);
    expect(live.ctx!.checks.totalPeriodHours).toBe(85);
    await user.click(btn('Submit'));
    expect(document.querySelector('[data-testid="submit-modal"]')!.textContent).toBe('OT 5 of 85');
  });

  it('the weekly notice is exempt-only and uses complete weeks only', () => {
    const under = page({ entries: [{ chargeCodeId: CC, hours: [0, 0, 0, 0, 8, 8, 8, 8, 0, 0, 0, 4, ...Array(3).fill(0)] }], workweekStartDay: 1, today: '2026-01-13' as CalendarDate });
    const v1 = renderTimesheet(under, <TimesheetPage />);
    expect(document.querySelector('[data-testid="weekly-notice"]')).toBeNull();               // not exempt
    v1.unmount();
    renderTimesheet({ ...under, flsaExempt: true }, <TimesheetPage />);
    const text = document.querySelector('[data-testid="weekly-notice"]')!.textContent;
    expect(text).toContain('Week of Jan 5: 32 hours. Record all time worked, including leave.');
    expect(text).not.toContain('Week of Jan 12');                                             // incomplete: never flagged
    expect(text).not.toContain('Week of Dec 29');                                             // edge week unknown outside days
  });

  it('v5.3 (§15.2): the "Past timesheets" link sits in the header area (by the status line); the grid\'s wrapper is the gridSlot, the page\'s last child', () => {
    renderTimesheet(page({}), <TimesheetPage />);
    const pageEl = document.querySelector('[class*="page"]') as HTMLElement;
    expect(pageEl.className).toMatch(/page/);
    const slot = pageEl.lastElementChild as HTMLElement;
    expect(slot.className).toMatch(/gridSlot/);
    expect(slot.querySelector('table[role="grid"]')).not.toBeNull();
    expect([...pageEl.children].filter((c) => /gridSlot/.test(c.className))).toHaveLength(1);
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Past timesheets')!;
    expect(link.getAttribute('href')).toBe('/timesheet/history');
    expect(slot.contains(link)).toBe(false);                                         // nothing below the scroller
    const status = document.querySelector('[class*="statusLine"]')!;
    expect(link.parentElement).toBe(status.parentElement);                           // next to the status line
    expect(Boolean(link.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('v5.2 (§14.5): the weekly notice is one p[role="note"] — not a Mantine Alert — icon hidden, lines joined with " · "', () => {
    const two = page({ entries: [{ chargeCodeId: CC, hours: [0, 0, 0, 0, 8, 8, 8, 8, 0, 0, 0, 4, 4, 4, 4] }], workweekStartDay: 1, today: '2026-01-20' as CalendarDate,
      outsideWeekHours: { '2026-01-16': 0, '2026-01-17': 0, '2026-01-18': 0 } });
    renderTimesheet({ ...two, flsaExempt: true }, <TimesheetPage />);
    const notice = document.querySelector('[data-testid="weekly-notice"]')!;
    expect(notice.tagName).toBe('P');
    expect(notice.getAttribute('role')).toBe('note');
    expect(notice.closest('.mantine-Alert-root')).toBeNull();
    expect(notice.className).not.toMatch(/mantine-Alert/);
    expect(notice.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(notice.textContent).toContain(' · ');
  });

  it('focus stays on Save, Discard changes, Today and ‹ after they become unavailable (aria-disabled, never disabled)', async () => {
    const user = userEvent.setup();
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: { [`${CC}-1`]: 1 }, noteRevisions: {} } });
    renderTimesheet(page({ today: '2026-01-15' as CalendarDate }), <TimesheetPage />);
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 14, value: 4 })); // a new entry today: no reason needed
    await user.click(btn('Save'));
    await settle();
    expect(document.activeElement).toBe(btn('Save'));
    expect(btn('Save').getAttribute('aria-disabled')).toBe('true');
    expect(btn('Save').hasAttribute('disabled')).toBe(false);

    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 13, value: 2 }));
    await user.click(btn('Discard changes'));
    // §4.9.5: Discard asks first; after confirming, focus is back on Discard changes (now aria-disabled).
    await user.click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Discard changes')!);
    await settle();
    expect(live.ctx!.hasUnsaved).toBe(false);
    expect(document.activeElement).toBe(btn('Discard changes'));
    expect(btn('Discard changes').getAttribute('aria-disabled')).toBe('true');
    expect(btn('Discard changes').hasAttribute('disabled')).toBe(false);

    actions.getTimesheetPeriod.mockResolvedValue(periodData({ chargeCodes: [chargeCode()], isCurrent: true, periodStart: '2026-01-16' as CalendarDate, numDays: 16, today: '2026-01-20' as CalendarDate }));
    await user.click(btn('Today'));
    await settle();
    expect(document.activeElement).toBe(btn('Today'));
    expect(btn('Today').getAttribute('aria-disabled')).toBe('true');
    expect(btn('Today').hasAttribute('disabled')).toBe(false);
    expect(document.querySelector('button[aria-label="Next period"]')!.getAttribute('aria-disabled')).toBe('true');

    let resolve!: (v: unknown) => void;
    actions.getNeighborPeriod.mockResolvedValue({ periodStart: '2026-01-01', numDays: 15, periodConfig: periodData().periodConfig, isCurrent: false });
    actions.getTimesheetPeriod.mockReturnValue(new Promise((r) => { resolve = r; }));
    const prev = document.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement;
    await user.click(prev);
    expect(live.ctx!.state.isLoadingPeriod).toBe(true);
    expect(document.activeElement).toBe(prev);
    expect(prev.hasAttribute('disabled')).toBe(false);
    await act(async () => { resolve(periodData({ chargeCodes: [chargeCode()] })); });
    expect(document.activeElement).toBe(prev);
  });

  it('a Choose period value missing from the 24-period list is added (the Select shows the period)', async () => {
    actions.getPeriodOptions.mockResolvedValue([{ start: '2026-10-01', numDays: 15, label: 'Oct 1 – Oct 15, 2026' }, { start: '2026-10-16', numDays: 16, label: 'Oct 16 – Oct 31, 2026' }]);
    renderTimesheet(page(), <TimesheetPage />);
    await settle();
    expect((document.querySelector('input[aria-label="Choose period"]') as HTMLInputElement).value).toBe('Jan 1 – 15, 2026');
  });

  it('no dashboard and no old exempt panel; the page no longer fetches the dashboard', () => {
    renderTimesheet(page({}, { flsaExempt: true }), <TimesheetPage />);
    expect(document.body.textContent).not.toMatch(/Total Period Hours|Semi-Monthly Timesheet|Days Remaining|Late/);
    expect(btn('Current')).toBeUndefined();
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/timesheet/page.tsx'), 'utf8');
    expect(src).not.toMatch(/getEmployeeDashboardData|TimesheetDashboard/);
    expect(document.querySelector('a[href="/timesheet/history"]')!.textContent).toBe('Past timesheets');
  });
});
