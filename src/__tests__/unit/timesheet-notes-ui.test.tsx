// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-timesheet-ui.md B-T5 (§4.8, §5 "Notes", v5.2 §14.4): N / n and the per-cell note trigger open NoteModal
 * for their cell — the trigger without entering edit mode, after committing an open draft once (the H1 path); a future
 * empty cell has no trigger; a locked period shows one only on cells with a note (read-only); a note is editable on a
 * CLOSED row (not the hours rule) and read-only when locked or in the future; the button says "Done" (no "Save" in the
 * modal) and the hint is the textarea's description; Done makes the note dirty; Save sends notes only with no
 * ReasonModal; Remove sets ''; focus returns to the cell for both openers; axe with the modal open.
 */

const actions = vi.hoisted(() => ({ saveTimesheetBatch: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/components/timesheet/ReasonModal', () => ({ ReasonModal: ({ opened }: { opened: boolean }) => (opened ? <div>REASON_MODAL_OPEN</div> : null) }));
// Counts the grid's SET_HOURS dispatches ("commits once").
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
import { NOTE_HINT } from '@/components/timesheet/NoteModal';
import { CC, CC2, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { enterGrid, installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import { expectNoAxeViolations } from '../helpers/axe';
import type { CalendarDate } from '@/lib/calendar-date';
import type { TimesheetPeriodData } from '@/types/timesheet';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { actions.saveTimesheetBatch.mockReset(); dispatched.setHours = 0; });
afterEach(() => cleanup());

// Jan 1–15, 2026; today Wed Jan 7 (index 6). Row A (open, a note on day 1), row B closed to new hours (no prior hours).
const fixture = (o: Partial<TimesheetPeriodData> = {}) => pageData({
  today: '2026-01-07' as CalendarDate,
  chargeCodes: [chargeCode({ id: CC, clin: 'A', name: 'Code 1' }), chargeCode({ id: CC2, clin: 'B', name: 'Retired code', assignable: false })],
  notes: { [`${CC}-1`]: { body: 'Site visit', revision: 1 } },
  ...o,
});
const setup = (data = fixture()) => {
  const user = userEvent.setup();
  renderTimesheet(data, <TimesheetGrid />);
  return user;
};
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const textarea = () => dialog()?.querySelector('textarea') as HTMLTextAreaElement;
const dialogButtons = () => [...(dialog()?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim() ?? b.getAttribute('aria-label') ?? '');
const dialogButton = (label: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const grid = () => document.querySelector('table[role="grid"]') as HTMLTableElement;
const cell = (r: number, c: number) => grid().querySelector(`td[data-r="${r}"][data-c="${c}"]`) as HTMLElement;
const trigger = (r: number, c: number) => cell(r, c).querySelector('[data-note-trigger]') as HTMLElement | null;
const editor = () => grid().querySelector('input[data-cell-editor]') as HTMLInputElement | null;
const focusedPos = () => { const el = document.activeElement as HTMLElement; return `${el?.dataset?.r}:${el?.dataset?.c}`; };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe('notes UI (B-T5)', () => {
  it('N and n open NoteModal for the active day cell (unchanged)', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('N');
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Note — A Code 1 — Wed, Jan 7');
    await user.keyboard('{Escape}');
    await settle();
    expect(dialog()).toBeNull();
    await user.keyboard('n');
    expect(dialog()).not.toBeNull();
  });

  it('a click on a cell\'s trigger opens NoteModal for THAT cell, selects it and doesn\'t enter edit mode', async () => {
    const user = setup();
    await user.click(trigger(0, 1)!);                              // Fri Jan 2, "Site visit"
    expect(dialog()!.textContent).toContain('Note — A Code 1 — Fri, Jan 2');
    expect(textarea().value).toBe('Site visit');
    expect(editor()).toBeNull();
    expect(grid().querySelector('[tabindex="0"]')).toBe(cell(0, 1));
    expect(dispatched.setHours).toBe(0);
  });

  it('while editing another cell, a trigger click commits that draft once (the H1 path), then opens the note', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}5');      // 0:3, draft "5"
    expect(editor()!.value).toBe('5');
    await user.click(trigger(0, 1)!);
    expect(live.ctx!.state.entries[0].hours[3]).toBe(5);
    expect(dispatched.setHours).toBe(1);
    expect(dialog()!.textContent).toContain('Fri, Jan 2');
    expect(editor()).toBeNull();
  });

  it('a trigger click on the cell being edited commits its draft first, then opens its note', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}5');      // 0:3
    await user.click(trigger(0, 3)!);
    expect(live.ctx!.state.entries[0].hours[3]).toBe(5);
    expect(dispatched.setHours).toBe(1);
    expect(dialog()!.textContent).toContain('Sun, Jan 4');
    expect(editor()).toBeNull();
  });

  it('a pointer-down on a trigger is default-prevented: focus stays put and an open editor keeps its draft until the click', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}5');      // 0:3, editing
    const input = editor()!;
    expect(fireEvent.mouseDown(trigger(0, 1)!)).toBe(false);        // defaultPrevented
    expect(document.activeElement).toBe(input);
    expect(editor()!.value).toBe('5');
    expect(dispatched.setHours).toBe(0);
    expect(fireEvent.mouseDown(cell(0, 2))).toBe(true);             // a plain cell's pointer-down is untouched
  });

  it('a future empty cell renders no trigger; a past cell and today do (hidden by CSS until hover / active / a note)', () => {
    setup();
    expect(trigger(0, 10)).toBeNull();                              // future, no note
    expect(trigger(0, 3)).not.toBeNull();
    expect(trigger(0, 6)).not.toBeNull();
    expect(trigger(1, 3)).not.toBeNull();                           // a closed row: notes stay editable there
  });

  it('a locked period shows a trigger only on cells with a note, and it opens read-only', async () => {
    const user = setup(fixture({ periodStatus: 'submitted' }));
    const withTrigger = [...grid().querySelectorAll('[data-note-trigger]')].map((t) => (t.closest('td') as HTMLElement).dataset.c);
    expect(withTrigger).toEqual(['1']);
    await user.click(trigger(0, 1)!);
    expect(textarea().readOnly).toBe(true);
    expect(dialogButtons()).not.toContain('Done');
  });

  it('a cell with a note keeps its trigger with the note class (and "Edit note"); others say "Add note"', () => {
    setup();
    expect(cell(0, 1).className).toMatch(/hasNote/);
    expect(trigger(0, 1)!.getAttribute('title')).toBe('Edit note');
    expect(cell(0, 3).className).not.toMatch(/hasNote/);
    expect(trigger(0, 3)!.getAttribute('title')).toBe('Add note');
    expect(trigger(0, 1)!.getAttribute('aria-hidden')).toBe('true');
  });

  it('editable on a CLOSED row (notes don\'t follow the hours rule)', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowDown}{ArrowLeft}{ArrowLeft}{ArrowLeft}'); // 1:3 — closed row, past, empty: hours read-only
    expect((document.activeElement as HTMLElement).getAttribute('aria-readonly')).toBe('true');
    await user.keyboard('N');
    expect(textarea().readOnly).toBe(false);
    expect(dialogButtons()).toEqual(expect.arrayContaining(['Done', 'Cancel', 'Remove note']));
  });

  it('read-only (Close only) when the period is locked, and on a future day', async () => {
    let user = setup(fixture({ periodStatus: 'submitted' }));
    await enterGrid(user);
    await user.keyboard('N');
    expect(textarea().readOnly).toBe(true);
    expect(dialogButtons().filter((b) => b !== '')).toEqual(expect.arrayContaining(['Close']));
    expect(dialogButtons()).not.toContain('Done');
    cleanup();
    user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowRight}{ArrowRight}N');                       // 0:8, future
    expect(textarea().readOnly).toBe(true);
    expect(dialogButtons()).not.toContain('Done');
  });

  it('the button says "Done" — no button in NoteModal contains "Save" — and the hint is the textarea\'s description', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('N');
    expect(dialogButtons()).toContain('Done');
    expect(dialogButtons().some((b) => /save/i.test(b))).toBe(false);
    const described = (textarea().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(NOTE_HINT);
    expect(NOTE_HINT).toBe('Your note is saved when you save your timesheet.');
    expect(dialog()!.querySelector('[data-testid="note-counter"]')!.closest('[aria-live], [role="status"]')).toBeNull();
  });

  it('Done makes the note dirty; Save sends notes only, without ReasonModal', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: {}, noteRevisions: { [`${CC}-6`]: 1 } } });
    const user = setup();
    await enterGrid(user);
    await user.keyboard('N');
    await user.type(textarea(), 'Badge outage');
    await user.click(dialogButton('Done'));
    expect(live.ctx!.dirtyNotes).toEqual([{ key: `${CC}-6`, rowId: CC, dayIndex: 6, body: 'Badge outage' }]);
    expect(live.ctx!.unsavedCount).toBe(1);
    await act(async () => { expect(await live.ctx!.requestSave()).toBe(true); });
    expect(document.body.textContent).not.toContain('REASON_MODAL_OPEN');
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    expect(actions.saveTimesheetBatch.mock.calls[0][0]).toMatchObject({ cells: [], notes: [{ chargeCodeId: CC, dayIndex: 6, body: 'Badge outage', expectedRevision: 0 }] });
    expect(actions.saveTimesheetBatch.mock.calls[0][0].changeReasonCode).toBeUndefined();
    expect(live.ctx!.dirtyNotes).toEqual([]);
  });

  it('Remove note sets the body to \'\'', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}N'); // 0:1, "Site visit"
    expect(textarea().value).toBe('Site visit');
    await user.click(dialogButton('Remove note'));
    expect(live.ctx!.state.notes[`${CC}-1`]).toBe('');
    expect(live.ctx!.dirtyNotes).toEqual([{ key: `${CC}-1`, rowId: CC, dayIndex: 1, body: '' }]);
  });

  it('focus returns to the cell after Done, Cancel and Esc — for the N key and for the trigger', async () => {
    const user = setup();
    await enterGrid(user);
    expect(focusedPos()).toBe('0:6');
    for (const close of ['Done', 'Cancel', '{Escape}']) {
      await user.keyboard('N');
      expect(dialog()).not.toBeNull();
      if (close === '{Escape}') await user.keyboard(close); else await user.click(dialogButton(close));
      await settle();
      expect(focusedPos(), `N then ${close}`).toBe('0:6');
      await user.click(trigger(0, 2)!);
      if (close === '{Escape}') await user.keyboard(close); else await user.click(dialogButton(close));
      await settle();
      expect(focusedPos(), `trigger then ${close}`).toBe('0:2');
      await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');   // back to 0:6
    }
  });

  it('axe clean with the modal open', async () => {
    const user = setup();
    await enterGrid(user);
    await user.keyboard('N');
    await expectNoAxeViolations(document.body);
  });
});
