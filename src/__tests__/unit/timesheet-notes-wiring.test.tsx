// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';

/**
 * feature-plan-ux-timesheet.md A-T14 (A4.9): the old grid saves notes. Server notes show on the first render (from
 * initialData) and after a period load; a cleared note keeps its revision in the baseline (clear → save → re-add →
 * save sends the cleared revision); cleared notes show no icon; the note modal is read-only on locked or future cells;
 * Next is disabled at the current period; a typed note enables Save, is sent with expectedRevision and no reason
 * code, and is clean after ok (also when the server no-ops); Discard reverts it; Submit is blocked while it's dirty.
 */

const actions = vi.hoisted(() => ({
  saveTimesheetBatch: vi.fn(),
  getTimesheetPeriod: vi.fn(),
  getNeighborPeriod: vi.fn(),
  submitPeriod: vi.fn(),
  getPeriodOptions: vi.fn(),
}));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({
  submitPeriod: actions.submitPeriod,
  getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20', timezone: 'America/New_York' })),
  getPeriodOptions: actions.getPeriodOptions,
}));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@/components/timesheet/ReasonModal', () => ({ ReasonModal: ({ opened }: { opened: boolean }) => (opened ? <div>REASON_MODAL_OPEN</div> : null) }));
vi.mock('@/components/timesheet/SubmitModal', () => ({ SubmitModal: () => null }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@mantine/notifications', () => ({ notifications: { show: notify } }));

import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import type { TimesheetPageData, TimesheetPeriodData } from '@/types/timesheet';
import { chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import type { CalendarDate } from '@/lib/calendar-date';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

const CC = '22222222-2222-4222-8222-222222222222';
const KEY = `${CC}-1`;

// feature-plan-ux-timesheet-ui.md §4.4 shape: { ...pageContext, period }.
const data = (o: Partial<TimesheetPeriodData> = {}): TimesheetPageData => pageData({
  chargeCodes: [chargeCode({ id: CC })],
  entries: [{ chargeCodeId: CC, hours: [8, ...Array(14).fill(0)] }],
  today: '2026-01-20' as CalendarDate, // after the period: every day is past, Submit is open
  revisions: { [`${CC}-0`]: 1 },
  ...o,
});

let ctx: ReturnType<typeof useTimesheet> | null = null;
function Probe() {
  const value = useTimesheet();
  useEffect(() => { ctx = value; });
  return null;
}

let m: Mounted | undefined;
const render = async (initial: TimesheetPageData) => {
  m = await mount(
    <TimesheetProvider initialData={initial}>
      <TimesheetPage />
      <Probe />
    </TimesheetProvider>,
  );
  await wait(10);
};
// UX-3 Part B: the grid marks a note with sr ", note" in the cell (the note glyph is aria-hidden).
const cell = (day: number) => document.querySelector(`td[data-r="0"][data-c="${day}"]`) as HTMLElement;
const hasNoteMark = (day: number) => Boolean(cell(day)?.textContent?.includes(', note'));
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
// UX-3 Part B: unavailable controls are aria-disabled (never `disabled`, which would drop focus).
const unavailable = (el: Element | null) => el?.getAttribute('aria-disabled') === 'true';
const writeNote = async (day: number, body: string) => {
  await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: day, body }); });
};
const lastSave = () => actions.saveTimesheetBatch.mock.calls.at(-1)![0];

beforeAll(installDomStubs);
beforeEach(() => {
  ctx = null;
  for (const f of Object.values(actions)) f.mockReset();
  notify.mockReset();
  actions.getPeriodOptions.mockResolvedValue([]);
});
afterEach(() => { unmount(m); m = undefined; });

