// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-timesheet-ui.md B-T2 / B-T3 / B-T4 (§4.3, §5 "Cell mode"): the grid's keyboard model. B-T2 navigation
 * (one tab stop, edges, modifiers, PageUp/Down, Tab leaves, clamping); B-T3 editing (seeding, commits once, Esc, Delete,
 * read-only and total announcements, clicks inside the input, full-width digits, IME); B-T4 validation (quarter hours,
 * invalid Tab leaves, the day total with L1, invalid blur).
 */

vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
// Counts the grid's SET_HOURS dispatches ("commit once" means exactly one dispatch per key commit).
const dispatched = vi.hoisted(() => ({ setHours: 0 }));
vi.mock('@/components/timesheet/TimesheetContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/timesheet/TimesheetContext')>();
  return {
    ...actual,
    useTimesheetDispatch: () => {
      const dispatch = actual.useTimesheetDispatch();
      return (action: Parameters<typeof dispatch>[0]) => { if (action.type === 'SET_HOURS') dispatched.setHours++; dispatch(action); };
    },
  };
});

import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { CC, CC2, IND, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { enterGrid, installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';
import type { TimesheetPeriodData } from '@/types/timesheet';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { dispatched.setHours = 0; });
afterEach(() => cleanup());

// Jan 1–15, 2026; today Wed Jan 7 (index 6). Rows: A, B (Direct), I (Indirect and leave).
const fixture = (o: Partial<TimesheetPeriodData> = {}) => pageData({
  today: '2026-01-07' as CalendarDate,
  chargeCodes: [chargeCode({ id: CC, clin: 'A' }), chargeCode({ id: CC2, clin: 'B', name: 'Code 2' }), chargeCode({ id: IND, clin: 'LV', name: 'Leave', kind: 'indirect', isIndirect: true })],
  entries: [
    { chargeCodeId: CC, hours: [8, 0, 20, ...Array(12).fill(0)] },
    { chargeCodeId: CC2, hours: [0, 16, 10, ...Array(12).fill(0)] },
    { chargeCodeId: IND, hours: Array(15).fill(0) },
  ],
  revisions: { [`${CC}-0`]: 1, [`${CC}-2`]: 1, [`${CC2}-1`]: 1, [`${CC2}-2`]: 1 },
  ...o,
});

const setup = (data = fixture()) => {
  const user = userEvent.setup();
  const view = renderTimesheet(data, <><TimesheetGrid /><button type="button">after</button></>);
  return { user, view };
};
const grid = () => document.querySelector('table[role="grid"]') as HTMLTableElement;
const cell = (r: number | 'foot', c: number | string) => grid().querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement;
const stops = () => [...grid().querySelectorAll('[tabindex="0"]')];
const pos = () => { const el = stops()[0] as HTMLElement; return `${el.dataset.r}:${el.dataset.c}`; };
const focused = () => { const el = document.activeElement as HTMLElement; return el?.dataset?.r !== undefined ? `${el.dataset.r}:${el.dataset.c}` : el?.tagName; };
const input = () => grid().querySelector('input[data-cell-editor]') as HTMLInputElement | null;
/** The cell whose editor is open (r:c). */
const editing = () => { const td = input()?.closest('td') as HTMLElement | null; return td ? `${td.dataset.r}:${td.dataset.c}` : null; };
const value = (r: number, d: number) => live.ctx!.state.entries[r].hours[d];
const polite = () => document.querySelector('[data-testid="ts-announce-polite"]')!.textContent;
const assertive = () => document.querySelector('[data-testid="ts-announce-assertive"]')!.textContent;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });
const press = async (user: ReturnType<typeof userEvent.setup>, keys: string) => { await user.keyboard(keys); };

