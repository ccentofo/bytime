import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type { ReactElement } from 'react';

/**
 * feature-plan-launch-blockers.md P5 / §9 "Signup", "Waitlist", "Cleanup/quota": signup cleanup (LB-D5 Terms
 * condition), the Neon-80 quota alert, founder waitlist provisioning and its environment guard, the local-database
 * loopback refusal, the flag's client wiring (no Turnstile without it), cron wiring, and secrets staying server-side.
 */

const h = vi.hoisted(() => ({
  raised: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<Record<string, unknown>>,
  tenant: { dbUrl: 'postgres://tenant' } as null | { dbUrl: string },
  order: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: () => {} } }));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/db/control-plane/locked', async () => {
  const { controlDb } = await import('@/db/control-plane');
  return { withLockedPool: async (fn: (db: unknown) => unknown) => fn(controlDb) };
});
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  raiseAlert: async (_db: unknown, a: Record<string, unknown>) => { h.raised.push(a); return { opened: true }; },
  resolveAlert: async (_db: unknown, a: Record<string, unknown>) => { h.resolved.push(a); },
}));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async () => h.tenant }));
vi.mock('@/server/internal/signup', () => ({ tenantsCreatedSince: async () => 7 }));
vi.mock('@/server/actions/signup', () => ({ startSignup: vi.fn(), resendSignupVerification: vi.fn() }));

import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { runSignupMaintenance } from '@/lib/signup/maintenance';
import { createNeonDatabase } from '@/lib/tenant/neon';
import { ProvisionConflictError } from '@/lib/tenant/provision';
import { provisionWaitlistedSignup, waitlistEnvRefusal, WaitlistError, type WaitlistProvisionDeps } from '@/lib/tenant/waitlist';
import { SignupForm } from '@/app/signup/SignupForm';

const db = controlDb as unknown as FakeControlDb;
const ROOT = path.resolve(__dirname, '../..');

