// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-timesheet-ui.md B-T7 (§4.9, §5 "Unsaved guard", §4.4 session expiry): period changes ask first (Save and
 * continue / Discard and continue / Cancel, Esc), the link listener's rules (one confirm, modifiers / _blank / #hash
 * ignored), unmount or a re-sync with a confirm open resolves false (and doesn't block a later sign-out), sign-out awaits
 * the confirm, beforeunload while dirty, requestSave re-saves edits made during a save, and an expired session.
 */

const actions = vi.hoisted(() => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: vi.fn(), getNeighborPeriod: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: actions.saveTimesheetBatch, getTimesheetPeriod: actions.getTimesheetPeriod }));
vi.mock('@/server/actions/periods', () => ({
  submitPeriod: vi.fn(),
  getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-07' })),
  getPeriodOptions: vi.fn(async () => [{ start: '2025-12-16', numDays: 16, label: 'Dec 16 – Dec 31, 2025' }, { start: '2026-01-01', numDays: 15, label: 'Jan 1 – Jan 15, 2026' }]),
}));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: actions.getNeighborPeriod }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/components/timesheet/ReasonModal', () => ({
  ReasonModal: ({ opened, onClose, onConfirm }: { opened: boolean; onClose: () => void; onConfirm: (r: string, c: string) => Promise<void> }) => (opened ? (
    <div><button type="button" onClick={onClose}>MOCK_REASON_CANCEL</button><button type="button" onClick={() => { void onConfirm('LATE_ENTRY', 'late'); }}>MOCK_REASON_CONFIRM</button></div>
  ) : null),
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn(async () => { auth.calls.push('signOut'); }) }));
vi.mock('@/components/approvals/ApprovalNotices', () => ({ clearDesigneeNoticeDismissals: vi.fn(() => { auth.calls.push('clearDismissals'); }) }));

