import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// oauth-state.ts is `import 'server-only'` (it handles a signing secret) — stub the marker so
// it's importable from a plain unit test, same as the integration suite's setup-db.ts does.
vi.mock('server-only', () => ({}));

import { mintOAuthState, verifyOAuthState, generateOAuthNonce } from '@/lib/integrations/oauth-state';

// ---------------------------------------------------------------------------
// R2-9: signed OAuth state. Covers the pure crypto/validation logic in
// isolation — missing, forged, expired, and tampered states must all be
// rejected; a validly-signed, unexpired state must round-trip exactly.
// ---------------------------------------------------------------------------

describe('OAuth state signing (R2-9)', () => {
  const originalSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret-for-oauth-state-signing-only';
  });

  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
  });

  it('round-trips a validly-signed, unexpired state', () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    const payload = verifyOAuthState(state);
    expect(payload).not.toBeNull();
    expect(payload?.tenantSlug).toBe('acme');
    expect(payload?.userId).toBe('user-1');
    expect(payload?.provider).toBe('quickbooks_online');
  });

  it('rejects a missing state', () => {
    expect(verifyOAuthState(null)).toBeNull();
    expect(verifyOAuthState(undefined)).toBeNull();
    expect(verifyOAuthState('')).toBeNull();
  });

  it('rejects a malformed state (no signature separator)', () => {
    expect(verifyOAuthState('not-a-valid-state-string')).toBeNull();
  });

  it('rejects a forged state (tampered payload, signature unchanged)', () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    const [payloadB64, signature] = state.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ tenantSlug: 'evil-corp', userId: 'user-1', provider: 'quickbooks_online', nonce: 'x', exp: Date.now() + 60_000 }), 'utf-8').toString('base64url');
    const forgedState = `${tamperedPayload}.${signature}`;
    expect(verifyOAuthState(forgedState)).toBeNull();
    void payloadB64;
  });

  it('rejects a state signed with a different secret', () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    process.env.AUTH_SECRET = 'a-completely-different-secret';
    expect(verifyOAuthState(state)).toBeNull();
  });

  it('rejects an expired state', () => {
    // Mint, then fast-forward past the 10-minute TTL.
    const realNow = Date.now;
    try {
      const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
      Date.now = () => realNow() + 11 * 60 * 1000;
      expect(verifyOAuthState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('a state minted for one tenant/user does not verify as belonging to another', () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    const payload = verifyOAuthState(state)!;
    expect(payload.tenantSlug === 'globex').toBe(false);
    expect(payload.userId === 'user-2').toBe(false);
  });
});