beforeEach(() => {
  db.reset();
  h.raised = [];
  h.resolved = [];
  h.order = [];
  h.tenant = { dbUrl: 'postgres://tenant' };
  vi.stubEnv('SIGNUP_CONTROLS_ENABLED', '');
  vi.stubEnv('NEON_API_KEY', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('signup cleanup (LB-D5)', () => {
  it('flag off → signups untouched', async () => {
    const r = await runSignupMaintenance(new Date());
    expect(r.cleanup).toBe('off');
    expect(db.deletes).toEqual([]);
  });

  it('flag on: unverified and verified-unprovisioned rows deleted; consumed rows by the S1 rule', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    db.onReturning('delete', signups, [{ id: 'u1' }, { id: 'u2' }]); // unverified
    const terms = { tVersion: '2026-10-21', tAccepted: new Date() };
    db.onSelect(signups, [
      { id: 'c1', slug: 'copied', email: 'a@x.dev', tId: 't1', tSignupEmail: 'a@x.dev', ...terms },          // own + Terms → delete
      { id: 'c2', slug: 'not-copied', email: 'b@x.dev', tId: 't2', tSignupEmail: 'b@x.dev', tVersion: null, tAccepted: null }, // own, no Terms → keep
      { id: 'c3', slug: 'taken', email: 'c@x.dev', tId: 't3', tSignupEmail: 'someone@else.dev', tVersion: null, tAccepted: null }, // other signer → delete
      { id: 'c4', slug: 'legacy', email: 'd@x.dev', tId: 't4', tSignupEmail: null, ...terms },               // NULL signup_email → keep
      { id: 'c5', slug: 'no-tenant', email: 'e@x.dev', tId: null, tSignupEmail: null, tVersion: null, tAccepted: null }, // no tenant → keep
    ]);
    db.onReturning('delete', signups, [{ id: 'v1' }]); // verified-unprovisioned
    const r = await runSignupMaintenance(new Date());
    expect(r.cleanup).toEqual({ unverifiedDeleted: 2, consumedDeleted: 2, consumedKept: ['not-copied', 'legacy', 'no-tenant'], verifiedUnprovisionedDeleted: 1 });
    expect(db.deletes).toHaveLength(4); // unverified, c1, c3, verified-unprovisioned
    expect(h.raised.map((a) => a.dedupKey)).toEqual(['not-copied', 'legacy', 'no-tenant']);
    // The alert for a slug is resolved once its row is deleted.
    expect(h.resolved.filter((a) => a.kind === 'signup-terms-not-copied').map((a) => a.dedupKey)).toEqual(['copied', 'taken']);
  });

  it('audit S1: consumedRowDecision', async () => {
    const { consumedRowDecision } = await import('@/lib/signup/maintenance');
    const withTerms = { termsVersion: 'v', termsAcceptedAt: new Date() };
    expect(consumedRowDecision('a@x.dev', { signupEmail: 'A@x.dev', ...withTerms })).toBe('delete');
    expect(consumedRowDecision('a@x.dev', { signupEmail: 'a@x.dev', termsVersion: 'v', termsAcceptedAt: null })).toBe('keep');
    expect(consumedRowDecision('a@x.dev', { signupEmail: 'other@x.dev', termsVersion: null, termsAcceptedAt: null })).toBe('delete');
    expect(consumedRowDecision('a@x.dev', { signupEmail: null, ...withTerms })).toBe('keep');
    expect(consumedRowDecision('a@x.dev', null)).toBe('keep');
  });

  it('audit S6: signup-cap-reached alerts of past UTC days are resolved (flag-independent)', async () => {
    const { opsAlerts } = await import('@/db/control-plane/schema');
    db.onReturning('update', opsAlerts, [{ id: 'a1' }, { id: 'a2' }]);
    const r = await runSignupMaintenance(new Date('2026-10-23T13:00:00Z'));
    expect(r.capAlertsResolved).toBe(2);
    expect(db.updates.find((u) => u.table === opsAlerts)?.set).toMatchObject({ resolutionNote: 'that UTC day is over' });
  });
});

describe('Neon project quota (LB-D2: alert at 80)', () => {
  function stubPages(pages: Array<{ count: number; cursor?: string } | 'fail'>) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const p = pages.shift()!;
      if (p === 'fail') return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ projects: Array.from({ length: p.count }, (_, i) => ({ id: `p${i}` })), pagination: p.cursor ? { cursor: p.cursor } : undefined }), { status: 200 });
    }));
    return urls;
  }

  it('paginates (limit 400 + cursor) and alerts at ≥ 80', async () => {
    vi.stubEnv('NEON_API_KEY', 'k');
    const urls = stubPages([{ count: 400, cursor: 'c-1' }, { count: 5, cursor: 'c-2' }]);
    expect((await runSignupMaintenance(new Date())).neonProjects).toBe(405);
    expect(urls[0]).toMatch(/limit=400/);
    expect(urls[1]).toMatch(/cursor=c-1/);
    expect(h.raised).toEqual([expect.objectContaining({ kind: 'neon-project-quota', detail: { projects: 405, threshold: 80 } })]);
    expect(h.resolved.map((a) => a.kind)).toEqual(['neon-project-quota-check-failed']);
  });

  it('below 80 → the quota alert resolves', async () => {
    vi.stubEnv('NEON_API_KEY', 'k');
    stubPages([{ count: 79 }]);
    await runSignupMaintenance(new Date());
    expect(h.raised).toEqual([]);
    expect(h.resolved.map((a) => a.kind)).toEqual(['neon-project-quota-check-failed', 'neon-project-quota']);
  });

  it('a list failure raises neon-project-quota-check-failed (occurrences track consecutive days)', async () => {
    vi.stubEnv('NEON_API_KEY', 'k');
    stubPages(['fail']);
    await runSignupMaintenance(new Date());
    expect(h.raised).toEqual([expect.objectContaining({ kind: 'neon-project-quota-check-failed' })]);
  });

  it('runs even when the lifecycle tenant loop stopped early, before the digest', async () => {
    vi.resetModules();
    vi.doMock('@/lib/cron/run-cron', () => ({ runCron: async (_r: unknown, _n: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()) }));
    vi.doMock('@/lib/tenant/lifecycle-runner', () => ({ runLifecycleCron: async () => ({ results: [], candidates: 3, incomplete: true }) }));
    vi.doMock('@/lib/signup/maintenance', () => ({ runSignupMaintenance: async () => { h.order.push('maintenance'); return {}; } }));
    vi.doMock('@/lib/tenant/ops-digest', () => ({ sendOpsDigest: async () => { h.order.push('digest'); return 'sent'; } }));
    vi.doMock('@/db/control-plane/locked', () => ({ withLockedPool: async () => [] }));
    const { GET } = await import('@/app/api/cron/tenant-lifecycle/route');
    const { NextRequest } = await import('next/server');
    const body = await (await GET(new NextRequest('https://cadenzpoint.com/api/cron/tenant-lifecycle'))).json();
    expect(body.incomplete).toBe(true);
    expect(h.order).toEqual(['maintenance', 'digest']);
    vi.doUnmock('@/lib/cron/run-cron');
    vi.doUnmock('@/lib/tenant/lifecycle-runner');
    vi.doUnmock('@/lib/signup/maintenance');
    vi.doUnmock('@/lib/tenant/ops-digest');
    vi.doUnmock('@/db/control-plane/locked');
    vi.resetModules();
  });
});

