// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

/**
 * feature-plan-ux-timesheet-ui.md B-T11 (§4.11): the server page fetches page 0 and passes it with the workspace
 * timezone; one row per period with its status word, `approvalBadge` as given, hours, deterministic dates and the comment
 * preview; Period links (every row → /timesheet?period={start}; "(current)" from the latest response — L12); no
 * pagination, search or sort UI; Load more appends the next page de-duplicated by start (and refreshes page 0 when a new
 * period started — L12; focus — L11); the table's label (L14); the empty state; axe; the employee nav entry.
 */

const h = vi.hoisted(() => ({ session: { user: { id: 'u1', email: 'u1@x' } } as unknown, getPastTimesheets: vi.fn(), tz: 'America/Los_Angeles' }));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => h.session }));
vi.mock('@/lib/session', () => ({ loginRedirect: async () => { throw Object.assign(new Error('NEXT_REDIRECT'), { url: '/login' }); } }));
vi.mock('@/server/actions/timesheet', () => ({ getPastTimesheets: h.getPastTimesheets }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => h.tz }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/timesheet/history', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import PastTimesheetsPage from '@/app/(app)/timesheet/history/page';
import { PastTimesheetsClient } from '@/app/(app)/timesheet/history/PastTimesheetsClient';
import { activeHref, mainNav, navLeaves } from '@/components/shell/nav-config';
import { installTimesheetDomStubs, withTheme } from '../helpers/timesheet-render';
import { expectNoAxeViolations } from '../helpers/axe';
import type { PastPeriodRow } from '@/server/internal/past-periods';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
beforeEach(() => { h.getPastTimesheets.mockReset(); h.session = { user: { id: 'u1', email: 'u1@x' } }; });
afterEach(() => cleanup());

const row = (start: string, o: Partial<PastPeriodRow> = {}): PastPeriodRow => ({
  start: start as CalendarDate, numDays: 15, label: `${start} label`, status: 'notSubmitted', hours: 0, submittedAt: null,
  reviewedAt: null, reviewComment: null, approvalBadge: null, isCurrent: false, ...o,
});
const ROWS = [
  row('2026-01-16', { label: 'Jan 16 – Jan 31, 2026', isCurrent: true, hours: 12.5 }),
  // Submitted at 03:00 UTC on Jan 2 = Jan 1 in Los Angeles; reviewed 06:30 UTC Jan 3 = Jan 2 in Los Angeles.
  row('2026-01-01', { label: 'Jan 1 – Jan 15, 2026', status: 'approved', hours: 80, submittedAt: new Date('2026-01-02T03:00:00Z'), reviewedAt: new Date('2026-01-03T06:30:00Z'), approvalBadge: 'Self-approved' }),
  row('2025-12-16', { label: 'Dec 16 – Dec 31, 2025', status: 'rejected', hours: 7.25, submittedAt: new Date('2026-01-01T12:00:00Z'), reviewedAt: new Date('2026-01-01T13:00:00Z'), reviewComment: 'Please fix Dec 24.' }),
  row('2025-12-01', { label: 'Dec 1 – Dec 15, 2025', status: 'submitted', hours: 40, submittedAt: new Date('2025-12-16T12:00:00Z') }),
];
const CURRENT = '2026-01-16' as CalendarDate;
const mountClient = (rows = ROWS, hasMore = false, tz = 'America/Los_Angeles') => render(withTheme(<PastTimesheetsClient initial={{ rows, page: 0, hasMore, currentStart: CURRENT }} timeZone={tz} />));
const bodyRows = () => [...document.querySelectorAll('tbody tr')];
const cells = (tr: Element) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim());
const periodLinks = () => [...document.querySelectorAll('tbody a')] as HTMLAnchorElement[];
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

describe('the server page (B-T11)', () => {
  it('fetches page 0 and passes it with the workspace timezone; titled "Past timesheets"', async () => {
    const first = { rows: ROWS, page: 0, hasMore: true, currentStart: CURRENT };
    h.getPastTimesheets.mockResolvedValue(first);
    const el = (await PastTimesheetsPage()) as ReactElement<{ initial: unknown; timeZone: string }>;
    expect(h.getPastTimesheets).toHaveBeenCalledWith({ page: 0 });
    expect(el.type).toBe(PastTimesheetsClient);
    expect(el.props.initial).toBe(first);
    expect(el.props.timeZone).toBe('America/Los_Angeles');
    const { metadata } = await import('@/app/(app)/timesheet/history/page');
    expect(metadata).toEqual({ title: 'Past timesheets' });
  });

  it('no session → loginRedirect, nothing fetched', async () => {
    h.session = null;
    await expect(PastTimesheetsPage()).rejects.toMatchObject({ url: '/login' });
    expect(h.getPastTimesheets).not.toHaveBeenCalled();
  });
});