describe('note wiring on the timesheet page (UX-3 A-T14, ported to Part B)', () => {
  it('a server note shows on the FIRST render, from initialData', async () => {
    await render(data({ notes: { [KEY]: { body: 'Site visit', revision: 2 } } }));
    expect(hasNoteMark(1)).toBe(true);
    expect(ctx!.state.notes[KEY]).toBe('Site visit');
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'Site visit', revision: 2 });
    expect(ctx!.dirtyNotes).toEqual([]);
  });

  it('typing a note enables Save; Save sends notes with expectedRevision and no reason (no ReasonModal); after ok the note is clean', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: {}, noteRevisions: { [KEY]: 1 } } });
    await render(data());
    expect(unavailable(button('Save'))).toBe(true);
    await writeNote(1, '  Badge outage  ');
    expect(unavailable(button('Save'))).toBe(false);
    await click(button('Save'));
    await wait(20);
    expect(document.body.textContent).not.toContain('REASON_MODAL_OPEN');
    expect(lastSave()).toMatchObject({ cells: [], notes: [{ chargeCodeId: CC, dayIndex: 1, body: 'Badge outage', expectedRevision: 0 }] });
    expect(lastSave().changeReasonCode).toBeUndefined();
    expect(ctx!.dirtyNotes).toEqual([]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'Badge outage', revision: 1 });
    expect(unavailable(button('Save'))).toBe(true);
    // L9: the toast counts notes as changes, not "entries".
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Timesheet saved', message: '1 change saved.' }));
  });

  it('after an ok where the server no-ops (no new revision) the note is clean and keeps its revision', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: {}, noteRevisions: {} } });
    await render(data({ notes: { [KEY]: { body: 'Same', revision: 3 } } }));
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'Same ' }); }); // trims to the same body: not dirty
    expect(ctx!.dirtyNotes).toEqual([]);
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'Changed' }); });
    await act(async () => { await ctx!.saveAll(); });
    expect(ctx!.dirtyNotes).toEqual([]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'Changed', revision: 3 });
  });

  it('clear → save → re-add → save sends the CLEARED revision as expectedRevision and succeeds; a cleared note shows no icon', async () => {
    actions.saveTimesheetBatch
      .mockResolvedValueOnce({ ok: true, data: { revisions: {}, noteRevisions: { [KEY]: 2 } } })
      .mockResolvedValueOnce({ ok: true, data: { revisions: {}, noteRevisions: { [KEY]: 3 } } });
    await render(data({ notes: { [KEY]: { body: 'Old', revision: 1 } } }));
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: '' }); });
    await act(async () => { await ctx!.saveAll(); });
    expect(lastSave().notes).toEqual([{ chargeCodeId: CC, dayIndex: 1, body: '', expectedRevision: 1 }]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: '', revision: 2 }); // kept, not deleted
    expect(hasNoteMark(1)).toBe(false);
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'New' }); });
    const second = await act(async () => ctx!.saveAll());
    expect(second).toEqual({ ok: true, data: undefined });
    expect(lastSave().notes).toEqual([{ chargeCodeId: CC, dayIndex: 1, body: 'New', expectedRevision: 2 }]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'New', revision: 3 });
  });

  it('Discard reverts a note; Submit is disabled while a note is dirty', async () => {
    await render(data({ notes: { [KEY]: { body: 'Saved', revision: 1 } } }));
    expect(unavailable(button('Submit'))).toBe(false);
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'Edited' }); });
    expect(unavailable(button('Submit'))).toBe(true);
    expect(unavailable(button('Discard changes'))).toBe(false);
    await click(button('Discard changes'));
    // §4.9.5: Discard asks first.
    const dialogDiscard = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Discard changes') as HTMLButtonElement;
    await click(dialogDiscard);
    await wait(20);
    expect(ctx!.state.notes[KEY]).toBe('Saved');
    expect(ctx!.dirtyNotes).toEqual([]);
    expect(unavailable(button('Submit'))).toBe(false);
  });

  it('Next is disabled at the current period', async () => {
    await render(data({ isCurrent: true }));
    expect(unavailable(document.body.querySelector('button[aria-label="Next period"]'))).toBe(true);
    unmount(m);
    await render(data({ isCurrent: false }));
    expect(unavailable(document.body.querySelector('button[aria-label="Next period"]'))).toBe(false);
    unmount(m);
    // A tab left open across a period boundary: the server said "current", but the period list (fetched for the new
    // today) has a newer current period — Next must not stay stuck.
    actions.getPeriodOptions.mockResolvedValue([{ start: '2026-01-01', numDays: 15, label: 'Jan 1' }, { start: '2026-01-16', numDays: 16, label: 'Jan 16' }]);
    await render(data({ isCurrent: true }));
    expect(unavailable(document.body.querySelector('button[aria-label="Next period"]'))).toBe(false);
    // L7: a later re-fetch (today rolled over) that FAILS forgets the old list's "current" and falls back to isCurrent.
    actions.getPeriodOptions.mockRejectedValue(new Error('offline'));
    await act(async () => { ctx!.dispatch({ type: 'SET_TODAY', today: '2026-01-21' as CalendarDate }); });
    await wait(20);
    expect(unavailable(document.body.querySelector('button[aria-label="Next period"]'))).toBe(true);
  });

  it('a period load shows that period\'s server notes', async () => {
    await render(data({ notes: { [KEY]: { body: 'January', revision: 1 } } }));
    actions.getNeighborPeriod.mockResolvedValue({ periodStart: '2025-12-16', numDays: 16, periodConfig: periodData().periodConfig, isCurrent: false });
    actions.getTimesheetPeriod.mockResolvedValue(periodData({
      chargeCodes: [chargeCode({ id: CC })], periodStart: '2025-12-16' as CalendarDate, numDays: 16, entries: [{ chargeCodeId: CC, hours: Array(16).fill(0) }], revisions: {},
      notes: { [`${CC}-3`]: { body: 'December', revision: 4 } }, isCurrent: false,
    }));
    await click(document.body.querySelector('button[aria-label="Previous period"]'));
    await wait(30);
    expect(ctx!.state.periodStart).toBe('2025-12-16');
    expect(ctx!.state.notes).toEqual({ [`${CC}-3`]: 'December' });
    expect(ctx!.state.savedNotes).toEqual({ [`${CC}-3`]: { body: 'December', revision: 4 } });
    expect(hasNoteMark(3)).toBe(true);
    expect(hasNoteMark(1)).toBe(false);
  });
});
