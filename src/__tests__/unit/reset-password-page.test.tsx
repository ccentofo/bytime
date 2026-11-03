// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Launch-blockers audit A12: the reset page renders the email as-is. `useSearchParams()` has already decoded it, and
 * decoding again (decodeURIComponent) threw a URIError for an address containing `%`, crashing the page.
 */

const h = vi.hoisted(() => ({ email: 'pat%ops@acme.com', extra: {} as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ token: 'tok', email: h.email, ...h.extra }),
}));
const verify = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<{ valid: boolean }>>(async () => ({ valid: true })));
vi.mock('@/server/actions/password-reset', () => ({
  verifyResetToken: verify,
  resetPassword: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ResetPasswordForm } from '@/app/reset-password/ResetPasswordForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  h.extra = {};
  verify.mockImplementation(async () => ({ valid: true }));
});

describe('reset password page', () => {
  it('renders an email containing % without crashing', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { root.render(<MantineProvider><ResetPasswordForm /></MantineProvider>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain('Resetting password for pat%ops@acme.com');
    errors.mockRestore();
  });

  it('after the "verifying" state resolves: one <main> and one h1 (feature-plan-ux-foundations.md T16)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<MantineProvider><ResetPasswordForm /></MantineProvider>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).not.toContain('Verifying reset link');
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect([...container.querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Set new password']);
  });
});

describe('first-run welcome mode (feature-plan-ux-page-fixes.md C9, T-C9a)', () => {
  async function renderWith(extra: Record<string, string>, settle = true) {
    h.extra = extra;
    h.email = 'founder@newco.com';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<MantineProvider><ResetPasswordForm /></MantineProvider>); });
    if (settle) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return container.textContent ?? '';
  }
  const labels = () => [...container.querySelectorAll('label')].map((l) => l.textContent?.replace(/\s*\*\s*$/, '').trim());

  it('welcome=1 → the welcome copy, never "Resetting password for"', async () => {
    const text = await renderWith({ welcome: '1' });
    expect([...container.querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Welcome to CadenzPoint']);
    expect(text).toContain('Your workspace is ready. Set a password for founder@newco.com to sign in.');
    expect(text).not.toContain('Resetting password for');
    expect(labels()).toEqual(['Password', 'Confirm password']);
    expect([...container.querySelectorAll('button[type="submit"]')].map((b) => b.textContent)).toEqual(['Set password']);
  });

  it('welcome=1 while checking, and with an invalid link', async () => {
    let resolve!: (v: { valid: boolean }) => void;
    verify.mockImplementation(() => new Promise((r) => { resolve = r; }));
    expect(await renderWith({ welcome: '1' }, false)).toContain('Checking your link…');
    await act(async () => { resolve({ valid: false }); });
    expect(container.textContent).toContain('This setup link is invalid or has expired. Use Forgot password to get a new one.');
    expect(container.querySelector('a[href="/forgot-password"]')!.textContent).toBe('Forgot password');
  });

  it.each([['true'], ['1x'], ['']])('welcome=%j → the reset copy', async (value) => {
    const text = await renderWith({ welcome: value });
    expect([...container.querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Set new password']);
    expect(text).toContain('Resetting password for founder@newco.com');
    expect(text).not.toContain('Welcome to CadenzPoint');
    expect(labels()).toEqual(['New password', 'Confirm new password']);
  });
});
