// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C4 / T-C4a: the assignment form's labor-category options follow the categories without a
 * reload — reactivating a category adds it to the options; deactivating one removes it and clears it if selected.
 */

const h = vi.hoisted(() => ({ updateLaborCategory: vi.fn(), getAllLaborCategories: vi.fn(), getAssignableLaborCategories: vi.fn() }));
vi.mock('@/server/actions/labor-category-rates', () => ({
  previewRateChangeImpact: vi.fn(), addLaborCategoryRateChange: vi.fn(), correctLaborCategoryRate: vi.fn(), removeLaborCategoryRateChange: vi.fn(),
}));
vi.mock('@/server/actions/labor-categories', () => ({
  createLaborCategory: vi.fn(), updateLaborCategory: h.updateLaborCategory, getAllLaborCategories: h.getAllLaborCategories,
  getAssignableLaborCategories: h.getAssignableLaborCategories, assignUserToLaborCategory: vi.fn(), endUserLaborCategoryAssignment: vi.fn(),
  getUserLaborCategoryAssignments: vi.fn(),
}));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { LaborCategoriesClient } from '@/app/(app)/admin/labor-categories/LaborCategoriesClient';
import { buttonByText, chooseRowAction, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); h.updateLaborCategory.mockResolvedValue({ ok: true, data: {} }); });
afterEach(() => { unmount(m); m = undefined; });

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const lcat = (id: string, code: string, status: 'active' | 'inactive') => ({
  id, clinId: 'c1', slinId: null, lcatCode: code, title: `${code} title`, hourlyRate: '100.00', ceilingRate: null, status,
  createdAt: new Date(), updatedAt: new Date(), clinNumber: '0001', clinDescription: null, contractName: 'NAVAIR', contractNumber: 'N1', slinNumber: null, rateChanges: [],
});
const assignable = (id: string, code: string) => ({ id, lcatCode: code, title: `${code} title`, clinId: 'c1', slinId: null, clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1', slinNumber: null });

async function render() {
  m = await mount(
    <LaborCategoriesClient
      initialLaborCategories={[lcat(L1, 'SE-I', 'active'), lcat(L2, 'SE-II', 'inactive')] as never}
      initialAssignments={[]}
      contracts={[]}
      users={[{ id: 'u1', fullName: 'Pat Doe', email: 'p@x' }] as never}
      assignableLcats={[assignable(L1, 'SE-I')] as never}
      today={'2026-10-31' as CalendarDate}
    />,
  );
  await wait();
}
const lcatInput = () => {
  const label = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Labor Category'))!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
};
const options = async () => {
  await click(lcatInput());
  const found = [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
  await click(lcatInput());   // close again
  return found;
};

describe('assignable labor categories refresh (C4)', () => {
  it('reactivating adds the category to the options; deactivating removes it and clears the selection', async () => {
    await render();
    expect((await options()).some((o) => o.includes('SE-II'))).toBe(false);

    h.getAllLaborCategories.mockResolvedValue([lcat(L1, 'SE-I', 'active'), lcat(L2, 'SE-II', 'active')]);
    h.getAssignableLaborCategories.mockResolvedValue([assignable(L1, 'SE-I'), assignable(L2, 'SE-II')]);
    await chooseRowAction('SE-II', 'Reactivate');
    await wait();
    expect(h.getAssignableLaborCategories).toHaveBeenCalledTimes(1);
    expect((await options()).some((o) => o.includes('SE-II'))).toBe(true);

    // Select SE-I, then deactivate it: it leaves the options and the selection clears.
    await click(lcatInput());
    await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('SE-I:')));
    expect(lcatInput().value).toContain('SE-I:');
    h.getAllLaborCategories.mockResolvedValue([lcat(L1, 'SE-I', 'inactive'), lcat(L2, 'SE-II', 'active')]);
    h.getAssignableLaborCategories.mockResolvedValue([assignable(L2, 'SE-II')]);
    await chooseRowAction('SE-I', 'Deactivate…');
    await click(buttonByText('Deactivate'));
    await wait();
    expect(lcatInput().value).toBe('');
    const after = await options();
    expect(after.some((o) => o.includes('SE-I:'))).toBe(false);
    expect(after.some((o) => o.includes('SE-II'))).toBe(true);
  });
});
