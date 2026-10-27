// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-foundations.md §4.5 / T9 (UX-AUDIT B2): Users has no cell Switches; Deactivate and FLSA status ask
 * first and call the SAME server action with the SAME arguments only on Confirm; your own row's Deactivate is
 * disabled with its reason; credential actions (Reset password, Unlock) stay available in read-only mode.
 */

const actions = vi.hoisted(() => ({
  updateUser: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  getUsers: vi.fn(async () => []),
  unlockUserAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
}));
vi.mock('@/server/actions/users', () => ({
  updateUser: actions.updateUser, getUsers: actions.getUsers, unlockUserAccount: actions.unlockUserAccount,
  createUserWithPassword: vi.fn(), setUserApprover: vi.fn(),
}));
vi.mock('@/server/actions/password', () => ({ adminResetPassword: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { UsersClient } from '@/app/(app)/admin/users/UsersClient';
import { buttonByText, chooseRowAction, click, dialogTitled, installDomStubs, menuItem, mount, openRowMenu, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const user = (id: string, fullName: string, extra: Partial<{ isActive: boolean; flsaExempt: boolean }> = {}) => ({
  id, email: `${id}@x.test`, fullName, role: 'employee' as const, isActive: true, flsaExempt: false, approverId: null,
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const USERS = [user('me', 'Ann Admin'), user('u2', 'Pat Doe')];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.getUsers.mockResolvedValue(USERS as never); });
afterEach(() => { unmount(m); m = undefined; });

const render = async (mode: 'full' | 'read_only' = 'full') => { m = await mount(<UsersClient initialUsers={USERS} currentUserId="me" />, mode); };

describe('Users row actions (T9)', () => {
  it('no Switch in the rows; Status and FLSA are words', async () => {
    await render();
    expect(m!.container.querySelectorAll('tbody input[role="switch"], tbody .mantine-Switch-root')).toHaveLength(0);
    const rowText = m!.container.querySelector('tbody')!.textContent!;
    expect(rowText).toContain('Active');
    expect(rowText).toContain('Non-exempt');
  });

  it('Deactivate → confirm → Cancel: updateUser NOT called; Confirm: called once with { isActive: false }', async () => {
    await render();
    await chooseRowAction('Pat Doe', 'Deactivate…');
    const dialog = dialogTitled('Deactivate Pat Doe?')!;
    expect(dialog.textContent).toContain("They're signed out and can't sign in.");
    await click(buttonByText('Cancel'));
    expect(dialogTitled('Deactivate Pat Doe?')).toBeUndefined();
    expect(actions.updateUser).not.toHaveBeenCalled();

    await chooseRowAction('Pat Doe', 'Deactivate…');
    await click(buttonByText('Deactivate'));
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { isActive: false });
  });

  it('a failed deactivation keeps the confirm open (closes only on success)', async () => {
    actions.updateUser.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Last active admin.' } as never);
    await render();
    await chooseRowAction('Pat Doe', 'Deactivate…');
    await click(buttonByText('Deactivate'));
    expect(dialogTitled('Deactivate Pat Doe?')).toBeDefined();
  });

  it('Mark as FLSA exempt → neutral confirm → Cancel: no call; Confirm: { flsaExempt: true }', async () => {
    await render();
    await chooseRowAction('Pat Doe', 'Mark as FLSA exempt…');
    const dialog = dialogTitled('Mark Pat Doe as FLSA exempt?')!;
    expect(dialog.textContent).toContain('Payroll export uses this to calculate overtime for every period, including past ones.');
    expect(buttonByText('Mark as exempt').getAttribute('style') ?? '').not.toContain('--mantine-color-red');
    await click(buttonByText('Cancel'));
    expect(actions.updateUser).not.toHaveBeenCalled();
    await chooseRowAction('Pat Doe', 'Mark as FLSA exempt…');
    await click(buttonByText('Mark as exempt'));
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { flsaExempt: true });
  });

  it('own row: Deactivate is aria-disabled with "You can\'t deactivate your own account"', async () => {
    await render();
    await openRowMenu('Ann Admin');
    const item = menuItem('Deactivate…')!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain("You can't deactivate your own account");
    await click(item);
    expect(dialogTitled('Deactivate Ann Admin?')).toBeUndefined();
  });

  it('read-only: Reset password and Unlock stay enabled; Deactivate and FLSA are disabled; Unlock calls the server', async () => {
    await render('read_only');
    await openRowMenu('Pat Doe');
    expect(menuItem('Reset password…')!.getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Unlock account')!.getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Mark as FLSA exempt…')!.getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Deactivate…')!.getAttribute('aria-disabled')).toBe('true');
    await expectNoAxeViolations(document.body);
    await click(menuItem('Unlock account'));
    expect(actions.unlockUserAccount).toHaveBeenCalledWith('u2@x.test');
  });
});
