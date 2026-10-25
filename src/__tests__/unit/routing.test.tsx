import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type { ReactElement } from 'react';

/**
 * feature-plan-launch-blockers.md P2 / §9 "Routing": apex vs workspace routing (server components rendered
 * statically) and the apex workspace finder action.
 */

class RedirectSignal extends Error {
  constructor(public url: string) { super(`REDIRECT:${url}`); }
}
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new RedirectSignal(url); },
  unstable_rethrow: (err: unknown) => { if (err instanceof RedirectSignal) throw err; },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const tenant = vi.hoisted(() => ({
  slug: '' as string,
  state: { kind: 'none' } as { kind: string; tenant?: unknown },
  registry: new Set<string>(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenant.slug,
  getTenantState: async () => tenant.state,
}));
vi.mock('@/lib/tenant/registry', () => ({
  getTenantBySlug: async (slug: string) => (tenant.registry.has(slug) ? { id: 't', slug, status: 'active' } : null),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }) }));
vi.mock('@/app/login/LoginForm', () => ({ LoginForm: () => <div>LOGIN_FORM</div> }));
vi.mock('@/app/forgot-password/ForgotPasswordForm', () => ({ ForgotPasswordForm: () => <div>FORGOT_FORM</div> }));
vi.mock('@/app/signup/SignupForm', () => ({ SignupForm: () => <div>SIGNUP_FORM</div> }));

import LandingPage from '@/app/page';
import LoginPage from '@/app/login/page';
import ForgotPasswordPage from '@/app/forgot-password/page';
import SignupPage from '@/app/signup/page';
import { goToWorkspace } from '@/server/actions/workspace-finder';
import { apexBaseUrl, tenantBaseUrl } from '@/lib/tenant/host';

const html = (el: ReactElement) => renderToStaticMarkup(<MantineProvider>{el}</MantineProvider>);

async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
}

beforeEach(() => {
  tenant.slug = '';
  tenant.state = { kind: 'none' };
  tenant.registry = new Set(['acme']);
  vi.stubEnv('NEXT_PUBLIC_DEMO_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/ (landing)', () => {
  it('on a workspace host redirects to /timesheet', async () => {
    tenant.slug = 'acme';
    expect(await redirectOf(LandingPage())).toBe('/timesheet');
  });

  it('on the apex renders the marketing page', async () => {
    const out = html(await LandingPage());
    expect(out).toContain('Start Free Trial');
  });

  it('hides the demo buttons and credentials when NEXT_PUBLIC_DEMO_URL is unset', async () => {
    const out = html(await LandingPage());
    expect(out).not.toContain('Try the Demo');
    expect(out).not.toContain('Launch Demo');
    expect(out).not.toContain('Password123!');
  });

  it('links the demo buttons to NEXT_PUBLIC_DEMO_URL when set (never the apex /login)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_URL', 'https://demo.cadenzpoint.com/login');
    const out = html(await LandingPage());
    expect(out).toContain('Try the Demo');
    expect(out).toContain('href="https://demo.cadenzpoint.com/login"');
    expect(out).not.toMatch(/href="\/login"/);
  });
});

describe('/login and /forgot-password', () => {
  it('apex /login renders the "Find your workspace" finder, not the sign-in form', async () => {
    const out = html(await LoginPage());
    expect(out).toContain('Find your workspace');
    expect(out).not.toContain('LOGIN_FORM');
  });

  it('apex /forgot-password renders the finder too', async () => {
    const out = html(await ForgotPasswordPage());
    expect(out).toContain('Find your workspace');
    expect(out).not.toContain('FORGOT_FORM');
  });

  it.each(['unknown', 'closed', 'provisioning', 'mismatch'])('a %s workspace /login renders TenantUnavailable', async (kind) => {
    tenant.state = { kind };
    const out = html(await LoginPage());
    expect(out).not.toContain('LOGIN_FORM');
    expect(out).not.toContain('Find your workspace');
    expect(out).toMatch(/Workspace not found|Workspace closed|Setting up your workspace|could not be verified/);
  });

  it.each(['full', 'read_only', 'billing_only', 'policy_hold'])('a %s workspace /login shows the sign-in form', async (kind) => {
    tenant.state = { kind, tenant: {} };
    expect(html(await LoginPage())).toContain('LOGIN_FORM');
  });
});

describe('/signup', () => {
  it('on a workspace host redirects to the apex signup page', async () => {
    tenant.slug = 'acme';
    expect(await redirectOf(SignupPage({ searchParams: Promise.resolve({}) }))).toBe(`${apexBaseUrl()}/signup`);
  });

  it('on the apex renders the signup form', async () => {
    expect(html(await SignupPage({ searchParams: Promise.resolve({}) }))).toContain('SIGNUP_FORM');
  });
});

describe('goToWorkspace (apex finder action)', () => {
  it('returns the slug’s own host for /login and /forgot-password (no server redirect — audit A4)', async () => {
    expect(await goToWorkspace('acme', '/login')).toEqual({ ok: true, data: { url: `${tenantBaseUrl('acme')}/login` } });
    expect(await goToWorkspace('  ACME ', '/forgot-password')).toEqual({ ok: true, data: { url: `${tenantBaseUrl('acme')}/forgot-password` } });
  });

  it.each(['/timesheet', '//evil.com', 'https://evil.com', '/login@evil.com', '', '/login/../admin'])(
    'refuses target %j (open-redirect guard) with the same refusal',
    async (target) => {
      await expect(goToWorkspace('acme', target)).resolves.toEqual({ ok: false, code: 'validation', error: 'Invalid request.' });
    },
  );

  it('refuses an invalid slug with a message, without a lookup', async () => {
    for (const bad of ['acme.root@evil.com', 'a_b', '-acme', 'www', '']) {
      const result = await goToWorkspace(bad, '/login');
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/workspace name/i) });
    }
  });

  it('an unknown workspace returns "No workspace with that name"', async () => {
    await expect(goToWorkspace('nobody', '/login')).resolves.toEqual({ ok: false, code: 'not_found', error: 'No workspace with that name.' });
  });
});
