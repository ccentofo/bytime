import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.3 / T6 (UX-D3): on a workspace host "/" sends admins and supervisors to Home,
 * employees to Timesheet, no session to sign-in — and the redirect isn't swallowed by the slug lookup's try.
 */

class RedirectSignal extends Error { constructor(public url: string) { super(`REDIRECT:${url}`); } }
const h = vi.hoisted(() => ({ slug: 'acme', user: null as null | { id: string; role: string; email: string; fullName: string }, slugThrows: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new RedirectSignal(url); } }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => { if (h.slugThrows) throw new Error('mismatch'); return h.slug; } }));
vi.mock('@/lib/session', () => ({ getSessionUser: async () => h.user }));

import LandingPage from '@/app/page';

async function redirectOf(): Promise<string | null> {
  try { await LandingPage(); return null; } catch (e) { if (e instanceof RedirectSignal) return e.url; throw e; }
}
const as = (role: string) => ({ id: 'u', role, email: 'x@y', fullName: 'X' });
beforeEach(() => { h.slug = 'acme'; h.user = null; h.slugThrows = false; });

describe('landing (T6)', () => {
  it('workspace host: admin → /home, supervisor → /home, employee → /timesheet, no session → /login', async () => {
    h.user = as('admin');
    expect(await redirectOf()).toBe('/home');
    h.user = as('supervisor');
    expect(await redirectOf()).toBe('/home');
    h.user = as('employee');
    expect(await redirectOf()).toBe('/timesheet');
    h.user = null;
    expect(await redirectOf()).toBe('/login');
  });

  it('the redirect is not swallowed: it propagates as NEXT_REDIRECT, never rendering the marketing page', async () => {
    h.user = as('admin');
    await expect(LandingPage()).rejects.toBeInstanceOf(RedirectSignal);
  });

  it('apex (no slug, or a host mismatch) renders the public page — no redirect', async () => {
    h.slug = '';
    expect(await redirectOf()).toBeNull();
    h.slugThrows = true;
    expect(await redirectOf()).toBeNull();
  });

  it('static: LoginForm pushes "/" after sign-in (the landing page decides) — unless a sanitized next was given (UX-3 A4.8)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/login/LoginForm.tsx'), 'utf8');
    expect(src).toContain("router.push(next ?? '/');");
    expect(src).not.toContain("router.push('/timesheet')");
  });
});
