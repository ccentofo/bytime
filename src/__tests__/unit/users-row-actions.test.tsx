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

import { UsersClient, roleChangeCopy } from '@/app/(app)/admin/users/UsersClient';
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
  const renderTeam = async (people = TEAM) => {
    actions.getUsers.mockResolvedValue(people as never);
    m = await mount(<UsersClient initialUsers={people} currentUserId="me" />);
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
    expect(roleChangeCopy('Pat', 'employee', 'supervisor', false)).toEqual({
      tone: 'neutral', title: 'Make Pat a supervisor?', confirmLabel: 'Make supervisor',
      message: 'They can review and approve timesheets for employees who share a CLIN with them, and for supervisors or admins who have them set as their approver.'
        + " They'll approve employees on the CLINs they're assigned to. Check Assignments → Approval scope." + OUT,
    });
    expect(roleChangeCopy('Pat', 'supervisor', 'admin', false)).toEqual({
      tone: 'danger', title: 'Make Pat an admin?', confirmLabel: 'Make admin',
      message: 'Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings.' + OUT,
    });
    expect(roleChangeCopy('Pat', 'employee', 'admin', true).message).toBe(
      'Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings.'
      + " You'll no longer be able to approve your own timesheets, because another admin can." + OUT,
    );
    expect(roleChangeCopy('Pat', 'admin', 'supervisor', true)).toEqual({
      tone: 'neutral', title: 'Change Pat from admin to supervisor?', confirmLabel: 'Change role',
      message: 'They lose access to users, contracts, costs and settings, and keep approving timesheets in their review scope.' + OUT,
    });
    const toEmployee = {
      tone: 'neutral', title: 'Change Pat to employee?', confirmLabel: 'Change role',
      message: 'They can no longer review or approve timesheets. Admins, and any other supervisor who shares a CLIN with those employees, can still approve them.' + OUT,
    };
    expect(roleChangeCopy('Pat', 'admin', 'employee', false)).toEqual(toEmployee);
    expect(roleChangeCopy('Pat', 'supervisor', 'employee', false)).toEqual(toEmployee);
  });

  it('a role change asks first: Cancel → no update; Confirm → one update with the role, and both dialogs close', async () => {
    await renderTeam();
    await edit('Pat Doe');
    await choose('Role', 'Supervisor');
    await click(inDialog(form(), 'Save changes'));
    const confirm = dialogTitled('Make Pat Doe a supervisor?')!;
    expect(confirm.textContent).toContain('share a CLIN with them');
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
    expect(actions.updateUser).toHaveBeenCalledWith('u2', { role: 'supervisor' });
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
