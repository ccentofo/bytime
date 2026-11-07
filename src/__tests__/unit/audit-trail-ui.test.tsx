// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-people-codes.md §6.1–§6.4 / AU-1, AU-5, AU-6 (UI half), AU-9:
 * AU-1 — the page loads the URL's filters, tab and page on the server (default: the last 30 WORKSPACE days), and the
 *        client shows that data on first paint with no request.
 * AU-5 — events show "Returned" (never "Rejected") with " · self-returned" / " · self-approved" when the actor is the
 *        employee, and keep their 500-event cap notice.
 * AU-6 — no Admin changes tab for a supervisor (and the page turns `tab=admin` into entries for them).
 * AU-9 — a filter change resets the page to 1 and writes the URL with replaceState; a stale response never replaces a
 *        newer one; the table is aria-busy while loading.
 */

const h = vi.hoisted(() => ({
  entries: vi.fn(), summary: vi.fn(), events: vi.fn(), admin: vi.fn(), resolve: vi.fn(), clins: vi.fn(async () => []),
  contracts: vi.fn(async () => []), users: vi.fn(async () => []), role: 'admin' as string,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/actions/audit', () => ({
  getAuditEntries: h.entries, getAuditSummary: h.summary, getAuditPeriodEvents: h.events, getAdminChanges: h.admin,
  getCellRevisionHistory: vi.fn(), getClinsForFilter: h.clins, getContractsForFilter: h.contracts, getUsersForFilter: h.users,
}));
vi.mock('@/server/actions/periods', () => ({ resolvePeriodRange: h.resolve }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'America/New_York', getWorkspaceToday: async () => '2026-11-06' }));
vi.mock('@/lib/session', () => ({ requirePageRole: async () => ({ id: 'me', role: h.role }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import AuditTrailPage from '@/app/(app)/admin/audit-trail/page';
import { AuditTrailClient } from '@/app/(app)/admin/audit-trail/AuditTrailClient';
import { parseAuditParams } from '@/lib/audit/audit-params';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

const realReplace = window.history.replaceState.bind(window.history);
let replaceSpy: ReturnType<typeof vi.fn>;
beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.entries.mockResolvedValue({ entries: [], total: 0, page: 1, pageSize: 50 });
  h.summary.mockResolvedValue({ entries: 0, changed: 0, late: 0, people: 0 });
  h.events.mockResolvedValue({ events: [], truncated: false });
  h.admin.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 });
  replaceSpy = vi.fn((...args: Parameters<History['replaceState']>) => realReplace(...args));
  window.history.replaceState = replaceSpy as never;
});
afterEach(() => { unmount(m); m = undefined; window.history.replaceState = realReplace; realReplace(null, '', '/'); });

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (id: string, o: Record<string, unknown> = {}) => ({
  id, userId: 'u1', userName: 'Jane Smith', userEmail: 'j@x', cellCode: 'cc', kind: 'charge', codeLabel: 'NAV-1', chargeCodeId: 'cc', clinId: 'c', indirectCodeId: null,
  clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N', slinNumber: null, indirectCategory: null, provenance: null, entryDate: '2026-10-13',
  hours: '6.00', revisionNumber: 1, changeReasonCode: null, comment: null, createdAt: new Date('2026-10-15T13:12:00Z'), createdById: 'u1', createdByName: 'Jane Smith', source: 'app', ...o,
});
const page = async (sp: Record<string, string>) => ((await AuditTrailPage({ searchParams: Promise.resolve(sp) })) as { props: Record<string, never> }).props;

