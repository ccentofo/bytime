// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §5.2 / US-7, US-8 (and the table): the ⋯ menu offers only what applies (Unlock now only
 * when locked; Reset two-step sign-in only when it's on and it isn't you); the two-step reset needs your password and
 * handles a stale "already off"; Add user lists every problem in one Alert whose links focus the field (no overtime
 * choice → "Choose an overtime status."), ticks the password rules and shows the seat use; columns show the approver,
 * overtime, two-step and "Locked · {n} min".
 */

const actions = vi.hoisted(() => ({
  create: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  list: vi.fn(async () => [] as unknown[]),
  unlock: vi.fn<(e: string) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  resetMfa: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { changed: true } })),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/users', () => ({
  updateUser: vi.fn(), getUsersForAdminPage: actions.list, unlockUserAccount: actions.unlock, createUserWithPassword: actions.create, setUserApprover: vi.fn(),
}));
vi.mock('@/server/actions/password', () => ({ adminResetPassword: vi.fn() }));
vi.mock('@/server/actions/mfa', () => ({ adminResetMfa: actions.resetMfa }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));

import { act } from 'react';
import { UsersClient, userMenuKeys } from '@/app/(app)/admin/users/UsersClient';
import { buttonByText, click, dialogTitled, installDomStubs, menuItems, mount, openRowMenu, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.list.mockImplementation(async () => PEOPLE); });
afterEach(() => { unmount(m); m = undefined; });

