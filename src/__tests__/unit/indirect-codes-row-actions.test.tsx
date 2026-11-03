// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-foundations.md §4.5 / T10 (UX-AUDIT B2): Indirect codes — no Active Switch; Deactivate asks first
 * ("Deactivate {code}?"); Cancel makes no call; Confirm calls updateIndirectCode once with the same arguments.
 */

const actions = vi.hoisted(() => ({
  updateIndirectCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  getIndirectChargeCodes: vi.fn(async () => []),
  seedIndirectCodes: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, data: { created: 9 } })),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/indirect-codes', () => ({
  updateIndirectCode: actions.updateIndirectCode, getIndirectChargeCodes: actions.getIndirectChargeCodes,
  createIndirectCode: vi.fn(), seedIndirectCodes: actions.seedIndirectCodes,
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));

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

// feature-plan-ux-page-fixes.md C2 / C3.
describe('"Show on every timesheet" (C2) and the standard codes (C3)', () => {
  const codes = [
    CODES[0],
    { ...CODES[0], id: 'ic2', code: 'LV-JURY', name: 'Jury duty', availableToAll: false },
    { ...CODES[0], id: 'ic3', code: 'UA-01', name: 'Old', isActive: false },
  ];
  const search = async (text: string) => {
    const input = m!.container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(350);
  };
  const rowText = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
  const hideDialog = (code = 'OH-01') => dialogTitled(`Hide ${code} from timesheets?`);
  const toggleSwitch = async () => click(document.body.querySelector('[role="dialog"] input[role="switch"], [role="dialog"] .mantine-Switch-input'));
  const editAndSave = async (code = 'OH-01') => {
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit' && b.closest('tr')?.textContent?.includes(code)));
  };

  it('T-C2a: the switch label and description; the "On timesheets" column says Yes / Hidden / Inactive; search finds "Hidden"', async () => {
    m = await mount(<IndirectCodesClient initialCodes={codes} />);
    expect([...m.container.querySelectorAll('thead th')].map((t) => t.textContent)).toContain('On timesheets');
    const rows = rowText();
    expect(rows.find((r) => r.includes('OH-01'))).toContain('Yes');
    expect(rows.find((r) => r.includes('LV-JURY'))).toContain('Hidden');
    expect(rows.find((r) => r.includes('UA-01'))).toMatch(/Inactive.*Inactive|InactiveInactive/);
    await editAndSave();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Show on every timesheet');
    expect(dialog.textContent).toContain("When off, employees can't add this code or record new hours on it. Where hours are already recorded, the row stays in that period for corrections and notes.");
    expect(dialog.textContent).not.toContain('Available to All Employees');
    await click(buttonByText('Cancel'));
    await search('Hidden');
    expect(rowText().filter((t) => /-0|JURY/.test(t))).toEqual([expect.stringContaining('LV-JURY')]);
  });

  it('T-C2b: turning it off asks first — Cancel → no update; Hide code → one update; a server error shows inside the confirm', async () => {
    m = await mount(<IndirectCodesClient initialCodes={codes} />);
    await editAndSave();
    await toggleSwitch();
    await click(buttonByText('Save Changes'));
    expect(hideDialog()!.textContent).toContain("Employees won't be able to add OH-01 or record new hours on it. Rows that already have hours stay visible in their period for corrections and notes.");
    expect(actions.updateIndirectCode).not.toHaveBeenCalled();
    await click([...hideDialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    expect(hideDialog()).toBeUndefined();
    expect(actions.updateIndirectCode).not.toHaveBeenCalled();

    actions.updateIndirectCode.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'That code is in use.' } as never);
    await click(buttonByText('Save Changes'));
    await click(buttonByText('Hide code'));
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(1);
    expect(actions.updateIndirectCode.mock.calls[0][1]).toMatchObject({ availableToAll: false });
    expect(hideDialog()!.querySelector('[role="alert"]')!.textContent).toBe('That code is in use.');   // inside the confirm
    // ...and only there: the edit form's own error badge is hidden while the confirm is open.
    expect([...document.body.querySelectorAll('.mantine-Badge-root')].filter((b) => b.textContent === 'That code is in use.')).toHaveLength(0);

    await click(buttonByText('Hide code'));
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(2);
    await wait();
    expect(hideDialog()).toBeUndefined();                                                            // closes on success
  });

  it('T-C2c: turning it on, or leaving it unchanged, saves with no confirm', async () => {
    m = await mount(<IndirectCodesClient initialCodes={codes} />);
    await editAndSave('LV-JURY');
    await toggleSwitch();                                    // off → on
    await click(buttonByText('Save Changes'));
    expect(hideDialog('LV-JURY')).toBeUndefined();
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(1);
    expect(actions.updateIndirectCode.mock.calls[0][1]).toMatchObject({ availableToAll: true });
    await wait();
    await editAndSave();                                     // OH-01, unchanged
    await click(buttonByText('Save Changes'));
    expect(hideDialog()).toBeUndefined();
    expect(actions.updateIndirectCode).toHaveBeenCalledTimes(2);
  });

  it('T-C3b: "Add standard codes" only with no codes (not for a search with no matches); created 0 → "none were added"', async () => {
    m = await mount(<IndirectCodesClient initialCodes={codes} />);
    expect(buttonByText('Add standard codes')).toBeUndefined();
    expect(buttonByText('Seed Defaults')).toBeUndefined();
    await search('zzz-no-such-code');
    expect(rowText().some((t) => /-0/.test(t))).toBe(false);
    expect(buttonByText('Add standard codes')).toBeUndefined();
    unmount(m);
    actions.getIndirectChargeCodes.mockResolvedValue([] as never);   // still none after each seed (the button stays)
    m = await mount(<IndirectCodesClient initialCodes={[]} />);
    actions.seedIndirectCodes.mockResolvedValueOnce({ ok: true, data: { created: 0 } });
    await click(buttonByText('Add standard codes'));
    expect(actions.seedIndirectCodes).toHaveBeenCalledTimes(1);
    expect(actions.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Your workspace already has indirect codes, so none were added.' }));
    actions.seedIndirectCodes.mockResolvedValueOnce({ ok: true, data: { created: 9 } });
    await click(buttonByText('Add standard codes'));
    expect(actions.notify).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Added 9 standard indirect codes.' }));
  });
});
