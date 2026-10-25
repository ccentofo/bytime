import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { and, eq, inArray, like } from 'drizzle-orm';

const h = vi.hoisted(() => ({ ip: '203.0.113.90', alerts: [] as Array<{ kind: string }> }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })) }));
vi.mock('@/lib/tenant/ops-alert-email', () => ({
  raiseAlertWithEmail: vi.fn(async (a: { kind: string }) => { h.alerts.push(a); return { opened: true, emailed: false }; }),
}));

import { controlDb } from '@/db/control-plane';
import { opsAlerts, signalCounters, signups } from '@/db/control-plane/schema';
import { withLockedPool } from '@/db/control-plane/locked';
import { raiseAlert } from '@/lib/tenant/lifecycle-store';
import { setTurnstileVerifierForTests } from '@/lib/turnstile';
import { runSignupMaintenance } from '@/lib/signup/maintenance';
import { recordWindowedSignalForTests, resolveSignupSignals } from '@/lib/signup/signals';
import { sendSignupVerifyEmail } from '@/lib/email/send-signup';
import { startSignup, resendSignupVerification } from '@/server/actions/signup';
import { tenantsCreatedSince } from '@/server/internal/signup';
import { flushAfter } from './helpers';
import { cpReady, cleanupLifecycleTenants, makeTenant } from './lifecycle-helpers';

