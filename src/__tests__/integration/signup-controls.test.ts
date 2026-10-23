import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { eq, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ ip: '203.0.113.50', created: 0 }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })) }));
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: vi.fn(async () => ({ opened: true, emailed: false })) }));
// Never provision a real database here: provisioning is the existing, separately tested path.
vi.mock('@/lib/tenant/provision', () => ({ ProvisionConflictError: class extends Error {}, provisionTenant: vi.fn(async () => ({ slug: 'x', adminUserId: 'u' })) }));
vi.mock('@/server/internal/signup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/signup')>()),
  tenantsCreatedSince: async () => h.created, // the dev control plane's real tenant count is not ours to control
}));

import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { setTurnstileVerifierForTests } from '@/lib/turnstile';
import { hashSignupIp } from '@/lib/signup/controls';
import { nullExpiredSignupIpHashes } from '@/lib/signup/signals';
import { provisionTenant } from '@/lib/tenant/provision';
import { startSignup, resendSignupVerification } from '@/server/actions/signup';
import { GET, POST } from '@/app/signup/verify/route';
import { cpReady } from './lifecycle-helpers';

/**
 * feature-plan-launch-blockers.md P5 / §9 "Signup" + "Resend verification" (database semantics). Every row uses a
 * `test-lc-signup-*` slug and is removed afterwards; nothing else in the control plane is touched (the cleanup job's
 * deletion rules are unit-tested — running them here would delete the developer's own old signup rows).
 */

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const slugOf = (tag: string) => `test-lc-signup-${tag}-${crypto.randomBytes(3).toString('hex')}`;
const row = async (slug: string) => (await controlDb.select().from(signups).where(eq(signups.slug, slug)))[0];

async function insertSignup(o: Partial<typeof signups.$inferInsert> & { slug: string; token: string }) {
  const { token, ...rest } = o;
  const [r] = await controlDb.insert(signups).values({
    email: `${rest.slug}@test.dev`, companyName: 'Test Co', verifyTokenHash: sha(token),
    termsVersion: 'v-test', termsAcceptedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), ...rest,
  }).returning();
  return r;
}
const verifyPost = (token: string, email: string) => POST(new NextRequest('https://cadenzpoint.com/signup/verify', {
  method: 'POST', body: new URLSearchParams({ token, email }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
}));

describe.skipIf(!cpReady)('signup controls (P5)', () => {
  beforeEach(() => {
    h.ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    h.created = 0;
    vi.stubEnv('APP_ROOT_DOMAIN', 'cadenzpoint.com');
    setTurnstileVerifierForTests(async () => ({ success: true, hostname: 'cadenzpoint.com' }));
    vi.mocked(provisionTenant).mockClear();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    setTurnstileVerifierForTests(null);
    await controlDb.delete(signups).where(like(signups.slug, 'test-lc-signup-%'));
  });

  it('flag off → no ip_hash written', async () => {
    const slug = slugOf('off');
    expect(await startSignup({ companyName: 'Off Co', email: 'off@test.dev', slug, termsAccepted: true })).toEqual({ ok: true, data: { slug } });
    expect((await row(slug)).ipHash).toBeNull();
  });

  it('flag on → ip_hash is the salted hash; the raw IP is in no column', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    const slug = slugOf('on');
    expect((await startSignup({ companyName: 'On Co', email: 'on@test.dev', slug, termsAccepted: true, turnstileToken: 't' })).ok).toBe(true);
    const r = await row(slug);
    expect(r.ipHash).toBe(hashSignupIp(h.ip));
    expect(JSON.stringify(r)).not.toContain(h.ip);
  });

  it('IP hashes older than 24 h are nulled; newer ones kept', async () => {
    const old = await insertSignup({ slug: slugOf('old'), token: 'a', ipHash: 'f'.repeat(64), createdAt: new Date(Date.now() - 25 * 3_600_000) });
    const fresh = await insertSignup({ slug: slugOf('new'), token: 'b', ipHash: 'e'.repeat(64) });
    await nullExpiredSignupIpHashes();
    expect((await row(old.slug)).ipHash).toBeNull();
    expect((await row(fresh.slug)).ipHash).toBe('e'.repeat(64));
  });

  it('the 4th verify from one ip_hash in 24 h is refused even when all 4 were started at 0 verified; reopening does not move verified_at', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    const ipHash = crypto.randomBytes(32).toString('hex');
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await insertSignup({ slug: slugOf(`ip${i}`), token: `tok-${i}`, ipHash }));
    for (let i = 0; i < 3; i++) await verifyPost(`tok-${i}`, rows[i].email);
    expect(provisionTenant).toHaveBeenCalledTimes(3);
    const refused = await verifyPost('tok-3', rows[3].email);
    expect(decodeURIComponent(refused.headers.get('location') ?? '')).toMatch(/your network/);
    expect(provisionTenant).toHaveBeenCalledTimes(3);
    const first = await row(rows[3].slug);
    expect(first.verifiedAt).not.toBeNull();
    expect(first.consumedAt).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await verifyPost('tok-3', rows[3].email);
    expect((await row(rows[3].slug)).verifiedAt!.getTime()).toBe(first.verifiedAt!.getTime());
  });

  it('cap at verify → waitlisted (unconsumed); the link reopened later, under the cap and expired, still only shows the waitlist', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    h.created = 20;
    const s = await insertSignup({ slug: slugOf('cap'), token: 'cap-tok', ipHash: crypto.randomBytes(32).toString('hex') });
    expect(await (await verifyPost('cap-tok', s.email)).text()).toMatch(/setting up a lot of new workspaces today/);
    let r = await row(s.slug);
    expect(r.waitlistedAt).not.toBeNull();
    expect(r.consumedAt).toBeNull();

    h.created = 0;
    await controlDb.update(signups).set({ expiresAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(signups.id, s.id));
    expect(await (await verifyPost('cap-tok', s.email)).text()).toMatch(/setting up a lot of new workspaces today/);
    expect(provisionTenant).not.toHaveBeenCalled();
    r = await row(s.slug);
    expect(r.consumedAt).toBeNull();
  });

  it('resend on a waitlisted or verified row changes nothing and answers generically', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    const waitlisted = await insertSignup({ slug: slugOf('rs-wl'), token: 'wl-tok', verifiedAt: new Date(), waitlistedAt: new Date() });
    const verified = await insertSignup({ slug: slugOf('rs-v'), token: 'v-tok', verifiedAt: new Date() });
    for (const s of [waitlisted, verified]) {
      const r = await resendSignupVerification({ email: s.email, slug: s.slug, turnstileToken: 't' });
      expect(r).toEqual({ ok: true, data: { message: expect.stringMatching(/If that signup is waiting/) } });
      expect((await row(s.slug)).verifyTokenHash).toBe(s.verifyTokenHash);
    }
  });

  it('resend rotates the token: the old link is dead; expiry stays ≤ created + 24 h', async () => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    const s = await insertSignup({ slug: slugOf('resend'), token: 'old-tok' });
    expect(await resendSignupVerification({ email: s.email, slug: s.slug, turnstileToken: 't' })).toMatchObject({ ok: true });
    const r = await row(s.slug);
    expect(r.verifyTokenHash).not.toBe(sha('old-tok'));
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(r.createdAt.getTime() + 24 * 3_600_000);
    const res = await GET(new NextRequest(`https://cadenzpoint.com/signup/verify?token=old-tok&email=${encodeURIComponent(s.email)}`));
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toMatch(/invalid or already used/);
  });
});
