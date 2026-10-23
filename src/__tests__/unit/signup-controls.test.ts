import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

/**
 * feature-plan-launch-blockers.md P5 / §9 "Signup", "Resend verification": the SIGNUP_CONTROLS_ENABLED flag, IP
 * hashing (/64, salt, never raw), Turnstile classification and the outage alert, startSignup's order and the generic
 * resend. Control-plane writes are recorded by a fake client; DB semantics are in integration/signup-controls.test.ts.
 */

const h = vi.hoisted(() => ({
  ip: '203.0.113.7',
  alerts: [] as Array<Record<string, unknown>>,
  resolved: [] as Array<Record<string, unknown>>,
  scheduled: [] as string[],
  slugTaken: false,
  verifiedFromIp: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/db/control-plane/locked', async () => {
  const { controlDb } = await import('@/db/control-plane');
  return { withLockedPool: async (fn: (db: unknown) => unknown) => fn(controlDb) };
});
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: async (a: Record<string, unknown>) => { h.alerts.push(a); return { opened: true, emailed: true }; } }));
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  resolveAlert: async (_db: unknown, a: Record<string, unknown>) => { h.resolved.push(a); },
  raiseAlert: async () => ({ opened: true }),
}));
vi.mock('@/lib/email/schedule', () => ({ scheduleEmail: (label: string) => { h.scheduled.push(label); } }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: async () => ({ ok: true, id: 'x' }) }));
vi.mock('@/server/internal/signup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/signup')>()),
  checkSlugAvailableInternal: async () => (h.slugTaken ? { available: false, reason: 'taken' } : { available: true }),
  verifiedSignupsFromIp: async () => h.verifiedFromIp,
}));

import { controlDb } from '@/db/control-plane';
import { signalCounters, signups } from '@/db/control-plane/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { hashSignupIp, signupIpKey, SignupConfigError, VERIFICATION_FAILED, RESEND_GENERIC_RESPONSE } from '@/lib/signup/controls';
import { verifyTurnstile, setTurnstileVerifierForTests, type SiteverifyResponse } from '@/lib/turnstile';
import { recordTurnstileOutageSignal, resolveSignupSignals } from '@/lib/signup/signals';
import { startSignup, resendSignupVerification } from '@/server/actions/signup';

const db = controlDb as unknown as FakeControlDb;
const REAL_SECRET = '0x4AAAAAAA-real-looking-secret';
let ipSeq = 0;

function setVerifier(resp: SiteverifyResponse | 'throw') {
  const calls: Array<{ response: string; remoteip?: string; idempotencyKey: string }> = [];
  setTurnstileVerifierForTests(async (p) => {
    calls.push(p);
    if (resp === 'throw') throw new Error('network');
    return resp;
  });
  return calls;
}

beforeEach(() => {
  db.reset();
  h.alerts = [];
  h.resolved = [];
  h.scheduled = [];
  h.slugTaken = false;
  h.verifiedFromIp = 0;
  h.ip = `198.51.100.${(ipSeq++ % 250) + 1}`; // a fresh in-memory limiter bucket per test
  vi.stubEnv('APP_ROOT_DOMAIN', 'cadenzpoint.com');
  vi.stubEnv('SIGNUP_CONTROLS_ENABLED', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', REAL_SECRET);
  vi.stubEnv('SIGNUP_IP_SALT', 'test-salt');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setTurnstileVerifierForTests(null);
});

const signupInput = (o: Record<string, unknown> = {}) => ({
  companyName: 'Acme Corp', email: 'Founder@Acme.com', slug: 'acme-test', termsAccepted: true, turnstileToken: 'tok', ...o,
});

describe('IP hashing', () => {
  it('IPv6 addresses in one /64 share a hash; another /64 does not', () => {
    const a = hashSignupIp('2001:db8:abcd:12::1');
    expect(hashSignupIp('2001:0db8:abcd:0012:ffff:1:2:3')).toBe(a);
    expect(hashSignupIp('2001:db8:abcd:13::1')).not.toBe(a);
    expect(signupIpKey('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(signupIpKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
  });

  it('is sha256(salt + ip) — never the raw IP', () => {
    const hash = hashSignupIp('203.0.113.7')!;
    expect(hash).toBe(crypto.createHash('sha256').update('test-salt203.0.113.7').digest('hex'));
    expect(hash).not.toContain('203.0.113.7');
  });

  it("'unknown' IP: refused (null) in production, hashed in dev", () => {
    expect(hashSignupIp('unknown')).not.toBeNull();
    vi.stubEnv('NODE_ENV', 'production');
    expect(hashSignupIp('unknown')).toBeNull();
  });

  it('missing salt in production → SignupConfigError (dev has a default)', () => {
    vi.stubEnv('SIGNUP_IP_SALT', '');
    expect(hashSignupIp('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => hashSignupIp('203.0.113.7')).toThrow(SignupConfigError);
  });
});

describe('Turnstile verification', () => {
  it('pass / fail / spent token keys', async () => {
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await verifyTurnstile('t')).toEqual({ ok: true });
    setVerifier({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'user' });
    setVerifier({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'user' });
  });

  it('sends remoteip and an idempotency key', async () => {
    const calls = setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    await verifyTurnstile('tok', { remoteip: '203.0.113.7' });
    expect(calls[0]).toMatchObject({ response: 'tok', remoteip: '203.0.113.7' });
    expect(calls[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a hostname other than the apex is refused', async () => {
    setVerifier({ success: true, hostname: 'evil.example' });
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'hostname' });
  });

  it('network error and internal-error are outages; missing secret in production is config', async () => {
    setVerifier('throw');
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'outage' });
    setVerifier({ success: false, 'error-codes': ['internal-error'] });
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'outage' });
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(await verifyTurnstile('t')).toMatchObject({ ok: false, kind: 'config' });
  });
});

