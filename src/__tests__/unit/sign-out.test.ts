import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * Signing out stays on the workspace host: Auth.js only clears the session (redirect: false) and the browser goes to
 * the RELATIVE '/login' — `callbackUrl: '/login'` was resolved against Auth.js's base URL and landed on the apex.
 */

const calls = vi.hoisted(() => [] as string[]);
vi.mock('next-auth/react', () => ({
  signOut: vi.fn(async (opts: unknown) => { calls.push(`signOut:${JSON.stringify(opts)}`); return undefined; }),
}));
vi.mock('@/components/approvals/ApprovalNotices', () => ({
  clearDesigneeNoticeDismissals: vi.fn(() => { calls.push('clearDismissals'); }),
}));

import { signOut } from 'next-auth/react';
import { signOutToLogin } from '@/components/auth/sign-out';

const ROOT = path.resolve(__dirname, '../../..');
afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); });

describe('signOutToLogin', () => {
  it('clears the designee-notice dismissals, signs out with redirect: false, then navigates to the relative /login', async () => {
    const assign = vi.fn((url: string) => { calls.push(`assign:${url}`); });
    vi.stubGlobal('window', { location: { assign } });
    await signOutToLogin();
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
    expect(assign).toHaveBeenCalledWith('/login');
    expect(calls).toEqual(['clearDismissals', 'signOut:{"redirect":false}', 'assign:/login']);
  });

  it('navigates only after signOut has resolved (the session is cleared first)', async () => {
    let release!: () => void;
    vi.mocked(signOut).mockImplementationOnce((() => new Promise<undefined>((r) => { release = () => r(undefined); })) as never);
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const done = signOutToLogin();
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();
    release();
    await done;
    expect(assign).toHaveBeenCalledWith('/login');
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Every `signOut(...)` call in `src` whose arguments use callbackUrl or lack `redirect: false`. */
export function badSignOutCalls(src: string): string[] {
  return [...stripComments(src).matchAll(/\bsignOut\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((args) => /callbackUrl/.test(args) || !/redirect:\s*false/.test(args));
}

describe('static: no signOut with callbackUrl or without redirect: false', () => {
  it('no file in src/ calls signOut that way', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src')).flatMap((f) =>
      badSignOutCalls(readFileSync(f, 'utf8')).map((args) => `${path.relative(ROOT, f)}: signOut(${args})`));
    expect(offenders).toEqual([]);
  });

  it('both sign-out buttons use the helper', () => {
    for (const rel of ['src/components/shell/AppHeader.tsx', 'src/components/auth/SignOutButton.tsx']) {
      expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toMatch(/onClick=\{\(\) => \{ void signOutToLogin\(\); \}\}/);
    }
  });

  it('fixtures: callbackUrl and a bare call are flagged; redirect: false is not', () => {
    expect(badSignOutCalls("signOut({ callbackUrl: '/login' })")).toHaveLength(1);
    expect(badSignOutCalls('signOut()')).toHaveLength(1);
    expect(badSignOutCalls("signOut({ redirect: false, callbackUrl: '/x' })")).toHaveLength(1);
    expect(badSignOutCalls('await signOut({ redirect: false })')).toEqual([]);
    expect(badSignOutCalls('export const { handlers, signIn, signOut, auth } = NextAuth({')).toEqual([]);
  });
});
