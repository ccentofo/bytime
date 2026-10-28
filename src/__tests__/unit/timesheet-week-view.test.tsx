// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-timesheet-ui.md B-T9 (§4.7 week view): below 40em the grid shows one week at a time — weeks aligned to
 * the workspace workweek and clipped to the period; only that week's day columns (data-c stays the period day index);
 * ← at a week edge continues into the previous week; PageDown moves 7 days (switching week); choosing a week moves to its
 * first day with one tab stop; the picker is always a Select "Week" (UX-TIMESHEET-B-AUDIT M4: a SegmentedControl clipped
 * at 320 px); a view switch mid-edit cancels the edit; Total is the period row total.
 */

vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { CC, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { enterGrid, installTimesheetDomStubs, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';
import type { TimesheetPeriodData } from '@/types/timesheet';

// A controllable matchMedia: `(max-width: 40em)` matches while `media.narrow` is true; a change notifies listeners.
const media = { narrow: true, listeners: new Set<(e: { matches: boolean }) => void>() };
const setNarrow = (narrow: boolean) => act(() => { media.narrow = narrow; for (const l of media.listeners) l({ matches: narrow }); });
beforeAll(() => {
  installTimesheetDomStubs();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() { return query.includes('max-width: 40em') ? media.narrow : false; },
      media: query, onchange: null,
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => { if (query.includes('max-width: 40em')) media.listeners.add(l); },
      removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => { media.listeners.delete(l); },
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});
beforeEach(() => { media.narrow = true; media.listeners.clear(); });
afterEach(() => cleanup());

// Jan 1–15, 2026 with a Monday workweek: weeks Jan 1–4 (Thu–Sun), Jan 5–11, Jan 12–15. Today Wed Jan 7 (index 6).
const fixture = (o: Partial<TimesheetPeriodData> = {}) => pageData({
  today: '2026-01-07' as CalendarDate,
  workweekStartDay: 1,
  chargeCodes: [chargeCode()],
  entries: [{ chargeCodeId: CC, hours: [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3] }],
  ...o,
});
const grid = () => document.querySelector('table[role="grid"]') as HTMLTableElement;
const dayCols = () => [...grid().querySelectorAll('tbody tr:not([class*="groupRow"]) td[data-c]')].map((td) => td.getAttribute('data-c')).filter((c) => c !== 'total');
const focused = () => { const el = document.activeElement as HTMLElement; return `${el?.dataset?.r}:${el?.dataset?.c}`; };
const stops = () => grid().querySelectorAll('[tabindex="0"]');
/** The "Week" Select's input (found through its visible label) and its option labels. */
const weekInput = () => { const label = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Week')!; return document.getElementById(label.htmlFor) as HTMLInputElement; };
const weekOptions = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(weekInput()); return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent); };

describe('week view (B-T9)', () => {
  it('narrow: weeks are aligned to the workweek and clipped to the period; only the active day\'s week renders (period day indexes)', async () => {
    const user = userEvent.setup();
    renderTimesheet(fixture(), <TimesheetGrid />);
    expect(dayCols()).toEqual(['4', '5', '6', '7', '8', '9', '10']);   // the week of Mon Jan 5 (today is Jan 7)
    expect(weekInput().value).toBe('Jan 5 – 11');
    expect(await weekOptions(user)).toEqual(['Jan 1 – 4', 'Jan 5 – 11', 'Jan 12 – 15']);
    expect(grid().querySelectorAll('thead th[id*="-ch-"]').length).toBe(7 + 1);  // 7 day headers + Total
  });

  it('Total is the PERIOD row total, not the week\'s', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    expect(grid().querySelector('td[data-r="0"][data-c="total"]')!.textContent).toBe('30.00');
  });

  it('← at the week edge continues into the previous week; PageDown moves 7 days (switching week); one tab stop throughout', async () => {
    const user = userEvent.setup();
    renderTimesheet(fixture(), <TimesheetGrid />);
    await enterGrid(user);
    expect(focused()).toBe('0:6');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(focused()).toBe('0:4');                                        // Mon Jan 5: the week's first day
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('0:3');                                        // Sun Jan 4, the previous week
    expect(dayCols()).toEqual(['0', '1', '2', '3']);
    await user.keyboard('{PageDown}');
    expect(focused()).toBe('0:10');
    expect(dayCols()).toEqual(['4', '5', '6', '7', '8', '9', '10']);
    await user.keyboard('{PageDown}');
    expect(focused()).toBe('0:14');                                       // clamped to the period's last day
    expect(dayCols()).toEqual(['11', '12', '13', '14']);
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('0:total');                                    // period edge: on to the total
    expect(stops()).toHaveLength(1);
  });

  it('choosing a week moves the active position to its first day (one tab stop)', async () => {
    const user = userEvent.setup();
    renderTimesheet(fixture(), <TimesheetGrid />);
    await user.click(weekInput());
    await user.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Jan 12 – 15')!);
    expect(dayCols()).toEqual(['11', '12', '13', '14']);
    expect(stops()).toHaveLength(1);
    expect((stops()[0] as HTMLElement).dataset.c).toBe('11');
  });

  it('the picker is a Select labelled "Week" for three weeks and for more (never a SegmentedControl; never clips at 320px)', () => {
    const three = renderTimesheet(fixture(), <TimesheetGrid />);
    expect(document.querySelector('.mantine-SegmentedControl-root')).toBeNull();
    expect(weekInput().value).toBe('Jan 5 – 11');
    three.unmount();
    renderTimesheet(fixture({ numDays: 31, entries: [{ chargeCodeId: CC, hours: Array(31).fill(0) }], submitOpensOn: '2026-01-30' as CalendarDate }), <TimesheetGrid />);
    expect(document.querySelector('.mantine-SegmentedControl-root')).toBeNull();
    expect(weekInput().value).toBe('Jan 5 – 11');
  });

  it('a view switch mid-edit cancels the edit (announced); the week follows the active day', async () => {
    media.narrow = false;
    const user = userEvent.setup();
    renderTimesheet(fixture(), <TimesheetGrid />);
    expect(dayCols()).toHaveLength(15);
    await enterGrid(user);
    await user.keyboard('{PageUp}7');                                      // Thu Jan 1 (past, editable): editing
    expect(document.querySelector('input[data-cell-editor]')).not.toBeNull();
    setNarrow(true);
    expect(document.querySelector('input[data-cell-editor]')).toBeNull();
    expect(dayCols()).toEqual(['0', '1', '2', '3']);                         // the week follows the active day
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(document.querySelector('[data-testid="ts-announce-polite"]')!.textContent).toBe('Edit cancelled');
  });

  it('wide: every day column renders and there is no week picker', () => {
    media.narrow = false;
    renderTimesheet(fixture(), <TimesheetGrid />);
    expect(dayCols()).toHaveLength(15);
    expect(document.querySelector('.mantine-Select-root')).toBeNull();
  });
});