describe('the page (AU-1, AU-6)', () => {
  it('default: the last 30 workspace days, the entries tab, page 1 — loaded on the server', async () => {
    const props = await page({});
    expect(props.initialRange).toEqual({ start: '2026-10-08', end: '2026-11-06', label: 'Last 30 days · Oct 8 – Nov 6, 2026' });
    expect(h.entries).toHaveBeenCalledWith({ startDate: '2026-10-08', endDate: '2026-11-06', page: 1, userId: undefined, contractId: undefined, clinId: undefined, reasonCode: undefined, revisionsOnly: undefined });
    expect(h.summary).toHaveBeenCalledTimes(1);
    expect(h.events).not.toHaveBeenCalled();
  });

  it('the URL\'s filters, tab and page are what loads; last pay period resolves through resolvePeriodRange', async () => {
    h.resolve.mockResolvedValue({ ok: true, data: { start: '2026-10-16', end: '2026-10-31', label: 'Last pay period · Oct 16 – 31, 2026' } });
    await page({ range: 'last', user: ID(1), contract: ID(2), clin: ID(3), reason: 'LATE_ENTRY', changed: '1', page: '3' });
    expect(h.resolve).toHaveBeenCalledWith({ kind: 'lastPeriod' });
    expect(h.entries).toHaveBeenCalledWith({ userId: ID(1), contractId: ID(2), clinId: ID(3), reasonCode: 'LATE_ENTRY', revisionsOnly: true, startDate: '2026-10-16', endDate: '2026-10-31', page: 3 });
    vi.clearAllMocks();
    await page({ tab: 'admin', range: 'custom', start: '2026-10-01', end: '2026-10-05' });
    expect(h.admin).toHaveBeenCalledWith({ start: '2026-10-01', end: '2026-10-05', page: 1 });
  });

  it('a supervisor\'s tab=admin → entries (getAdminChanges never runs); invalid values → defaults', async () => {
    h.role = 'supervisor';
    const props = await page({ tab: 'admin' });
    expect((props.initialParams as { tab: string }).tab).toBe('entries');
    expect(h.admin).not.toHaveBeenCalled();
    const p = parseAuditParams((k) => ({ range: 'decade', tab: 'nope', page: '-2', user: 'x', clin: ID(1), reason: 'BOGUS' } as Record<string, string>)[k], { isAdmin: true });
    expect(p).toMatchObject({ range: 'last30', tab: 'entries', page: 1, user: null, clin: null, reason: null });
  });
});

