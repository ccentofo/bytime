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

import { GET } from '@/app/api/integrations/complete/[provider]/route';
import { mintOAuthState, generateOAuthNonce } from '@/lib/integrations/oauth-state';
import { NextRequest } from 'next/server';

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

  it('rejects a forged state (tampered payload)', async () => {
    const nonce = generateOAuthNonce();
    const state = mintOAuthState({ tenantSlug: 'acme', userId: admin.id, provider: 'quickbooks_online', nonce });
    const [, signature] = state.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ tenantSlug: 'acme', userId: 'someone-else', provider: 'quickbooks_online', nonce, exp: Date.now() + 60_000 }), 'utf-8').toString('base64url');
    const forgedState = `${forgedPayload}.${signature}`;

    const request = requestWithNonceCookie(
      `http://acme.localhost:3000/api/integrations/complete/quickbooks_online?code=auth-code&state=${encodeURIComponent(forgedState)}`,
      nonce
    );
    const response = await GET(request, { params: Promise.resolve({ provider: 'quickbooks_online' }) });
    expect(response.headers.get('location')).toContain('error=connection_failed');
    expect(connectorState.exchangeCodeForTokens).not.toHaveBeenCalled();
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
});
