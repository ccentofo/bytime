import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-upstash-rate-limiting.md T15 (§6.1): the real callers share one budget per limit (memory mode here,
 * with a fresh store per case). The signup availability check and the apex workspace finder share 30 per minute per IP;
 * startSignup and resendSignupVerification share 8 per hour per IP.
 */

const h = vi.hoisted(() => ({ ip: '203.0.113.40' }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/lib/signup/signals', () => ({ nullExpiredSignupIpHashes: async () => 0, raiseSignupConfigMissing: async () => {} }));
vi.mock('@/lib/email/schedule', () => ({ scheduleEmail: () => {} }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: async () => ({ ok: true, id: 'x' }) }));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async (slug: string) => ({ slug }) }));
vi.mock('@/server/internal/signup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/signup')>()),
  requireHumanSignup: async () => {},
  checkSlugAvailableInternal: async () => ({ available: true }),
  verifiedSignupsFromIp: async () => 0,
}));

import { NextRequest } from 'next/server';
import { GET as signupCheck } from '@/app/signup/check/route';
import { goToWorkspace } from '@/server/actions/workspace-finder';
import { startSignup, resendSignupVerification } from '@/server/actions/signup';
import { __resetForTests } from '@/lib/rate-limit/store';

const check = (i: number) => signupCheck(new NextRequest(`https://cadenzpoint.com/signup/check?slug=zz-${i}`, { headers: { 'x-forwarded-for': h.ip } }));
const find = () => goToWorkspace('acme', '/login');
const start = (i: number) => startSignup({ companyName: `Co ${i}`, email: `owner${i}@example.com`, slug: `co-${i}`, termsAccepted: true, turnstileToken: 't' });
const resend = (i: number) => resendSignupVerification({ email: `owner${i}@example.com`, slug: `co-${i}`, turnstileToken: 't' });

beforeEach(() => {
  __resetForTests();
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL']) vi.stubEnv(k, '');
  vi.stubEnv('APP_ROOT_DOMAIN', 'cadenzpoint.com');
  vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
  vi.stubEnv('SIGNUP_IP_SALT', 'test-salt');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('T15: shared budgets', () => {
  it('15 signup checks + 15 workspace-finder lookups use the whole slug-lookup budget; the 31st of either is refused', async () => {
    for (let i = 0; i < 15; i++) expect((await check(i)).status).toBe(200);
    for (let i = 0; i < 15; i++) expect(await find()).toMatchObject({ ok: true });
    expect((await check(99)).status).toBe(429);
    expect(await find()).toMatchObject({ ok: false, error: 'Too many attempts. Please wait a minute and try again.' });
  });

  it('another IP has its own budget', async () => {
    for (let i = 0; i < 30; i++) await check(i);
    expect((await check(99)).status).toBe(429);
    h.ip = '203.0.113.41';
    expect((await check(100)).status).toBe(200);
    h.ip = '203.0.113.40';
  });

  it('signup start and resend share 8 per IP: 4 + 4 pass, then both are refused', async () => {
    for (let i = 0; i < 4; i++) expect(await start(i)).toMatchObject({ ok: true });
    for (let i = 0; i < 4; i++) expect(await resend(i)).toMatchObject({ ok: true });
    expect(await start(8)).toMatchObject({ ok: false, error: 'Too many signup attempts. Please try again later.' });
    expect(await resend(8)).toMatchObject({ ok: false, error: 'Too many signup attempts. Please try again later.' });
  });
});
