// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect } from 'react';

/**
 * feature-plan-ux-timesheet-ui.md B-T8 (§4.4 re-sync and generations, §4.10 URL sync): history.replaceState from an
 * effect on committed state (never router.replace), canonicalizing on mount; late period-load results or failures after a
 * newer load or a re-sync are ignored (loadGen / syncGen); the latest of two quick ‹ clicks wins; a same-route re-sync
 * (a new initialData object) is applied during render, so children never see the old period after the prop change, and
 * it resets edit mode; one ‹ makes exactly one getTimesheetPeriod call.
 */

const actions = vi.hoisted(() => ({ getTimesheetPeriod: vi.fn(), getNeighborPeriod: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import { useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { CC2, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { enterGrid, installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => {
  for (const f of [...Object.values(actions), ...Object.values(router)]) f.mockReset();
  actions.getNeighborPeriod.mockImplementation(async (start: string) => ({ periodStart: start === '2026-01-01' ? '2025-12-16' : '2025-12-01', numDays: 16, periodConfig: periodData().periodConfig, isCurrent: false }));
  window.history.replaceState(null, '', '/timesheet?period=2026-01-05');
  seen.length = 0;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const seen: string[] = [];
/** Logs the period every committed render sees (useLayoutEffect: before paint, after the commit). */
function PeriodProbe() {
  const { state } = useTimesheetState();
  useLayoutEffect(() => { seen.push(state.periodStart); });
  return null;
}
const DEC16 = periodData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 });
const DEC1 = periodData({ chargeCodes: [chargeCode()], periodStart: '2025-12-01' as CalendarDate, numDays: 15 });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const prevButton = () => document.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement;

describe('URL sync (B-T8, §4.10)', () => {
  it('canonicalizes on mount with history.replaceState (not router.replace): a mid-period URL → ?period={start}; the current period → /timesheet', async () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    const view = renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    expect(spy).toHaveBeenCalledWith(null, '', '/timesheet?period=2026-01-01');
    expect(window.location.search).toBe('?period=2026-01-01');
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    view.unmount();
    spy.mockClear();
    renderTimesheet(pageData({ chargeCodes: [chargeCode()], isCurrent: true }), <TimesheetPage />);
    expect(spy).toHaveBeenCalledWith(null, '', '/timesheet');
    expect(window.location.pathname + window.location.search).toBe('/timesheet');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // let the period list settle
  });

  it('only when the URL differs; after a period load (from the committed state), not from the fetch continuation', async () => {
    window.history.replaceState(null, '', '/timesheet?period=2026-01-01');
    const spy = vi.spyOn(window.history, 'replaceState');
    renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    expect(spy).not.toHaveBeenCalled();                     // already canonical
    actions.getTimesheetPeriod.mockResolvedValue(DEC16);
    const user = userEvent.setup();
    await user.click(prevButton());
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?period=2025-12-16');
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('generations and re-sync (B-T8, §4.4)', () => {
  it('after ‹, exactly one getTimesheetPeriod call', async () => {
    actions.getTimesheetPeriod.mockResolvedValue(DEC16);
    renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    await userEvent.setup().click(prevButton());
    expect(actions.getTimesheetPeriod).toHaveBeenCalledTimes(1);
  });

  it('the latest of two quick ‹ clicks wins: the first response, arriving last, is ignored', async () => {
    const first = deferred<typeof DEC16>();
    const second = deferred<typeof DEC1>();
    actions.getTimesheetPeriod.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    const user = userEvent.setup();
    await user.click(prevButton());
    await user.click(prevButton());
    await act(async () => { second.resolve(DEC1); });
    expect(live.ctx!.state.periodStart).toBe('2025-12-01');
    await act(async () => { first.resolve(DEC16); });
    expect(live.ctx!.state.periodStart).toBe('2025-12-01');
    expect(live.ctx!.state.isLoadingPeriod).toBe(false);
  });

  it('a late failure after a newer load is ignored (no error, the newer period stays)', async () => {
    const first = deferred<typeof DEC16>();
    actions.getTimesheetPeriod.mockReturnValueOnce(first.promise).mockResolvedValueOnce(DEC1);
    renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    const user = userEvent.setup();
    await user.click(prevButton());
    await user.click(prevButton());
    expect(live.ctx!.state.periodStart).toBe('2025-12-01');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { first.reject(new Error('network')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(live.ctx!.state.periodStart).toBe('2025-12-01');
    expect(document.querySelector('[data-testid="ts-announce-assertive"]')!.textContent).toBe('');
  });

  it('a re-sync supersedes a load in flight: its late result is ignored', async () => {
    const load = deferred<typeof DEC16>();
    actions.getTimesheetPeriod.mockReturnValueOnce(load.promise);
    const view = renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    await userEvent.setup().click(prevButton());
    view.rerenderWith(pageData({ chargeCodes: [chargeCode()], periodStart: '2025-11-16' as CalendarDate, numDays: 15 }));
    expect(live.ctx!.state.periodStart).toBe('2025-11-16');
    expect(live.ctx!.state.syncGen).toBe(1);
    await act(async () => { load.resolve(DEC16); });
    expect(live.ctx!.state.periodStart).toBe('2025-11-16');
  });

  it('same-route re-sync: a child logging periodStart in useLayoutEffect never logs the old period after the prop change', () => {
    const view = renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <><TimesheetPage /><PeriodProbe /></>);
    expect(seen.at(-1)).toBe('2026-01-01');
    seen.length = 0;
    // New child elements, so every child re-renders on the very commit that carries the new initialData (as on the page).
    view.rerenderWith(pageData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 }), <><TimesheetPage /><PeriodProbe /></>);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === '2025-12-16')).toBe(true);
    expect(window.location.search).toBe('?period=2025-12-16');
  });

  it('edit mode resets on re-sync', async () => {
    const view = renderTimesheet(pageData({ chargeCodes: [chargeCode()] }), <TimesheetPage />);
    const user = userEvent.setup();
    await enterGrid(user);
    await user.keyboard('7');
    expect(document.querySelector('input[data-cell-editor]')).not.toBeNull();
    view.rerenderWith(pageData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 }));
    expect(document.querySelector('input[data-cell-editor]')).toBeNull();
    // M1: focus is on the grid's active cell (the one tab stop), not <body>.
    expect(document.activeElement).toBe(document.querySelector('table[role="grid"] [tabindex="0"]'));
  });

  it('M1: a re-sync with fewer rows, while a removed row is focused, puts focus on the clamped active cell', async () => {
    const two = [chargeCode(), chargeCode({ id: CC2, clin: 'B' })];
    const view = renderTimesheet(pageData({ chargeCodes: two }), <TimesheetPage />);
    const user = userEvent.setup();
    await enterGrid(user);
    await user.keyboard('{ArrowDown}');
    expect((document.activeElement as HTMLElement).dataset.r).toBe('1');
    view.rerenderWith(pageData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 }));
    const active = document.activeElement as HTMLElement;
    expect(active).toBe(document.querySelector('table[role="grid"] [tabindex="0"]'));
    expect(active.dataset.r).toBe('0');
  });
});