import { TimesheetPage } from '@/components/timesheet/TimesheetClient';
import { SESSION_EXPIRED } from '@/components/timesheet/TimesheetContext';
import { confirmLeave } from '@/lib/timesheet/unsaved-guard';
import { signOutToLogin } from '@/components/auth/sign-out';
import { CC, CC2, chargeCode, pageData, periodData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
const prevented: boolean[] = [];
const recordClick = (e: MouseEvent) => { if ((e.target as Element).closest?.('a')) { prevented.push(e.defaultPrevented); e.preventDefault(); } };
beforeEach(() => {
  for (const f of [...Object.values(actions), ...Object.values(router)]) f.mockReset();
  auth.calls.length = 0;
  prevented.length = 0;
  actions.getNeighborPeriod.mockResolvedValue({ periodStart: '2025-12-16', numDays: 16, periodConfig: periodData().periodConfig, isCurrent: false });
  actions.getTimesheetPeriod.mockResolvedValue(DEC16);
  window.history.replaceState(null, '', '/timesheet?period=2026-01-01');
  // Bubble phase on window: runs after the guard's capture listener; records whether it prevented the click, then stops
  // jsdom's (unimplemented) navigation.
  window.addEventListener('click', recordClick);
});
afterEach(() => { window.removeEventListener('click', recordClick); cleanup(); vi.unstubAllGlobals(); });

const DEC16 = periodData({ chargeCodes: [chargeCode(), chargeCode({ id: CC2, clin: 'B' })], periodStart: '2025-12-16' as CalendarDate, numDays: 16 });
// Jan 1–15, 2026; today Wed Jan 7 (index 6): a new entry today needs no reason; one on an earlier day is late.
const data = () => pageData({ today: '2026-01-07' as CalendarDate, chargeCodes: [chargeCode(), chargeCode({ id: CC2, clin: 'B' })] });
const setup = (extra: React.ReactNode = null) => {
  const user = userEvent.setup();
  const view = renderTimesheet(data(), <><TimesheetPage />{extra}</>);
  return { user, view };
};
const edit = (dayIndex: number, value = 4, chargeCodeId = CC) => act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId, dayIndex, value }));
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find((d) => /unsaved change/.test(d.textContent ?? '')) as HTMLElement | undefined;
const dialogButton = (label: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const prev = () => document.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement;
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const okSave = (revisions: Record<string, number>) => ({ ok: true, data: { revisions, noteRevisions: {} } });

describe('period changes ask first (B-T7)', () => {
  it('clean: ‹ moves without a confirm', async () => {
    const { user } = setup();
    await user.click(prev());
    expect(dialog()).toBeUndefined();
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
  });

  it('dirty + ‹ → confirm → "Save and continue": saved, then moves', async () => {
    actions.saveTimesheetBatch.mockResolvedValue(okSave({ [`${CC}-6`]: 1 }));
    const { user } = setup();
    await edit(6);
    await user.click(prev());
    expect(dialog()!.textContent).toContain('You have 1 unsaved change');
    expect(actions.getTimesheetPeriod).not.toHaveBeenCalled();
    await user.click(dialogButton('Save and continue'));
    await settle();
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
  });

  it('"Save and continue" → ReasonModal cancelled → stays (and the confirm closed before the ReasonModal opened)', async () => {
    const { user } = setup();
    await edit(2);                                             // a late entry: needs a reason
    await user.click(prev());
    await user.click(dialogButton('Save and continue'));
    await settle();
    expect(dialog()).toBeUndefined();
    await user.click(button('MOCK_REASON_CANCEL'));
    await settle();
    expect(actions.saveTimesheetBatch).not.toHaveBeenCalled();
    expect(live.ctx!.state.periodStart).toBe('2026-01-01');
    expect(live.ctx!.hasUnsaved).toBe(true);
  });

  it('"Save and continue" → a save failure without ReasonModal → stays, still dirty', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: false, code: 'validation', error: "Hours for Wed, Jan 7, 2026 would total 25. A day can't exceed 24 hours across all charge codes." });
    const { user } = setup();
    await edit(6);
    await user.click(prev());
    await user.click(dialogButton('Save and continue'));
    await settle();
    expect(live.ctx!.state.periodStart).toBe('2026-01-01');
    expect(live.ctx!.hasUnsaved).toBe(true);
  });

  it('"Discard and continue" → moves; beforeunload is removed, then re-armed by the next edit', async () => {
    const { user } = setup();
    await edit(6);
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(true);
    await user.click(prev());
    await user.click(dialogButton('Discard and continue'));
    await settle();
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
    expect(live.ctx!.hasUnsaved).toBe(false);
    expect(unload()).toBe(false);
    await edit(3, 2);
    expect(unload()).toBe(true);
  });

  it('L6: while "Save and continue" is in flight, a second navigation request is ignored, not queued', async () => {
    let release!: (v: unknown) => void;
    actions.saveTimesheetBatch.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { user } = setup(<a href="/home">Home</a>);
    await edit(6);
    await user.click(prev());
    await user.click(dialogButton('Save and continue'));
    await settle();
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    let second: boolean | undefined;
    act(() => { void confirmLeave().then((r) => { second = r; }); });   // e.g. sign-out
    await settle();
    expect(second).toBe(false);
    await user.click([...document.querySelectorAll('a')].find((a) => a.textContent === 'Home')!);   // e.g. a link
    await act(async () => { release(okSave({ [`${CC}-6`]: 1 })); });
    await settle();
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');          // the first destination ran
    expect(router.push).not.toHaveBeenCalled();                      // the second never did
    expect(dialog()).toBeUndefined();
  });

  it('Cancel or Esc → stays, focus back on the trigger; the Choose period Select snaps back', async () => {
    const { user } = setup();
    await edit(6);
    await user.click(prev());
    await user.click(dialogButton('Cancel'));
    await settle();
    expect(dialog()).toBeUndefined();
    expect(live.ctx!.state.periodStart).toBe('2026-01-01');
    expect(document.activeElement).toBe(prev());
    await user.click(prev());
    await user.keyboard('{Escape}');
    await settle();
    expect(live.ctx!.state.periodStart).toBe('2026-01-01');
    // Choose period: pick another period, cancel — the Select still shows the period on screen.
    const select = document.querySelector('input[aria-label="Choose period"]') as HTMLInputElement;
    await user.click(select);
    await user.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Dec 16 – Dec 31, 2025')!);
    expect(dialog()).not.toBeUndefined();
    await user.click(dialogButton('Cancel'));
    await settle();
    expect(select.value).toBe('Jan 1 – Jan 15, 2026'); // the period list's own label for the period on screen
    expect(actions.getTimesheetPeriod).not.toHaveBeenCalled();
  });
});

