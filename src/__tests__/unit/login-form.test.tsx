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

// feature-plan-hotfix-mfa-qr.md §7: 2FA sign-in never reached the code step. next-auth builds the POST body with
// `new URLSearchParams({ ...params })`, which serialises `mfaCode: undefined` as the string "undefined" — verified as a
// wrong code, so the code field never appeared and every attempt counted toward the lockout.
describe('LoginForm 2FA step (hotfix §7)', () => {
  // The six visible code boxes (PinInput also renders a hidden input carrying the joined value).
  const pinInputs = () => [...container.querySelectorAll<HTMLInputElement>('input.mantine-PinInput-pinInput, .mantine-PinInput-root input:not([type="hidden"])')];
  const signInParams = (call: number) => auth.signIn.mock.calls[call][1] as Record<string, unknown>;
  const verify = async () => {
    const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const enterCode = async (code: string) => {
    const inputs = pinInputs();
    expect(inputs).toHaveLength(6);
    for (const [i, ch] of [...code].entries()) await act(async () => { type(inputs[i], ch); });
  };

  beforeEach(() => auth.checkLockout.mockResolvedValue({ isLocked: false, failedAttempts: 0, minutesRemaining: 0 }));
  /**
   * signIn as the real stack behaves for a 2FA account: the params serialised exactly as next-auth/react does
   * (`new URLSearchParams({ ...params })`), then a server that verifies ANY mfaCode it receives — the pre-fix server, so
   * these tests depend on the client sending no mfaCode key before the code step. "123456" is the right code.
   */
  const strictServer = async (_provider: string, params: Record<string, unknown>) => {
    const body = new URLSearchParams({ ...(params as Record<string, string>) });
    const code = body.get('mfaCode');
    if (code === null || code === '') return { code: 'mfa_required', error: 'CredentialsSignin', ok: false };
    return code === '123456' ? { ok: true, error: null } : { code: 'mfa_invalid', error: 'CredentialsSignin', ok: false };
  };

  it('first submit for a 2FA account sends no mfaCode key', async () => {
    auth.signIn.mockResolvedValue({ code: 'mfa_required' });
    await submitForm();
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    const params = signInParams(0);
    expect(params).toMatchObject({ email: 'jane@acme.com', password: 'Password123!', redirect: false });
    expect('mfaCode' in params).toBe(false);
  });

  it('the body next-auth would build from the first submit has no mfaCode= (URLSearchParams, as next-auth/react does)', async () => {
    auth.signIn.mockResolvedValue({ code: 'mfa_required' });
    await submitForm();
    const body = new URLSearchParams({ ...(signInParams(0) as Record<string, string>) }).toString();
    expect(body).not.toMatch(/mfaCode=/);
    expect(body).not.toContain('undefined');
  });

  it('after mfa_required, the code field appears and the second submit sends mfaCode: "123456"', async () => {
    auth.signIn.mockImplementation(strictServer);
    await submitForm();
    expect(container.textContent).not.toContain('Invalid code');
    expect(container.textContent).toContain('Enter the 6-digit code from your authenticator app');
    await enterCode('123456');
    await verify();
    expect(auth.signIn).toHaveBeenCalledTimes(2);
    expect(signInParams(1)).toMatchObject({ email: 'jane@acme.com', password: 'Password123!', mfaCode: '123456', redirect: false });
  });

  it('mfa_invalid on the code step keeps the code field and shows "Invalid code"', async () => {
    auth.signIn.mockImplementation(strictServer);
    await submitForm();
    expect(container.textContent).not.toContain('Invalid code');
    await enterCode('000000');
    await verify();
    expect(container.textContent).toContain('Invalid code. Please try again.');
    expect(container.textContent).toContain('Enter the 6-digit code from your authenticator app');
    expect(pinInputs()).toHaveLength(6);
    expect(pinInputs().map((i) => i.value).join('')).toBe('');            // cleared for the retry
    expect(container.textContent).not.toContain('Invalid email or password');
  });
});
