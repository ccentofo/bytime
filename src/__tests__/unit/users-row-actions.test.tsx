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
  resetMfa: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { changed: true } })),
  unlockUserAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  setUserApprover: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
}));
vi.mock('@/server/actions/users', () => ({
  updateUser: actions.updateUser, getUsersForAdminPage: actions.getUsers, unlockUserAccount: actions.unlockUserAccount,
  createUserWithPassword: vi.fn(), setUserApprover: actions.setUserApprover,
}));
vi.mock('@/server/actions/password', () => ({ adminResetPassword: vi.fn() }));
vi.mock('@/server/actions/mfa', () => ({ adminResetMfa: actions.resetMfa }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { UsersClient, editConfirmCopy, roleChangeCopy } from '@/app/(app)/admin/users/UsersClient';
import { notifications } from '@mantine/notifications';
import { buttonByText, chooseRowAction, click, dialogTitled, installDomStubs, menuItem, mount, openRowMenu, unmount, wait, type Mounted } from '../helpers/dom';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { expectNoAxeViolations } from '../helpers/axe';

const user = (id: string, fullName: string, extra: Partial<{ isActive: boolean; flsaExempt: boolean; role: 'admin' | 'supervisor' | 'employee'; approverId: string | null; mfaEnabled: boolean; lock: { minutesRemaining: number } | null }> = {}) => ({
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

  it('Mark as exempt → neutral confirm → Cancel: no call; Confirm: { flsaExempt: true }', async () => {
    await render();
    await chooseRowAction('Pat Doe', 'Mark as exempt…');
    const dialog = dialogTitled('Mark Pat Doe as FLSA exempt?')!;
    expect(dialog.textContent).toContain('Payroll export uses this to calculate overtime for every period, including past ones.');
    expect(buttonByText('Mark as exempt').getAttribute('style') ?? '').not.toContain('--mantine-color-red');
    await click(buttonByText('Cancel'));
    expect(actions.updateUser).not.toHaveBeenCalled();
    await chooseRowAction('Pat Doe', 'Mark as exempt…');
    await click(buttonByText('Mark as exempt'));
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { flsaExempt: true });
  });

  it('a refused FLSA change keeps its confirm open and its button enabled (closes only on success)', async () => {
    actions.updateUser.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'No.' } as never);
    await render();
    await chooseRowAction('Pat Doe', 'Mark as exempt…');
    await click(buttonByText('Mark as exempt'));
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(dialogTitled('Mark Pat Doe as FLSA exempt?')).toBeDefined();
    expect(buttonByText('Mark as exempt').disabled).toBe(false);
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
    const people = [user('me', 'Ann Admin'), user('u2', 'Pat Doe', { lock: { minutesRemaining: 9 } })];
    m = await mount(<UsersClient initialUsers={people} currentUserId="me" />, 'read_only');
    await openRowMenu('Pat Doe');
    expect(menuItem('Reset password…')!.getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Unlock now')!.getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Mark as exempt…')!.getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Deactivate…')!.getAttribute('aria-disabled')).toBe('true');
    await expectNoAxeViolations(document.body);
    await click(menuItem('Unlock now'));
    expect(actions.unlockUserAccount).toHaveBeenCalledWith('u2@x.test');
  });

  it('§5.2: search covers the name and email; the Status filter shows inactive people', async () => {
    const people = [user('me', 'Ann Admin'), user('u3', 'Gone Person', { isActive: false, flsaExempt: true })];
    m = await mount(<UsersClient initialUsers={people} currentUserId="me" />);
    const statusLabel = [...document.body.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.trim() === 'Status')!;
    await click(document.getElementById(statusLabel.htmlFor));
    await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'All'));
    const names = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '').filter((t) => /Admin|Person/.test(t));
    const search = async (q: string) => {
      const input = m!.container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(350); // MRT debounces the global filter 250 ms
    };
    await search('u3@x');
    expect(names()).toEqual([expect.stringContaining('Gone Person')]);
    await search('Ann');
    expect(names()).toEqual([expect.stringContaining('Ann Admin')]);
  });
});

