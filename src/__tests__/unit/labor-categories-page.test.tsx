// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-kit-contracts.md §4.2 / L-1: Labor categories. Grouped by contract (groups start expanded); People
 * counts link to the Assignments tab filtered by category (0 is plain); the unpriced notice only when > 0; no
 * assignment UI and no report; the Add modal lists contracts; the page makes exactly its five loads.
 */

const h = vi.hoisted(() => ({
  updateLaborCategory: vi.fn(),
  getAllLaborCategories: vi.fn(), getLaborCategoryPeopleCounts: vi.fn(), getUnpricedSummary: vi.fn(),
  getContracts: vi.fn(), getWorkspaceToday: vi.fn(), getClinsByContract: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/actions/labor-category-rates', () => ({
  previewRateChangeImpact: vi.fn(), addLaborCategoryRateChange: vi.fn(), correctLaborCategoryRate: vi.fn(), removeLaborCategoryRateChange: vi.fn(),
}));
// Only what the page and client may use: any other export (the old assignment / report reads) would be undefined.
vi.mock('@/server/actions/labor-categories', () => ({
  createLaborCategory: vi.fn(), updateLaborCategory: h.updateLaborCategory, getAllLaborCategories: h.getAllLaborCategories,
  getLaborCategoryPeopleCounts: h.getLaborCategoryPeopleCounts, getUnpricedSummary: h.getUnpricedSummary,
}));
vi.mock('@/server/actions/contracts', () => ({ getContracts: h.getContracts }));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: h.getClinsByContract }));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: h.getWorkspaceToday }));
vi.mock('@/lib/session', () => ({ requirePageRole: vi.fn(async () => ({ id: 'a', role: 'admin' })) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import LaborCategoriesPage from '@/app/(app)/admin/labor-categories/page';
import { LaborCategoriesClient } from '@/app/(app)/admin/labor-categories/LaborCategoriesClient';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import { chooseRowAction, click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(() => { unmount(m); m = undefined; });

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const N1 = '33333333-3333-4333-8333-333333333333';
const lcat = (id: string, code: string, title: string, contract: 'army' | 'navair', o: { clin?: string; slin?: string | null; status?: 'active' | 'inactive' } = {}) => ({
  id, clinId: `clin-${code}`, slinId: o.slin ? `slin-${code}` : null, lcatCode: code, title, hourlyRate: '55.00', ceilingRate: '65.00',
  status: o.status ?? 'active', createdAt: new Date(), updatedAt: new Date(), clinNumber: o.clin ?? '0001', clinDescription: null,
  contractId: contract, contractName: contract === 'army' ? 'Army IT Support' : 'NAVAIR Systems Support',
  contractNumber: contract === 'army' ? 'W911QX-23-D-0042' : 'W58RGZ-21-C-0001', slinNumber: o.slin ?? null, rateChanges: [],
});
const CATS = [
  lcat(A1, 'HD-I', 'Help desk analyst', 'army'),
  lcat(A2, 'SA-I', 'Junior systems administrator', 'army', { clin: '0002', slin: '0002AA', status: 'inactive' }),
  lcat(N1, 'PM-II', 'Program manager', 'navair'),
];
const CONTRACTS = [{ id: 'army', name: 'Army IT Support', contractNumber: 'W911QX-23-D-0042', status: 'active' }, { id: 'navair', name: 'NAVAIR Systems Support', contractNumber: 'W58RGZ-21-C-0001', status: 'active' }];

async function render(unpricedHours = 1719, peopleCounts: Record<string, number> = { [A1]: 2 }) {
  m = await mount(
    <LaborCategoriesClient initialLaborCategories={CATS as never} contracts={CONTRACTS as never} peopleCounts={peopleCounts}
      unpricedHours={unpricedHours} today={'2026-11-03' as CalendarDate} />,
  );
}
const bodyRows = () => [...m!.container.querySelectorAll('tbody tr')] as HTMLElement[];
const rowWith = (text: string) => bodyRows().find((r) => r.textContent?.includes(text));

describe('Labor categories page (L-1)', () => {
  it('groups by contract, groups start expanded; a group row names the contract, its number and the count', async () => {
    await render();
    const texts = bodyRows().map((r) => r.textContent ?? '');
    expect(texts).toHaveLength(5); // 2 groups + 3 categories, all visible
    const army = rowWith('Army IT Support')!;
    expect(army.textContent).toContain('W911QX-23-D-0042');
    expect(army.textContent).toContain('· 2 categories');
    expect(army.querySelector('button[aria-label="Hide categories for Army IT Support"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowWith('NAVAIR Systems Support')!.textContent).toContain('· 1 category');
    // Children follow their group: Army's two, then NAVAIR's group and its one.
    expect(texts.findIndex((t) => t.includes('Help desk analyst'))).toBe(1);
    expect(texts.findIndex((t) => t.includes('Program manager'))).toBe(4);
    const sa = rowWith('Junior systems administrator')!;
    expect(sa.textContent).toContain('· CLIN 0002 · SLIN 0002AA');
    expect(sa.textContent).toContain('SA-I');
    expect(sa.textContent).toContain('Inactive');
    expect(rowWith('Help desk analyst')!.textContent).toContain('$55.00');
    expect(rowWith('Help desk analyst')!.textContent).toContain('$65.00');
    // Collapsing a group hides its categories.
    await click(army.querySelector('button[aria-label="Hide categories for Army IT Support"]'));
    expect(rowWith('Help desk analyst')).toBeUndefined();
  });

  it('People: a count links to the Assignments tab filtered by that category; 0 is plain text', async () => {
    await render();
    const link = rowWith('Help desk analyst')!.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('2');
    expect(link.getAttribute('href')).toBe(`/admin/assignments?tab=labor-categories&laborCategoryId=${A1}`);
    expect(rowWith('Program manager')!.querySelector('a')).toBeNull();
  });

  it('the notice shows only when hours are unpriced, linking to the Unpriced hours report', async () => {
    await render(1719);
    const note = m!.container.querySelector('[role="note"]')!;
    expect(note.textContent).toContain('1,719.00 hours have no labor-category rate, so their cost isn\'t counted.');
    const a = note.querySelector('a')!;
    expect([a.textContent, a.getAttribute('href')]).toEqual(['See what to fix', '/admin/reports/unpriced']);
    unmount(m);
    await render(0);
    expect(m!.container.querySelector('[role="note"]')).toBeNull();
  });

  it('no assignment UI and no report on the page', async () => {
    await render();
    const text = document.body.textContent ?? '';
    for (const gone of ['Create Assignment', 'User Labor Category Assignments', 'Unpriced hours', 'Overlapping']) expect(text).not.toContain(gone);
    expect([...document.body.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Assign')).toBe(false);
    expect(document.body.querySelectorAll('table')).toHaveLength(1);
  });

  it('the Add modal lists the contracts; its rates are MoneyInputs (a comma is a thousands separator)', async () => {
    await render();
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add labor category'));
    const label = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Contract'))!;
    await click(document.getElementById(label.htmlFor));
    const options = [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['Army IT Support (W911QX-23-D-0042)', 'NAVAIR Systems Support (W58RGZ-21-C-0001)']);
    const rateLabel = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Starting hourly rate'))!;
    const rate = document.getElementById(rateLabel.htmlFor) as HTMLInputElement;
    const user = userEvent.setup();
    await act(async () => { await user.type(rate, '1,234.5'); });
    expect(rate.value).toBe('$1,234.5');
  });

  it('the page makes its five loads and passes the counts and the unpriced hours', async () => {
    h.getAllLaborCategories.mockResolvedValue(CATS);
    h.getContracts.mockResolvedValue(CONTRACTS);
    h.getLaborCategoryPeopleCounts.mockResolvedValue({ [A1]: 2 });
    h.getUnpricedSummary.mockResolvedValue({ hours: 12.5, groups: 3, employees: 2 });
    h.getWorkspaceToday.mockResolvedValue('2026-11-03');
    const el = (await LaborCategoriesPage()) as { props: Record<string, unknown> };
    for (const f of [h.getAllLaborCategories, h.getContracts, h.getLaborCategoryPeopleCounts, h.getUnpricedSummary, h.getWorkspaceToday]) expect(f).toHaveBeenCalledTimes(1);
    expect(el.props).toMatchObject({ initialLaborCategories: CATS, contracts: CONTRACTS, peopleCounts: { [A1]: 2 }, unpricedHours: 12.5, today: '2026-11-03' });
    expect(Object.keys(el.props).sort()).toEqual(['contracts', 'initialLaborCategories', 'peopleCounts', 'today', 'unpricedHours']);
  });

  it('UX-4B1-AUDIT M4: Reactivate on two rows runs both at once (rows never share a busy group)', async () => {
    const pending: Array<(v: unknown) => void> = [];
    h.updateLaborCategory.mockImplementation(() => new Promise((r) => { pending.push(r); }));
    h.getAllLaborCategories.mockResolvedValue(CATS);
    const twoInactive = [CATS[0], CATS[1], { ...CATS[2], status: 'inactive' as const }];
    m = await mount(<LaborCategoriesClient initialLaborCategories={twoInactive as never} contracts={CONTRACTS as never} peopleCounts={{}} unpricedHours={0} today={'2026-11-03' as CalendarDate} />);
    await chooseRowAction('SA-I', 'Reactivate');
    await chooseRowAction('PM-II', 'Reactivate');
    expect(h.updateLaborCategory.mock.calls.map((c) => c[0])).toEqual([A2, N1]);
    await act(async () => { for (const r of pending) r({ ok: true, data: {} }); });
  });
});
