// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-foundations.md §4.5 / T10 (UX-AUDIT B2): Indirect codes — no Active Switch; Deactivate asks first
 * ("Deactivate {code}?"); Cancel makes no call; Confirm calls updateIndirectCode once with the same arguments.
 */

const actions = vi.hoisted(() => ({
  updateIndirectCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  getIndirectChargeCodes: vi.fn(async () => []),
}));
vi.mock('@/server/actions/indirect-codes', () => ({
  updateIndirectCode: actions.updateIndirectCode, getIndirectChargeCodes: actions.getIndirectChargeCodes,
  createIndirectCode: vi.fn(), seedIndirectCodes: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { IndirectCodesClient } from '@/app/(app)/admin/indirect-codes/IndirectCodesClient';
import { buttonByText, chooseRowAction, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { act } from 'react';

const CODES = [{
  id: 'ic1', code: 'OH-01', name: 'Overhead', category: 'overhead' as const, description: null, isActive: true,
  availableToAll: true, leavePayType: null, createdAt: new Date(), updatedAt: new Date(),
}];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.getIndirectChargeCodes.mockResolvedValue(CODES as never); });
afterEach(() => { unmount(m); m = undefined; });

describe('Indirect codes row actions (T10)', () => {
  it('no Switch in the rows; the status is a word', async () => {
    m = await mount(<IndirectCodesClient initialCodes={CODES} />);
    expect(m.container.querySelectorAll('tbody input[role="switch"], tbody .mantine-Switch-root')).toHaveLength(0);
    expect(m.container.querySelector('tbody')!.textContent).toContain('Active');
  });

  it('Deactivate requires the confirm: Cancel → no call; Confirm → updateIndirectCode(id, { isActive: false }) once', async () => {
    m = await mount(<IndirectCodesClient initialCodes={CODES} />);
    await chooseRowAction('OH-01', 'Deactivate…');
    expect(dialogTitled('Deactivate OH-01?')!.textContent).toContain("Employees can't charge new time to it. Existing hours stay on record.");
    await click(buttonByText('Cancel'));
    expect(actions.updateIndirectCode).not.toHaveBeenCalled();
    await chooseRowAction('OH-01', 'Deactivate…');
    await click(buttonByText('Deactivate'));
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(1);
    expect(actions.updateIndirectCode).toHaveBeenCalledWith('ic1', { isActive: false });
  });

  it('a refused deactivation keeps the confirm open and its button enabled (closes only on success)', async () => {
    actions.updateIndirectCode.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'No.' } as never);
    m = await mount(<IndirectCodesClient initialCodes={CODES} />);
    await chooseRowAction('OH-01', 'Deactivate…');
    await click(buttonByText('Deactivate'));
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(1);
    expect(dialogTitled('Deactivate OH-01?')).toBeDefined();
    expect(buttonByText('Deactivate').disabled).toBe(false);
  });

  it('L3: the table search finds the Status word', async () => {
    const codes = [CODES[0], { ...CODES[0], id: 'ic2', code: 'GA-01', name: 'G and A', isActive: false }];
    m = await mount(<IndirectCodesClient initialCodes={codes} />);
    const input = m.container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Inactive');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(350);
    const rows = [...m.container.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '').filter((t) => /-01/.test(t));
    expect(rows).toEqual([expect.stringContaining('GA-01')]);
  });
});