describe('Users role changes and FLSA wording (feature-plan-ux-page-fixes.md C16, T-C16)', () => {
  const OUT = " They'll be signed out within a minute and must sign in again.";
  const TEAM = [user('me', 'Ann Admin', { role: 'admin' }), user('u2', 'Pat Doe'), user('s1', 'Sam Super', { role: 'supervisor' })];
  const CLINS = [
    { clinId: 'clin-1', clinNumber: '0001', clinDescription: 'Base', contractId: 'k1', contractName: 'NAVAIR' },
    { clinId: 'clin-2', clinNumber: '0002', clinDescription: null, contractId: 'k1', contractName: 'NAVAIR' },
    { clinId: 'clin-9', clinNumber: '0009', clinDescription: null, contractId: 'k2', contractName: 'Army' },
  ];
  const renderTeam = async (people = TEAM) => {
    actions.getUsers.mockResolvedValue(people as never);
    m = await mount(<UsersClient initialUsers={people} currentUserId="me" approvalClins={CLINS} />);
  };
  const edit = (name: string) => click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit' && b.closest('tr')?.textContent?.includes(name)));
  const form = () => dialogTitled('Edit user')!;
  const field = (text: string) => {
    const l = [...form().querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text);
    return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null;
  };
  const choose = async (label: string, option: string) => {
    const input = field(label)!;
    await click(input);
    // UX-4c §5.2: role options carry a description ("Supervisor — records time and approves their CLINs"); only this
    // field's listbox (the toolbar has a Role filter too).
    const listbox = document.getElementById(input.getAttribute('aria-controls')!)!;
    await click([...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === option || o.textContent?.startsWith(`${option} — `)));
  };
  const inDialog = (d: HTMLElement, text: string) => [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
  const setName = (v: string) => act(async () => {
    const input = field('Full name')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('each transition has its own title, message, tone and button, and every message ends with the sign-out line', () => {
    // feature-plan-approval-scope.md §5: a promotion summarizes the CLINs chosen; a demotion removes the scope.
    expect(roleChangeCopy('Pat', 'employee', 'supervisor', false, ['NAVAIR CLIN 0001', 'Army CLIN 0009'])).toEqual({
      tone: 'neutral', title: 'Make Pat a supervisor?', confirmLabel: 'Make supervisor',
      message: 'They can review and approve timesheets for employees on the CLINs they approve, and for supervisors or admins who have them set as their approver.'
        + " Charge code access doesn't change. They'll approve: NAVAIR CLIN 0001, Army CLIN 0009." + OUT,
    });
    expect(roleChangeCopy('Pat', 'employee', 'supervisor', false).message).toContain(" They won't approve any CLINs yet." + OUT);
    expect(roleChangeCopy('Pat', 'supervisor', 'admin', false)).toEqual({
      tone: 'danger', title: 'Make Pat an admin?', confirmLabel: 'Make admin',
      message: 'Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings.'
        + " Their approval scope is removed. Charge code access doesn't change." + OUT,
    });
    expect(roleChangeCopy('Pat', 'employee', 'admin', false).message).not.toContain('approval scope');
    expect(roleChangeCopy('Pat', 'employee', 'admin', true).message).toBe(
      'Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings.'
      + " You'll no longer be able to approve your own timesheets, because another admin can." + OUT,
    );
    expect(roleChangeCopy('Pat', 'admin', 'supervisor', true, ['NAVAIR CLIN 0001'])).toEqual({
      tone: 'neutral', title: 'Change Pat from admin to supervisor?', confirmLabel: 'Change role',
      message: "They lose access to users, contracts, costs and settings. They'll approve: NAVAIR CLIN 0001." + OUT,
    });
    const toEmployee = 'They can no longer review or approve timesheets. Admins, and any supervisor who approves those employees\' CLINs, can still approve them.';
    expect(roleChangeCopy('Pat', 'admin', 'employee', false)).toEqual({ tone: 'neutral', title: 'Change Pat to employee?', confirmLabel: 'Change role', message: toEmployee + OUT });
    expect(roleChangeCopy('Pat', 'supervisor', 'employee', false)).toEqual({
      tone: 'neutral', title: 'Change Pat to employee?', confirmLabel: 'Change role',
      message: toEmployee + " Their approval scope is removed. Charge code access doesn't change." + OUT,
    });
  });

  it('a role change asks first: Cancel → no update; Confirm → one update with the role, and both dialogs close', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    await click(inDialog(form(), 'Save changes'));
    const confirm = dialogTitled('Make Pat Doe a supervisor?')!;
    expect(confirm.textContent).toContain("They won't approve any CLINs yet.");
    expect(confirm.textContent).toContain(OUT.trim());
    expect(inDialog(confirm, 'Make supervisor').getAttribute('style') ?? '').not.toContain('--mantine-color-red');
    await click(inDialog(confirm, 'Cancel'));
    expect(dialogTitled('Make Pat Doe a supervisor?')).toBeUndefined();
    expect(actions.updateUser).not.toHaveBeenCalled();
    expect(form()).toBeDefined();                                    // back to the form, which keeps the choice

    await click(inDialog(form(), 'Save changes'));
    await click(inDialog(dialogTitled('Make Pat Doe a supervisor?')!, 'Make supervisor'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { role: 'supervisor', approvalClinIds: [] });
    expect(dialogTitled('Make Pat Doe a supervisor?')).toBeUndefined();
    expect(dialogTitled('Edit user')).toBeUndefined();
  });

  it('Esc under the role confirm closes only the confirm; the edit form stays open', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    await click(inDialog(form(), 'Save changes'));
    expect(dialogTitled('Make Pat Doe a supervisor?')).toBeDefined();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await wait();
    expect(dialogTitled('Make Pat Doe a supervisor?')).toBeUndefined();
    expect(dialogTitled('Edit user')).toBeDefined();
    expect(actions.updateUser).not.toHaveBeenCalled();
  });

  it('making an admin is a danger confirm, and names the end of self-approval only when you are the sole admin', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Admin');
    await click(inDialog(form(), 'Save changes'));
    const confirm = dialogTitled('Make Pat Doe an admin?')!;
    expect(inDialog(confirm, 'Make admin').getAttribute('style') ?? '').toContain('--mantine-color-red');
    expect(confirm.textContent).toContain("You'll no longer be able to approve your own timesheets, because another admin can.");
    unmount(m);
    await renderTeam([...TEAM, user('a2', 'Al Admin', { role: 'admin' })]);
    await edit('Pat Doe');
    await choose('Role', 'Admin');
    await click(inDialog(form(), 'Save changes'));
    expect(dialogTitled('Make Pat Doe an admin?')!.textContent).not.toContain('approve your own timesheets');
  });

  it('M1: an Edit save that changes overtime shows the FLSA confirm; Cancel sends nothing; Confirm sends it', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await click(form().querySelector('input[type="radio"][value="exempt"]'));
    await click(inDialog(form(), 'Save changes'));
    const confirm = dialogTitled('Mark Pat Doe as FLSA exempt?')!;
    expect(confirm.textContent).toContain('Payroll export uses this to calculate overtime for every period, including past ones.');
    await click(inDialog(confirm, 'Cancel'));
    await wait();
    expect(actions.updateUser).not.toHaveBeenCalled();
    expect(form()).toBeDefined();
    await click(inDialog(form(), 'Save changes'));
    await click(inDialog(dialogTitled('Mark Pat Doe as FLSA exempt?')!, 'Mark as exempt'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { flsaExempt: true });
  });

  it('M1: role and overtime both changed → ONE confirm carrying both messages', async () => {
    expect(editConfirmCopy('Pat', null, null, false)).toBeNull();
    expect(editConfirmCopy('Pat', null, false, false)).toEqual({
      tone: 'neutral', title: 'Mark Pat as FLSA non-exempt?', confirmLabel: 'Mark as non-exempt',
      message: 'Payroll export uses this to calculate overtime for every period, including past ones.',
    });
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    await click(form().querySelector('input[type="radio"][value="exempt"]'));
    await click(inDialog(form(), 'Save changes'));
    const confirm = dialogTitled('Make Pat Doe a supervisor?')!;
    expect(confirm.textContent).toContain('on the CLINs they approve');
    expect(confirm.textContent).toContain('Their overtime status changes to exempt: payroll export uses this to calculate overtime for every period, including past ones.');
    expect(dialogTitled('Mark Pat Doe as FLSA exempt?')).toBeUndefined();
    await click(inDialog(confirm, 'Save changes'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { role: 'supervisor', flsaExempt: true, approvalClinIds: [] });
  });

  it('AS-15: the CLIN picker shows only for a real change to supervisor (or Add); the confirm summarizes; the ids are sent; Cancel keeps them', async () => {
    const picker = () => form().querySelector('[data-testid="approval-clins"]');
    await renderTeam();
    await edit('Sam Super');                                                         // already a supervisor: no picker
    expect(picker()).toBeNull();
    await setName('Sam S');
    await click(inDialog(form(), 'Save changes'));
    await wait();
    expect(actions.updateUser).toHaveBeenLastCalledWith('s1', { fullName: 'Sam S' }); // no approvalClinIds
    unmount(m);
    actions.updateUser.mockClear();

    await renderTeam();
    await edit('Pat Doe');
    expect(picker()).toBeNull();                                                     // an employee: no picker
    await choose('Role', 'Supervisor');
    expect(form().textContent).toContain("Charge code access doesn't change. Their approval scope starts with only what you choose here.");
    const input = document.getElementById([...form().querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.startsWith('CLINs they approve'))!.htmlFor)!;
    for (const option of ['NAVAIR CLIN 0001 — Base', 'Army CLIN 0009']) {
      await click(input);
      await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
    }
    await click(inDialog(form(), 'Save changes'));
    expect(dialogTitled('Make Pat Doe a supervisor?')!.textContent).toContain("They'll approve: NAVAIR CLIN 0001, Army CLIN 0009.");
    await click(inDialog(dialogTitled('Make Pat Doe a supervisor?')!, 'Cancel'));
    await click(inDialog(form(), 'Save changes'));                                   // the selection survived Cancel
    expect(dialogTitled('Make Pat Doe a supervisor?')!.textContent).toContain("They'll approve: NAVAIR CLIN 0001, Army CLIN 0009.");
    await click(inDialog(dialogTitled('Make Pat Doe a supervisor?')!, 'Make supervisor'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { role: 'supervisor', approvalClinIds: ['clin-1', 'clin-9'] });
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
  });

  it('AS-15: switching the role away from supervisor hides the picker and sends no ids; demotion copy', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    expect(form().querySelector('[data-testid="approval-clins"]')).not.toBeNull();
    await choose('Role', 'Admin');
    expect(form().querySelector('[data-testid="approval-clins"]')).toBeNull();      // not a change to supervisor any more
    unmount(m);
    await renderTeam();
    await edit('Sam Super');
    await choose('Role', 'Employee');
    expect(form().querySelector('[data-testid="approval-clins"]')).toBeNull();
    await click(inDialog(form(), 'Save changes'));
    expect(dialogTitled('Change Sam Super to employee?')!.textContent).toContain("Their approval scope is removed. Charge code access doesn't change.");
    await click(inDialog(dialogTitled('Change Sam Super to employee?')!, 'Change role'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledWith('s1', { role: 'employee' });
  });

  it('a name-only edit saves without a confirm', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await setName('Pat Dee');
    await click(inDialog(form(), 'Save changes'));
    await wait();
    expect(document.body.textContent).not.toContain('signed out within a minute');
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { fullName: 'Pat Dee' });
  });

  it('a server refusal shows inside the confirm (not the form behind it), and the confirm stays open', async () => {
    actions.updateUser.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'The last admin can’t be demoted.' } as never);
    await renderTeam();
    await edit('Sam Super');
    await choose('Role', 'Employee');
    await click(inDialog(form(), 'Save changes'));
    await click(inDialog(dialogTitled('Change Sam Super to employee?')!, 'Change role'));
    await wait();
    const confirm = dialogTitled('Change Sam Super to employee?')!;
    expect(confirm.querySelector('[role="alert"]')!.textContent).toBe('The last admin can’t be demoted.');
    expect(form().textContent).not.toContain('The last admin can’t be demoted.');
  });

  it('L3: cancelling the role confirm after a refusal clears its error (it doesn\'t reappear on the form)', async () => {
    actions.updateUser.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'The last admin can’t be demoted.' } as never);
    await renderTeam();
    await edit('Sam Super');
    await choose('Role', 'Employee');
    await click(inDialog(form(), 'Save changes'));
    await click(inDialog(dialogTitled('Change Sam Super to employee?')!, 'Change role'));
    await wait();
    expect(dialogTitled('Change Sam Super to employee?')!.textContent).toContain('The last admin can’t be demoted.');
    await click(inDialog(dialogTitled('Change Sam Super to employee?')!, 'Cancel'));
    await wait(300);
    expect(form().textContent).not.toContain('The last admin can’t be demoted.');
  });

  it('partial save: the role saved but the approver failed → the explicit message, a refreshed user, and a retry sends only the approver', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    await choose('Approver', 'Sam Super (supervisor)');
    actions.setUserApprover.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Approver unavailable.' } as never);
    const saved = TEAM.map((u) => (u.id === 'u2' ? { ...u, role: 'supervisor' as const } : u));
    actions.getUsers.mockResolvedValue(saved as never);
    await click(inDialog(form(), 'Save changes'));
    await click(inDialog(dialogTitled('Make Pat Doe a supervisor?')!, 'Make supervisor'));
    await wait();
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.getUsers).toHaveBeenCalled();                     // refetched before any retry
    const confirm = dialogTitled('Make Pat Doe a supervisor?')!;
    expect(confirm.querySelector('[role="alert"]')!.textContent).toBe("The role was saved, but the approver couldn't be updated. Try saving again.");
    // Back in the form, Save no longer asks to confirm the (already saved) role and sends only the approver.
    await click(inDialog(confirm, 'Cancel'));
    await click(inDialog(form(), 'Save changes'));
    await wait();
    expect(dialogTitled('Make Pat Doe a supervisor?')).toBeUndefined();
    expect(actions.updateUser).toHaveBeenCalledTimes(1);
    expect(actions.setUserApprover).toHaveBeenCalledTimes(2);
    expect(actions.setUserApprover).toHaveBeenLastCalledWith('u2', 's1');
    expect(dialogTitled('Edit user')).toBeUndefined();
  });

  it('the FLSA toast says exempt / non-exempt, never salaried or hourly', async () => {
    await renderTeam();
    await chooseRowAction('Pat Doe', 'Mark as exempt…');
    await click(buttonByText('Mark as exempt'));
    await wait();
    const shown = vi.mocked(notifications.show).mock.calls.map(([n]) => n);
    expect(shown).toContainEqual(expect.objectContaining({ title: 'Marked exempt', message: 'Pat Doe is now FLSA exempt.' }));
    expect(JSON.stringify(shown)).not.toMatch(/salaried|hourly/i);
  });

  it('exempt is not "salaried" anywhere it is described (the export dictionary, the schema and the type comments)', () => {
    for (const file of ['src/lib/export/allowlists.ts', 'src/db/schema.ts', 'src/types/timesheet.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/salaried/i);
    }
    expect(readFileSync('src/lib/export/allowlists.ts', 'utf8')).toContain("'true for FLSA-exempt employees, who must still record all hours worked.'");
  });
});
