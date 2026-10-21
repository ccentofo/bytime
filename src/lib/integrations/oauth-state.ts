import 'server-only';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// R2-9: signed OAuth `state` for the QBO/Gusto connect flow.
//
// Both providers only allow ONE registered redirect URI (the apex domain), but a connection
// must be saved into the TENANT that initiated it. The flow is: tenant subdomain mints a
// signed state binding (tenantSlug, userId, provider, nonce) → provider redirects to the apex
// callback, which only verifies the signature and forwards to the tenant's own "complete"
// route → that route re-verifies the signature AND the nonce (against an httpOnly cookie set
// at mint time, deleted on use) before exchanging the code. This prevents CSRF (an attacker
// can't mint a valid, correctly-signed state for someone else's tenant/user) and replay
// (the nonce is single-use).
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the nonce cookie's maxAge

export interface OAuthStatePayload {
  tenantSlug: string;
  userId: string;
  provider: string;
  nonce: string;
  exp: number; // unix ms
}

/**
 * HMAC key for the state, derived (HKDF) from OAUTH_STATE_SECRET or, if that's unset or empty,
 * AUTH_SECRET. Deriving keeps this key distinct from anything else AUTH_SECRET signs. `||`, not
 * `??`: a copied .env.example leaves OAUTH_STATE_SECRET as an empty string. Throws if neither
 * is set — never signs with an empty key.
 */
function getStateKey(): Buffer {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('OAUTH_STATE_SECRET or AUTH_SECRET must be set to use the OAuth connect flow.');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, '', 'cadenzpoint-oauth-state-v1', 32));
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', getStateKey()).update(payloadB64).digest('base64url');
}

/** Constant-time string comparison (false on any length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Generate a random, single-use nonce for the connect flow's cookie. */
export function generateOAuthNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Mint a signed `state` string: base64url(JSON payload) + '.' + HMAC-SHA256 signature. */
export function mintOAuthState(input: { tenantSlug: string; userId: string; provider: string; nonce: string }): string {
  const payload: OAuthStatePayload = { ...input, exp: Date.now() + STATE_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a `state` string's signature and expiry. Returns the payload if valid, or null —
 * never throws, so callers can treat "invalid" and "malformed" identically (fail closed).
 */
export function verifyOAuthState(state: string | null | undefined): OAuthStatePayload | null {
  if (!state) return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = sign(payloadB64);
  } catch {
    return null; // no secret configured — nothing can verify
  }
  if (!safeEqual(signature, expectedSignature)) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  if (
    typeof payload.tenantSlug !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.provider !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }

  if (Date.now() > payload.exp) return null;

  return payload;
}
