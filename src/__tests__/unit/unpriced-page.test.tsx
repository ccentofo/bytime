// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §4.4 / U-2: the Unpriced hours page — breadcrumb and strip; one row per thing to fix
 * with its fix link (§6 routing); the overlap sections; the "Show overlaps only" toggle; the truncated notice; the empty
 * states; legacy startDate/endDate honoured (custom range shown, and the Excel link uses start/end).
 */

const h = vi.hoisted(() => ({ push: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push, refresh: vi.fn() }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/periods', () => ({ resolvePeriodRange: vi.fn(async () => ({ ok: true, data: { start: '2026-10-01', end: '2026-10-15', label: 'x' } })) }));

import { UnpricedClient } from '@/app/(app)/admin/reports/unpriced/UnpricedClient';
import type { OverlapRow, UnpricedGroup, UnpricedReport } from '@/server/internal/cost-basis';
import { act } from 'react';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';
import { WorkspaceModeProvider } from '@/components/shell/WorkspaceMode';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { h.push.mockReset(); });
afterEach(() => { unmount(m); m = undefined; vi.unstubAllGlobals(); });

const g = (o: Partial<UnpricedGroup>): UnpricedGroup => ({
  key: o.employeeName ?? 'k', reason: 'no-category', level: null, userId: 'u1', employeeName: 'Jane Smith', contractId: 'k1', contractName: 'NAVAIR',
  clinId: 'c1', clinNumber: '0001', slinId: null, slinNumber: null, chargeCodeId: 'cc1', chargeCode: 'NAVAIR-0001-ONSITE', hours: 412.5,
  first: '2026-01-02', last: '2026-10-28', entries: 40, overlaps: [], fix: { kind: 'set-code-category', chargeCodeId: 'cc1' }, ...o,
});
const p = (o: Partial<OverlapRow> = {}): OverlapRow => ({
  userId: 'u9', employeeName: 'Dee Future', level: 'clin', contractId: 'k1', clinId: 'c1', slinId: null, clinNumber: '0001', slinNumber: null,
  a: { assignmentId: 'a1', lcatCode: 'SE-II', title: '', effectiveDate: '2027-01-01', endDate: null },
  b: { assignmentId: 'b1', lcatCode: 'SE-III', title: '', effectiveDate: '2027-02-01', endDate: '2027-06-30' }, ...o,
});
const report = (o: Partial<UnpricedReport> = {}): UnpricedReport => ({
  totals: { hours: 1719, groups: 6, employees: 4, overlaps: 1 },
  groups: [
    g({}),
    g({ key: 'e', employeeName: 'Emily Davis', userId: 'u2', chargeCodeId: null, chargeCode: null, contractName: 'Army', clinNumber: '0002', slinNumber: '0002AA', hours: 342.5, fix: { kind: 'assign-category', userId: 'u2' } }),
    g({ key: 'r', reason: 'conflict', level: 'clin', employeeName: 'Robert Taylor', userId: 'u3', chargeCodeId: null, chargeCode: null, hours: 96, first: '2026-09-01', last: '2026-09-30', fix: { kind: 'end-overlap', userId: 'u3', assignmentIds: ['x1', 'x2'] } }),
  ],
  unattachedOverlaps: [], outOfViewOverlaps: [], truncated: false, ...o,
});
const contracts = [{ id: 'k1', name: 'NAVAIR', contractNumber: 'N-1' }];
const row = (t: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(t)) as HTMLElement;

describe('Unpriced hours page (U-2)', () => {
  it('breadcrumb, h1 and the strip', async () => {
    m = await mount(<UnpricedClient report={report()} filters={{}} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="page-breadcrumb"]')!.textContent).toBe('Downloads › Unpriced hours');
    expect(m.container.querySelector('[data-testid="page-breadcrumb"] a')!.getAttribute('href')).toBe('/admin/reports');
    expect(m.container.querySelector('h1')!.textContent).toBe('Unpriced hours');
    const strip = m.container.querySelector('[data-testid="unpriced-strip"]')!.textContent!;
    expect(strip).toContain('1,719.00Unpriced hours');
    expect(strip).toContain('6Things to fix');
    expect(strip).toContain('4Employees affected');
  });

  it('rows: what\'s wrong, employee, where, hours, dates, and the fix link for each kind', async () => {
    m = await mount(<UnpricedClient report={report()} filters={{}} contracts={contracts} />);
    const jane = row('Jane Smith');
    expect(jane.textContent).toContain('No category');
    expect(jane.textContent).toContain('NAVAIR-0001-ONSITE');
    expect(jane.textContent).toContain('412.50');
    expect(jane.textContent).toContain('Jan 2, 2026 – Oct 28, 2026');
    const fix = (r: HTMLElement) => r.querySelector('a[data-testid="fix-link"]') as HTMLAnchorElement;
    expect([fix(jane).textContent, fix(jane).getAttribute('href')]).toEqual(['Set category on code', '/admin/charge-codes?code=cc1']);
    const emily = row('Emily Davis');
    expect(emily.textContent).toContain('Army CLIN 0002 SLIN 0002AA');
    expect([fix(emily).textContent, fix(emily).getAttribute('href')]).toEqual(['Assign Emily a category', '/admin/assignments?tab=labor-categories&userId=u2']);
    const rob = row('Robert Taylor');
    expect(rob.querySelector('[data-tone="bad"]')!.textContent).toBe('Overlapping categories');
    expect([fix(rob).textContent, fix(rob).getAttribute('href')]).toEqual(['Review overlap', '/admin/assignments?tab=labor-categories&userId=u3&assignments=x1%2Cx2']);
  });

  it('the unattached section lists pairs with Review overlap; out-of-view shows only under a filter', async () => {
    m = await mount(<UnpricedClient report={report({ unattachedOverlaps: [p()] })} filters={{}} contracts={contracts} />);
    const sec = m.container.querySelector('[data-testid="unattached-overlaps"]')!;
    expect(sec.textContent).toContain('Overlapping assignments (no hours affected yet)');
    expect(sec.textContent).toContain('SE-II and SE-III');
    expect(sec.querySelector('a')!.getAttribute('href')).toBe('/admin/assignments?tab=labor-categories&userId=u9&assignments=a1%2Cb1');
    unmount(m);
    m = await mount(<UnpricedClient report={report({ outOfViewOverlaps: [p({ employeeName: 'Rob Out' })] })} filters={{ startDate: '2026-06-01', endDate: '2026-06-30' }} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="out-of-view-overlaps"]')!.textContent).toContain('Overlapping assignments with no unpriced hours in this view');
    unmount(m);
    m = await mount(<UnpricedClient report={report({ outOfViewOverlaps: [p()] })} filters={{}} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="out-of-view-overlaps"]')).toBeNull();
  });

  it('"Show overlaps only" navigates with reason=conflict (and back without it)', async () => {
    m = await mount(<UnpricedClient report={report()} filters={{ contractId: 'k1' }} contracts={contracts} />);
    await click(m.container.querySelector('input[type="checkbox"]'));
    expect(h.push).toHaveBeenLastCalledWith('/admin/reports/unpriced?contractId=k1&reason=conflict');
    unmount(m);
    m = await mount(<UnpricedClient report={report()} filters={{ reason: 'conflict' }} contracts={contracts} />);
    await click(m.container.querySelector('input[type="checkbox"]'));
    expect(h.push).toHaveBeenLastCalledWith('/admin/reports/unpriced');
  });

  it('truncated → the info notice', async () => {
    m = await mount(<UnpricedClient report={report({ truncated: true })} filters={{}} contracts={contracts} />);
    expect(m.container.querySelector('[role="note"]')!.textContent).toBe('Showing the 1,000 largest groups. Download Excel for everything.');
  });

  it('empty: no groups and no pairs → the all-priced sentence; no groups with unattached pairs → the section with a sentence', async () => {
    m = await mount(<UnpricedClient report={report({ groups: [], totals: { hours: 0, groups: 0, employees: 0, overlaps: 0 } })} filters={{}} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="unpriced-empty"]')!.textContent).toBe('No unpriced hours. Every recorded hour has a labor-category rate.');
    unmount(m);
    m = await mount(<UnpricedClient report={report({ groups: [], unattachedOverlaps: [p()] })} filters={{}} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="unpriced-empty"]')).toBeNull();
    expect(m.container.querySelector('[data-testid="unpriced-only-overlaps"]')!.textContent).toContain('No unpriced hours yet. These overlapping assignments will leave hours unpriced');
    expect(m.container.querySelector('[data-testid="unattached-overlaps"]')).not.toBeNull();
  });

  it('legacy startDate/endDate: the custom range is shown, and Download Excel asks with start/end', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ error: 'There are no unpriced hours or overlapping assignments to download.' }), { status: 422, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    m = await mount(<UnpricedClient report={report()} filters={{ startDate: '2026-01-01', endDate: '2026-01-31' }} contracts={contracts} />);
    expect(m.container.textContent).toContain('Start date');
    const periodLabel = [...m.container.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Period')!;
    expect((document.getElementById(periodLabel.htmlFor) as HTMLInputElement).value).toBe('Custom dates…');
    await click([...m.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Download Excel')));
    await wait();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reports/unpriced-xlsx?start=2026-01-01&end=2026-01-31');
    expect(m.container.querySelector('[data-testid="download-error"]')!.textContent).toBe('There are no unpriced hours or overlapping assignments to download.');
  });

  it('UX-4B1-AUDIT M2: a CLIN / SLIN scope shows as a chip; removing it drops clinId and slinId (the contract stays)', async () => {
    const K = '11111111-1111-4111-8111-111111111111', C = '22222222-2222-4222-8222-222222222222', S = '33333333-3333-4333-8333-333333333333';
    m = await mount(<UnpricedClient report={{ ...report(), scope: { contract: 'NAVAIR (N-1)', clinNumber: '0001', slinNumber: '0001AA' } }}
      filters={{ contractId: K, clinId: C, slinId: S }} contracts={contracts} />);
    const chip = m.container.querySelector('[data-testid="unpriced-scope-chip"]')!;
    expect(chip.textContent).toBe('CLIN 0001 · SLIN 0001AA');
    await click(chip.querySelector('button[aria-label="Remove filter CLIN 0001 · SLIN 0001AA"]'));
    expect(h.push).toHaveBeenLastCalledWith(`/admin/reports/unpriced?contractId=${K}`);
    unmount(m);
    m = await mount(<UnpricedClient report={{ ...report(), scope: { contract: 'NAVAIR (N-1)', clinNumber: null, slinNumber: null } }} filters={{ contractId: K }} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="unpriced-scope-chip"]')).toBeNull();
  });

  it('UX-4B1-AUDIT L10: under filters the empty state reads "No unpriced hours in this view."', async () => {
    m = await mount(<UnpricedClient report={report({ groups: [], totals: { hours: 0, groups: 0, employees: 0, overlaps: 0 } })} filters={{ reason: 'conflict' }} contracts={contracts} />);
    expect(m.container.querySelector('[data-testid="unpriced-empty"]')!.textContent).toBe('No unpriced hours in this view.');
  });

  it('UX-4B1-AUDIT L10: the period follows the URL — a back / forward re-render replaces an unsent choice', async () => {
    const ui = (filters: Parameters<typeof UnpricedClient>[0]['filters'], period?: string) => (
      // The same tree as mount(), so React updates the page in place (a remount would hide a stale draft).
      <MantineProvider env="test" theme={theme}><WorkspaceModeProvider mode="full"><UnpricedClient report={report()} filters={filters} period={period} contracts={contracts} /></WorkspaceModeProvider></MantineProvider>
    );
    m = await mount(<UnpricedClient report={report()} filters={{ startDate: '2026-10-01', endDate: '2026-10-15' }} period="lastPeriod" contracts={contracts} />);
    const periodInput = () => document.getElementById([...m!.container.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Period')!.htmlFor) as HTMLInputElement;
    expect(periodInput().value).toBe('Last pay period');
    // A choice the URL hasn't caught up with (the router is mocked, so nothing navigates).
    await click(periodInput());
    await click([...document.getElementById(periodInput().getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Custom dates…'));
    expect(periodInput().value).toBe('Custom dates…');
    // Back to All time (the URL changes under the page).
    await act(async () => { m!.root.render(ui({})); });
    expect(periodInput().value).toBe('All time');
    await act(async () => { m!.root.render(ui({ startDate: '2026-11-01', endDate: '2026-11-03' }, 'thisMonth')); });
    expect(periodInput().value).toBe('This month');
  });
});
