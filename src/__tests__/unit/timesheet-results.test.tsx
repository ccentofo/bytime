// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-launch-blockers.md P4 §3 / §9 "Timesheet context": a RETURNED failure is never treated as success —
 * no MARK_SAVED (unsaved changes stay), no 'submitted' status, the server's message is shown, no success toast.
 */

const actions = vi.hoisted(() => ({
  saveTimesheetBatch: vi.fn(),
  submitPeriod: vi.fn(),
}));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({
  submitPeriod: actions.submitPeriod,
  getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20', timezone: 'America/New_York' })),
}));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('@/lib/offline/offline-store', () => ({ seedOfflineStore: vi.fn() }));
// The modals are UI plumbing here: render them as plain buttons that call onConfirm.
vi.mock('@/components/timesheet/SubmitModal', () => ({
  SubmitModal: ({ onConfirm }: { onConfirm: (c?: string) => void }) => <button onClick={() => onConfirm('done')}>MOCK_CONFIRM_SUBMIT</button>,
}));
vi.mock('@/components/timesheet/ReasonModal', () => ({
  ReasonModal: ({ onConfirm }: { onConfirm: (r: string, c: string) => void }) => <button onClick={() => onConfirm('LATE_ENTRY', 'late')}>MOCK_CONFIRM_REASON</button>,
}));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@mantine/notifications', () => ({ notifications: { show: notify } }));

import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';
import type { CalendarDate } from '@/lib/calendar-date';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

const initialData: TimesheetPageData = {
  userId: 'u1',
  chargeCodes: [{ id: 'cc1', projectName: 'Proj', clin: 'CC-1', description: 'Code 1', kind: 'charge', assignable: true }],
  entries: [{ chargeCodeId: 'cc1', hours: Array(15).fill(0) }],
  periodStart: '2026-01-01' as CalendarDate,
  numDays: 15,
  today: '2026-01-20' as CalendarDate,
  revisions: {},
  periodStatus: 'draft',
  periodConfig: { periodType: 'semimonthly', anchorDate: '2026-01-01' as CalendarDate, weekStartDay: 1 },
  readOnly: false,
};

let container: HTMLDivElement;
let root: Root;
let ctx: ReturnType<typeof useTimesheet> | null = null;
const captureCtx = (value: ReturnType<typeof useTimesheet>) => { ctx = value; };

/** Hands the live context to the test after every render (an effect, so render stays pure). */
function Probe({ onContext }: { onContext: (value: ReturnType<typeof useTimesheet>) => void }) {
  const value = useTimesheet();
  useEffect(() => { onContext(value); });
  return null;
}

async function render(children: React.ReactNode) {
  await act(async () => {
    root.render(<MantineProvider><TimesheetProvider initialData={initialData}>{children}<Probe onContext={captureCtx} /></TimesheetProvider></MantineProvider>);
  });
}

beforeEach(() => {
  actions.saveTimesheetBatch.mockReset();
  actions.submitPeriod.mockReset();
  notify.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ctx = null;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function makeDirty() {
  // A first-time entry on an earlier day of the period (Jan 2; today is Jan 20): a dirty cell.
  await act(async () => { ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: 'cc1', dayIndex: 1, value: 8 }); });
  expect(ctx!.dirtyCells).toHaveLength(1);
}

describe('TimesheetContext', () => {
  it('a failed save returns the failure and does NOT mark the changes saved', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: false, code: 'validation', error: 'This period has been certified and is locked.' });
    await render(null);
    await makeDirty();

    let result: Awaited<ReturnType<NonNullable<typeof ctx>['saveAll']>> | undefined;
    await act(async () => { result = await ctx!.saveAll(); });

    expect(result).toEqual({ ok: false, code: 'validation', error: 'This period has been certified and is locked.' });
    expect(ctx!.dirtyCells).toHaveLength(1); // unsaved changes kept — no MARK_SAVED
    expect(ctx!.state.savedEntries[0].hours[1]).toBe(0);
    expect(ctx!.state.isSaving).toBe(false);
  });

  it('a successful save marks the changes saved', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { 'cc1-1': 1 } });
    await render(null);
    await makeDirty();
    await act(async () => { await ctx!.saveAll(); });
    expect(ctx!.dirtyCells).toHaveLength(0);
    expect(ctx!.state.savedCellRevisions['cc1-1']).toBe(1);
  });

  it('a save with nothing to save is a successful no-op', async () => {
    await render(null);
    let result: unknown;
    await act(async () => { result = await ctx!.saveAll(); });
    expect(result).toEqual({ ok: true, data: undefined });
    expect(actions.saveTimesheetBatch).not.toHaveBeenCalled();
  });

  it('a failed submit does NOT set the status to submitted', async () => {
    actions.submitPeriod.mockResolvedValue({ ok: false, code: 'validation', error: 'Cannot submit an empty timesheet.' });
    await render(null);
    let result: { ok: boolean } | undefined;
    await act(async () => { result = await ctx!.submitTimesheet(); });
    expect(result?.ok).toBe(false);
    expect(ctx!.state.periodStatus).toBe('draft');
  });

  it('an action that THROWS (unexpected) is reported generically and also leaves state untouched', async () => {
    actions.saveTimesheetBatch.mockRejectedValue(new Error('relation "timesheet_entries" — SELECT …'));
    await render(null);
    await makeDirty();
    let result: { ok: boolean; error?: string } | undefined;
    await act(async () => { result = await ctx!.saveAll(); });
    expect(result?.ok).toBe(false);
    expect(result?.error).not.toMatch(/SELECT|relation/);
    expect(ctx!.dirtyCells).toHaveLength(1);
  });
});

describe('TimesheetToolbar', () => {
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  const shown = () => notify.mock.calls.map((c) => c[0] as { title: string; message: string });
  const click = async (label: string) => {
    await act(async () => { button(label).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  it('a failed save shows the server’s message and never the success toast', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: false, code: 'validation', error: 'This period has been certified and is locked.' });
    await render(<TimesheetToolbar />);
    await makeDirty();
    await click('MOCK_CONFIRM_REASON'); // a first-time entry on a past day goes through the reason path
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([expect.objectContaining({ title: 'Save Failed', message: 'This period has been certified and is locked.' })]);
    expect(shown().map((n) => n.title)).not.toContain('Timesheet Saved');
  });

  it('a successful save shows the success toast', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { 'cc1-1': 1 } });
    await render(<TimesheetToolbar />);
    await makeDirty();
    await click('MOCK_CONFIRM_REASON');
    expect(shown().map((n) => n.title)).toEqual(['Timesheet Saved']);
  });

  it('a failed submit shows the server’s message and never the success toast', async () => {
    actions.submitPeriod.mockResolvedValue({ ok: false, code: 'validation', error: 'Cannot submit an empty timesheet.' });
    await render(<TimesheetToolbar />);
    await click('MOCK_CONFIRM_SUBMIT');
    expect(actions.submitPeriod).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([expect.objectContaining({ title: 'Submit Failed', message: 'Cannot submit an empty timesheet.' })]);
    expect(ctx!.state.periodStatus).toBe('draft');
  });
});
