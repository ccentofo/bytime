import 'server-only';
import crypto from 'crypto';

/**
 * Cloudflare Turnstile server-side verification (feature-plan-launch-blockers.md P5, §2):
 * POST https://challenges.cloudflare.com/turnstile/v0/siteverify with `secret`, `response`, `remoteip`,
 * `idempotency_key` → `success`, `error-codes`, `hostname`. Tokens are single-use (`timeout-or-duplicate`).
 *
 * Outcomes are classified so only real outages count toward the `turnstile-outage` alert — user errors (bad, expired
 * or spent tokens, wrong hostname) never do. The secret is server-only and never reaches a client bundle.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

export interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
  challenge_ts?: string;
}

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; kind: 'user' | 'hostname' | 'outage' | 'config'; codes: string[] };

type Verifier = (params: { secret: string; response: string; remoteip?: string; idempotencyKey: string }) => Promise<SiteverifyResponse>;

const defaultVerifier: Verifier = async ({ secret, response, remoteip, idempotencyKey }) => {
  const res = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response, ...(remoteip ? { remoteip } : {}), idempotency_key: idempotencyKey }),
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
  return (await res.json()) as SiteverifyResponse;
};

let verifier: Verifier = defaultVerifier;

/** Tests inject a fake siteverify (null restores the real one). */
export function setTurnstileVerifierForTests(v: Verifier | null): void {
  verifier = v ?? defaultVerifier;
}

const OUTAGE_CODES = new Set(['internal-error']);
const CONFIG_CODES = new Set(['missing-input-secret', 'invalid-input-secret']);

/** Cloudflare's documented test secrets (always pass / always fail / token already spent) report a dummy hostname. */
const isTestSecret = (secret: string) => /^[123]x0+AA$/.test(secret);

/** The apex host Turnstile must report (`APP_ROOT_DOMAIN`, without a port). */
function expectedHostname(): string {
  return (process.env.APP_ROOT_DOMAIN ?? '').split(':')[0].toLowerCase();
}

export async function verifyTurnstile(token: string | undefined | null, opts: { remoteip?: string } = {}): Promise<TurnstileOutcome> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') return { ok: false, kind: 'config', codes: ['missing-input-secret'] };
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification (development only).');
    return { ok: true };
  }
  if (!token) return { ok: false, kind: 'user', codes: ['missing-input-response'] };

  let result: SiteverifyResponse;
  try {
    const remoteip = opts.remoteip && opts.remoteip !== 'unknown' ? opts.remoteip : undefined;
    result = await verifier({ secret, response: token, remoteip, idempotencyKey: crypto.randomUUID() });
  } catch {
    return { ok: false, kind: 'outage', codes: ['network-error'] };
  }

  const codes = result['error-codes'] ?? [];
  if (result.success !== true) {
    if (codes.some((c) => OUTAGE_CODES.has(c))) return { ok: false, kind: 'outage', codes };
    if (codes.some((c) => CONFIG_CODES.has(c))) return { ok: false, kind: 'config', codes };
    return { ok: false, kind: 'user', codes };
  }
  if (!isTestSecret(secret) && (result.hostname ?? '').toLowerCase() !== expectedHostname()) {
    return { ok: false, kind: 'hostname', codes: [`hostname:${result.hostname ?? ''}`] };
  }
  return { ok: true };
}