describe('navigation (B-T2)', () => {
  it('initial position is today in the first row; Tab enters the grid there; exactly one tabindex=0', async () => {
    const { user } = setup();
    expect(stops()).toHaveLength(1);
    expect(pos()).toBe('0:6');
    await enterGrid(user);
    expect(focused()).toBe('0:6');
  });

  it('← → ↑ ↓, Home / End move the one tab stop; edges stop; group rows are skipped; the footer is the last row', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{Home}');
    expect(focused()).toBe('0:rh');
    await press(user, '{ArrowLeft}');
    expect(focused()).toBe('0:rh');                    // edge stops
    await press(user, '{ArrowRight}{ArrowRight}');
    expect(focused()).toBe('0:1');
    await press(user, '{End}');
    expect(focused()).toBe('0:total');
    await press(user, '{ArrowRight}');
    expect(focused()).toBe('0:total');
    await press(user, '{ArrowUp}');
    expect(focused()).toBe('0:total');
    await press(user, '{ArrowDown}{ArrowDown}');
    expect(focused()).toBe('2:total');                 // past the "Indirect and leave" group row
    await press(user, '{ArrowDown}');
    expect(focused()).toBe('foot:total');
    await press(user, '{ArrowDown}');
    expect(focused()).toBe('foot:total');
    expect(stops()).toHaveLength(1);
    expect(pos()).toBe('foot:total');
  });

  it('Ctrl/Meta + Home / End go to the first day of the first row / the grand total', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{Control>}{End}{/Control}');
    expect(focused()).toBe('foot:total');
    await press(user, '{Control>}{Home}{/Control}');
    expect(focused()).toBe('0:0');
    await press(user, '{Meta>}{End}{/Meta}');
    expect(focused()).toBe('foot:total');
  });

  it('PageUp / PageDown on a day move 7 days, clamped to the period; on the row header or total they do nothing', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{PageDown}');
    expect(focused()).toBe('0:13');
    await press(user, '{PageDown}');
    expect(focused()).toBe('0:14');
    await press(user, '{PageUp}');
    expect(focused()).toBe('0:7');
    await press(user, '{Home}{PageDown}');
    expect(focused()).toBe('0:rh');
    await press(user, '{End}{PageUp}');
    expect(focused()).toBe('0:total');
  });

  it('handled keys are defaultPrevented; Alt+← and ⌘+← (browser Back) and Tab are not handled', async () => {
    const { user } = setup();
    await enterGrid(user);
    const el = () => document.activeElement as HTMLElement;
    for (const key of ['PageDown', 'PageUp', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(fireEvent.keyDown(el(), { key }), key).toBe(false);
    }
    const before = focused();
    expect(fireEvent.keyDown(el(), { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(el(), { key: 'ArrowLeft', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(el(), { key: 'ArrowRight', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(el(), { key: 'Tab' })).toBe(true);
    expect(focused()).toBe(before);
  });

  it('v5.2: exactly one tab stop in the grid area with note triggers rendered; no trigger is focusable', async () => {
    const { user } = setup(fixture({ notes: { [`${CC}-1`]: { body: 'Site visit', revision: 1 } } }));
    const area = grid().closest('[class*="gridArea"]')!;
    expect(grid().querySelectorAll('[data-note-trigger]').length).toBeGreaterThan(10);
    expect(area.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    for (const t of grid().querySelectorAll('[data-note-trigger]')) {
      expect(t.tagName).toBe('SPAN');
      expect(t.hasAttribute('tabindex')).toBe(false);
      expect(t.getAttribute('role')).toBeNull();
      expect(t.getAttribute('aria-hidden')).toBe('true');
      expect(t.querySelector('button, a, input, [tabindex]')).toBeNull();
    }
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');  // 0:1, has a note
    expect(area.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await user.tab();
    expect((document.activeElement as HTMLElement).textContent).toBe('after');      // straight out: no trigger stop
  });

  it('Tab leaves the grid', async () => {
    const { user } = setup();
    await enterGrid(user);
    await user.tab();
    expect((document.activeElement as HTMLElement).textContent).toBe('after');
  });

  it('exactly one tabindex=0 after a period with fewer rows and with no body rows (the position is clamped)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowDown}{ArrowDown}');
    expect(pos()).toBe('2:6');
    act(() => live.ctx!.dispatch({ type: 'SET_PERIOD_DATA', ...periodData({ chargeCodes: [chargeCode({ id: CC })], numDays: 15 }) }));
    expect(stops()).toHaveLength(1);
    expect(pos()).toBe('0:6');
    act(() => live.ctx!.dispatch({ type: 'SET_PERIOD_DATA', ...periodData({ chargeCodes: [], entries: [] }) }));
    expect(stops()).toHaveLength(1);
    expect(pos()).toBe('foot:6');
  });
});

describe('editing (B-T3)', () => {
  it('typing 7 on an editable day enters edit with the draft exactly "7"; "," seeds "."; full-width digits are accepted', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}');   // 0:3 (Sat, past, empty, editable)
    await press(user, '7');
    expect(input()!.value).toBe('7');
    expect(document.activeElement).toBe(input());
    await press(user, '{Escape}');
    await press(user, ',');
    expect(input()!.value).toBe('.');
    await press(user, '{Escape}');
    await press(user, '７');
    expect(input()!.value).toBe('7');
    await press(user, '.５');
    expect(input()!.value).toBe('7.5');
  });

  it('Enter, ↑, ↓ and Tab each commit once', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}'); // 0:3
    await press(user, '6{Enter}');
    expect(value(0, 3)).toBe(6);
    expect(dispatched.setHours).toBe(1);
    expect(focused()).toBe('0:3');
    await press(user, '5{ArrowDown}');
    expect(value(0, 3)).toBe(5);
    expect(focused()).toBe('1:3');
    await press(user, '4{ArrowUp}');
    expect(value(1, 3)).toBe(4);
    expect(focused()).toBe('0:3');
    await press(user, '3{Tab}');
    expect(value(0, 3)).toBe(3);
    expect(focused()).toBe('0:4');
    expect(dispatched.setHours).toBe(4);
  });

  // UX-TIMESHEET-B-AUDIT M8: a valid Tab at the last visible day (and Shift+Tab at the first) commits and LEAVES the grid.
  it('a valid Tab at the last day commits and leaves the grid; Shift+Tab at the first day commits and leaves it backwards (M8)', async () => {
    const { user } = setup(fixture({ today: '2026-01-15' as CalendarDate }));   // every day is past or today: all editable
    await enterGrid(user);
    await press(user, '{End}{ArrowLeft}');                    // 0:14, the last day
    expect(focused()).toBe('0:14');
    await press(user, '5{Tab}');
    expect(value(0, 14)).toBe(5);
    expect((document.activeElement as HTMLElement).textContent).toBe('after');
    await user.tab({ shift: true });                           // back into the grid, at its tab stop (0:14)
    await press(user, '{Home}{ArrowRight}');                   // 0:0, the first day
    expect(focused()).toBe('0:0');
    await press(user, '2{Shift>}{Tab}{/Shift}');
    expect(value(0, 0)).toBe(2);
    expect(grid().contains(document.activeElement)).toBe(false);
    expect(input()).toBeNull();
  });

  it('F2 enters edit with the caret at the end; Enter and Space enter edit with the text selected (M8)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{Home}{ArrowRight}');                   // 0:0 holds 8.00
    await press(user, '{F2}');
    expect(input()!.value).toBe('8.00');
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([4, 4]);
    await press(user, '{Escape}');
    await press(user, '{Enter}');
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 4]);
    await press(user, '{Escape}');
    await press(user, ' ');
    expect(input()).not.toBeNull();
    expect(input()!.value).toBe('8.00');
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 4]);
  });

  it('edit-mode Esc discards the draft and the blur does not commit', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await press(user, '9{Escape}');
    expect(input()).toBeNull();
    expect(value(0, 3)).toBe(0);
    expect(dispatched.setHours).toBe(0);
    expect(focused()).toBe('0:3');
  });

  it('nav-mode Esc restores a changed cell and announces; Delete sets 0 and announces "Cleared"', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{Control>}{Home}{/Control}');      // 0:0, saved 8
    await press(user, '{Delete}');
    expect(value(0, 0)).toBe(0);
    await settle();
    expect(polite()).toBe('Cleared');
    await press(user, '{Escape}');
    expect(value(0, 0)).toBe(8);
    await settle();
    expect(polite()).toBe('Restored to 8.00');
  });

  it('Enter on a read-only day announces its reason; Enter on a total announces "Totals are calculated."', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowRight}{ArrowRight}{ArrowRight}{Enter}');  // 0:9, future
    expect(input()).toBeNull();
    await settle();
    expect(polite()).toBe("Future date. Hours can't be entered yet.");
    await press(user, '7');
    expect(input()).toBeNull();
    await press(user, '{End}{Enter}');
    await settle();
    expect(polite()).toBe('Totals are calculated.');
  });

  it('a click on an editable day enters edit with the text selected; a click inside the input does not reselect', async () => {
    const { user } = setup();
    await user.click(cell(0, 0));
    expect(input()!.value).toBe('8.00');
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 4]);
    await user.keyboard('7');
    expect(input()!.value).toBe('7');
    await user.click(input()!);
    expect(input()!.value).toBe('7');
    expect([input()!.selectionStart, input()!.selectionEnd]).not.toEqual([0, 1]);
  });

  it('L1: nav-mode Esc doesn\'t restore a value that would push the day over 24 — it says why and keeps the value', async () => {
    const { user } = setup();
    await enterGrid(user);
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 0, value: 2 }));   // A: saved 8 → 2
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC2, dayIndex: 0, value: 20 })); // B: 0 → 20 (day 22)
    await press(user, '{Home}{ArrowRight}');                   // 0:0
    dispatched.setHours = 0;
    await press(user, '{Escape}');                             // restoring 8 would make 28 (saved total 8)
    expect(value(0, 0)).toBe(2);
    expect(dispatched.setHours).toBe(0);
    await settle();
    expect(assertive()).toBe("This day would total 28 hours. A day can't exceed 24.");
    // Lower B first; then the restore fits and goes through.
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC2, dayIndex: 0, value: 10 }));
    await press(user, '{Escape}');
    expect(value(0, 0)).toBe(8);
  });

  it('L2: Enter on a footer daily total announces "Totals are calculated."', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{Control>}{End}{/Control}{Home}{ArrowRight}');   // foot:0
    expect(focused()).toBe('foot:0');
    await press(user, '{Enter}');
    await settle();
    expect(polite()).toBe('Totals are calculated.');
    expect(input()).toBeNull();
  });

  it('IME composing (and keyCode 229) does not seed', async () => {
    const { user } = setup();
    await enterGrid(user);
    fireEvent.keyDown(document.activeElement!, { key: '7', isComposing: true });
    expect(input()).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: '7', keyCode: 229 });
    expect(input()).toBeNull();
  });
});

