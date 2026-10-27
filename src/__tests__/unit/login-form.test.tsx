// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-launch-blockers.md P2 / §9 "Routing": LoginForm resets its loading state when checkLockout or
 * signIn throws (previously the spinner never stopped, e.g. on an unreachable workspace).
 * Driven with react-dom/client + act (no @testing-library/dom in this repo).
 */

const auth = vi.hoisted(() => ({
  checkLockout: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: auth.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/server/actions/login-attempts', () => ({ checkLockout: auth.checkLockout }));

import { LoginForm } from '@/app/login/LoginForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Mantine reads matchMedia; jsdom doesn't implement it.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  auth.checkLockout.mockReset();
  auth.signIn.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Set a React-controlled input's value the way a user would (native setter + input event). */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submitForm(): Promise<HTMLButtonElement> {
  await act(async () => { root.render(<MantineProvider><LoginForm /></MantineProvider>); });
  const email = container.querySelector('input[type="email"]') as HTMLInputElement;
  const password = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => { type(email, 'jane@acme.com'); type(password, 'Password123!'); });
  const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
  await act(async () => { button.click(); });
  // let the rejected promise and finally{} settle
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container.querySelector('button[type="submit"]') as HTMLButtonElement;
}

describe('LoginForm loading state', () => {
  it('stops loading and shows an error when checkLockout throws', async () => {
    auth.checkLockout.mockRejectedValue(new Error('No tenant in request context.'));
    const button = await submitForm();
    expect(auth.checkLockout).toHaveBeenCalled();
    expect(container.textContent).toMatch(/something went wrong signing in/i);
    expect(button.hasAttribute('data-loading')).toBe(false);
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('stops loading when signIn throws', async () => {
    auth.checkLockout.mockResolvedValue({ isLocked: false, failedAttempts: 0, minutesRemaining: 0 });
    auth.signIn.mockRejectedValue(new Error('network'));
    const button = await submitForm();
    expect(auth.signIn).toHaveBeenCalled();
    expect(container.textContent).toMatch(/something went wrong signing in/i);
    expect(button.hasAttribute('data-loading')).toBe(false);
  });
});

describe('LoginForm structure (feature-plan-ux-foundations.md T16)', () => {
  it('one <main> and one h1 ("Sign in")', async () => {
    await act(async () => { root.render(<MantineProvider><LoginForm /></MantineProvider>); });
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect([...container.querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Sign in']);
  });

  it('the MFA recovery-code switch is a keyboard-reachable <button type="button"> that does not submit the form', async () => {
    auth.checkLockout.mockResolvedValue({ isLocked: false, failedAttempts: 0, minutesRemaining: 0 });
    auth.signIn.mockResolvedValue({ code: 'mfa_required' });
    await submitForm();
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use a recovery code instead')!;
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute('type')).toBe('button');
    await act(async () => { toggle.click(); });
    expect(auth.signIn).toHaveBeenCalledTimes(1); // no submit
    expect(container.textContent).toContain('Use authenticator app instead');
  });
});
