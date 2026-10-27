// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-foundations.md §4.5 / T12 (UX-AUDIT V8): Charge codes — "Edit" is a visible button, the menu holds
 * "Change labor category" then (behind a divider) Deactivate last; Reactivate fetches its info, then confirms with a
 * neutral (not red) button.
 */

const actions = vi.hoisted(() => ({
  deactivateChargeCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  reactivateChargeCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  getChargeCodeReactivationInfo: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ stillAssigned: 2, assignable: true })),
  listChargeCodes: vi.fn(async () => []),
}));
vi.mock('@/server/actions/charge-codes', () => ({
  createChargeCode: vi.fn(), updateChargeCode: vi.fn(), autobridgeChargeCodesFromClins: vi.fn(), createCostClass: vi.fn(),
  deactivateChargeCode: actions.deactivateChargeCode, reactivateChargeCode: actions.reactivateChargeCode,
  getChargeCodeReactivationInfo: actions.getChargeCodeReactivationInfo, listChargeCodes: actions.listChargeCodes,
}));
vi.mock('@/server/actions/charge-code-categories', () => ({
  previewChargeCodeCategoryImpact: vi.fn(), addChargeCodeCategoryChange: vi.fn(), correctChargeCodeCategory: vi.fn(), removeChargeCodeCategoryChange: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ChargeCodesClient } from '@/app/(app)/admin/charge-codes/ChargeCodesClient';
import { buttonByText, buttonsByText, chooseRowAction, click, dialogTitled, installDomStubs, menuItems, mount, openRowMenu, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const row = (id: string, code: string, isActive: boolean) => ({
  id, code, name: `${code} name`, description: null, clinId: 'c1', clinNumber: '0001', slinId: null, contractName: 'NAVAIR', contractNumber: 'N-1',
  laborCategoryId: null, classId: null, className: null, workLocation: null, billable: true, isActive, createdAt: new Date(), categoryChanges: [],
});
const CODES = [row('cc1', 'NAV-01', true), row('cc2', 'NAV-02', false)];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.listChargeCodes.mockResolvedValue(CODES as never); });
afterEach(() => { unmount(m); m = undefined; });

const render = async () => { m = await mount(<ChargeCodesClient initialCodes={CODES} costClasses={[]} contracts={[]} laborCategories={[]} />); };

describe('Charge codes row actions (T12)', () => {
  it('each row shows a visible "Edit" button and a "More actions" trigger (no icon group)', async () => {
    await render();
    expect(buttonsByText('Edit')).toHaveLength(2);
    expect(document.body.querySelector('button[aria-label="More actions for NAV-01"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Edit charge code"], button[aria-label="Labor category"]')).toBeNull();
  });

  it('the menu: "Change labor category", a divider, then Deactivate last (danger)', async () => {
    await render();
    await openRowMenu('NAV-01');
    expect(menuItems().map((i) => i.textContent)).toEqual(['Change labor category', 'Deactivate…']);
    const dropdown = document.body.querySelector('[role="menu"]')!;
    const kids = [...dropdown.children];
    expect(kids.findIndex((k) => k.className.includes('divider'))).toBe(kids.indexOf(menuItems()[1]) - 1);
    expect(menuItems()[1].className).toMatch(/danger/);
    await expectNoAxeViolations(document.body);
  });

  it('Reactivate fetches its info, then confirms with a neutral (not red) button; Confirm calls reactivateChargeCode once', async () => {
    await render();
    await chooseRowAction('NAV-02', 'Reactivate…');
    expect(actions.getChargeCodeReactivationInfo).toHaveBeenCalledWith('cc2');
    expect(dialogTitled('Reactivate charge code?')).toBeDefined();
    const confirm = buttonByText('Reactivate');
    expect(confirm.getAttribute('style') ?? '').not.toContain('--mantine-color-red');
    await click(confirm);
    expect(actions.reactivateChargeCode).toHaveBeenCalledTimes(1);
    expect(actions.reactivateChargeCode).toHaveBeenCalledWith('cc2');
  });

  it('Deactivate keeps its red confirm; Cancel → no call', async () => {
    await render();
    await chooseRowAction('NAV-01', 'Deactivate…');
    expect(buttonByText('Deactivate').getAttribute('style') ?? '').toContain('--mantine-color-red');
    await click(buttonByText('Cancel'));
    expect(actions.deactivateChargeCode).not.toHaveBeenCalled();
  });
});