describe('the list (B-T11)', () => {
  it('one row per period: status words, approvalBadge as given, 2-decimal hours, dates, the comment preview', () => {
    mountClient();
    expect([...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual(['Period', 'Status', 'Hours', 'Submitted', 'Reviewed', 'Comment']);
    expect(bodyRows().map(cells)).toEqual([
      ['Jan 16 – Jan 31, 2026 (current)', 'Not submitted', '12.50', '', '', ''],
      ['Jan 1 – Jan 15, 2026', 'ApprovedSelf-approved', '80.00', 'Jan 1, 2026', 'Jan 2, 2026', ''],
      ['Dec 16 – Dec 31, 2025', 'Returned', '7.25', 'Jan 1, 2026', 'Jan 1, 2026', 'Please fix Dec 24.'],
      ['Dec 1 – Dec 15, 2025', 'Submitted', '40.00', 'Dec 16, 2025', '', ''],
    ]);
    const badges = [...bodyRows()[1].querySelectorAll('.mantine-Badge-root')].map((b) => b.textContent);
    expect(badges).toEqual(['Approved', 'Self-approved']);
  });

  it('dates are formatted in the timezone passed (deterministic, not the browser\'s)', () => {
    mountClient(ROWS, false, 'UTC');
    expect(cells(bodyRows()[1]).slice(3, 5)).toEqual(['Jan 2, 2026', 'Jan 3, 2026']);
  });

  it('every Period link carries its period — the current one too (L12)', () => {
    mountClient();
    expect(periodLinks().map((a) => a.getAttribute('href'))).toEqual(['/timesheet?period=2026-01-16', '/timesheet?period=2026-01-01', '/timesheet?period=2025-12-16', '/timesheet?period=2025-12-01']);
  });

  it('the table is labelled "Past timesheets" (L14)', () => {
    mountClient();
    expect(document.querySelector('table')!.getAttribute('aria-label')).toBe('Past timesheets');
  });

  it('no pagination, search or sort UI', () => {
    mountClient(ROWS, true);
    expect(document.querySelector('input[aria-label="Search this table"], input[type="search"]')).toBeNull();
    expect(document.querySelector('[aria-label*="page" i], .mantine-Pagination-root')).toBeNull();
    expect(document.querySelector('[aria-sort]')).toBeNull();
    expect([...document.querySelectorAll('thead button')]).toHaveLength(0);
  });

  it('Load more appends the next page, de-duplicated by start; the button goes away on the last page (focus → the first new row)', async () => {
    h.getPastTimesheets.mockResolvedValue({ page: 1, hasMore: false, currentStart: CURRENT, rows: [row('2025-12-01', { label: 'DUPLICATE' }), row('2025-11-16', { label: 'Nov 16 – Nov 30, 2025' }), row('2025-11-01', { label: 'Nov 1 – Nov 15, 2025' })] });
    const user = userEvent.setup();
    mountClient(ROWS, true);
    const more = button('Load more')!;
    expect(more.hasAttribute('disabled')).toBe(false);
    await user.click(more);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.getPastTimesheets).toHaveBeenCalledWith({ page: 1 });
    expect(periodLinks().map((a) => a.textContent)).toEqual(['Jan 16 – Jan 31, 2026 (current)', 'Jan 1 – Jan 15, 2026', 'Dec 16 – Dec 31, 2025', 'Dec 1 – Dec 15, 2025', 'Nov 16 – Nov 30, 2025', 'Nov 1 – Nov 15, 2025']);
    expect(button('Load more')).toBeUndefined();
    expect(document.activeElement?.textContent).toBe('Nov 16 – Nov 30, 2025');
  });

  it('L11: a last page that brings no new rows moves focus to the last row\'s link (not the page body)', async () => {
    h.getPastTimesheets.mockResolvedValue({ page: 1, hasMore: false, currentStart: CURRENT, rows: [row('2025-12-01', { label: 'DUPLICATE' })] });
    const user = userEvent.setup();
    mountClient(ROWS, true);
    await user.click(button('Load more')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(periodLinks()).toHaveLength(4);
    expect(button('Load more')).toBeUndefined();
    expect(document.activeElement?.textContent).toBe('Dec 1 – Dec 15, 2025');
  });

  it('L12: when a new period started since page 0, Load more refreshes page 0 — the new current row on top, "(current)" moves', async () => {
    const NEW = '2026-02-01' as CalendarDate;
    h.getPastTimesheets.mockImplementation(async ({ page }: { page: number }) => (page === 0
      ? { page: 0, hasMore: true, currentStart: NEW, rows: [row(NEW, { label: 'Feb 1 – 15, 2026', isCurrent: true }), row('2026-01-16', { label: 'Jan 16 – 31, 2026', status: 'submitted', hours: 80 }), ...ROWS.slice(1)] }
      : { page: 1, hasMore: false, currentStart: NEW, rows: [row('2025-12-01', { label: 'DUPLICATE' }), row('2025-11-16', { label: 'Nov 16 – Nov 30, 2025' })] }));
    const user = userEvent.setup();
    mountClient(ROWS, true);
    await user.click(button('Load more')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.getPastTimesheets.mock.calls.map((c) => c[0])).toEqual([{ page: 1 }, { page: 0 }]);
    expect(periodLinks().map((a) => a.textContent)).toEqual(['Feb 1 – 15, 2026 (current)', 'Jan 16 – 31, 2026', 'Jan 1 – Jan 15, 2026', 'Dec 16 – Dec 31, 2025', 'Dec 1 – Dec 15, 2025', 'Nov 16 – Nov 30, 2025']);
    expect(cells(bodyRows()[1])[1]).toBe('Submitted');                // page 0's latest data for the old current row
  });

  it('Load more with the current period unchanged makes one request', async () => {
    h.getPastTimesheets.mockResolvedValue({ page: 1, hasMore: true, currentStart: CURRENT, rows: [row('2025-11-16', { label: 'Nov 16 – Nov 30, 2025' })] });
    const user = userEvent.setup();
    mountClient(ROWS, true);
    await user.click(button('Load more')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(h.getPastTimesheets).toHaveBeenCalledTimes(1);
    expect(periodLinks()[0].textContent).toBe('Jan 16 – Jan 31, 2026 (current)');
  });

  it('while loading, Load more is aria-disabled (never disabled) and a second click doesn\'t fetch again', async () => {
    let release!: (v: unknown) => void;
    h.getPastTimesheets.mockReturnValue(new Promise((r) => { release = r; }));
    const user = userEvent.setup();
    mountClient(ROWS, true);
    await user.click(button('Load more')!);
    const loading = button('Loading…')!;
    expect(loading.getAttribute('aria-disabled')).toBe('true');
    expect(loading.hasAttribute('disabled')).toBe(false);
    await user.click(loading);
    expect(h.getPastTimesheets).toHaveBeenCalledTimes(1);
    await act(async () => { release({ rows: [], page: 1, hasMore: true, currentStart: CURRENT }); });
    expect(button('Load more')).toBeDefined();
  });

  it('empty state: "No past timesheets yet."', () => {
    mountClient([], false);
    expect(document.body.textContent).toContain('No past timesheets yet.');
    expect(periodLinks()).toHaveLength(0);
  });

  it('one h1, axe clean', async () => {
    const { container } = mountClient(ROWS, true);
    expect([...container.querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Past timesheets']);
    await expectNoAxeViolations(container);
  });
});

describe('navigation (B-T11)', () => {
  it('employees get "Past timesheets" (icon history), and it is the active leaf on /timesheet/history', () => {
    const leaves = navLeaves(mainNav('employee'));
    expect(mainNav('employee')).toContainEqual({ label: 'Past timesheets', href: '/timesheet/history', icon: 'history' });
    expect(activeHref('/timesheet/history', leaves)).toBe('/timesheet/history');
    expect(activeHref('/timesheet', leaves)).toBe('/timesheet');
    // Approvers have no menu entry: the page highlights My timesheet.
    expect(activeHref('/timesheet/history', navLeaves(mainNav('supervisor')))).toBe('/timesheet');
  });
});
