// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { useEffect } from 'react';

/**
 * feature-plan-ux-timesheet-ui.md B-T14 (§4.5, trap T-E): both live regions exist and are empty at mount; they are the
 * only live regions (no live totals); toasts carry no live role, and success is spoken once — by the announcer; error
 * toasts don't auto-close; a repeated message is re-announced. (The status line, note counter and "Edit cancelled"
 * cases are added with the steps that build them.)
 */

const actions = vi.hoisted(() => ({ saveTimesheetBatch: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notify } }));

import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { useAnnounce } from '@/components/timesheet/TimesheetAnnouncer';
import { CC, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { actions.saveTimesheetBatch.mockReset(); notify.mockReset(); });
afterEach(() => cleanup());

const polite = () => document.querySelector('[data-testid="ts-announce-polite"]') as HTMLElement;
const assertive = () => document.querySelector('[data-testid="ts-announce-assertive"]') as HTMLElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });
// Today is the period's first day, so a new entry on it is neither late nor an edit: no ReasonModal.
const data = () => pageData({ today: '2026-01-01' as CalendarDate, chargeCodes: [chargeCode()] });

const held: { announce: ReturnType<typeof useAnnounce> | null } = { announce: null };
function AnnounceProbe() { const announce = useAnnounce(); useEffect(() => { held.announce = announce; }); return null; }

describe('announcer (B-T14)', () => {
  it('both regions exist, are empty at mount, and are the only live regions (no live totals)', () => {
    renderTimesheet(data(), <TimesheetGrid />);
    expect(polite().getAttribute('role')).toBe('status');
    expect(polite().getAttribute('aria-live')).toBe('polite');
    expect(assertive().getAttribute('role')).toBe('alert');
    expect(assertive().getAttribute('aria-live')).toBe('assertive');
    expect([polite().textContent, assertive().textContent]).toEqual(['', '']);
    const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')];
    expect(live).toEqual([polite(), assertive()]);
  });

  it('a save: the toast has no live role, success is spoken once by the announcer (polite)', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: true, data: { revisions: { [`${CC}-0`]: 1 }, noteRevisions: {} } });
    renderTimesheet(data(), <TimesheetGrid />);
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 0, value: 8 }));
    await act(async () => { expect(await live.ctx!.requestSave()).toBe(true); });
    await settle();
    expect(polite().textContent).toBe('Saved');
    expect(assertive().textContent).toBe('');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Timesheet saved', role: 'none' });
    expect(notify.mock.calls[0][0].autoClose).not.toBe(false);
  });

  it('a failed save: assertive, and the error toast has no live role and does not auto-close', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: false, code: 'validation', error: 'This period has been certified and is locked.' });
    renderTimesheet(data(), <TimesheetGrid />);
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC, dayIndex: 0, value: 8 }));
    await act(async () => { expect(await live.ctx!.requestSave()).toBe(false); });
    await settle();
    expect(assertive().textContent).toBe('This period has been certified and is locked.');
    expect(polite().textContent).toBe('');
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Save failed', role: 'none', autoClose: false });
  });

  it('a repeated message is re-announced (cleared, then set again)', async () => {
    renderTimesheet(data(), <><TimesheetGrid /><AnnounceProbe /></>);
    act(() => held.announce!('Cleared'));
    await settle();
    expect(polite().textContent).toBe('Cleared');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(polite().textContent ?? ''));
    observer.observe(polite(), { childList: true, characterData: true, subtree: true });
    act(() => held.announce!('Cleared'));
    await settle();
    observer.disconnect();
    expect(seen).toContain('');
    expect(seen.at(-1)).toBe('Cleared');
  });
});