/**
 * Launch-blockers audit S4 (with S1, S6, S7): the destructive signup cleanup against real Postgres — the 7 d / 30 d /
 * 30 d windows, `isNull(consumedAt)` on the unverified step, and the S1 consumed-row rule (tenant matched on slug only)
 * — plus the outage window logic, the daily-cap count, resend for consumed / > 24 h rows, signup-config-missing
 * resolution and startSignup's opportunistic ip_hash nulling.
 *
 * Scope (audit R6): the signups cleanup steps run with an id filter over ONLY the rows this test inserted (the
 * integration control plane can be the developer's own), the window logic uses a unique test key, and every alert /
 * tenant / row this test creates is removed. Some steps are NOT scoped and act on the whole control plane, exactly as
 * production does: runSignupMaintenance resolves EVERY past-UTC-day `signup-cap-reached` alert; resolveSignupSignals
 * resolves every quiet signup signal alert (outage, hostname mismatch, secret rejected) and `signup-config-missing`;
 * startSignup nulls EVERY signups.ip_hash older than 24 h.
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const tag = () => crypto.randomBytes(3).toString('hex');

describe.skipIf(!cpReady)('signup cleanup and signals (audit S4)', () => {
  const insertedIds: string[] = [];
  const testSlugs: string[] = [];

  async function signup(o: Partial<typeof signups.$inferInsert> & { slug?: string; token?: string }) {
    const slug = o.slug ?? `test-lc-signup-${tag()}`;
    testSlugs.push(slug);
    const { token, ...rest } = o;
    const [row] = await controlDb.insert(signups).values({
      email: `${slug}@test.dev`, companyName: 'Cleanup Co', verifyTokenHash: sha(token ?? tag()),
      termsVersion: 'v-test', termsAcceptedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
      ...rest, slug,
    }).returning();
    insertedIds.push(row.id);
    return row;
  }
  const exists = async (id: string) => (await controlDb.select({ id: signups.id }).from(signups).where(eq(signups.id, id))).length === 1;

  beforeEach(() => {
    vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true');
    vi.stubEnv('APP_ROOT_DOMAIN', 'cadenzpoint.com');
    h.ip = `203.0.113.${Math.floor(Math.random() * 150) + 50}`;
    h.alerts = [];
    setTurnstileVerifierForTests(async () => ({ success: true, hostname: 'cadenzpoint.com' }));
    vi.mocked(sendSignupVerifyEmail).mockClear();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    setTurnstileVerifierForTests(null);
    if (insertedIds.length) await controlDb.delete(signups).where(inArray(signups.id, insertedIds.splice(0)));
    await controlDb.delete(signups).where(like(signups.slug, 'test-lc-signup-%'));
    if (testSlugs.length) {
      await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.kind, 'signup-terms-not-copied'), inArray(opsAlerts.dedupKey, testSlugs.splice(0))));
    }
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.kind, 'signup-cap-reached'), like(opsAlerts.dedupKey, '%-s4test')));
    await controlDb.delete(signalCounters).where(like(signalCounters.key, 's4-test-signal-%'));
    await cleanupLifecycleTenants();
  });

  it('windows, isNull(consumedAt) on the unverified step, and the S1 consumed-row rule', async () => {
    const terms = { termsVersion: 'v1', termsAcceptedAt: ago(40) };
    const own = await makeTenant({ signupEmail: 'own@test.dev', ...terms });
    const ownNoTerms = await makeTenant({ signupEmail: 'noterms@test.dev', termsVersion: null, termsAcceptedAt: null });
    const someoneElses = await makeTenant({ signupEmail: 'other@test.dev', ...terms });
    const legacy = await makeTenant({ signupEmail: null, ...terms });
    testSlugs.push(own.slug, ownNoTerms.slug, someoneElses.slug, legacy.slug);

    const rows = {
      unverifiedOld: await signup({ createdAt: ago(8) }),
      unverifiedNew: await signup({ createdAt: ago(6) }),
      unverifiedButConsumed: await signup({ createdAt: ago(8), consumedAt: ago(8) }),        // not the unverified step's
      consumedOwnTerms: await signup({ slug: own.slug, email: 'own@test.dev', consumedAt: ago(31) }),
      consumedOwnNoTerms: await signup({ slug: ownNoTerms.slug, email: 'noterms@test.dev', consumedAt: ago(31) }),
      consumedOtherSigner: await signup({ slug: someoneElses.slug, email: 'loser@test.dev', consumedAt: ago(31) }),
      consumedLegacy: await signup({ slug: legacy.slug, email: 'legacy@test.dev', consumedAt: ago(31) }),
      consumedNoTenant: await signup({ consumedAt: ago(31) }),
      // R5: this row provisioned the workspace (provisioned_at) but the tenant names another signer → kept, not deleted.
      consumedProvisionedMismatch: await signup({ slug: someoneElses.slug, email: 'founder@test.dev', consumedAt: ago(31), provisionedAt: ago(31) }),
      consumedRecent: await signup({ slug: own.slug, email: 'own@test.dev', consumedAt: ago(29) }),
      verifiedOld: await signup({ verifiedAt: ago(31), createdAt: ago(31) }),
      verifiedNew: await signup({ verifiedAt: ago(29), createdAt: ago(29) }),
    };
    // A lingering alert for the own-tenant slug must be resolved once that row is deleted (S1).
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'signup-terms-not-copied', dedupKey: own.slug }, new Date()));

    await runSignupMaintenance(new Date(), { signupFilter: inArray(signups.id, Object.values(rows).map((r) => r.id)) });

    const survivors = Object.fromEntries(await Promise.all(Object.entries(rows).map(async ([k, r]) => [k, await exists(r.id)])));
    expect(survivors).toEqual({
      unverifiedOld: false,
      unverifiedNew: true,
      unverifiedButConsumed: true,
      consumedOwnTerms: false,
      consumedOwnNoTerms: true,
      consumedOtherSigner: false,
      consumedLegacy: true,
      consumedNoTenant: true,
      consumedProvisionedMismatch: true,
      consumedRecent: true,
      verifiedOld: false,
      verifiedNew: true,
    });
    const openFor = async (slug: string) => (await controlDb.select().from(opsAlerts)
      .where(and(eq(opsAlerts.kind, 'signup-terms-not-copied'), eq(opsAlerts.dedupKey, slug)))).filter((a) => !a.resolvedAt).length;
    expect(await openFor(ownNoTerms.slug)).toBe(1);
    expect(await openFor(legacy.slug)).toBe(1);
    expect(await openFor(rows.consumedNoTenant.slug)).toBe(1);
    expect(await openFor(someoneElses.slug)).toBe(1); // R5: the kept provisioning row's alert (raised after the loser's delete)
    expect(await openFor(own.slug)).toBe(0); // resolved when its row was deleted
  });

  it('S6: signup-cap-reached alerts of past UTC days resolve; today’s stays open', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await withLockedPool(async (db) => {
      await raiseAlert(db, { tenantId: null, kind: 'signup-cap-reached', dedupKey: '2000-01-01-s4test' }, new Date());
      await raiseAlert(db, { tenantId: null, kind: 'signup-cap-reached', dedupKey: `${today}-s4test` }, new Date());
    });
    await runSignupMaintenance(new Date(), { signupFilter: inArray(signups.id, ['00000000-0000-0000-0000-000000000000']) });
    const rows = await controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.kind, 'signup-cap-reached'), like(opsAlerts.dedupKey, '%-s4test')));
    expect(rows.find((r) => r.dedupKey === '2000-01-01-s4test')?.resolvedAt).not.toBeNull();
    expect(rows.find((r) => r.dedupKey === `${today}-s4test`)?.resolvedAt).toBeNull();
  });

  it('outage window logic: counts within the hour, resets after it', async () => {
    const key = `s4-test-signal-${tag()}`;
    const t0 = new Date('2026-01-01T12:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(await recordWindowedSignalForTests(key, at(0))).toBe(1);
    expect(await recordWindowedSignalForTests(key, at(10))).toBe(2);
    expect(await recordWindowedSignalForTests(key, at(59))).toBe(3);
    expect(await recordWindowedSignalForTests(key, at(61 + 59))).toBe(1); // window started at t0: stale after an hour
  });

  it('daily-cap count: tenants created in the last 24 h, any status', async () => {
    const since = new Date(Date.now() - DAY);
    const before = await tenantsCreatedSince(since);
    await makeTenant({ status: 'provisioning' });
    await makeTenant({ createdAt: ago(2) });
    expect(await tenantsCreatedSince(since)).toBe(before + 1);
  });

  it('S7: resend for a consumed or > 24 h old row changes nothing and sends nothing', async () => {
    const consumed = await signup({ consumedAt: new Date(), token: 'c-tok' });
    const stale = await signup({ createdAt: new Date(Date.now() - 25 * 3_600_000), token: 's-tok' });
    for (const row of [consumed, stale]) {
      expect(await resendSignupVerification({ email: row.email, slug: row.slug, turnstileToken: 't' })).toMatchObject({ ok: true });
      const [after] = await controlDb.select().from(signups).where(eq(signups.id, row.id));
      expect(after.verifyTokenHash).toBe(row.verifyTokenHash);
    }
    await flushAfter();
    expect(sendSignupVerifyEmail).not.toHaveBeenCalled();
  });

  it('signup-config-missing resolves once the required env is present', async () => {
    await withLockedPool((db) => raiseAlert(db, { tenantId: null, kind: 'signup-config-missing' }, new Date()));
    await resolveSignupSignals(new Date()); // NODE_ENV=test: nothing is required → configuration present
    const open = (await controlDb.select().from(opsAlerts).where(eq(opsAlerts.kind, 'signup-config-missing'))).filter((a) => !a.resolvedAt);
    expect(open).toEqual([]);
  });

  it('startSignup opportunistically nulls IP hashes older than 24 h', async () => {
    const old = await signup({ ipHash: 'f'.repeat(64), createdAt: new Date(Date.now() - 25 * 3_600_000) });
    const slug = `test-lc-signup-${tag()}`;
    testSlugs.push(slug);
    expect((await startSignup({ companyName: 'Fresh Co', email: `${slug}@test.dev`, slug, termsAccepted: true, turnstileToken: 't' })).ok).toBe(true);
    const [row] = await controlDb.select().from(signups).where(eq(signups.id, old.id));
    expect(row.ipHash).toBeNull();
  });
});
