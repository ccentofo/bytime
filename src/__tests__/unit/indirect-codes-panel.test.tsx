// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §3.5 / CC-9: the Indirect tab — groups in order (empty ones hidden) with their
 * sub-lines; Pay type words, "Not set" as a bad badge, "—" off leave; the Notice for ANY leave code without a pay type
 * (an inactive one too, as payroll-data blocks on it), singular / plural, whose "Set pay type" opens the first one's
 * form; the empty state; inline form errors plus one Alert for the server's.
 */

const actions = vi.hoisted(() => ({
  updateIndirectCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  createIndirectCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  getIndirectChargeCodes: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@/server/actions/indirect-codes', () => ({
  updateIndirectCode: actions.updateIndirectCode, getIndirectChargeCodes: actions.getIndirectChargeCodes,
  createIndirectCode: actions.createIndirectCode, seedIndirectCodes: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { IndirectCodesPanel, leaveCodesWithoutPayType } from '@/app/(app)/admin/charge-codes/IndirectCodesPanel';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { unmount(m); m = undefined; });

const ic = (id: string, code: string, category: string, o: Record<string, unknown> = {}) => ({
  id, code, name: `${code} name`, category, description: null, isActive: true, availableToAll: true, leavePayType: category === 'leave' ? 'pto' : null,
  createdAt: new Date(), updatedAt: new Date(), ...o,
}) as never;
const render = async (codes: unknown[]) => { m = await mount(<IndirectCodesPanel initialCodes={codes as never} />); await wait(10); };
const rows = () => [...document.body.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');

describe('Indirect tab (§3.5)', () => {
  it('groups in order with sub-lines; empty groups hidden; pay type words, "Not set", "—" off leave', async () => {
    await render([ic('a', 'UA-1', 'unallowable'), ic('b', 'OH-1', 'overhead'), ic('c', 'LV-SL', 'leave', { leavePayType: 'sick' }), ic('d', 'LV-X', 'leave', { leavePayType: null }), ic('e', 'GA-1', 'ga')]);
    const text = rows();
    expect(text.filter((t) => /^(Leave|Overhead|G&A|IR&D|B&P|Unallowable)/.test(t))).toEqual([
      'Leave · paid and unpaid time off', 'Overhead', 'G&A · general and administrative', 'Unallowable · FAR 31.205',
    ]);
    expect(text.find((t) => t.includes('LV-SL'))).toContain('Sick');
    expect(text.find((t) => t.includes('LV-X'))).toContain('Not set');
    expect(document.body.querySelector('[data-tone="bad"]')!.textContent).toBe('Not set');
    expect(text.find((t) => t.includes('OH-1'))).toContain('—');
  });

  it('CC-9: the notice appears for an INACTIVE leave code with no pay type; "Set pay type" opens its form', async () => {
    await render([ic('a', 'OH-1', 'overhead'), ic('z', 'LV-BRV', 'leave', { name: 'Bereavement', leavePayType: null, isActive: false })]);
    const notice = document.body.querySelector('[data-testid="pay-type-notice"]')!;
    expect(notice.textContent).toContain('LV-BRV Bereavement has no pay type, so Payroll export is blocked for anyone who charged it.');
    await click([...notice.querySelectorAll('button')].find((b) => b.textContent === 'Set pay type'));
    const dialog = dialogTitled('Edit indirect code')!;
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('LV-BRV');
  });

  it('plural notice; "Set pay type" opens the first by code; no notice when every leave code has one', async () => {
    await render([ic('y', 'LV-ZZ', 'leave', { leavePayType: null }), ic('x', 'LV-AA', 'leave', { leavePayType: null })]);
    const notice = document.body.querySelector('[data-testid="pay-type-notice"]')!;
    expect(notice.textContent).toContain('2 leave codes have no pay type, so Payroll export is blocked for anyone who charged them.');
    await click([...notice.querySelectorAll('button')].find((b) => b.textContent === 'Set pay type'));
    expect((dialogTitled('Edit indirect code')!.querySelector('input') as HTMLInputElement).value).toBe('LV-AA');
    unmount(m);
    await render([ic('c', 'LV-SL', 'leave')]);
    expect(document.body.querySelector('[data-testid="pay-type-notice"]')).toBeNull();
    expect(leaveCodesWithoutPayType([ic('o', 'OH-1', 'overhead')])).toEqual([]);
  });

  it('empty state: "No indirect codes yet." / "Add the standard DCAA set or add your own." / "Add standard codes"', async () => {
    await render([]);
    const empty = document.body.querySelector('[data-testid="indirect-empty"]')!;
    expect(empty.textContent).toContain('No indirect codes yet.');
    expect(empty.textContent).toContain('Add the standard DCAA set or add your own.');
    expect(buttonByText('Add standard codes')).toBeDefined();
  });

  it('form: inline errors on click (no request); a server error is one Alert in the form, not a badge', async () => {
    await render([ic('a', 'OH-1', 'overhead')]);
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit'));
    const dialog = dialogTitled('Edit indirect code')!;
    const input = dialog.querySelector('input') as HTMLInputElement;
    const { act } = await import('react');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(buttonByText('Save Changes'));
    expect(dialog.textContent).toContain('Enter a code.');
    expect(actions.updateIndirectCode).not.toHaveBeenCalled();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'OH-2'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    actions.updateIndirectCode.mockResolvedValueOnce({ ok: false, code: 'conflict', error: 'That code is already used.' });
    await click(buttonByText('Save Changes'));
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe('That code is already used.');
    expect(dialog.querySelector('.mantine-Badge-root')).toBeNull();
  });
});