const u = (id: string, fullName: string, o: Record<string, unknown> = {}) => ({
  id, email: `${id}@x.test`, fullName, role: 'employee', isActive: true, flsaExempt: false, approverId: null, createdAt: new Date(), updatedAt: new Date(),
  mfaEnabled: false, lock: null, approverName: null, ...o,
});
const PEOPLE = [
  u('me', 'Ann Admin', { role: 'admin', mfaEnabled: true }),
  u('s1', 'Sam Super', { role: 'supervisor', approverName: 'Ann Admin', flsaExempt: true, mfaEnabled: true }),
  u('j1', 'John Doe', { lock: { minutesRemaining: 11 } }),
  u('a1', 'Al Admin', { role: 'admin' }),
];
const render = async (seats = { active: 4, limit: 10 }) => {
  m = await mount(<UsersClient initialUsers={PEOPLE as never} currentUserId="me" seats={seats} />);
  await wait(10);
};
const rowOf = (name: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name)) as HTMLElement;
const setValue = (input: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const field = (root: Element, label: string) => {
  const l = [...root.querySelectorAll<HTMLLabelElement>('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === label);
  return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null;
};

describe('the Users table', () => {
  it('name with email and " · you"; plain role; approver words; overtime; two-step; "Locked · 11 min"; the seat line', async () => {
    await render();
    expect(rowOf('Ann Admin').textContent).toContain('me@x.test · you');
    expect(rowOf('Ann Admin').textContent).toContain('None — admins approve');
    expect(rowOf('Sam Super').textContent).toContain('Ann Admin');
    expect(rowOf('Sam Super').textContent).toContain('Exempt');
    expect(rowOf('John Doe').textContent).toContain('CLIN supervisors');
    expect(rowOf('John Doe').querySelector('[data-testid="user-locked"]')!.textContent).toBe('Locked · 11 min');
    expect(rowOf('Ann Admin').textContent).toContain('On');
    expect(rowOf('John Doe').textContent).toContain('Off');
    expect(m!.container.querySelector('[data-testid="seat-line"]')!.textContent).toBe('4 active · 6 of 10 seats free');
    unmount(m);
    await render({ active: 4, limit: null as never });
    expect(m!.container.querySelector('[data-testid="seat-line"]')!.textContent).toBe('4 active');
  });
});

describe('the ⋯ menu (US-7)', () => {
  it('Unlock now only when locked; Reset two-step only when on and not yourself', async () => {
    expect(userMenuKeys(PEOPLE[2] as never, 'me')).toEqual(['unlock', 'reset-password', 'flsa', 'deactivate']);
    expect(userMenuKeys(PEOPLE[0] as never, 'me')).toEqual(['reset-password', 'flsa', 'deactivate']);
    expect(userMenuKeys(PEOPLE[1] as never, 'me')).toEqual(['reset-password', 'reset-mfa', 'flsa', 'deactivate']);
    await render();
    await openRowMenu('John Doe');
    expect(menuItems().map((i) => i.textContent)).toEqual(['Unlock now', 'Reset password…', 'Mark as exempt…', 'Deactivate…']);
    await click(menuItems()[0]);
    await wait(10);
    expect(actions.unlock).toHaveBeenCalledWith('j1@x.test');
    expect(actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message)).toContain('John Doe can sign in again');
    expect(actions.list).toHaveBeenCalled();
    await openRowMenu('Sam Super');
    expect(menuItems().map((i) => i.textContent)).toContain('Reset two-step sign-in…');
  });

  it('Reset two-step sign-in: needs your password; sends it; a stale "already off" says so and refetches', async () => {
    await render();
    await openRowMenu('Sam Super');
    await click(menuItems().find((i) => i.textContent === 'Reset two-step sign-in…'));
    const dialog = dialogTitled('Reset two-step sign-in for Sam Super?')!;
    expect(dialog.textContent).toContain("They're signed out within a minute. They'll sign in with just their password and can turn two-step sign-in on again from their profile.");
    await click(buttonByText('Reset two-step sign-in'));
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe('Enter your password.');
    expect(actions.resetMfa).not.toHaveBeenCalled();
    await setValue(field(dialog, 'Your password')!, 'hunter22!');
    actions.resetMfa.mockResolvedValueOnce({ ok: true, data: { changed: false } });
    await click(buttonByText('Reset two-step sign-in'));
    await wait(10);
    expect(actions.resetMfa).toHaveBeenCalledWith({ userId: 's1', currentPassword: 'hunter22!' });
    expect(actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message)).toContain('Two-step sign-in was already off');
    expect(actions.list).toHaveBeenCalled();
  });
});

describe('Add user (US-8)', () => {
  it('no overtime choice → the Alert lists it with a link that focuses the field; nothing is sent', async () => {
    await render();
    await click(buttonByText('Add user'));
    const drawer = dialogTitled('Add user')!;
    await setValue(field(drawer, 'Full name')!, 'Priya N');
    await setValue(field(drawer, 'Email')!, 'priya@x.test');
    await setValue(field(drawer, 'Temporary password')!, 'harbor-light');
    await click([...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Add user'));
    const alert = drawer.querySelector('[data-testid="user-form-alert"]')!;
    expect(alert.textContent).toContain('Fix 1 thing to add this user:');
    const link = [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Choose an overtime status.')!;
    await click(link);
    expect(document.activeElement).toBe(drawer.querySelector('input[type="radio"][value="nonexempt"]'));
    expect(actions.create).not.toHaveBeenCalled();
  });

  it('every problem is listed; the password rules tick as met; the seat use; a valid form sends flsaExempt and no approver for an employee', async () => {
    await render();
    await click(buttonByText('Add user'));
    const drawer = dialogTitled('Add user')!;
    expect(drawer.querySelector('[data-testid="seat-use"]')!.textContent).toBe('Uses 1 of 6 free seats');
    await click([...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Add user'));
    expect(drawer.querySelector('[data-testid="user-form-alert"]')!.textContent).toContain('Fix 4 things to add this user:');
    const rules = () => [...drawer.querySelectorAll('[data-testid="password-rules"] li')].map((li) => [li.textContent, li.hasAttribute('data-met')]);
    expect(rules()[0]).toEqual(['· At least 8 characters', false]);
    await setValue(field(drawer, 'Temporary password')!, 'harbor-light');
    expect(rules()[0]).toEqual(['✓ At least 8 characters', true]);
    await setValue(field(drawer, 'Full name')!, 'Priya N');
    await setValue(field(drawer, 'Email')!, 'priya@x.test');
    await click(drawer.querySelector('input[type="radio"][value="exempt"]'));
    await click([...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Add user'));
    await wait(10);
    expect(actions.create).toHaveBeenCalledWith({ email: 'priya@x.test', fullName: 'Priya N', role: 'employee', password: 'harbor-light', flsaExempt: true, approverId: null });
  });

  it('a server error goes in the same Alert', async () => {
    actions.create.mockResolvedValueOnce({ ok: false, code: 'conflict', error: 'A user with that email already exists.' });
    await render();
    await click(buttonByText('Add user'));
    const drawer = dialogTitled('Add user')!;
    await setValue(field(drawer, 'Full name')!, 'Priya N');
    await setValue(field(drawer, 'Email')!, 'me@x.test');
    await setValue(field(drawer, 'Temporary password')!, 'harbor-light');
    await click(drawer.querySelector('input[type="radio"][value="nonexempt"]'));
    await click([...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Add user'));
    await wait(10);
    expect(drawer.querySelector('[data-testid="user-form-alert"]')!.textContent).toBe('A user with that email already exists.');
  });
});
