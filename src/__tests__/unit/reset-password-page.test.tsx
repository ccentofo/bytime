// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Launch-blockers audit A12: the reset page renders the email as-is. `useSearchParams()` has already decoded it, and
 * decoding again (decodeURIComponent) threw a URIError for an address containing `%`, crashing the page.
 */

const h = vi.hoisted(() => ({ email: 'pat%ops@acme.com' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ token: 'tok', email: h.email }),
}));
vi.mock('@/server/actions/password-reset', () => ({
  verifyResetToken: vi.fn(async () => ({ valid: true })),
  resetPassword: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import ResetPasswordPage from '@/app/reset-password/page';

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
});

describe('reset password page', () => {
  it('renders an email containing % without crashing', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { root.render(<MantineProvider><ResetPasswordPage /></MantineProvider>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain('Resetting password for pat%ops@acme.com');
    errors.mockRestore();
  });
});
