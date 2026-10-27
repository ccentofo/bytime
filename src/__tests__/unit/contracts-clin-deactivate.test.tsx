// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-foundations.md §4.5 / T11 (UX-AUDIT B2, B5): in the CLIN/SLIN drawer, Deactivate asks first; Cancel
 * makes no call; the SLIN copy promises no charging block (nothing reads slins.status); Esc with a confirm open
 * closes only the confirm — the drawer stays open (closeOnEscape guard, trap T-P).
 */

const actions = vi.hoisted(() => ({
  updateClin: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: null })),
  updateSlin: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: null })),
  getClinsByContract: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => [] as unknown[]),
  getSlinsByClin: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => [] as unknown[]),
}));
vi.mock('@/server/actions/contracts', () => ({ createContract: vi.fn(), updateContract: vi.fn() }));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: actions.getClinsByContract, createClin: vi.fn(), updateClin: actions.updateClin }));
vi.mock('@/server/actions/slins', () => ({ getSlinsByClin: actions.getSlinsByClin, createSlin: vi.fn(), updateSlin: actions.updateSlin }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ContractsClient } from '@/app/(app)/admin/contracts/ContractsClient';
import { buttonByText, buttonsByText, chooseRowAction, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

const now = new Date();
const CONTRACT = { id: 'k1', contractNumber: 'N-1', name: 'NAVAIR', description: null, contractType: 'prime', status: 'active' as const, startDate: null, endDate: null, fundedValue: null, ceilingValue: null, createdAt: now, updatedAt: now };
const CLIN = { id: 'c1', contractId: 'k1', clinNumber: '0001', description: 'Eng', fundedAmount: null, status: 'active' as const, createdAt: now, updatedAt: now };
const SLIN = { id: 's1', clinId: 'c1', slinNumber: '0001AA', description: 'Sub', fundedAmount: null, status: 'active' as const, createdAt: now, updatedAt: now };

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  actions.getClinsByContract.mockResolvedValue([CLIN]);
  actions.getSlinsByClin.mockResolvedValue([SLIN]);
});
afterEach(() => { unmount(m); m = undefined; });

async function openDrawer() {
  m = await mount(<ContractsClient initialContracts={[CONTRACT]} />);
  await chooseRowAction('N-1', 'Manage CLINs and SLINs');
  await wait(50);
  expect(dialogTitled('CLINs — NAVAIR (N-1)')).toBeDefined();
}
// Mantine's ModalBase listens on window; dispatch from an element so `event.target` is a real node.
const pressEscape = () => act(async () => {
  ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

describe('CLIN / SLIN deactivate confirm (T11)', () => {
  it('CLIN: Deactivate asks first; Cancel → no call; Confirm → updateClin(id, { status: "inactive" }) once', async () => {
    await openDrawer();
    await click(buttonsByText('Deactivate')[0]);
    expect(dialogTitled('Deactivate CLIN 0001?')!.textContent).toContain("Employees can't charge new time to it. Existing hours stay on record.");
    await click(buttonByText('Cancel'));
    expect(actions.updateClin).not.toHaveBeenCalled();
    await click(buttonsByText('Deactivate')[0]);
    const confirm = dialogTitled('Deactivate CLIN 0001?')!;
    await click([...confirm.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Deactivate'));
    expect(actions.updateClin).toHaveBeenCalledTimes(1);
    expect(actions.updateClin).toHaveBeenCalledWith('c1', { status: 'inactive' });
  });

  it('SLIN: Deactivate asks first with copy that makes no charging claim; Cancel → no call', async () => {
    await openDrawer();
    await click(document.body.querySelector('button[aria-label="Expand SLINs"]'));
    await wait(50);
    const slinButton = buttonsByText('Deactivate')[1];
    await click(slinButton);
    const dialog = dialogTitled('Deactivate SLIN 0001AA?')!;
    expect(dialog.textContent).toContain('Marks it inactive. Existing hours stay on record.');
    expect(dialog.textContent).not.toMatch(/can.t charge/i);
    await click(buttonByText('Cancel'));
    expect(actions.updateSlin).not.toHaveBeenCalled();
  });

  it('Esc with the confirm open closes the confirm and leaves the drawer open', async () => {
    await openDrawer();
    await click(buttonsByText('Deactivate')[0]);
    expect(dialogTitled('Deactivate CLIN 0001?')).toBeDefined();
    await pressEscape();
    await wait(50);
    expect(dialogTitled('Deactivate CLIN 0001?')).toBeUndefined();
    expect(dialogTitled('CLINs — NAVAIR (N-1)')).toBeDefined();
    expect(actions.updateClin).not.toHaveBeenCalled();
  });
});
