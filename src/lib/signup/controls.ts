import 'server-only';
import crypto from 'crypto';
import { signupIpKey } from '@/lib/ip-key';

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

export { signupIpKey } from '@/lib/ip-key';

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