describe('the link listener (B-T7)', () => {
  const links = (
    <nav>
      <a href="/home">Home</a>
      <a href="/home" target="_blank" rel="noopener">New tab</a>
      <a href="#main-content">Skip</a>
      <a href="/timesheet?period=2026-01-01#top">Same page anchor</a>
      <a href="/api/export/x">Export</a>
      <a href="/files/report.csv" download>Download</a>
      <a href="https://example.com/help">Elsewhere</a>
    </nav>
  );
  const link = (text: string) => [...document.querySelectorAll('a')].find((a) => a.textContent === text) as HTMLAnchorElement;

  it('only while there are unsaved changes', async () => {
    const { user } = setup(links);
    await user.click(link('Home'));
    expect(prevented).toEqual([false]);
    expect(dialog()).toBeUndefined();
  });

  it('dirty: a plain click is intercepted → one confirm → Discard and continue → router.push', async () => {
    const { user } = setup(links);
    await edit(6);
    await user.click(link('Home'));
    expect(prevented).toEqual([true]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
    await user.click(dialogButton('Discard and continue'));
    await settle();
    expect(router.push).toHaveBeenCalledWith('/home');
  });

  it('dirty: modifier clicks, target=_blank, #main-content and a same-page #hash are ignored', async () => {
    const { user } = setup(links);
    await edit(6);
    await user.keyboard('{Control>}');
    await user.click(link('Home'));
    await user.keyboard('{/Control}');
    await user.keyboard('{Meta>}');
    await user.click(link('Home'));
    await user.keyboard('{/Meta}');
    await user.click(link('New tab'));
    await user.click(link('Skip'));
    await user.click(link('Same page anchor'));
    expect(prevented).toEqual([false, false, false, false, false]);
    expect(dialog()).toBeUndefined();
  });

  it('dirty: a download link and a cross-origin link pass through (M8)', async () => {
    const { user } = setup(links);
    await edit(6);
    await user.click(link('Download'));
    await user.click(link('Elsewhere'));
    expect(prevented).toEqual([false, false]);
    expect(dialog()).toBeUndefined();
  });

  it('the Past timesheets link → exactly one confirm; a non-app path is opened with location.assign', async () => {
    const { user } = setup(links);
    await edit(6);
    await user.click(link('Past timesheets'));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await user.click(dialogButton('Discard and continue'));
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/timesheet/history');
    await edit(6, 3);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, href: window.location.href, origin: window.location.origin, pathname: window.location.pathname, search: window.location.search });
    await user.click(link('Export'));
    await user.click(dialogButton('Discard and continue'));
    await settle();
    expect(assign).toHaveBeenCalledWith('/api/export/x');
  });
});

