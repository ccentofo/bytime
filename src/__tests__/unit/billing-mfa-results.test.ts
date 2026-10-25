import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-blockers audit A12: getTenantForBilling's expected refusals are UserFacingErrors (a billing action returns
 * the message instead of Next's redacted digest), and initMFASetup returns an ActionResult.
 */

const h = vi.hoisted(() => ({ host: 'acme.localhost', tenant: null as null | Record<string, unknown>, signedIn: true }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: h.host }) }));
vi.mock('@/lib/tenant/registry', () => ({ getTenantBySlug: async () => h.tenant }));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  return {
    AuthorizationError,
    requireSession: async () => {
      if (!h.signedIn) throw new AuthorizationError('unauthenticated', 'Unauthorized: No active session');
      return { id: 'u1', email: 'pat@acme.com', fullName: 'Pat', role: 'admin' };
    },
  };
});

import { getTenantForBilling } from '@/lib/tenant/context';
import { userAction } from '@/lib/action-result';
import { UserFacingError } from '@/lib/errors';
import { initMFASetup } from '@/server/actions/mfa';

const tenant = (o: Record<string, unknown>) => ({ id: 't', slug: 'acme', dbUrl: 'x', suspensionReason: null, ...o });

beforeEach(() => {
  h.host = 'acme.localhost';
  h.tenant = null;
  h.signedIn = true;
});

describe('getTenantForBilling refusals are user-facing', () => {
  it.each([
    [{ status: 'deleting' }, 'This workspace is being removed.'],
    [{ status: 'provisioning' }, 'This workspace is still being set up.'],
    [{ status: 'suspended', suspensionReason: 'policy' }, 'This workspace is on hold. Contact support@cadenzpoint.com.'],
    [{ status: 'deleted' }, 'This workspace is not available.'],
  ])('%j → UserFacingError "%s" (returned by a billing action, not redacted)', async (o, message) => {
    h.tenant = tenant(o);
    await expect(getTenantForBilling()).rejects.toBeInstanceOf(UserFacingError);
    expect(await userAction(() => getTenantForBilling())).toEqual({ ok: false, code: 'validation', error: message });
  });

  it('an unknown workspace → not_found', async () => {
    expect(await userAction(() => getTenantForBilling())).toEqual({ ok: false, code: 'not_found', error: 'Unknown workspace.' });
  });

  it('an active or non-payment-suspended workspace is returned', async () => {
    h.tenant = tenant({ status: 'suspended', suspensionReason: 'nonpayment' });
    await expect(getTenantForBilling()).resolves.toMatchObject({ slug: 'acme' });
  });
});

describe('initMFASetup returns a result', () => {
  it('signed in → { ok: true } with a secret and an otpauth URI', async () => {
    const r = await initMFASetup();
    expect(r).toMatchObject({ ok: true, data: { secret: expect.any(String), uri: expect.stringMatching(/^otpauth:\/\//) } });
  });

  it('signed out → { ok:false, code:"unauthenticated" } (not a thrown, redacted error)', async () => {
    h.signedIn = false;
    expect(await initMFASetup()).toEqual({ ok: false, code: 'unauthenticated', error: 'Unauthorized: No active session' });
  });
});
