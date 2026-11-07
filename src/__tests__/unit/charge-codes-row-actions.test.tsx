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
  updateChargeCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
}));
vi.mock('@/server/actions/charge-codes', () => ({
  createChargeCode: vi.fn(), updateChargeCode: actions.updateChargeCode, autobridgeChargeCodesFromClins: vi.fn(), createCostClass: vi.fn(),
  deactivateChargeCode: actions.deactivateChargeCode, reactivateChargeCode: actions.reactivateChargeCode,
  getChargeCodeReactivationInfo: actions.getChargeCodeReactivationInfo, listChargeCodes: actions.listChargeCodes,
}));
vi.mock('@/server/actions/charge-code-categories', () => ({
  previewChargeCodeCategoryImpact: vi.fn(), addChargeCodeCategoryChange: vi.fn(), correctChargeCodeCategory: vi.fn(), removeChargeCodeCategoryChange: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { act } from 'react';
import { readFileSync } from 'node:fs';
import { ChargeCodesClient } from '@/app/(app)/admin/charge-codes/ChargeCodesClient';
import { buttonByText, buttonsByText, chooseRowAction, click, dialogTitled, installDomStubs, menuItems, mount, openRowMenu, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const row = (id: string, code: string, isActive: boolean) => ({
  id, code, name: `${code} name`, description: null, clinId: 'c1', clinNumber: '0001', slinId: null, contractName: 'NAVAIR', contractNumber: 'N-1',
  laborCategoryId: null, classId: null, className: null, workLocation: null, billable: true, isActive, createdAt: new Date(), categoryChanges: [],
  hasHours: false,
});
const CODES = [row('cc1', 'NAV-01', true), row('cc2', 'NAV-02', false)];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.listChargeCodes.mockResolvedValue(CODES as never); });
afterEach(() => { unmount(m); m = undefined; });

const render = async () => { m = await mount(<ChargeCodesClient initialCodes={CODES} costClasses={[]} contracts={[]} laborCategories={[]} />); };
/** The Direct tab's Status filter (Active by default, §3.2). */
const showStatus = async (word: 'Active' | 'Inactive' | 'All') => {
  const label = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Status')!;
  await click(document.getElementById(label.htmlFor));
  await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === word));
};

