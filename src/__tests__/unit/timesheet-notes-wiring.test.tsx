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
}));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({
  submitPeriod: actions.submitPeriod,
  getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20', timezone: 'America/New_York' })),
  getPeriodOptions: vi.fn(async () => []),
}));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('@/lib/offline/offline-store', () => ({ seedOfflineStore: vi.fn() }));
vi.mock('@/components/timesheet/ReasonModal', () => ({ ReasonModal: ({ opened }: { opened: boolean }) => (opened ? <div>REASON_MODAL_OPEN</div> : null) }));
vi.mock('@/components/timesheet/SubmitModal', () => ({ SubmitModal: () => null }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import type { TimesheetPageData } from '@/types/timesheet';
import type { CalendarDate } from '@/lib/calendar-date';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

const CC = '22222222-2222-4222-8222-222222222222';
const KEY = `${CC}-1`;

const data = (o: Partial<TimesheetPageData> = {}): TimesheetPageData => ({
  userId: 'u1',
  chargeCodes: [{ id: CC, projectName: 'Navy', clin: 'NAV-1', description: 'Code 1', kind: 'charge', assignable: true }],
  entries: [{ chargeCodeId: CC, hours: [8, ...Array(14).fill(0)] }],
  periodStart: '2026-01-01' as CalendarDate,
  numDays: 15,
  today: '2026-01-20' as CalendarDate, // after the period: every day is past, Submit is open
  revisions: { [`${CC}-0`]: 1 },
  periodStatus: 'draft',
  periodConfig: { periodType: 'semimonthly', anchorDate: '2026-01-01' as CalendarDate, weekStartDay: 1 },
  readOnly: false,
  notes: {},
  isCurrent: false,
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
      <PayPeriodSelector />
      <TimesheetToolbar />
      <BiWeeklyTable />
      <DailyNoteModal />
      <Probe />
    </TimesheetProvider>,
  );
  await wait(10);
};
const cell = (day: number) => document.getElementById(`cell-${CC}-${day}`)!;
const noteIcon = (day: number) => cell(day).querySelector('button[aria-label="Add note"]') as HTMLButtonElement | null;
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const hover = async (day: number) => { await act(async () => { cell(day).dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); }); };
const textarea = () => document.body.querySelector('textarea') as HTMLTextAreaElement;
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const writeNote = async (day: number, body: string) => {
  if (!noteIcon(day)) await hover(day);
  await click(noteIcon(day));
  await wait(20);
  await type(body);
  await click(button('Save Note'));
  await wait(20);
};
const lastSave = () => actions.saveTimesheetBatch.mock.calls.at(-1)![0];

beforeAll(installDomStubs);
beforeEach(() => {
  ctx = null;
  for (const f of Object.values(actions)) f.mockReset();
});
afterEach(() => { unmount(m); m = undefined; });

describe('old-grid note wiring (UX-3 A-T14)', () => {
  it('a server note shows on the FIRST render, from initialData', async () => {
    await render(data({ notes: { [KEY]: { body: 'Site visit', revision: 2 } } }));
    expect(noteIcon(1)).not.toBeNull();
    expect(ctx!.state.notes[KEY]).toBe('Site visit');
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'Site visit', revision: 2 });
    expect(ctx!.dirtyNotes).toEqual([]);
  });

  it('typing a note enables Save; Save sends notes with expectedRevision and no reason (no ReasonModal); after ok the note is clean', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: {}, noteRevisions: { [KEY]: 1 } } });
    await render(data());
    expect(button('Save').disabled).toBe(true);
    await writeNote(1, '  Badge outage  ');
    expect(button('Save').disabled).toBe(false);
    await click(button('Save'));
    await wait(20);
    expect(document.body.textContent).not.toContain('REASON_MODAL_OPEN');
    expect(lastSave()).toMatchObject({ cells: [], notes: [{ chargeCodeId: CC, dayIndex: 1, body: 'Badge outage', expectedRevision: 0 }] });
    expect(lastSave().changeReasonCode).toBeUndefined();
    expect(ctx!.dirtyNotes).toEqual([]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'Badge outage', revision: 1 });
    expect(button('Save').disabled).toBe(true);
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
    expect(noteIcon(1)).toBeNull();
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'New' }); });
    const second = await act(async () => ctx!.saveAll());
    expect(second).toEqual({ ok: true, data: undefined });
    expect(lastSave().notes).toEqual([{ chargeCodeId: CC, dayIndex: 1, body: 'New', expectedRevision: 2 }]);
    expect(ctx!.state.savedNotes[KEY]).toEqual({ body: 'New', revision: 3 });
  });

  it('Discard reverts a note; Submit is disabled while a note is dirty', async () => {
    await render(data({ notes: { [KEY]: { body: 'Saved', revision: 1 } } }));
    expect(button('Submit').disabled).toBe(false);
    await act(async () => { ctx!.dispatch({ type: 'SET_NOTE', chargeCodeId: CC, dayIndex: 1, body: 'Edited' }); });
    expect(button('Submit').disabled).toBe(true);
    expect(button('Discard Changes').disabled).toBe(false);
    await click(button('Discard Changes'));
    expect(ctx!.state.notes[KEY]).toBe('Saved');
    expect(ctx!.dirtyNotes).toEqual([]);
    expect(button('Submit').disabled).toBe(false);
  });

  it('the note modal is read-only on a locked period and on a future date', async () => {
    await render(data({ periodStatus: 'submitted', notes: { [KEY]: { body: 'Locked note', revision: 1 } } }));
    await click(noteIcon(1));
    await wait(20);
    expect(textarea().readOnly).toBe(true);
    expect(button('Save Note')).toBeUndefined();
    unmount(m);
    await render(data({ today: '2026-01-05' as CalendarDate, notes: { [`${CC}-10`]: { body: 'Future note', revision: 1 } } }));
    await click(noteIcon(10));
    await wait(20);
    expect(textarea().readOnly).toBe(true);
    expect(button('Save Note')).toBeUndefined();
    unmount(m);
    await render(data({ today: '2026-01-05' as CalendarDate }));
    await hover(2);
    await click(noteIcon(2));
    await wait(20);
    expect(textarea().readOnly).toBe(false); // an editable past cell
  });

  it('Next is disabled at the current period', async () => {
    await render(data({ isCurrent: true }));
    expect((document.body.querySelector('button[aria-label="Next pay period"]') as HTMLButtonElement).disabled).toBe(true);
    unmount(m);
    await render(data({ isCurrent: false }));
    expect((document.body.querySelector('button[aria-label="Next pay period"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a period load shows that period\'s server notes', async () => {
    await render(data({ notes: { [KEY]: { body: 'January', revision: 1 } } }));
    actions.getNeighborPeriod.mockResolvedValue({ periodStart: '2025-12-16', numDays: 16, periodConfig: data().periodConfig, isCurrent: false });
    actions.getTimesheetPeriod.mockResolvedValue({
      ...data(), periodStart: '2025-12-16', numDays: 16, entries: [{ chargeCodeId: CC, hours: Array(16).fill(0) }], revisions: {},
      notes: { [`${CC}-3`]: { body: 'December', revision: 4 } }, isCurrent: false,
    });
    await click(document.body.querySelector('button[aria-label="Previous pay period"]'));
    await wait(30);
    expect(ctx!.state.periodStart).toBe('2025-12-16');
    expect(ctx!.state.notes).toEqual({ [`${CC}-3`]: 'December' });
    expect(ctx!.state.savedNotes).toEqual({ [`${CC}-3`]: { body: 'December', revision: 4 } });
    expect(noteIcon(3)).not.toBeNull();
    expect(noteIcon(1)).toBeNull();
  });
});
