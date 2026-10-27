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
import { buttonByText, chooseRowAction, click, dialogTitled, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

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
});
