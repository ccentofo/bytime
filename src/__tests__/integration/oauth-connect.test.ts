import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

// ---------------------------------------------------------------------------
// R2-9: the tenant-side OAuth completion route (complete/[provider]/route.ts) is
// where the real authorization logic lives — it must reject a missing, forged,
// expired, or already-used state, and a state minted for a different user or
// tenant, and only connect on a fully valid round-trip.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  // Write actions obtain their client through the write gate (feature-plan-terms-compliance-fixes.md §5.1).
  getDbForWrite: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'acme' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };

const sessionState = vi.hoisted(() => ({
  user: null as null | FakeSessionUser,
}));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

const connectorState = vi.hoisted(() => ({
  exchangeCodeForTokens: vi.fn(async (_code: string, realmId?: string) => ({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresIn: 3600,
    realmId,
    companyName: 'Fake Co',
  })),
}));

vi.mock('@/lib/integrations/registry', () => ({
  getConnector: (id: string) =>
    id === 'quickbooks_online'
      ? { metadata: { name: 'QuickBooks Online' }, exchangeCodeForTokens: connectorState.exchangeCodeForTokens }
      : undefined,
}));

import crypto from 'crypto';
import { GET } from '@/app/api/integrations/complete/[provider]/route';
import { GET as apexCallback } from '@/app/api/integrations/callback/[provider]/route';
import { mintOAuthState, generateOAuthNonce } from '@/lib/integrations/oauth-state';
import { NextRequest } from 'next/server';

// Signing secret for this suite; CI's integration job doesn't set AUTH_SECRET.
process.env.OAUTH_STATE_SECRET = 'integration-test-oauth-state-secret';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.APP_ROOT_DOMAIN = 'localhost';

const QBO = { params: Promise.resolve({ provider: 'quickbooks_online' }) };
const completeUrl = (state: string, extra = '') =>
  `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code${extra}&state=${encodeURIComponent(state)}`;

/** True if the response expires the nonce cookie (single use). */
function clearsNonceCookie(response: Response): boolean {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return /qbo_oauth_nonce=;[^,]*Expires=Thu, 01 Jan 1970/.test(setCookie);
}