describe('Turnstile outage alert', () => {
  it('3 outage signals within the window raise turnstile-outage (immediate email); 2 do not', async () => {
    db.onReturning('insert', signalCounters, [{ count: 2 }]);
    expect(await recordTurnstileOutageSignal()).toBe(2);
    expect(h.alerts).toEqual([]);
    db.onReturning('insert', signalCounters, [{ count: 3 }]);
    await recordTurnstileOutageSignal();
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'turnstile-outage' })]);
  });

  it('resolves after an hour without an outage signal (not before); config-missing resolves once env is present', async () => {
    const now = new Date('2026-10-22T12:00:00Z');
    db.onSelect(signalCounters, [{ at: new Date(now.getTime() - 30 * 60_000) }]);
    await resolveSignupSignals(now);
    expect(h.resolved.map((a) => a.kind)).toEqual(['signup-config-missing']); // flag off → config not required
    h.resolved = [];
    db.onSelect(signalCounters, [{ at: new Date(now.getTime() - 61 * 60_000) }]);
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIGNUP_IP_SALT', '');
    await resolveSignupSignals(now);
    expect(h.resolved.map((a) => a.kind)).toEqual(['turnstile-outage']); // salt still missing → config alert stays
  });
});

describe('startSignup — flag off (exactly as before)', () => {
  it('no Turnstile call, no ip_hash written, returns the slug', async () => {
    const calls = setVerifier({ success: false, 'error-codes': ['invalid-input-response'] });
    const r = await startSignup(signupInput({ turnstileToken: undefined }));
    expect(r).toEqual({ ok: true, data: { slug: 'acme-test' } });
    expect(calls).toEqual([]);
    expect(db.inserts.find((i) => i.table === signups)!.values.ipHash).toBeNull();
  });

  it('companyName length is not newly capped when the flag is off', async () => {
    expect((await startSignup(signupInput({ companyName: 'x'.repeat(150) }))).ok).toBe(true);
  });
});

