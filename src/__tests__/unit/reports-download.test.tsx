// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-kit-contracts.md §4.5 / R-1 (and C15 / T-C15b, kept): Downloads. Five rows for an admin; a supervisor
 * sees only Signed timesheet and Hours summary, and a supervisor's page load never calls getUnpricedSummary. Neutral
 * buttons (the PDF is the one primary). Busy state per button through composite keys (a row's buttons block each
 * other, never another row's; a second click is ignored; aria-disabled, never `disabled`). A 422 shows the route's
 * message in place, under that row only. Downloads go through fetch, never window.open. Presets resolve on the server.
 */

const h = vi.hoisted(() => ({
  resolvePeriodRange: vi.fn(), getPeriodOptions: vi.fn(), getReportFilterOptions: vi.fn(), getUnpricedSummary: vi.fn(),
  getWorkspaceToday: vi.fn(), role: 'admin' as string,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/actions/periods', () => ({ resolvePeriodRange: h.resolvePeriodRange, getPeriodOptions: h.getPeriodOptions }));
vi.mock('@/server/actions/reports', () => ({ getReportFilterOptions: h.getReportFilterOptions }));
vi.mock('@/server/actions/labor-categories', () => ({ getUnpricedSummary: h.getUnpricedSummary }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: h.getWorkspaceToday }));
vi.mock('@/lib/session', () => ({ requirePageRole: vi.fn(async () => ({ id: 'u', role: h.role })) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import ReportsPage from '@/app/(app)/admin/reports/page';
import { ReportsClient } from '@/app/(app)/admin/reports/ReportsClient';
import { buttonsByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  for (const f of [h.resolvePeriodRange, h.getPeriodOptions, h.getReportFilterOptions, h.getUnpricedSummary, h.getWorkspaceToday]) f.mockReset();
  h.resolvePeriodRange.mockResolvedValue({ ok: true, data: { start: '2026-10-16', end: '2026-10-31', label: 'x' } });
});
afterEach(() => { unmount(m); m = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PERIODS = [
  { start: '2026-10-01', numDays: 15, label: 'Oct 1 – Oct 15, 2026' },
  { start: '2026-10-16', numDays: 16, label: 'Oct 16 – Oct 31, 2026' },
  { start: '2026-11-01', numDays: 15, label: 'Nov 1 – Nov 15, 2026' },
];
const OPTIONS = {
  users: [{ id: 'u1', fullName: 'Pat Doe', email: 'p@x' }],
  contracts: [{ id: 'k1', name: 'NAVAIR', contractNumber: 'N1', startDate: '2026-01-15' as CalendarDate }],
};
const UNPRICED = { hours: 1719, groups: 6, employees: 4 };

async function render(role: 'admin' | 'supervisor' = 'admin') {
  m = await mount(
    <ReportsClient filterOptions={OPTIONS} role={role} periodOptions={PERIODS as never} today={'2026-11-03' as CalendarDate}
      unpriced={role === 'admin' ? UNPRICED : null} />,
  );
}
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const row = (key: string) => document.body.querySelector(`[data-testid="report-${key}"]`) as HTMLElement;
// UX-4B1-AUDIT L12: row titles are h2 under the page's h1 (no skipped level).
const titles = () => [...document.body.querySelectorAll('[data-testid^="report-"] h2')].map((t) => t.textContent);
const btnIn = (r: HTMLElement, text: string) => [...r.querySelectorAll('button, a')].find((b) => b.textContent?.trim() === text) as HTMLElement;
const xlsx = () => new Response('x', { status: 200, headers: { 'content-disposition': 'attachment; filename="r.xlsx"' } });

describe('Downloads layout (R-1)', () => {
  it('an admin sees the five rows in order; the h1 is "Downloads"', async () => {
    await render();
    expect(document.body.querySelector('h1')?.textContent).toBe('Downloads');
    expect(titles()).toEqual(['Signed timesheet', 'Contract costs', 'Hours summary', 'Cost by pay period', 'Unpriced hours']);
    expect(document.body.querySelectorAll('[data-testid^="report-"] h3')).toHaveLength(0);
    expect(row('summary').textContent).toContain('Total hours per employee by contract and CLIN (direct time only).');
    expect(row('unpriced').querySelector('[data-testid="unpriced-summary"]')!.textContent).toBe('All time · 1,719.00 hours · 6 things to fix');
    expect(btnIn(row('unpriced'), 'View').getAttribute('href')).toBe('/admin/reports/unpriced');
  });

  it('a supervisor sees only Signed timesheet and Hours summary', async () => {
    await render('supervisor');
    expect(titles()).toEqual(['Signed timesheet', 'Hours summary']);
  });

  it('a supervisor\'s page load never calls getUnpricedSummary; an admin\'s does (once)', async () => {
    h.getWorkspaceToday.mockResolvedValue('2026-11-03');
    h.getReportFilterOptions.mockResolvedValue(OPTIONS);
    h.getPeriodOptions.mockResolvedValue(PERIODS);
    h.getUnpricedSummary.mockResolvedValue(UNPRICED);
    h.role = 'supervisor';
    const sup = (await ReportsPage()) as { props: Record<string, unknown> };
    expect(h.getUnpricedSummary).not.toHaveBeenCalled();
    expect(sup.props.unpriced).toBeNull();
    expect(h.getPeriodOptions).toHaveBeenCalledWith('2026-11-03', 24, 0);
    h.role = 'admin';
    const admin = (await ReportsPage()) as { props: Record<string, unknown> };
    expect(h.getUnpricedSummary).toHaveBeenCalledTimes(1);
    expect(admin.props.unpriced).toEqual(UNPRICED);
  });

  it('neutral buttons: only the PDF is filled, the rest outlined; no colour-coding in the source', async () => {
    await render();
    const variants = [...document.body.querySelectorAll('[data-testid^="report-"] .mantine-Button-root')]
      .map((b) => `${b.textContent?.trim()}:${b.getAttribute('data-variant') ?? 'filled'}`); // Mantine omits the default
    expect(variants).toEqual(['Download PDF:filled', 'Excel:default', 'CSV:default', 'Excel:default', 'Excel:default', 'View:default', 'Excel:default']);
    const src = readFileSync('src/app/(app)/admin/reports/ReportsClient.tsx', 'utf8');
    expect(src).not.toMatch(/color="(red|success|signal|green)"/);
  });

  it('presets: Last pay period is the default; "Contract to date" appears only once a contract is chosen', async () => {
    await render();
    const datesInput = () => [...row('costs').querySelectorAll('input')].find((i) => (i as HTMLInputElement).value.includes('pay period')) as HTMLInputElement;
    expect(datesInput().value).toBe('Last pay period · Oct 16 – 31, 2026');
    const options = async () => {
      await click(datesInput());
      const list = document.getElementById(datesInput().getAttribute('aria-controls')!)!;
      const found = [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      await click(datesInput());
      return found;
    };
    expect(await options()).toEqual(['Last pay period · Oct 16 – 31, 2026', 'This pay period · Nov 1 – 15, 2026', 'This month · Nov 1 – 3, 2026', 'Custom dates…']);
    const contract = [...row('costs').querySelectorAll('input')].find((i) => i.getAttribute('placeholder') === 'All contracts') as HTMLInputElement;
    await click(contract);
    await click([...document.getElementById(contract.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')][0]);
    expect((await options()).at(-2)).toBe('Contract to date · Jan 15 – Nov 3, 2026');
  });
});

describe('Downloads behaviour (R-1, C15)', () => {
  it('a download resolves the preset on the server, then fetches with that range; never window.open; via document.body', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchMock = vi.fn(async () => xlsx());
    vi.stubGlobal('fetch', fetchMock);
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const appended: string[] = [];
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(n: T) => { if (n instanceof HTMLAnchorElement) appended.push(n.download); return realAppend(n); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await render();
    await click(btnIn(row('costs'), 'Excel'));
    await wait();
    expect(h.resolvePeriodRange).toHaveBeenCalledWith({ kind: 'lastPeriod' });
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/cost-report-xlsx?startDate=2026-10-16&endDate=2026-10-31', { credentials: 'same-origin' });
    expect(appended).toEqual(['r.xlsx']);
    expect(open).not.toHaveBeenCalled();
    const src = readFileSync('src/app/(app)/admin/reports/ReportsClient.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bopen\s*\(/);
  });

  it('composite busy keys: the busy button shows the Loader; its row-mate is aria-disabled; other rows are free; a second click is ignored', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    await render();
    const excel = btnIn(row('costs'), 'Excel');
    const csv = btnIn(row('costs'), 'CSV');
    await click(excel);
    await wait();
    expect(excel.getAttribute('aria-busy')).toBe('true');
    expect(excel.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(csv.getAttribute('aria-disabled')).toBe('true');
    expect(csv.querySelector('.mantine-Loader-root')).toBeNull();
    expect(btnIn(row('summary'), 'Excel').getAttribute('aria-disabled')).toBeNull();
    for (const b of [excel, csv]) expect(b.hasAttribute('disabled')).toBe(false);
    await click(csv);
    await click(excel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })); });
    await wait();
    expect(excel.getAttribute('aria-busy')).toBeNull();
  });

  it('a 422 shows the route\'s message in place under that row only; the next attempt clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No hours recorded between Oct 16 and Oct 31, 2026.' }), { status: 422, headers: { 'content-type': 'application/json' } })));
    await render();
    await click(btnIn(row('costs'), 'CSV'));
    await wait();
    expect(row('costs').querySelector('[role="alert"]')!.textContent).toBe('No hours recorded between Oct 16 and Oct 31, 2026.');
    for (const other of ['pdf', 'summary', 'periodCost', 'unpriced']) expect(row(other).querySelector('[role="alert"]'), other).toBeNull();
    const again = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => again.promise));
    await click(btnIn(row('costs'), 'CSV'));
    expect(row('costs').querySelector('[role="alert"]')).toBeNull();
    await act(async () => { again.resolve(xlsx()); });
  });

  it('a preset the server refuses shows its message; nothing is fetched', async () => {
    h.resolvePeriodRange.mockResolvedValue({ ok: false, code: 'validation', error: 'That contract no longer exists.' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await click(btnIn(row('summary'), 'Excel'));
    await wait();
    expect(row('summary').querySelector('[role="alert"]')!.textContent).toBe('That contract no longer exists.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Signed timesheet: no employee → inline message, no fetch; a 404 → "That employee wasn\'t found."; the default period is the last one', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await click(buttonsByText('Download PDF')[0]);
    await wait();
    expect(row('pdf').querySelector('[role="alert"]')!.textContent).toBe('Choose an employee.');
    expect(fetchMock).not.toHaveBeenCalled();
    const employee = [...row('pdf').querySelectorAll('input')].find((i) => i.getAttribute('placeholder') === 'Choose an employee') as HTMLInputElement;
    await click(employee);
    await click([...document.getElementById(employee.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')][0]);
    expect(row('pdf').querySelector('[role="alert"]')).toBeNull(); // an input change clears it
    await click(buttonsByText('Download PDF')[0]);
    await wait();
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/timesheet-pdf?userId=u1&periodStart=2026-10-16', { credentials: 'same-origin' });
    expect(row('pdf').querySelector('[role="alert"]')!.textContent).toBe("That employee wasn't found.");
  });

  it('Cost by pay period downloads the chosen count (default 6)', async () => {
    const fetchMock = vi.fn(async () => xlsx());
    vi.stubGlobal('fetch', fetchMock);
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await render();
    await click(btnIn(row('periodCost'), 'Excel'));
    await wait();
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/period-cost-xlsx?n=6', { credentials: 'same-origin' });
  });
});