/** A state with the right shape and claims but a signature from the wrong key. */
function stateSignedWithWrongKey(payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signature = crypto.createHmac('sha256', 'not-the-real-key').update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function actingAs(user: Awaited<ReturnType<typeof createTestUser>>) {
  sessionState.user = { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

function requestWithNonceCookie(url: string, nonce: string | undefined): NextRequest {
  const headers: Record<string, string> = {};
  if (nonce !== undefined) headers.cookie = `qbo_oauth_nonce=${nonce}`;
  return new NextRequest(url, { headers });
}

describe('OAuth completion route (R2-9)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    actingAs(admin);
    tenantState.requestSlug = 'acme';
    connectorState.exchangeCodeForTokens.mockClear();
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('completes a fully valid round-trip and saves the connection', async () => {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce });
    const request = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&realmId=123&state=${encodeURIComponent(state)}`,
      nonce
    );

    const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(response.status).toBe(307); // redirect
    expect(response.headers.get('location')).toContain('connected=true');
    expect(connectorState.exchangeCodeForTokens).toHaveBeenCalledTimes(1);
    expect(clearsNonceCookie(response)).toBe(true);

    const db = getTestDb();
    const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'quickbooks_online'));
    expect(rows).toHaveLength(1);
  });

  it('rejects a missing state', async () => {
    const nonce = generateOAuthNonce();
    const request = requestWithNonceCookie(
      'http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code',
      nonce
    );
    const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects a forged state (correct claims, wrong signing key)', async () => {
    const nonce = generateOAuthNonce();
    // Every claim matches this admin, tenant, provider and cookie, so ONLY the signature check
    // can reject it.
    const forgedState = stateSignedWithWrongKey({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce, exp: Date.now() + 60_000 });
    const response = await GET(requestWithNonceCookie(completeUrl(forgedState), nonce), QBO);
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(clearsNonceCookie(response)).toBe(true);
  });

  it('rejects an expired state', async () => {
    const nonce = generateOAuthNonce();
    const realNow = Date.now;
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce });
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      const request = requestWithNonceCookie(
        `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(state)}`,
        nonce
      );
      const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
      expect(response.headers.get('location')).toContain('error=connection_failed');
      expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects a reused (already-consumed) nonce — cookie missing on the second attempt', async () => {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce });

    // First attempt: valid, cookie present.
    const firstRequest = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(state)}`,
      nonce
    );
    const firstResponse = await GET(firstRequest, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(firstResponse.headers.get('location')).toContain('connected=true');
    // The browser is told to delete the nonce — that is what makes the state single-use.
    expect(clearsNonceCookie(firstResponse)).toBe(true);

    // Second attempt with the SAME state, but no cookie (browser already had it deleted after
    // the first completion) — simulates replay.
    const secondRequest = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(state)}`,
      undefined
    );
    const secondResponse = await GET(secondRequest, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(secondResponse.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).toHaveBeenCalledTimes(1); // only the first attempt
  });

  it('rejects a state minted for a different tenant', async () => {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'globex', userId: admin.id, provider: 'quickbooks_online', nonce }); // different tenant
    tenantState.requestSlug = 'acme'; // this request resolves to acme

    const request = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(state)}`,
      nonce
    );
    const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects a state minted for a different user', async () => {
    const otherUser = await createTestUser({ role: 'admin' });
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: otherUser.id, provider: 'quickbooks_online', nonce }); // different user
    actingAs(admin); // the ACTOR completing the flow is a different admin than the state names

    const request = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(state)}`,
      nonce
    );
    const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });
  it('rejects a nonce cookie that does not match the nonce in the state', async () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    const response = await GET(requestWithNonceCookie(completeUrl(state), generateOAuthNonce()), QBO);
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects a state minted for a different provider', async () => {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'gusto', nonce });
    const response = await GET(requestWithNonceCookie(completeUrl(state), nonce), QBO);
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects a non-admin actor even with a valid state for them', async () => {
    const supervisor = await createTestUser({ role: 'supervisor' });
    actingAs(supervisor);
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: supervisor.id, provider: 'quickbooks_online', nonce });
    const response = await GET(requestWithNonceCookie(completeUrl(state), nonce), QBO);
    expect(response.headers.get('location')).not.toContain('connected=true');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(clearsNonceCookie(response)).toBe(true);
  });

  it('sends an unauthenticated request to login without exchanging the code', async () => {
    sessionState.user = null;
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce });
    const response = await GET(requestWithNonceCookie(completeUrl(state), nonce), QBO);
    expect(response.headers.get('location')).toContain('/login');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });
});

describe('Apex OAuth callback (R2-9)', () => {
  const apexUrl = (query: string) => new NextRequest(`http://localhost:3000/api/integrations/callback/quickbooks_online?${query}`);

  it('forwards a valid state to the tenant from the state (not the request), carrying code, realmId and state', async () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n' });
    const response = await apexCallback(apexUrl(`code=c1&realmId=r1&state=${encodeURIComponent(state)}`), QBO);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('http://acme.localhost:3000');
    expect(location.pathname).toBe('/api/integrations/complete/quickbooks_online');
    expect(location.searchParams.get('code')).toBe('c1');
    expect(location.searchParams.get('realmId')).toBe('r1');
    expect(location.searchParams.get('state')).toBe(state);
  });

  it('rejects a forged state with 400 and redirects nowhere', async () => {
    const forged = stateSignedWithWrongKey({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n', exp: Date.now() + 60_000 });
    const response = await apexCallback(apexUrl(`code=c1&state=${encodeURIComponent(forged)}`), QBO);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects a validly signed state whose slug is not a valid tenant slug', async () => {
    const state = mintOAuthState({ tenantSlug: 'evil.com/x', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n' });
    const response = await apexCallback(apexUrl(`code=c1&state=${encodeURIComponent(state)}`), QBO);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects a state minted for a different provider', async () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'gusto', nonce: 'n' });
    const response = await apexCallback(apexUrl(`code=c1&state=${encodeURIComponent(state)}`), QBO);
    expect(response.status).toBe(400);
  });

  it('sends a declined consent back to the workspace with a fixed error code (provider text not reflected)', async () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n' });
    const response = await apexCallback(apexUrl(`error=%3Cscript%3E&state=${encodeURIComponent(state)}`), QBO);
    const location = response.headers.get('location')!;
    expect(location).toBe('http://acme.localhost:3000/admin/integrations?error=connection_cancelled');
  });
});
