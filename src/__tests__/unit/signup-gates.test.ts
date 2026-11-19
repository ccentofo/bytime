import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * SWEEP-FINDINGS.md A1-G17: signup's gates.
 * - The Terms gate: anything but `termsAccepted === true` is refused before any other work (no limiter count, no row).
 * - An invalid workspace name is refused (the REAL checkSlugAvailableInternal → isValidSlug), with no row written.
 * - Resend acts only on a PENDING row: its lookup filters by email + slug and requires consumed, verified and waitlisted
 *   to be null, inside the 24 h life.
 */

const h = vi.hoisted(() => ({ ip: '203.0.113.60', selectWheres: [] as unknown[], selectRows: [] as unknown[][], inserts: [] as unknown[], consumes: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/db/control-plane', () => {
  const chain = (): Record<string, unknown> => {
    let rows: unknown[] = [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (w: unknown) => { h.selectWheres.push(w); rows = h.selectRows.shift() ?? []; return c; };
    c.orderBy = () => c;
    c.limit = () => c;
    c.then = (res: (v: unknown[]) => unknown) => Promise.resolve(rows).then(res);
    return c;
  };
  return {
    controlDb: {
      select: () => chain(),
      insert: () => ({ values: async (v: unknown) => { h.inserts.push(v); } }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    },
  };
});
vi.mock('@/lib/rate-limit/store', () => ({
  consume: async (name: string) => { h.consumes.push(name); return { allowed: true, retryAfterMs: 0, source: 'memory', resetAt: Date.now() + 1000 }; },
  refund: async () => {},
}));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async () => null }));
vi.mock('@/lib/tenant/window-slugs', () => ({ isOpenWindowSlug: async () => false }));
vi.mock('@/lib/email/schedule', () => ({ scheduleEmail: () => {} }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: async () => ({ ok: true, id: 'x' }) }));
vi.mock('@/lib/signup/signals', () => ({ nullExpiredSignupIpHashes: async () => 0, raiseSignupConfigMissing: async () => {} }));
vi.mock('@/server/internal/signup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/signup')>()), // the REAL checkSlugAvailableInternal
  requireHumanSignup: async () => {},
  verifiedSignupsFromIp: async () => 0,
}));

import { startSignup, resendSignupVerification } from '@/server/actions/signup';

beforeEach(() => {
  h.selectWheres = [];
  h.selectRows = [];
  h.inserts = [];
  h.consumes = [];
  vi.stubEnv('SIGNUP_CONTROLS_ENABLED', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const input = (o: Record<string, unknown> = {}) => ({ companyName: 'Acme Corp', email: 'founder@acme.com', slug: 'acme-test', termsAccepted: true, ...o });
const TERMS = 'You must agree to the Terms of Service and Privacy Policy.';

describe('A1-G17: the Terms gate', () => {
  it.each([[false], [undefined], ['true'], [1], [null]])('termsAccepted = %j → refused first: no limiter count, no lookup, no row', async (termsAccepted) => {
    expect(await startSignup(input({ termsAccepted }) as never)).toEqual({ ok: false, error: TERMS, code: 'validation' });
    expect(h.consumes).toEqual([]);
    expect(h.selectWheres).toEqual([]);
    expect(h.inserts).toEqual([]);
  });

  it('true → a pending signup row is written (control)', async () => {
    expect(await startSignup(input())).toEqual({ ok: true, data: { slug: 'acme-test' } });
    expect(h.inserts).toHaveLength(1);
  });
});

describe('A1-G17: an invalid workspace name is refused', () => {
  it.each([['a.b'], ['Acme'], ['café'], ['x'.repeat(64)], ['-acme'], ['www']])('slug %j → "not allowed", nothing written', async (slug) => {
    expect(await startSignup(input({ slug }))).toEqual({ ok: false, error: 'That workspace name is not allowed. Use letters, numbers, and hyphens.', code: 'validation' });
    expect(h.inserts).toEqual([]);
  });
});

describe('A1-G17: resend only for pending rows', () => {
  beforeEach(() => { vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true'); });

  it('the lookup binds the email and slug and requires consumed, verified and waitlisted to be null, within 24 h', async () => {
    await resendSignupVerification({ email: ' Founder@Acme.com ', slug: 'acme-test', turnstileToken: 't' });
    expect(h.selectWheres).toHaveLength(1);
    const q = new PgDialect().sqlToQuery(h.selectWheres[0] as SQL);
    expect(q.sql).toBe(
      '("signups"."email" = $1 and "signups"."slug" = $2 and "signups"."consumed_at" is null and "signups"."verified_at" is null '
      + 'and "signups"."waitlisted_at" is null and "signups"."created_at" > $3)',
    );
    expect(q.params.slice(0, 2)).toEqual(['founder@acme.com', 'acme-test']);
    const ageMs = Date.now() - new Date(q.params[2] as string).getTime();
    expect(ageMs).toBeGreaterThan(24 * 3_600_000 - 5_000);
    expect(ageMs).toBeLessThan(24 * 3_600_000 + 5_000);
  });
});
