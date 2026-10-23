import 'server-only';
import crypto from 'crypto';

/**
 * Signup abuse controls (feature-plan-launch-blockers.md P5, LB-D2). Everything here is behind the server-only flag
 * SIGNUP_CONTROLS_ENABLED (default off — signup behaves exactly as before). The flag must not be turned on in
 * production until the updated Privacy Policy is published (LB-D3, LB-D5).
 */

export function signupControlsEnabled(): boolean {
  return process.env.SIGNUP_CONTROLS_ENABLED === 'true';
}

const isProduction = () => process.env.NODE_ENV === 'production';

/** The user-facing refusal for every verification problem (Turnstile, unknown IP, missing config) — never specific. */
export const VERIFICATION_FAILED = 'Verification failed — please try again.';

/** resendSignupVerification's one answer, whatever happened — no enumeration of who signed up. */
export const RESEND_GENERIC_RESPONSE = 'If that signup is waiting, we’ve sent a new link.';

/** Thrown by the signup flow when required configuration is missing in production (→ refuse + alert). */
export class SignupConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`Signup controls are missing required configuration: ${missing.join(', ')}`);
    this.name = 'SignupConfigError';
  }
}

/** Which required server secrets are missing (production only; dev has defaults). */
export function missingSignupConfig(): string[] {
  if (!isProduction()) return [];
  const missing: string[] = [];
  if (!process.env.TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY');
  if (!process.env.SIGNUP_IP_SALT) missing.push('SIGNUP_IP_SALT');
  // Audit S2: without the public site key the widget never renders and "Create workspace" stays disabled forever.
  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) missing.push('NEXT_PUBLIC_TURNSTILE_SITE_KEY');
  return missing;
}

/**
 * The address the hash is taken over: IPv4 as-is; IPv6 reduced to its /64 prefix (one subscriber holds a whole /64,
 * so rotating within it must not mint new buckets). Returns null for an unusable value ('unknown', empty).
 */
export function signupIpKey(ip: string): string | null {
  const raw = ip.trim().toLowerCase();
  if (!raw || raw === 'unknown') return null;
  if (!raw.includes(':')) return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw) ? raw : null; // IPv4
  let v6 = raw.replace(/^\[|\]$/g, '').split('%')[0];
  // A trailing dotted quad (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) → two hex groups, so every form parses alike.
  const dotted = v6.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    v6 = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v6.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = v6.includes('::') ? Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0') : [];
  const groups = [...headParts, ...fill, ...tailParts];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map((g) => parseInt(g, 16));
  // Audit S8: IPv4 carried inside IPv6 is that IPv4 address — not one shared ::/64 bucket (or a refusal).
  // IPv4-mapped ::ffff:a.b.c.d / ::ffff:hhhh:hhhh, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96.
  const zeros = (from: number, to: number) => n.slice(from, to).every((x) => x === 0);
  const isMapped = zeros(0, 5) && n[5] === 0xffff;
  const isCompatible = zeros(0, 6) && (n[6] !== 0 || n[7] > 1); // not :: or ::1
  const isNat64 = n[0] === 0x64 && n[1] === 0xff9b && zeros(2, 6);
  if (isMapped || isCompatible || isNat64) return `${n[6] >> 8}.${n[6] & 0xff}.${n[7] >> 8}.${n[7] & 0xff}`;
  return `${n.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

const DEV_SALT = 'cadenzpoint-dev-signup-ip-salt';

/**
 * sha256(SIGNUP_IP_SALT + key). The raw IP is never stored or logged. Production without a salt → SignupConfigError;
 * an unusable IP → null (production refuses; dev hashes the literal so local testing works).
 */
export function hashSignupIp(ip: string): string | null {
  const salt = process.env.SIGNUP_IP_SALT || (isProduction() ? '' : DEV_SALT);
  if (!salt) throw new SignupConfigError(['SIGNUP_IP_SALT']);
  const key = signupIpKey(ip) ?? (isProduction() ? null : 'unknown');
  if (!key) return null;
  return crypto.createHash('sha256').update(salt + key).digest('hex');
}
