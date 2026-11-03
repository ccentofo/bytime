import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { NextRequest } from 'next/server';

/**
 * feature-plan-launch-blockers.md P5 / §9 "Signup": the verify route. GET writes nothing; a waitlisted link always
 * shows the waitlist message and never provisions; with the flag on, POST runs resume → IP hash / per-IP limit → slug
 * → cap → provision, in that order. DB semantics (coalesce, counts) are in integration/signup-controls.test.ts.
 */

const h = vi.hoisted(() => ({
  tenant: null as null | { status: string; dbUrl: string },
  created: 0,
  fromIp: 0,
  alerts: [] as Array<Record<string, unknown>>,
  provision: vi.fn(async (input: Record<string, unknown>) => { void input; return { slug: 'newco', adminUserId: 'u1' }; }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', async () => ({ controlDb: (await import('../helpers/fake-control-db')).createFakeControlDb() }));
vi.mock('@/lib/tenant/provision', () => ({ ProvisionConflictError: class extends Error {}, provisionTenant: h.provision }));
vi.mock('@/lib/tenant/invite', () => ({ issueSetPasswordToken: async () => 'set-token' }));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async () => h.tenant }));
vi.mock('@/lib/tenant/ops-alert-email', () => ({ raiseAlertWithEmail: async (a: Record<string, unknown>) => { h.alerts.push(a); return { opened: true, emailed: true }; } }));
vi.mock('@/server/internal/signup', () => ({ tenantsCreatedSince: async () => h.created, verifiedSignupsFromIp: async () => h.fromIp }));

import { controlDb } from '@/db/control-plane';
import { signups, tenants } from '@/db/control-plane/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { GET, POST } from '@/app/signup/verify/route';

const db = controlDb as unknown as FakeControlDb;
const TOKEN = 'raw-token';
const EMAIL = 'founder@newco.com';
const LB_D2 = "We're setting up a lot of new workspaces today. Leave your email and we'll have yours ready within one business day.";

function signupRow(o: Record<string, unknown> = {}) {
  return {
    id: 's1', email: EMAIL, slug: 'newco', companyName: 'NewCo', timezone: null, termsVersion: 'v1', termsAcceptedAt: new Date(),
    verifyTokenHash: crypto.createHash('sha256').update(TOKEN).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000),
    consumedAt: null, createdAt: new Date(), ipHash: 'hash-1', verifiedAt: null, waitlistedAt: null, provisionedAt: null, ...o,
  };
}
const get = () => GET(new NextRequest(`https://cadenzpoint.com/signup/verify?token=${TOKEN}&email=${encodeURIComponent(EMAIL)}`));
const post = () => POST(new NextRequest('https://cadenzpoint.com/signup/verify', {
  method: 'POST', body: new URLSearchParams({ token: TOKEN, email: EMAIL }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
}));
const updatedKeys = () => db.updates.filter((u) => u.table === signups).flatMap((u) => Object.keys(u.set));
const location = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');

beforeEach(() => {
  db.reset();
  h.tenant = null;
  h.created = 0;
  h.fromIp = 0;
  h.alerts = [];
  h.provision.mockClear();
  // Provisioning creates the tenant the route then looks up to mint the set-password link.
  h.provision.mockImplementation(async () => { h.tenant = { status: 'active', dbUrl: 'x' }; return { slug: 'newco', adminUserId: 'u1' }; });
  vi.stubEnv('APP_ROOT_DOMAIN', 'cadenzpoint.com');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://cadenzpoint.com');
  vi.stubEnv('SIGNUP_CONTROLS_ENABLED', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('verify GET writes nothing', () => {
  it('a normal link renders the confirm page, no writes', async () => {
    db.onSelect(signups, [signupRow()]);
    const res = await get();
    expect(await res.text()).toContain('Confirm and create workspace');
    expect(db.updates).toEqual([]);
  });

  it('a waitlisted link (even expired) shows the waitlist message, no writes', async () => {
    db.onSelect(signups, [signupRow({ waitlistedAt: new Date(), verifiedAt: new Date(), expiresAt: new Date(Date.now() - 25 * 3_600_000) })]);
    const res = await get();
    expect(await res.text()).toContain(LB_D2);
    expect(db.updates).toEqual([]);
  });

  it('an expired, non-waitlisted link → the expired message', async () => {
    db.onSelect(signups, [signupRow({ expiresAt: new Date(Date.now() - 1000) })]);
    expect(location(await get())).toMatch(/expired/);
  });
});

describe('verify POST — waitlisted links never provision', () => {
  for (const flag of ['', 'true']) {
    it(`reopened after 25 h and under the cap (flag ${flag ? 'on' : 'off'}) → waitlist message, no provisioning`, async () => {
      vi.stubEnv('SIGNUP_CONTROLS_ENABLED', flag);
      db.onSelect(signups, [signupRow({ waitlistedAt: new Date(), verifiedAt: new Date(), expiresAt: new Date(Date.now() - 1000) })]);
      const res = await post();
      expect(await res.text()).toContain(LB_D2);
      expect(h.provision).not.toHaveBeenCalled();
      expect(db.updates).toEqual([]);
    });
  }
});

describe('verify POST — flag off (as before)', () => {
  it('provisions without writing verified_at or checking the cap', async () => {
    h.created = 999;
    db.onSelect(signups, [signupRow({ ipHash: null })]);
    const res = await post();
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(updatedKeys()).toEqual(['consumedAt', 'provisionedAt']); // audit S1: provisioned_at on the success path
    expect(location(res)).toContain('/reset-password?token=set-token');
  });
});

describe('verify POST — flag on', () => {
  beforeEach(() => { vi.stubEnv('SIGNUP_CONTROLS_ENABLED', 'true'); });

  it('sets verified_at (once, via coalesce) then provisions under the cap', async () => {
    db.onSelect(signups, [signupRow()]);
    await post();
    const first = db.updates.find((u) => u.table === signups)!;
    expect(Object.keys(first.set)).toEqual(['verifiedAt']);
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.provision.mock.calls[0][0]).toMatchObject({ termsVersion: 'v1', adminEmail: EMAIL });
  });

  it('already-active tenant (same signer) → consumed + /login', async () => {
    h.tenant = { status: 'active', dbUrl: 'x' };
    db.onSelect(signups, [signupRow()]);
    const res = await post();
    expect(location(res)).toMatch(/\/\/newco\.[^/]+\/login$/); // host.ts reads the root domain at import
    expect(updatedKeys()).toEqual(['consumedAt']);
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('a resume (own tenant row) provisions even at the cap and over the IP limit', async () => {
    h.created = 50;
    h.fromIp = 10;
    h.tenant = { status: 'provisioning', dbUrl: 'x' };
    db.onSelect(signups, [signupRow({ ipHash: null })]);
    db.onSelect(tenants, [{ id: 't1' }]);
    await post();
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(updatedKeys()).not.toContain('waitlistedAt');
  });

  it('a non-resume verify whose ip_hash is already null → "link has expired — sign up again", unconsumed', async () => {
    db.onSelect(signups, [signupRow({ ipHash: null })]);
    const res = await post();
    expect(location(res)).toMatch(/This link has expired — please sign up again/);
    expect(h.provision).not.toHaveBeenCalled();
    expect(updatedKeys()).toEqual(['verifiedAt']);
  });

  it('the 4th verify from one IP hash in 24 h is refused; the row stays unconsumed', async () => {
    h.fromIp = 3;
    db.onSelect(signups, [signupRow()]);
    const res = await post();
    expect(location(res)).toMatch(/your network/);
    expect(h.provision).not.toHaveBeenCalled();
    expect(updatedKeys()).toEqual(['verifiedAt']);
  });

  it('slug taken by another tenant at the cap → "name just taken", consumed, NOT waitlisted', async () => {
    h.created = 20;
    h.tenant = { status: 'provisioning', dbUrl: 'x' }; // someone else's in-progress tenant
    db.onSelect(signups, [signupRow()]);
    const res = await post();
    expect(location(res)).toMatch(/just taken/);
    expect(updatedKeys()).toEqual(['verifiedAt', 'consumedAt']);
    expect(h.alerts).toEqual([]);
  });

  it('cap reached → waitlisted (unconsumed), signup-cap-reached deduplicated per UTC day, waitlist message', async () => {
    h.created = 20;
    db.onSelect(signups, [signupRow()]);
    const res = await post();
    expect(await res.text()).toContain(LB_D2);
    expect(updatedKeys()).toEqual(['verifiedAt', 'waitlistedAt']);
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'signup-cap-reached', dedupKey: new Date().toISOString().slice(0, 10) })]);
  });
});

describe('verify pages: landmarks and contrast (feature-plan-ux-page-fixes.md C9, T-C9b)', () => {
  const lum = (color: string) => {
    const hex = color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join('')}` : color;
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const rule = (html: string, selector: string) => html.match(new RegExp(`\\n\\s*${selector.replace(/[.:]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))?.[1] ?? '';
  const prop = (css: string, name: string) => css.match(new RegExp(`(?:^|;|\\s)${name}:\\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\\b`, 'i'))?.[1];
  async function pages() {
    db.onSelect(signups, [signupRow()]);
    const confirm = await (await get()).text();
    db.onSelect(signups, [signupRow({ waitlistedAt: new Date() })]);
    const waitlist = await (await get()).text();   // rendered through htmlPage()
    return { confirm, waitlist };
  }

  it('both pages: one <main> around the card and one <h1>; the emoji is aria-hidden', async () => {
    const { confirm, waitlist } = await pages();
    for (const html of [confirm, waitlist]) {
      expect(html.match(/<main[\s>]/g)).toHaveLength(1);
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(html.indexOf('<main')).toBeLessThan(html.indexOf('class="card"'));
      expect(html.indexOf('</main>')).toBeGreaterThan(html.lastIndexOf('</div>'));
    }
    expect(confirm).toContain('<div class="icon" aria-hidden="true">🏢</div>');
  });

  it('no #228be6 / #9ca3af; text on the white card ≥ 4.5:1; the focus outline ≥ 3:1', async () => {
    const { confirm, waitlist } = await pages();
    for (const html of [confirm, waitlist]) {
      expect(html.toLowerCase()).not.toMatch(/#228be6|#9ca3af/);
      for (const sel of ['h1', 'p']) expect(ratio(prop(rule(html, sel), 'color')!, '#ffffff'), sel).toBeGreaterThanOrEqual(4.5);
    }
    for (const sel of ['.workspace', '.note']) expect(ratio(prop(rule(confirm, sel), 'color')!, '#ffffff'), sel).toBeGreaterThanOrEqual(4.5);
    const button = rule(confirm, 'button');
    expect(ratio(prop(button, 'color')!, prop(button, 'background')!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', prop(rule(confirm, 'button:hover'), 'background')!)).toBeGreaterThanOrEqual(4.5);
    const focus = rule(confirm, 'button:focus-visible');
    expect(focus).toMatch(/outline:\s*2px solid #4f6bff;\s*outline-offset:\s*2px/);
    expect(ratio('#4f6bff', '#ffffff')).toBeGreaterThanOrEqual(3);
  });
});
