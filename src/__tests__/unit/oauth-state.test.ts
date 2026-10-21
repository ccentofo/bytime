import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

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
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalStateSecret = process.env.OAUTH_STATE_SECRET;

  beforeEach(() => {
    // Control both inputs so the result never depends on the developer's shell or .env.
    process.env.AUTH_SECRET = 'test-secret-for-oauth-state-signing-only';
    delete process.env.OAUTH_STATE_SECRET;
  });

  afterEach(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalStateSecret === undefined) delete process.env.OAUTH_STATE_SECRET;
    else process.env.OAUTH_STATE_SECRET = originalStateSecret;
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

  it('falls back to AUTH_SECRET when OAUTH_STATE_SECRET is an empty string (copied .env.example)', () => {
    process.env.OAUTH_STATE_SECRET = '';
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    expect(verifyOAuthState(state)).not.toBeNull();
  });

  it('prefers OAUTH_STATE_SECRET over AUTH_SECRET when both are set', () => {
    process.env.OAUTH_STATE_SECRET = 'dedicated-state-secret';
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    process.env.OAUTH_STATE_SECRET = 'rotated-state-secret';
    expect(verifyOAuthState(state)).toBeNull();
  });

  it('with no secret at all: minting throws and verifying returns null (never signs with an empty key)', () => {
    const state = mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: generateOAuthNonce() });
    delete process.env.AUTH_SECRET;
    expect(() => mintOAuthState({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n' })).toThrow();
    expect(verifyOAuthState(state)).toBeNull();
  });

  it('rejects a state HMAC-signed with the raw AUTH_SECRET (the key is derived, not reused)', () => {
    const payloadB64 = Buffer.from(JSON.stringify({ tenantSlug: 'acme', userId: 'user-1', provider: 'quickbooks_online', nonce: 'n', exp: Date.now() + 60_000 }), 'utf-8').toString('base64url');
    const rawSignature = crypto.createHmac('sha256', process.env.AUTH_SECRET!).update(payloadB64).digest('base64url');
    expect(verifyOAuthState(`${payloadB64}.${rawSignature}`)).toBeNull();
  });
});
