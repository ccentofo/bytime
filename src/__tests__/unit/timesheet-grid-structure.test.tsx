// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';

/**
 * feature-plan-ux-timesheet-ui.md B-T1 (§4.2): the grid tree — caption, column/row headers with data-r/data-c, one tbody
 * per non-empty group, explicit role=gridcell, exactly one tabindex=0, blank empty cells, aria-readonly placement (never
 * aria-disabled), day-header screen-reader text rules, no "Late" badge, rowName on indirect rows; axe clean.
 */

vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { CC, CC2, IND, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import { expectNoAxeViolations } from '../helpers/axe';
import type { CalendarDate } from '@/lib/calendar-date';
import type { TimesheetPeriodData } from '@/types/timesheet';

beforeAll(() => installTimesheetDomStubs());
afterEach(() => cleanup());

// Jan 1–15, 2026: Jan 1 is a Thursday; today is Wed Jan 7 (index 6); the user was created Mon Jan 5.
const hoursA = [8, ...Array(14).fill(0)];
const hoursB = [0, 0, 4, ...Array(12).fill(0)];
const fixture = (o: Partial<TimesheetPeriodData> = {}) => pageData({
  today: '2026-01-07' as CalendarDate,
  userCreatedOn: '2026-01-05' as CalendarDate,
  chargeCodes: [
    chargeCode({ id: CC, clin: 'NAV-1', name: 'Code 1' }),
    chargeCode({ id: CC2, clin: 'OLD-1', name: 'Retired code', assignable: false }),
    chargeCode({ id: IND, clin: 'LV-AL', name: 'Annual leave', projectName: 'Leave', description: 'Paid leave', kind: 'indirect', isIndirect: true }),
  ],
  entries: [
    { chargeCodeId: CC, hours: hoursA, provenance: ['Imported from Deltek on 2026-01-02', ...Array(14).fill(null)] },
    { chargeCodeId: CC2, hours: hoursB },
    { chargeCodeId: IND, hours: Array(15).fill(0) },
  ],
  revisions: { [`${CC}-0`]: 1, [`${CC2}-2`]: 1 },
  notes: { [`${CC}-1`]: { body: 'Site visit', revision: 1 } },
  ...o,
});

const grid = () => document.querySelector('table[role="grid"]') as HTMLTableElement;
const cell = (r: number | 'foot', c: number | string) => grid().querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement;
const srOf = (el: Element) => el.querySelector('span[class*="srOnly"]')?.textContent ?? '';

describe('grid structure (B-T1)', () => {
  it('table, caption, headers, groups and footer per §4.2', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const g = grid();
    expect(g.tagName).toBe('TABLE');
    const caption = g.querySelector('caption')!;
    expect(caption.textContent).toBe('Hours for Jan 1 to 15, 2026, Draft');
    expect(g.getAttribute('aria-labelledby')).toBe(caption.id);
    expect(document.getElementById(g.getAttribute('aria-describedby')!)!.textContent).toBe('Arrow keys move. Type a number to enter hours. N adds or edits a note. Escape undoes the cell.');

    const heads = [...g.querySelectorAll('thead th')];
    expect(heads).toHaveLength(17);
    expect(heads.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    expect(heads[0].textContent).toBe('Charge code');
    expect(heads.at(-1)!.textContent).toBe('Total');

    const bodies = [...g.querySelectorAll('tbody')];
    expect(bodies.map((b) => b.querySelector('th[scope="rowgroup"]')!.textContent)).toEqual(['Direct', 'Indirect and leave']);
    expect(bodies[0].querySelector('th[scope="rowgroup"]')!.getAttribute('colspan')).toBe('17');

    const rowHeads = [...g.querySelectorAll('tbody th[scope="row"]')];
    expect(rowHeads.map((th) => [th.getAttribute('data-r'), th.getAttribute('data-c')])).toEqual([['0', 'rh'], ['1', 'rh'], ['2', 'rh']]);
    expect(rowHeads[0].id).toMatch(new RegExp(`-rh-${CC}$`));
    expect(rowHeads[1].textContent).toContain('Closed to new hours');
    // rowName: the indirect row shows the code's own name, not its category.
    expect(rowHeads[2].textContent).toBe('Annual leave LV-AL');                // v5.2: name, then the code chip
    expect(rowHeads[2].textContent).not.toContain('Leave ');

    const foot = g.querySelector('tfoot tr')!;
    expect(foot.querySelector('th[scope="row"]')!.textContent).toBe('Daily total');
    expect(foot.querySelector('th')!.getAttribute('data-r')).toBe('foot');
    expect(cell('foot', 'total').textContent).toContain('12.00');
  });

  // v5.2 visual revision (§14, §14.6 B-T1).
  it('v5.2: no button above the table; no meter in the day headers; the visible hint', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const area = grid().closest('[class*="gridArea"]')!;
    expect(area.querySelectorAll('button')).toHaveLength(0);
    expect([...area.querySelectorAll('*')].some((el) => /\bnote\b/i.test(el.textContent ?? '') && el.tagName === 'BUTTON')).toBe(false);
    expect(document.body.textContent).not.toContain('Choose a day cell first');
    expect(grid().querySelectorAll('thead [class*="meter"]')).toHaveLength(0);
    for (const th of grid().querySelectorAll('thead th[id*="-ch-"]:not([id$="-ch-total"])')) {
      expect([...th.querySelector('[aria-hidden="true"]')!.children].map((c) => c.textContent)).toHaveLength(2); // name, date
    }
    expect(area.querySelector('[class*="hint"]')!.textContent).toBe('Click a cell or type a number to enter hours. Hover a cell to add a note, or press N.');
  });

  it('v5.2: group rows carry no vertical-line class; every other row cell does', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    for (const group of grid().querySelectorAll('tr[class*="groupRow"]')) {
      for (const c of group.children) expect(c.className, 'group row cell').not.toMatch(/\bcell\b|_cell_|cell__/);
    }
    const rowCells = [...grid().querySelectorAll('tbody tr:not([class*="groupRow"]) > *, tfoot tr > *')];
    expect(rowCells.length).toBeGreaterThan(0);
    for (const c of rowCells) expect(c.className, `${c.tagName} ${c.getAttribute('data-c')}`).toMatch(/cell/);
  });

  it('v5.2: the row header reads name, then the code chip (accessible name "{name} {code}"); no name → the chip alone', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const rh = grid().querySelector('tbody th[scope="row"]')!;
    const parts = [...rh.children].map((c) => [c.className.match(/name|code|closedNote/)?.[0], c.textContent]);
    expect(parts.slice(0, 2)).toEqual([['name', 'Code 1'], ['code', 'NAV-1']]);
    expect(rh.textContent).toBe('Code 1 NAV-1');
    cleanup();
    renderTimesheet(fixture({ chargeCodes: [chargeCode({ id: CC, clin: 'CLIN 0001', name: 'CLIN 0001' })], entries: [{ chargeCodeId: CC, hours: hoursA }] }), <TimesheetGrid />);
    const only = grid().querySelector('tbody th[scope="row"]')!;
    expect([...only.children].map((c) => c.className.match(/name|code/)?.[0])).toEqual(['code']);
    expect(only.textContent).toBe('CLIN 0001');
  });

  it('v5.2: axe clean with note triggers rendered (the active cell and a cell with a note)', async () => {
    const { container } = renderTimesheet(fixture(), <TimesheetGrid />);
    expect(cell(0, 6).querySelector('[data-note-trigger]')).not.toBeNull();   // active
    expect(cell(0, 1).querySelector('[data-note-trigger]')).not.toBeNull();   // has a note
    await expectNoAxeViolations(container);
  });

  it('day cells are explicit gridcells with data-r/data-c; empty cells are blank; 2 decimals; exactly one tabindex=0 (today in the first row)', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const g = grid();
    const tds = [...g.querySelectorAll('td')];
    expect(tds.every((td) => td.getAttribute('role') === 'gridcell')).toBe(true);
    expect(tds.every((td) => td.hasAttribute('data-r') && td.hasAttribute('data-c'))).toBe(true);
    // Every positioned element is a real table cell: a day cell is a <td role="gridcell">, a row header a <th scope="row">.
    for (const el of g.querySelectorAll('[data-r][data-c]')) {
      expect(el.tagName, `${el.getAttribute('data-r')}:${el.getAttribute('data-c')}`).toBe(el.getAttribute('data-c') === 'rh' ? 'TH' : 'TD');
      if (el.tagName === 'TD') expect(el.getAttribute('role')).toBe('gridcell');
    }
    expect(g.querySelectorAll('[data-r][data-c]')).toHaveLength(4 * 17);
    expect(cell(0, 0).querySelector('span')!.textContent).toBe('8.00');
    expect(cell(0, 3).querySelector('span')!.textContent).toBe('');
    expect(g.textContent).not.toContain('—');
    const stops = [...g.querySelectorAll('[tabindex="0"]')];
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(cell(0, 6));
    expect(g.querySelector('[aria-disabled]')).toBeNull();
  });

  it('aria-readonly: future, closed-and-uncorrectable and total cells; never on editable cells or row headers; each with its reason', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const desc = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' | ');
    expect(cell(0, 1).hasAttribute('aria-readonly')).toBe(false);                 // editable
    expect(cell(1, 2).hasAttribute('aria-readonly')).toBe(false);                 // closed row, but correctable (prior revision)
    expect(cell(1, 3).getAttribute('aria-readonly')).toBe('true');               // closed, empty
    expect(desc(cell(1, 3))).toBe('Closed to new hours. You can correct hours already recorded.');
    expect(cell(0, 9).getAttribute('aria-readonly')).toBe('true');               // future
    expect(desc(cell(0, 9))).toBe("Future date. Hours can't be entered yet.");
    expect(cell(0, 'total').getAttribute('aria-readonly')).toBe('true');
    expect(desc(cell(0, 'total'))).toBe('Totals are calculated.');
    expect(cell('foot', 4).getAttribute('aria-readonly')).toBe('true');
    expect([...grid().querySelectorAll('th[scope="row"]')].some((th) => th.hasAttribute('aria-readonly'))).toBe(false);
    // Imported provenance has its own hidden description; a note is ", note" (the glyph is aria-hidden).
    expect(desc(cell(0, 0))).toBe('Imported from Deltek on 2026-01-02');
    expect(srOf(cell(0, 0))).toBe(', imported');
    expect(srOf(cell(0, 1))).toBe(', note');
  });

  it('every day cell is read-only when the period is submitted (reason: locked) or the workspace is read-only', () => {
    const { unmount } = renderTimesheet(fixture({ periodStatus: 'submitted' }), <TimesheetGrid />);
    const days = [...grid().querySelectorAll('tbody td')].filter((td) => td.getAttribute('data-c') !== 'total');
    expect(days.every((td) => td.getAttribute('aria-readonly') === 'true')).toBe(true);
    expect(document.getElementById(cell(0, 1).getAttribute('aria-describedby')!)!.textContent).toBe("This timesheet is submitted and can't be changed.");
    unmount();
    renderTimesheet(fixture({ readOnly: true }), <TimesheetGrid />);
    expect(document.getElementById(cell(0, 1).getAttribute('aria-describedby')!)!.textContent).toBe('This workspace is read-only.');
  });

  it('day headers: visible day + date ("Today" today) and a meter, all aria-hidden; sr text with hours, ", today", and "no hours logged" only for past weekdays on or after userCreatedOn; no Late badge', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    const th = (d: number) => document.querySelector(`th[id$="-ch-${d}"]`) as HTMLElement;
    expect(th(0).querySelector('[aria-hidden="true"]')!.textContent).toBe('ThuJan 1');
    expect(srOf(th(0))).toBe('Thursday Jan 1, 8 hours');
    expect(th(6).querySelector('[aria-hidden="true"]')!.textContent).toBe('WedToday');
    expect(srOf(th(6))).toBe('Wednesday Jan 7, today, 0 hours');
    expect(srOf(th(4))).toBe('Monday Jan 5, 0 hours, no hours logged');   // past weekday, on the creation day
    expect(srOf(th(5))).toBe('Tuesday Jan 6, 0 hours, no hours logged');
    expect(srOf(th(1))).toBe('Friday Jan 2, 0 hours');                     // before the user existed
    expect(srOf(th(2))).toBe('Saturday Jan 3, 4 hours');                   // weekend: never "no hours logged"
    expect(srOf(th(3))).toBe('Sunday Jan 4, 0 hours');                     // weekend, no hours: never "no hours logged"
    expect(srOf(th(9))).toBe('Saturday Jan 10, 0 hours');                  // future
    expect(document.querySelector(`[id$="-chn-4"]`)!.textContent).toBe('Monday Jan 5');
    expect(document.querySelector(`[id$="-chn-4"]`)!.hasAttribute('hidden')).toBe(true);
    expect(grid().textContent).not.toMatch(/\bLate\b/);
    expect(srOf(cell('foot', 4))).toBe(', no hours, past workday');
    expect(srOf(cell('foot', 1))).toBe('');
  });

  it('L3: while a period loads, every day cell is read-only with the reason "Loading…"', () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    expect(cell(0, 3).getAttribute('aria-readonly')).toBeNull();               // editable before the load
    act(() => live.ctx!.dispatch({ type: 'BEGIN_PERIOD_LOAD' }));
    expect(cell(0, 3).getAttribute('aria-readonly')).toBe('true');
    expect(document.getElementById(cell(0, 3).getAttribute('aria-describedby')!)!.textContent).toBe('Loading…');
    expect(document.getElementById(cell(0, 10).getAttribute('aria-describedby')!)!.textContent).toBe('Loading…'); // future too
  });

  it('L13: a row name that repeats its code is shown once (a legacy CLIN without a description)', () => {
    renderTimesheet(fixture({ chargeCodes: [chargeCode({ id: CC, clin: 'CLIN 0001', name: 'CLIN 0001', kind: 'clin', assignable: false })], entries: [{ chargeCodeId: CC, hours: hoursA }] }), <TimesheetGrid />);
    const rh = grid().querySelector('tbody th[scope="row"]')!;
    expect(rh.textContent).toBe('CLIN 0001 Closed to new hours');
    expect(rh.querySelector('[class*="name"]')).toBeNull();
  });

  it('no body rows: the footer row header is the one tab stop', () => {
    renderTimesheet(fixture({ chargeCodes: [], entries: [] }), <TimesheetGrid />);
    expect(grid().querySelectorAll('tbody')).toHaveLength(0);
    const stops = [...grid().querySelectorAll('[tabindex="0"]')];
    expect(stops).toEqual([grid().querySelector('tfoot th')]);
  });

  it('axe clean', async () => {
    renderTimesheet(fixture(), <TimesheetGrid />);
    await expectNoAxeViolations(document.body);
  });
});