describe('validation (B-T4)', () => {
  it('7.3 stays in edit with aria-invalid on the input, a visible error, announced assertively', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await press(user, '7.3{Enter}');
    expect(input()).not.toBeNull();
    expect(input()!.getAttribute('aria-invalid')).toBe('true');
    const err = document.getElementById(input()!.getAttribute('aria-describedby')!)!;
    expect(err.textContent).toBe('Use quarter hours (.00, .25, .50 or .75).');
    await settle();
    expect(assertive()).toBe('Use quarter hours (.00, .25, .50 or .75).');
    expect(value(0, 3)).toBe(0);
  });

  it('an invalid Tab restores the earlier value, announces, and lets focus leave the grid', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await press(user, '7.3');
    await user.tab();
    expect((document.activeElement as HTMLElement).textContent).toBe('after');
    expect(input()).toBeNull();
    expect(value(0, 3)).toBe(0);
    await settle();
    expect(assertive()).toBe("7.3 isn't valid; restored 0.00");
  });

  it('a day over 24 is blocked, unless it is no higher than the saved total (L1)', async () => {
    const { user } = setup();
    await user.click(cell(0, 1));                 // day 1: A 0 + B 16 (saved 16)
    await user.keyboard('{Control>}a{/Control}9{Enter}');
    expect(input()!.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input()!.getAttribute('aria-describedby')!)!.textContent).toBe("This day would total 25 hours. A day can't exceed 24.");
    await press(user, '{Escape}');
    await user.click(cell(1, 2));                 // day 2: A 20 + B 10 = 30 saved (imported-style)
    await user.keyboard('{Control>}a{/Control}8{Enter}');
    expect(value(1, 2)).toBe(8);                  // 28 ≤ 30
    await user.click(cell(1, 2));
    await user.keyboard('{Control>}a{/Control}12{Enter}');
    expect(input()!.getAttribute('aria-invalid')).toBe('true'); // 32 > 30
    expect(value(1, 2)).toBe(8);
  });

  // UX-TIMESHEET-B-AUDIT H1: a click with no focus change first (a screen-reader activation, an iOS tap) — no mousedown,
  // so the editor never blurred before the click.
  it('a click on another cell with no prior blur commits a valid draft exactly once, then moves (H1)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}5');   // 0:3, draft "5"
    expect(input()!.value).toBe('5');
    dispatched.setHours = 0;
    fireEvent.click(cell(0, 4));
    expect(value(0, 3)).toBe(5);
    expect(dispatched.setHours).toBe(1);
    expect(editing()).toBe('0:4');                                  // editing the clicked cell, with its own value
    expect(input()!.value).toBe('');
    expect(document.activeElement).toBe(input());
    fireEvent.blur(input()!);                                       // a later native blur commits nothing more
    expect(dispatched.setHours).toBe(1);
  });

  it('a click on another cell with no prior blur restores an invalid draft and announces it (H1)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}7.3');
    dispatched.setHours = 0;
    fireEvent.click(cell(1, 3));
    expect(value(0, 3)).toBe(0);
    expect(dispatched.setHours).toBe(0);
    expect(editing()).toBe('1:3');
    await settle();
    expect(assertive()).toBe("7.3 isn't valid; restored 0.00");
  });

  it('a click on the cell being edited (no prior blur) keeps the draft (H1)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}5');
    fireEvent.click(cell(0, 3));
    expect(input()!.value).toBe('5');
    expect(document.activeElement).toBe(input());
    expect(value(0, 3)).toBe(0);
  });

  it('M1: a window blur while editing (the input stays the active element) commits and leaves focus on the cell, not <body>', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}5');
    dispatched.setHours = 0;
    fireEvent.blur(input()!);                    // a window blur: no focus move inside the document
    expect(input()).toBeNull();
    expect(value(0, 3)).toBe(5);
    expect(dispatched.setHours).toBe(1);
    expect(focused()).toBe('0:3');
    // The suppression used for that move doesn't leak: the next edit's blur commits normally.
    await press(user, '6');
    await user.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'after')!);
    expect(value(0, 3)).toBe(6);
  });

  it('M1: the suppression used for that move never outlives it (a browser that fires no blur for the move)', async () => {
    const { user } = setup();
    await enterGrid(user);
    await press(user, '{ArrowLeft}{ArrowLeft}{ArrowLeft}5');
    const td = cell(0, 3);
    Object.defineProperty(td, 'focus', { value: () => {}, configurable: true }); // the move causes no nested blur here
    fireEvent.blur(input()!);
    expect(value(0, 3)).toBe(5);
    delete (td as { focus?: unknown }).focus;
    await user.click(cell(0, 4));                // edit another cell; its blur must commit
    await press(user, '3');
    await user.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'after')!);
    expect(value(0, 4)).toBe(3);
  });

  it('an invalid blur restores and announces', async () => {
    const { user } = setup();
    await user.click(cell(0, 3));
    await user.keyboard('7.3');
    await user.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'after')!);
    expect(input()).toBeNull();
    expect(value(0, 3)).toBe(0);
    await settle();
    expect(assertive()).toBe("7.3 isn't valid; restored 0.00");
  });
});
