import crypto from 'crypto';
import { signupIpKey } from '@/lib/ip-key';

/**
 * Rate-limit identifiers (feature-plan-upstash-rate-limiting.md §6.3). Every shared identifier is a keyed hash before
 * it leaves the process: no raw IP or email ever reaches Upstash, a log or Sentry. The label plus the HMAC make these
 * differ from `signups.ip_hash` (a plain salted sha256), so the two can't be joined. No `server-only`: the store and
 * everything it imports at the top load in plain Node (§6.2's import rule).
 */

const LABEL = 'cp-rate-limit:v1:';

/** The process-random secret used when SIGNUP_IP_SALT isn't set (memory mode only; never the public dev salt). */
let processSecret: string | null = null;

/** The HMAC secret: SIGNUP_IP_SALT, else a random per-process value. */
function secret(): string {
  const salt = process.env.SIGNUP_IP_SALT;
  if (salt) return salt;
  processSecret ??= crypto.randomBytes(32).toString('hex');
  return processSecret;
}

/** HMAC-SHA256(secret, "cp-rate-limit:v1:" + value), hex. */
export function rateLimitId(value: string): string {
  return crypto.createHmac('sha256', secret()).update(LABEL + value).digest('hex');
}

/** 'ip:' + the normalized IP (IPv4; IPv6 /64; IPv4-in-IPv6 → IPv4), or 'ip:unknown'. */
export function ipIdentifier(ip: string): string {
  return `ip:${signupIpKey(ip) ?? 'unknown'}`;
}