describe('startSignup — flag on', () => {
  beforeEach(() => { vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true'); });

  it('Turnstile failure → generic refusal, nothing stored; user errors never count as outages', async () => {
    setVerifier({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await startSignup(signupInput())).toEqual({ ok: false, code: 'validation', error: VERIFICATION_FAILED });
    expect(db.inserts).toEqual([]); // no signup row AND no signal_counters write (user errors never count as outages)
    expect(h.alerts).toEqual([]);
  });

  it('an outage-class failure IS counted toward the turnstile-outage window', async () => {
    setVerifier({ success: false, 'error-codes': ['internal-error'] });
    expect(await startSignup(signupInput())).toEqual({ ok: false, code: 'validation', error: VERIFICATION_FAILED });
    expect(db.inserts.filter((i) => i.table === signalCounters).length).toBeGreaterThan(0);
    expect(db.inserts.filter((i) => i.table === signups)).toEqual([]);
  });

  it('pass → row stored with the IP HASH (raw IP never stored), email scheduled', async () => {
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    const r = await startSignup(signupInput());
    expect(r).toEqual({ ok: true, data: { slug: 'acme-test' } });
    const row = db.inserts.find((i) => i.table === signups)!.values;
    expect(row.ipHash).toBe(hashSignupIp(h.ip));
    expect(JSON.stringify(db.inserts.map((i) => i.values))).not.toContain(h.ip);
    expect(h.scheduled).toEqual(['signup-verify']);
  });

  it('companyName > 120 refused (before Turnstile)', async () => {
    const calls = setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await startSignup(signupInput({ companyName: 'x'.repeat(121) }))).toMatchObject({ ok: false, error: expect.stringMatching(/120/) });
    expect(calls).toEqual([]);
  });

  it("'unknown' IP in production → refused", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    h.ip = 'unknown';
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await startSignup(signupInput())).toEqual({ ok: false, code: 'validation', error: VERIFICATION_FAILED });
    expect(db.inserts.filter((i) => i.table === signups)).toEqual([]);
  });

  it('missing secret / salt in production → refused + signup-config-missing alert', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIGNUP_IP_SALT', '');
    const calls = setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await startSignup(signupInput())).toEqual({ ok: false, code: 'validation', error: VERIFICATION_FAILED });
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'signup-config-missing', detail: { missing: ['SIGNUP_IP_SALT'] } })]);
    expect(calls).toEqual([]);
  });

  it('per-IP limit: 3 verified workspaces from this IP hash in 24 h → refused', async () => {
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    h.verifiedFromIp = 3;
    expect(await startSignup(signupInput())).toMatchObject({ ok: false, error: expect.stringMatching(/your network/) });
    expect(db.inserts.filter((i) => i.table === signups)).toEqual([]);
  });

  it('a second submit after "name taken" succeeds with a fresh token', async () => {
    const calls = setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    h.slugTaken = true;
    expect(await startSignup(signupInput({ turnstileToken: 'tok-1' }))).toMatchObject({ ok: false, error: expect.stringMatching(/taken/) });
    h.slugTaken = false;
    expect(await startSignup(signupInput({ slug: 'acme-two', turnstileToken: 'tok-2' }))).toEqual({ ok: true, data: { slug: 'acme-two' } });
    expect(calls.map((c) => c.response)).toEqual(['tok-1', 'tok-2']);
  });
});

describe('resendSignupVerification', () => {
  beforeEach(() => { vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true'); });

  it('requires a fresh Turnstile pass', async () => {
    setVerifier({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await resendSignupVerification({ email: 'a@acme.com', slug: 'acme', turnstileToken: 't' })).toEqual({ ok: false, code: 'validation', error: VERIFICATION_FAILED });
    expect(h.scheduled).toEqual([]);
  });

  it('no pending row (waitlisted / verified / unknown) → the same generic answer, nothing sent', async () => {
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await resendSignupVerification({ email: 'nobody@acme.com', slug: 'acme', turnstileToken: 't' })).toEqual({ ok: true, data: { message: RESEND_GENERIC_RESPONSE } });
    expect(h.scheduled).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('a pending row: token rotated (old link dies), expiry never beyond created + 24 h, email re-sent, generic answer', async () => {
    setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    const createdAt = new Date(Date.now() - 2 * 3_600_000);
    db.onSelect(signups, [{ id: 's1', email: 'a@acme.com', slug: 'acme', companyName: 'Acme', createdAt, verifyTokenHash: 'old' }]);
    expect(await resendSignupVerification({ email: 'a@acme.com', slug: 'acme', turnstileToken: 't' })).toEqual({ ok: true, data: { message: RESEND_GENERIC_RESPONSE } });
    const set = db.updates.find((u) => u.table === signups)!.set as { verifyTokenHash: string; expiresAt: Date };
    expect(set.verifyTokenHash).not.toBe('old');
    expect(set.expiresAt.getTime()).toBeLessThanOrEqual(createdAt.getTime() + 24 * 3_600_000);
    expect(h.scheduled).toEqual(['signup-verify']);
    expect(db.updates.some((u) => 'ipHash' in u.set || 'verifiedAt' in u.set)).toBe(false); // not counted toward the IP limit
  });

  it('flag off → no resend action (generic, nothing happens)', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', '');
    const calls = setVerifier({ success: true, hostname: 'cadenzpoint.com' });
    expect(await resendSignupVerification({ email: 'a@acme.com', slug: 'acme' })).toEqual({ ok: true, data: { message: RESEND_GENERIC_RESPONSE } });
    expect(calls).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });
});
