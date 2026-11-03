// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-page-fixes.md C15 / T-C15b: Reports downloads go through fetch, never window.open; a failure shows a
 * red alert under THAT card's buttons; while busy the card's buttons are aria-disabled (never `disabled`) with a loader
 * and a second click is ignored; a download clicks an anchor appended to document.body.
 */

vi.mock('@/server/actions/periods', () => ({
  getWorkspaceContext: vi.fn(async () => ({ today: '2026-10-31' })),
  getPeriodOptions: vi.fn(async () => [{ start: '2026-10-16', numDays: 16, label: 'Oct 16 – 31, 2026' }]),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@mantine/dates', () => ({
  DateInput: ({ onChange, value, label }: { onChange: (v: string | null) => void; value: string | null; label: string }) =>
    <label>{label}<input aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} /></label>,
}));

import { ReportsClient } from '@/app/(app)/admin/reports/ReportsClient';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const cards = () => [...document.body.querySelectorAll('.mantine-Paper-root')] as HTMLElement[];
const costCard = () => cards().find((c) => c.textContent?.includes('Detailed Cost Report'))!;
const summaryCard = () => cards().find((c) => c.textContent?.includes('Employee Summary Report'))!;

async function renderWithCostDates() {
  m = await mount(<ReportsClient filterOptions={{ users: [], contracts: [] }} role="admin" />);
  await wait();
  const [start, end] = [...costCard().querySelectorAll('input[aria-label="Start Date"], input[aria-label="End Date"]')] as HTMLInputElement[];
  for (const [input, v] of [[start, '2026-01-01'], [end, '2026-01-31']] as const) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

describe('Reports downloads (C15)', () => {
  it('never window.open; a failure shows an alert under that card only; the next attempt clears it', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Too many requests', retryAfter: 30 }), { status: 429, headers: { 'content-type': 'application/json' } })));
    await renderWithCostDates();
    await click(buttonByText('Download CSV'));
    await wait();
    expect(open).not.toHaveBeenCalled();
    const alert = costCard().querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Too many downloads. Try again in 30 seconds.');
    expect(summaryCard().querySelector('[role="alert"]')).toBeNull();
    // The next attempt clears it at once (while its request is still pending), and a failure shows it again.
    const again = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => again.promise));
    await click(buttonByText('Download CSV'));
    expect(costCard().querySelector('[role="alert"]')).toBeNull();
    await act(async () => { again.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })); });
    await wait();
    expect(costCard().querySelector('[role="alert"]')!.textContent).toBe("The report couldn't be generated. Try again in a moment.");
    // An input change clears it.
    const [start] = [...costCard().querySelectorAll('input[aria-label="Start Date"]')] as HTMLInputElement[];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(start, '2026-01-02');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(costCard().querySelector('[role="alert"]')).toBeNull();
  });

  it('no download path opens a window (every card goes through downloadFile)', () => {
    const src = readFileSync('src/app/(app)/admin/reports/ReportsClient.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bopen\s*\(/);
    expect(src.match(/void runDownload\('(pdf|cost|summary)'/g)?.length).toBe(4); // PDF, CSV, Excel, summary
  });

  it('while busy: aria-disabled with a loader, never disabled; a second click is ignored; then a download through document.body', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }));
    const appended: Node[] = [];
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(n: T) => { appended.push(n); return realAppend(n); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await renderWithCostDates();
    await click(buttonByText('Download CSV'));
    const csv = buttonByText('Download CSV');
    const excel = buttonByText('Download Excel');
    expect(csv.getAttribute('aria-disabled')).toBe('true');
    expect(csv.hasAttribute('disabled')).toBe(false);
    expect(csv.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(excel.getAttribute('aria-disabled')).toBe('true');        // the whole card is busy
    await click(csv);
    await click(excel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(new Response('a,b', { status: 200, headers: { 'content-disposition': 'attachment; filename="cost.csv"' } })); });
    await wait();
    expect(appended.some((n) => n instanceof HTMLAnchorElement && (n as HTMLAnchorElement).download === 'cost.csv')).toBe(true);
    expect(buttonByText('Download CSV').getAttribute('aria-disabled')).toBeNull();
  });
});