const PARAMS = parseAuditParams(() => null, { isAdmin: true });
const RANGE = { start: '2026-10-08' as CalendarDate, end: '2026-11-06' as CalendarDate, label: 'Last 30 days · Oct 8 – Nov 6, 2026' };
const render = async (o: Record<string, unknown> = {}) => {
  m = await mount(<AuditTrailClient initialParams={PARAMS} initialRange={RANGE} contracts={[]} users={[{ id: ID(1), fullName: 'Jane Smith', email: 'j@x' }]}
    workspaceTimezone="America/New_York" workspaceToday={'2026-11-06' as CalendarDate} isAdmin
    initialData={{ entries: { entries: [entry('e1', { revisionNumber: 2, changeReasonCode: 'CORRECTION', comment: 'Forgot the visit.' }), entry('e2', { changeReasonCode: 'LATE_ENTRY' })] as never, total: 2, page: 1, pageSize: 50 }, summary: { entries: 312, changed: 9, late: 4, people: 7 } }}
    {...o} />);
  await wait(10);
};
const tabNames = () => [...document.body.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const choose = async (label: string, option: string) => {
  const l = [...document.body.querySelectorAll<HTMLLabelElement>('[data-testid="audit-filters"] label')].find((x) => x.textContent?.trim() === label)!;
  const input = document.getElementById(l.htmlFor)!;
  await click(input);
  await click([...document.getElementById(input.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
};

describe('the client', () => {
  it('AU-1: first paint shows the server\'s data with no request; the strip, Version, Reason, Comment, Entered, History; the edge flags', async () => {
    await render();
    expect(h.entries).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="audit-summary"]')!.textContent).toBe('312Entries in this view9Changed after first entry4Entered late7People');
    const rows = [...document.body.querySelectorAll('[data-testid="audit-entries"] tbody tr')];
    expect(rows[0].textContent).toContain('Correction');
    expect(rows[0].textContent).toContain('Forgot the visit.');
    expect(rows[0].textContent).toContain('by Jane Smith');
    expect(rows[0].getAttribute('data-correction')).toBe('true');
    expect(rows[1].getAttribute('data-late')).toBe('true');
    expect(rows[1].getAttribute('data-correction')).toBeNull();
    expect(rows[0].querySelector('button[aria-label="History for Jane Smith, Oct 13, 2026"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="audit-legend"]')!.textContent).toContain('Changed or entered late');
  });

  it('AU-6: no Admin changes tab for a supervisor; an admin has it', async () => {
    await render({ isAdmin: false });
    expect(tabNames()).toEqual(['Hour entries', 'Timesheet events']);
    unmount(m);
    await render();
    expect(tabNames()).toEqual(['Hour entries', 'Timesheet events', 'Admin changes']);
  });

  it('AU-5: "Returned" with " · self-returned", " · self-approved"; the cap notice', async () => {
    const ev = (id: string, event: string, self: boolean) => ({ id, userId: 'u1', userName: 'Robert Taylor', periodStart: '2026-10-01', periodEnd: '2026-10-15', event, text: '', selfApproved: false, context: null, comment: null, createdAt: new Date('2026-10-18T17:05:00Z'), actorId: self ? 'u1' : 's1', actorName: self ? 'Robert Taylor' : 'Sarah Wilson', self });
    await render({ initialParams: { ...PARAMS, tab: 'events' }, initialData: { events: { events: [ev('a', 'rejected', false), ev('b', 'rejected', true), ev('c', 'approved', true)], truncated: true } } });
    const cells = [...document.body.querySelectorAll('[data-testid="audit-event"]')].map((c) => c.textContent);
    expect(cells).toEqual(['Returned', 'Returned · self-returned', 'Approved · self-approved']);
    expect(document.body.textContent).not.toContain('Rejected');
    expect(document.body.querySelector('[data-testid="audit-events"]')!.textContent).toContain('Oct 1 – 15, 2026');
    expect(document.body.querySelector('[data-testid="audit-events-truncated"]')!.textContent).toBe('Showing the first 500 events. Narrow your filters for more.');
  });

  it('AU-9: a filter change resets the page to 1 and replaces the URL; the stale response is ignored; aria-busy while loading', async () => {
    await render({ initialParams: { ...PARAMS, page: 3 }, initialData: { entries: { entries: [entry('e1')], total: 200, page: 3, pageSize: 50 }, summary: { entries: 200, changed: 0, late: 0, people: 1 } } });
    expect(h.entries).not.toHaveBeenCalled();                                        // a server-loaded page 3 stays page 3 (no reload)
    let releaseSlow!: (v: unknown) => void;
    h.entries.mockImplementationOnce(() => new Promise((r) => { releaseSlow = r; }))
      .mockResolvedValueOnce({ entries: [entry('fast', { userName: 'Fast Result' })], total: 1, page: 1, pageSize: 50 });
    await choose('Reason', 'Late entry');
    expect(h.entries).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'LATE_ENTRY', page: 1 }));
    expect(replaceSpy).toHaveBeenLastCalledWith(null, '', '/?reason=LATE_ENTRY');
    expect(document.body.querySelector('[data-testid="audit-entries"] table')!.getAttribute('aria-busy')).toBe('true');
    await choose('Employee', 'Jane Smith');
    await wait(10);
    expect(document.body.querySelector('[data-testid="audit-entries"]')!.textContent).toContain('Fast Result');
    await act(async () => { releaseSlow({ entries: [entry('slow', { userName: 'Slow Result' })], total: 1, page: 1, pageSize: 50 }); });
    await wait(10);
    expect(document.body.querySelector('[data-testid="audit-entries"]')!.textContent).not.toContain('Slow Result');
    expect(document.body.querySelector('[data-testid="audit-entries"] table')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('Custom dates…: no query until both dates are valid', async () => {
    await render();
    await choose('Dates', 'Custom dates…');
    expect(h.entries).not.toHaveBeenCalled();
  });
});