describe('notice-delivery cron', () => {
  it('nulls expired signup IP hashes and resolves signup signals every run (flag-independent)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/cron/run-cron', () => ({ runCron: async (_r: unknown, _n: string, work: () => Promise<Record<string, unknown>>) => Response.json(await work()) }));
    vi.doMock('@/lib/tenant/notices', () => ({ deliverPendingNotices: async () => ({ sent: 0 }) }));
    vi.doMock('@/lib/signup/signals', () => ({
      nullExpiredSignupIpHashes: async () => { h.order.push('null-ip-hashes'); return 4; },
      resolveSignupSignals: async () => { h.order.push('resolve-signals'); },
    }));
    const { GET } = await import('@/app/api/cron/notice-delivery/route');
    const { NextRequest } = await import('next/server');
    const body = await (await GET(new NextRequest('https://cadenzpoint.com/api/cron/notice-delivery'))).json();
    expect(h.order).toEqual(['null-ip-hashes', 'resolve-signals']);
    expect(body.ipHashesCleared).toBe(4);
    vi.doUnmock('@/lib/cron/run-cron');
    vi.doUnmock('@/lib/tenant/notices');
    vi.doUnmock('@/lib/signup/signals');
    vi.resetModules();
  });
});

describe('founder waitlist provisioning', () => {
  const REMOTE_CP = 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/control';
  const realEnv = { CONTROL_PLANE_DATABASE_URL: REMOTE_CP, APP_ROOT_DOMAIN: 'cadenzpoint.com', NEXT_PUBLIC_APP_URL: 'https://cadenzpoint.com' };

  it('refuses localhost app URLs against a non-loopback control plane', () => {
    expect(waitlistEnvRefusal({ ...realEnv, APP_ROOT_DOMAIN: 'localhost:3000' })).toMatch(/localhost/);
    expect(waitlistEnvRefusal({ ...realEnv, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })).not.toBeNull();
    expect(waitlistEnvRefusal({ CONTROL_PLANE_DATABASE_URL: REMOTE_CP })).not.toBeNull();
    expect(waitlistEnvRefusal(realEnv)).toBeNull();
    expect(waitlistEnvRefusal({ CONTROL_PLANE_DATABASE_URL: 'postgresql://localhost/bytime_control' })).toBeNull();
  });

  const waitlistedRow = (o: Record<string, unknown> = {}) => ({
    id: 's1', email: 'jane.doe@newco.com', slug: 'newco', companyName: 'NewCo', timezone: 'America/Chicago',
    termsVersion: '2026-10-21-draft-1', termsAcceptedAt: new Date('2026-10-21T10:00:00Z'),
    verifiedAt: new Date(), waitlistedAt: new Date(), consumedAt: null, provisionedAt: null, ...o,
  });
  const deps = (emailOk = true) => ({
    provision: vi.fn(async () => ({ slug: 'newco', adminUserId: 'u1' })),
    issueToken: vi.fn(async () => 'tok'),
    sendEmail: vi.fn(async () => (emailOk ? { ok: true as const, id: 'm' } : { ok: false as const, reason: 'error' as const })),
  });

  beforeEach(() => { for (const [k, v] of Object.entries(realEnv)) vi.stubEnv(k, v); });

  it('passes Terms version + time, timezone and adminName; marks consumed + provisioned; awaits the email', async () => {
    db.onSelect(signups, [waitlistedRow()]);
    const d = deps();
    const r = await provisionWaitlistedSignup('s1', d as unknown as WaitlistProvisionDeps);
    expect(d.provision).toHaveBeenCalledWith({
      slug: 'newco', name: 'NewCo', adminEmail: 'jane.doe@newco.com', adminName: 'jane.doe',
      timezone: 'America/Chicago', termsVersion: '2026-10-21-draft-1', termsAcceptedAt: new Date('2026-10-21T10:00:00Z'),
    });
    expect(Object.keys(db.updates.find((u) => u.table === signups)!.set).sort()).toEqual(['consumedAt', 'provisionedAt']);
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ emailed: true, setPasswordUrl: expect.stringContaining('/reset-password?token=tok') });
  });

  it('an email failure returns the link (the command prints it and exits non-zero)', async () => {
    db.onSelect(signups, [waitlistedRow()]);
    const r = await provisionWaitlistedSignup('s1', deps(false) as unknown as WaitlistProvisionDeps);
    expect(r.emailed).toBe(false);
    expect(r.setPasswordUrl).toContain('token=tok');
    const script = readFileSync(path.join(ROOT, '../scripts/tenant-admin.ts'), 'utf8');
    expect(script).toMatch(/if \(!r\.emailed\) \{[\s\S]*?r\.setPasswordUrl[\s\S]*?process\.exit\(1\)/);
  });

  it('refuses unverified, already-provisioned and non-waitlisted rows', async () => {
    for (const o of [{ verifiedAt: null }, { provisionedAt: new Date() }, { consumedAt: new Date() }, { waitlistedAt: null }]) {
      db.onSelect(signups, [waitlistedRow(o)]);
      const d = deps();
      await expect(provisionWaitlistedSignup('s1', d as unknown as WaitlistProvisionDeps)).rejects.toBeInstanceOf(WaitlistError);
      expect(d.provision).not.toHaveBeenCalled();
    }
  });

  it('audit S9: if the set-password token can’t be issued, the row is NOT marked provisioned and the recovery path is printed', async () => {
    db.onSelect(signups, [waitlistedRow()]);
    const d = deps();
    d.issueToken.mockRejectedValueOnce(new Error('tenant db unreachable'));
    await expect(provisionWaitlistedSignup('s1', d as unknown as WaitlistProvisionDeps))
      .rejects.toThrow(/could not be issued[\s\S]*waitlist provision s1 --yes[\s\S]*Forgot password" at https?:\/\/newco\.[^ ]+\/forgot-password/);
    expect(db.updates.filter((u) => u.table === signups)).toEqual([]);
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('a slug taken meanwhile is reported (ProvisionConflictError → WaitlistError)', async () => {
    db.onSelect(signups, [waitlistedRow()]);
    const d = deps();
    d.provision.mockRejectedValueOnce(new ProvisionConflictError('taken'));
    await expect(provisionWaitlistedSignup('s1', d as unknown as WaitlistProvisionDeps)).rejects.toThrow(/taken by someone else/);
  });
});

describe('createLocalDevDatabase', () => {
  it('refuses a non-loopback admin URL (covers every caller)', async () => {
    vi.stubEnv('DEV_TENANT_ADMIN_DATABASE_URL', 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/control');
    await expect(createNeonDatabase('newco')).rejects.toThrow(/non-loopback/);
  });
});

describe('client wiring of the flag', () => {
  const render = (el: ReactElement) => renderToStaticMarkup(<MantineProvider>{el}</MantineProvider>);

  it('flag off → no Turnstile widget (and so no Cloudflare script) on /signup', () => {
    expect(render(<SignupForm controls={null} />)).not.toContain('data-turnstile-widget');
  });

  it('flag on → the widget renders and "Create workspace" waits for a token', () => {
    const html = render(<SignupForm controls={{ turnstileSiteKey: '1x00000000000000000000AA' }} />);
    expect(html).toContain('data-turnstile-widget');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Create workspace/);
  });

  it('the server page reads the flag; the client only ever gets the public site key', async () => {
    vi.doMock('@/lib/tenant/context', () => ({ getTenantSlug: async () => '' }));
    const { default: SignupPage } = await import('@/app/signup/page');
    const off = (await SignupPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ controls: unknown }>;
    expect(off.props.controls).toBeNull();
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-key');
    const on = (await SignupPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ controls: unknown }>;
    expect(on.props.controls).toEqual({ turnstileSiteKey: 'site-key' });
    vi.doUnmock('@/lib/tenant/context');
  });

  it('audit S2: flag on in production with no public site key → the page raises signup-config-missing (after the response)', async () => {
    vi.resetModules();
    const raised: string[][] = [];
    vi.doMock('@/lib/tenant/context', () => ({ getTenantSlug: async () => '' }));
    vi.doMock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => { void fn(); } }));
    vi.doMock('@/lib/signup/signals', () => ({ raiseSignupConfigMissing: async (missing: string[]) => { raised.push(missing); } }));
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    vi.stubEnv('SIGNUP_IP_SALT', 'salt');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    const { default: SignupPage } = await import('@/app/signup/page');
    await SignupPage({ searchParams: Promise.resolve({}) });
    expect(raised).toEqual([['NEXT_PUBLIC_TURNSTILE_SITE_KEY']]);
    vi.doUnmock('@/lib/tenant/context');
    vi.doUnmock('next/server');
    vi.doUnmock('@/lib/signup/signals');
    vi.resetModules();
  });

  it('the Turnstile secret and the IP salt never appear in client code', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? (n === '__tests__' ? [] : files(p)) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const offenders = files(ROOT).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return (/^\s*['"]use client['"]/.test(src) && /TURNSTILE_SECRET_KEY|SIGNUP_IP_SALT/.test(src)) || /NEXT_PUBLIC_(TURNSTILE_SECRET|SIGNUP_IP_SALT)/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('CSP allows the Turnstile origin in script-src and frame-src (Cloudflare Turnstile CSP docs)', () => {
    const cfg = readFileSync(path.join(ROOT, '../next.config.ts'), 'utf8');
    expect(cfg).toMatch(/script-src.*https:\/\/challenges\.cloudflare\.com/);
    expect(cfg).toMatch(/frame-src.*https:\/\/challenges\.cloudflare\.com/);
  });
});