describe('Charge codes row actions (T12)', () => {
  it('each row shows a visible "Edit" button and a "More actions" trigger (no icon group)', async () => {
    await render();
    await showStatus('All');
    expect(buttonsByText('Edit')).toHaveLength(2);
    expect(document.body.querySelector('button[aria-label="More actions for NAV-01"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Edit charge code"], button[aria-label="Labor category"]')).toBeNull();
  });

  it('the menu: "Change labor category…", a divider, then Deactivate last (danger)', async () => {
    await render();
    await openRowMenu('NAV-01');
    expect(menuItems().map((i) => i.textContent)).toEqual(['Change labor category…', 'Deactivate…']);
    const dropdown = document.body.querySelector('[role="menu"]')!;
    const kids = [...dropdown.children];
    expect(kids.findIndex((k) => k.className.includes('divider'))).toBe(kids.indexOf(menuItems()[1]) - 1);
    expect(menuItems()[1].className).toMatch(/danger/);
    await expectNoAxeViolations(document.body);
  });

  it('Reactivate fetches its info, then confirms with a neutral (not red) button; Confirm calls reactivateChargeCode once', async () => {
    await render();
    await showStatus('Inactive');
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

// feature-plan-ux-page-fixes.md C5: the edit form and the code's CLIN.
describe('Charge code edit and its CLIN (C5)', () => {
  // The page lists ACTIVE contract + CLIN pairs only; the codes below sit on CLIN c1, which isn't listed (inactive).
  const ACTIVE = [{ id: 'k9', name: 'Atlas', contractNumber: 'A-9', clins: [{ id: 'c9', clinNumber: '0009', description: 'Ops' }] }];
  const renderWith = async (codes: Array<Omit<ReturnType<typeof row>, "laborCategoryId"> & { laborCategoryId: string | null }>) => {
    m = await mount(<ChargeCodesClient initialCodes={codes as never} costClasses={[]} contracts={ACTIVE} laborCategories={[]} />);
  };
  const edit = (code: string) => click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit' && b.closest('tr')?.textContent?.includes(code)));
  const dialog = () => dialogTitled('Edit charge code')!;
  const labelled = (text: string) => { const l = [...dialog().querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text); return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null; };
  const choose = async (field: string, option: string) => {
    await click(labelled(field));
    await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(option)));
  };

  it('T-C5a: a code with hours → its contract and CLIN read-only with the hours reason; with labor categories → the categories reason', async () => {
    await renderWith([{ ...row('cc1', 'NAV-01', true), hasHours: true }, { ...row('cc2', 'NAV-02', true), laborCategoryId: 'lc1' }]);
    await edit('NAV-01');
    const locked = dialog().querySelector('[data-testid="charge-code-clin-locked"]') as HTMLInputElement;
    expect(locked.readOnly).toBe(true);
    expect(locked.value).toBe('N-1 — NAVAIR · CLIN 0001');
    expect(dialog().textContent).toContain("This code has recorded hours, so its CLIN and SLIN can't change. Create a new charge code to use a different CLIN.");
    expect(labelled('Contract')).toBeNull();
    expect(labelled('CLIN')).toBeNull();
    await click(buttonByText('Cancel'));
    await edit('NAV-02');
    expect(dialog().textContent).toContain("Remove this code's labor categories before moving it to another CLIN or SLIN.");
    expect(labelled('CLIN')).toBeNull();
  });

  it('T-C5b: an inactive CLIN with no hours → editable Selects with "(inactive)" preselected; moving sends the new clinId; renaming sends none', async () => {
    await renderWith([row('cc1', 'NAV-01', true)]);
    await edit('NAV-01');
    expect(labelled('Contract')!.value).toBe('N-1 · CLIN 0001 (inactive)');
    expect(labelled('CLIN')!.value).toBe('0001 (inactive)');
    expect(dialog().textContent).toContain('This CLIN or its contract is inactive. Choose another CLIN to move the code, or leave it to edit the other fields.');
    // Rename only → no clinId sent.
    const name = labelled('Name')!;
    const setValue = (input: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })); };
    await act(async () => { setValue(name, 'Renamed'); });
    await click(buttonByText('Save'));
    expect(actions.updateChargeCode).toHaveBeenCalledTimes(1);
    expect(actions.updateChargeCode.mock.calls[0][1]).toMatchObject({ name: 'Renamed' });
    expect('clinId' in (actions.updateChargeCode.mock.calls[0][1] as object)).toBe(false);
    // Move to an active CLIN → sends it.
    await edit('NAV-01');
    await choose('Contract', 'A-9 — Atlas');
    expect(labelled('CLIN')!.value).toBe('');                 // choosing a contract clears the CLIN, as before
    await choose('CLIN', '0009');
    await click(buttonByText('Save'));
    expect(actions.updateChargeCode).toHaveBeenCalledTimes(2);
    expect(actions.updateChargeCode.mock.calls[1][1]).toMatchObject({ clinId: 'c9' });
  });
});

// UX-4A-AUDIT.md L6: T-C5c (integration) catches an uncorrelated exists, not an interpolated outer column, which would
// bind to the subquery's own table. Pin the literal outer column.
describe('listChargeCodes hasHours correlation (C5, L6)', () => {
  it('the exists subquery names the outer column literally: te.charge_code_id = charge_codes.id', () => {
    const src = readFileSync('src/server/actions/charge-codes.ts', 'utf8');
    const hasHours = src.match(/hasHours:\s*sql<boolean>`([^`]*)`/)?.[1] ?? '';
    expect(hasHours).toContain('te.charge_code_id = charge_codes.id');
    expect(hasHours).not.toContain('${');
  });
});

// feature-plan-ux-kit-contracts.md §4.4.7 / U-4: the Unpriced report's "Set category on code" lands here with ?code={id}.
describe('?code= deep link (U-4)', () => {
  it('opens the labor-category dialog for that code', async () => {
    m = await mount(<ChargeCodesClient initialCodes={CODES} costClasses={[]} contracts={[]} laborCategories={[]} openCategoryForId="cc1" />);
    expect(dialogTitled('Labor category — NAV-01')).toBeDefined();
  });

  it('an id not in the list opens nothing', async () => {
    m = await mount(<ChargeCodesClient initialCodes={CODES} costClasses={[]} contracts={[]} laborCategories={[]} openCategoryForId="99999999-9999-4999-8999-999999999999" />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('the page passes ?code= through only when it is a UUID', () => {
    const page = readFileSync('src/app/(app)/admin/charge-codes/page.tsx', 'utf8');
    expect(page).toMatch(/const openCategoryForId = code && UUID\.test\(code\) \? code : undefined;/);
    expect(page).toContain('openCategoryForId={openCategoryForId}');
  });
});

