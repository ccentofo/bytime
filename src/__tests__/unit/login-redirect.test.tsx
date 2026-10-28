// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { readFileSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-timesheet.md A-T11 (A4.8): deep links survive sign-in — loginRedirect (async) builds /login?next=…
 * from x-cp-path through safeNext, URL-encoded; every former bare /login redirect returns it; the login page passes the
 * sanitized `next`; LoginForm goes there after the password step and after MFA; the proxy overwrites x-cp-path.
 */

const h = vi.hoisted(() => ({ cpPath: null as string | null, push: vi.fn(), signIn: vi.fn(), checkLockout: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(h.cpPath === null ? {} : { 'x-cp-path': h.cpPath }) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); },
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/session', async (importOriginal) => importOriginal()); // the REAL module (setup.ts mocks it globally)
vi.mock('@/db', () => ({ getDbForAuth: async () => ({}) }));
vi.mock('@/server/internal/approval-rules', () => ({ reviewScope: async () => 'all' }));
vi.mock('next-auth/react', () => ({ signIn: h.signIn }));
vi.mock('@/server/actions/login-attempts', () => ({ checkLockout: h.checkLockout }));
vi.mock('@/components/auth/workspace-auth-gate', () => ({ workspaceAuthGate: async (_t: string, form: () => unknown) => form() }));
vi.mock('@/lib/tenant/host', () => ({ tenantFromHost: () => 'acme' }));

import { loginRedirect } from '@/lib/session';
import LoginPage from '@/app/login/page';
import { LoginForm } from '@/app/login/LoginForm';
import { proxy } from '@/proxy';

const ROOT = path.resolve(__dirname, '../../..');
const redirectedTo = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { url?: string }).url; } throw new Error('no redirect'); };

describe('loginRedirect', () => {
  it('is async and sends to /login?next=<encoded safe path> from x-cp-path', async () => {
    h.cpPath = '/timesheet?period=2026-10-01';
    const p = loginRedirect();
    expect(p).toBeInstanceOf(Promise);
    expect(await redirectedTo(p)).toBe(`/login?next=${encodeURIComponent('/timesheet?period=2026-10-01')}`);
    expect(await redirectedTo(loginRedirect())).toBe('/login?next=%2Ftimesheet%3Fperiod%3D2026-10-01');
  });

  it('an unsafe or missing path gives a bare /login', async () => {
    for (const bad of ['//evil.com', '/api/x', '/timesheet/..//evil.com', null]) {
      h.cpPath = bad;
      expect(await redirectedTo(loginRedirect()), String(bad)).toBe('/login');
    }
  });

  it('every former bare /login redirect now returns loginRedirect() (static)', () => {
    const files = ['src/app/(app)/layout.tsx', 'src/app/(app)/timesheet/page.tsx', 'src/app/(app)/profile/page.tsx', 'src/app/(app)/profile/notifications/page.tsx', 'src/lib/session.ts'];
    for (const f of files) {
      const src = stripComments(readFileSync(path.join(ROOT, f), 'utf8'));
      expect(src, f).not.toMatch(/redirect\(\s*['"]\/login['"]\s*\)/);
      expect(src, f).toMatch(/return loginRedirect\(\);/);
      // Every call is returned (the definition itself is excluded).
      expect(src.match(/(?<!function )loginRedirect\(\)/g)!.length, f).toBe(src.match(/return loginRedirect\(\);/g)!.length);
    }
    const layout = stripComments(readFileSync(path.join(ROOT, 'src/app/(app)/layout.tsx'), 'utf8'));
    expect(layout.match(/return loginRedirect\(\);/g)).toHaveLength(3);
  });
});

describe('the proxy', () => {
  it('sets x-cp-path to pathname + search, overwriting an incoming value', async () => {
    const req = new NextRequest('https://acme.cadenzpoint.com/timesheet?period=2026-10-01', { headers: { 'x-cp-path': '//evil.com', host: 'acme.cadenzpoint.com' } });
    const res = await proxy(req);
    expect(res.headers.get('x-middleware-request-x-cp-path')).toBe('/timesheet?period=2026-10-01');
  });
});

describe('the login page and LoginForm', () => {
  it('the page passes the sanitized next (first value of an array; unsafe → null)', async () => {
    const formProps = async (next: unknown) => {
      const el = await LoginPage({ searchParams: Promise.resolve({ next: next as string }) }) as unknown as { props: { next: string | null } };
      return el.props.next;
    };
    expect(await formProps('/timesheet?period=2026-10-01')).toBe('/timesheet?period=2026-10-01');
    expect(await formProps(['/admin/users', '//x'])).toBe('/admin/users');
    expect(await formProps('//evil.com')).toBeNull();
    expect(await formProps(undefined)).toBeNull();
    expect(renderToStaticMarkup(<MantineProvider>{await LoginPage({ searchParams: Promise.resolve({}) }) as never}</MantineProvider>)).toContain('Sign In');
  });

  let container: HTMLDivElement; let root: Root;
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    h.push.mockReset(); h.signIn.mockReset(); h.checkLockout.mockReset();
    h.checkLockout.mockResolvedValue({ isLocked: false, failedAttempts: 0 });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const setValue = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = async () => {
    await act(async () => { (container.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const signInWith = async (next: string | null) => {
    await act(async () => { root.render(<MantineProvider><LoginForm next={next} /></MantineProvider>); });
    await act(async () => {
      setValue(container.querySelector('input[type="email"]')!, 'jane@acme.com');
      setValue(container.querySelector('input[type="password"]')!, 'Password123!');
    });
    await submit();
  };

  it('pushes next after the password step (and "/" without one)', async () => {
    h.signIn.mockResolvedValue({ ok: true, error: undefined });
    await signInWith('/timesheet?period=2026-10-01');
    expect(h.push).toHaveBeenCalledWith('/timesheet?period=2026-10-01');
    act(() => root.unmount()); root = createRoot(container); h.push.mockReset();
    await signInWith(null);
    expect(h.push).toHaveBeenCalledWith('/');
  });

  it('pushes next after the MFA step', async () => {
    h.signIn.mockResolvedValueOnce({ code: 'mfa_required' }).mockResolvedValueOnce({ ok: true, error: undefined });
    await signInWith('/admin/users');
    expect(h.push).not.toHaveBeenCalled();
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use a recovery code instead')!;
    await act(async () => { toggle.click(); });
    await act(async () => { setValue(container.querySelector('input[placeholder="Enter 8-character recovery code"]')!, 'ABCD1234'); });
    await submit();
    expect(h.signIn).toHaveBeenCalledTimes(2);
    expect(h.push).toHaveBeenCalledWith('/admin/users');
  });
});