describe('lifecycle, sign-out and beforeunload (B-T7)', () => {
  it('provider unmount with a confirm open → it resolves false, and a later sign-out is not blocked', async () => {
    const { view } = setup();
    await edit(6);
    let result: boolean | undefined;
    act(() => { void confirmLeave().then((r) => { result = r; }); });
    expect(dialog()).not.toBeUndefined();
    view.unmount();
    await settle();
    expect(result).toBe(false);
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    await signOutToLogin();
    expect(auth.calls).toEqual(['clearDismissals', 'signOut']);
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('a re-sync (syncGen change) with a confirm open closes it and resolves false', async () => {
    const { view } = setup();
    await edit(6);
    let result: boolean | undefined;
    act(() => { void confirmLeave().then((r) => { result = r; }); });
    expect(dialog()).not.toBeUndefined();
    view.rerenderWith(pageData({ chargeCodes: [chargeCode()], periodStart: '2025-12-16' as CalendarDate, numDays: 16 }));
    await settle();
    expect(result).toBe(false);
    expect(dialog()).toBeUndefined();
    expect(await confirmLeave()).toBe(true); // the re-sync replaced the data: nothing unsaved, nothing pending
  });

  it('a re-sync with the ReasonModal open closes it and the save resolves false (M8)', async () => {
    const { view } = setup();
    await edit(2);                                             // a late entry: needs a reason
    let result: boolean | undefined;
    act(() => { void live.ctx!.requestSave().then((r) => { result = r; }); });
    await settle();
    expect(button('MOCK_REASON_CANCEL')).toBeDefined();
    view.rerenderWith(pageData({ today: '2026-01-07' as CalendarDate, chargeCodes: [chargeCode()] }));
    await settle();
    expect(button('MOCK_REASON_CANCEL')).toBeUndefined();
    expect(result).toBe(false);
    expect(actions.saveTimesheetBatch).not.toHaveBeenCalled();
  });

  it('sign-out awaits the confirm before signOut (Cancel → never signs out; Discard → signs out)', async () => {
    const { user } = setup();
    await edit(6);
    const assign = vi.fn();
    let done = false;
    act(() => { void signOutToLogin().then(() => { done = true; }); });
    await settle();
    expect(dialog()).not.toBeUndefined();
    expect(auth.calls).toEqual([]);
    await user.click(dialogButton('Cancel'));
    await settle();
    expect(done).toBe(true);
    expect(auth.calls).toEqual([]);
    vi.stubGlobal('location', { ...window.location, assign });
    act(() => { void signOutToLogin(); });
    await settle();
    await user.click(dialogButton('Discard and continue'));
    await settle();
    expect(auth.calls).toEqual(['clearDismissals', 'signOut']);
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('a cancelable beforeunload is defaultPrevented only while dirty', async () => {
    setup();
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(false);
    await edit(6);
    expect(unload()).toBe(true);
    await edit(6, 0);
    expect(unload()).toBe(false);
  });
});

describe('save flow (B-T7)', () => {
  it('requestSave re-saves edits made during a save, without resending (or conflicting on) what was saved', async () => {
    let release!: (v: unknown) => void;
    actions.saveTimesheetBatch
      .mockReturnValueOnce(new Promise((r) => { release = r; }))
      .mockResolvedValueOnce(okSave({ [`${CC2}-6`]: 1 }));
    setup();
    await edit(6);
    let result: boolean | undefined;
    act(() => { void live.ctx!.requestSave().then((r) => { result = r; }); });
    await vi.waitFor(() => expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1)); // the first save is in flight
    await edit(6, 5, CC2);                                     // an edit made during that save
    await act(async () => { release(okSave({ [`${CC}-6`]: 1 })); });
    await settle();
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(2);
    expect(actions.saveTimesheetBatch.mock.calls[0][0].cells).toEqual([expect.objectContaining({ chargeCodeId: CC, dayIndex: 6, hours: 4, expectedRevision: 0 })]);
    expect(actions.saveTimesheetBatch.mock.calls[1][0].cells).toEqual([expect.objectContaining({ chargeCodeId: CC2, dayIndex: 6, hours: 5, expectedRevision: 0 })]);
    expect(result).toBe(true);
    expect(live.ctx!.hasUnsaved).toBe(false);
  });

  it('an expired session: the Alert with a target=_blank sign-in link (next = this page), announced; the edits stay dirty', async () => {
    actions.saveTimesheetBatch.mockResolvedValue({ ok: false, code: 'unauthenticated', error: 'Unauthorized: No active session' });
    setup();
    await edit(6);
    let result: boolean | undefined;
    await act(async () => { result = await live.ctx!.requestSave(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); }); // the announcer speaks after ~50 ms
    expect(result).toBe(false);
    const alert = document.querySelector('[data-testid="session-expired"]')!;
    expect(alert.textContent).toContain(SESSION_EXPIRED);
    const signIn = alert.querySelector('a')!;
    expect(signIn.textContent).toBe('Sign in (new tab)');
    expect(signIn.getAttribute('target')).toBe('_blank');
    expect(signIn.getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/timesheet?period=2026-01-01')}`);
    expect(document.querySelector('[data-testid="ts-announce-assertive"]')!.textContent).toBe(SESSION_EXPIRED);
    expect(live.ctx!.hasUnsaved).toBe(true);
    expect(live.ctx!.dirtyCells).toHaveLength(1);
  });
});

describe('a save in flight (H2)', () => {
  const deferredSave = () => { let release!: (v: unknown) => void; actions.saveTimesheetBatch.mockReturnValueOnce(new Promise((r) => { release = r; })); return (v: unknown) => act(async () => { release(v); }); };
  const reasonOpen = () => [...document.querySelectorAll('button')].some((b) => b.textContent === 'MOCK_REASON_CONFIRM');

  it('Discard changes is aria-disabled (never disabled) while saving, with the reason "Saving…"; a click does nothing', async () => {
    const land = deferredSave();
    const { user } = setup();
    await edit(6);
    await user.click(button('Save'));
    const discard = button('Discard changes');
    expect(discard.getAttribute('aria-disabled')).toBe('true');
    expect(discard.hasAttribute('disabled')).toBe(false);
    expect(document.getElementById(discard.getAttribute('aria-describedby')!)!.textContent).toBe('Saving…');
    await user.click(discard);
    expect([...document.querySelectorAll('[role="dialog"]')].some((d) => /Discard/.test(d.textContent ?? ''))).toBe(false);
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(button('Discard changes').getAttribute('aria-describedby')).toBeNull();
  });

  it('M2: Save never gets `disabled` during a pending save — it says "Saving…", is aria-disabled, keeps focus, ignores clicks', async () => {
    const land = deferredSave();
    const { user } = setup();
    await edit(6);
    await user.click(button('Save'));
    const saving = button('Saving…');
    expect(saving).toBe(document.activeElement);
    expect(saving.hasAttribute('disabled')).toBe(false);
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    await user.click(saving);
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(button('Save')).toBe(document.activeElement);
  });

  it('‹ during a slow save waits for it, then moves WITHOUT a confirm once the save covered everything', async () => {
    const land = deferredSave();
    const { user } = setup();
    await edit(6);
    await user.click(button('Save'));
    await user.click(prev());
    await settle();
    expect(dialog()).toBeUndefined();                          // no confirm while the save runs
    expect(actions.getTimesheetPeriod).not.toHaveBeenCalled();
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(dialog()).toBeUndefined();
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
  });

  it('‹ during a slow save, with an edit made meanwhile that stays unsaved: the confirm then counts only that edit', async () => {
    const land = deferredSave();
    const { user } = setup();
    await edit(6);
    await user.click(button('Save'));
    await edit(2, 3, CC2);                                     // made during the save: a late entry (needs a reason)
    await user.click(prev());                                  // 2 unsaved now; 1 once the save lands
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(dialog()).toBeUndefined();                          // the Save's own re-check asks for a reason first
    await user.click(button('MOCK_REASON_CANCEL'));
    await settle();
    expect(dialog()!.textContent).toContain('You have 1 unsaved change');
    expect(dialog()!.textContent).not.toContain('2 unsaved');
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
  });

  it('a save landing after a period change neither moves the baseline (the MARK_SAVED stale guard, M8) nor opens a ReasonModal for the new period', async () => {
    const land = deferredSave();
    setup();
    await edit(6);
    act(() => { void live.ctx!.requestSave(); });
    await vi.waitFor(() => expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1));
    await act(async () => { await live.ctx!.loadPeriodByDate('2025-12-16' as CalendarDate); }); // bypasses the guard
    expect(live.ctx!.state.periodStart).toBe('2025-12-16');
    await edit(3, 5);                                          // a late entry in the NEW period (needs a reason)
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(reasonOpen()).toBe(false);
    expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1);
    expect(live.ctx!.state.savedCellRevisions).toEqual({});
    expect(live.ctx!.state.savedEntries.every((e) => e.hours.every((h) => h === 0))).toBe(true);
    expect(live.ctx!.dirtyCells).toEqual([expect.objectContaining({ chargeCodeId: CC, dayIndex: 3, hours: 5 })]);
  });

  it('…and the same after a re-sync', async () => {
    const land = deferredSave();
    const { view } = setup();
    await edit(6);
    act(() => { void live.ctx!.requestSave(); });
    await vi.waitFor(() => expect(actions.saveTimesheetBatch).toHaveBeenCalledTimes(1));
    view.rerenderWith(pageData({ today: '2026-01-07' as CalendarDate, chargeCodes: [chargeCode(), chargeCode({ id: CC2, clin: 'B' })] }));
    await edit(2, 5);                                          // a late entry after the re-sync
    await land(okSave({ [`${CC}-6`]: 1 }));
    await settle();
    expect(reasonOpen()).toBe(false);
    expect(live.ctx!.state.savedCellRevisions).toEqual({});
    expect(live.ctx!.dirtyCells).toEqual([expect.objectContaining({ dayIndex: 2, hours: 5 })]);
  });
});
