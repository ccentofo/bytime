/**
 * Rate limiting. Two stores:
 * - **In memory, per server instance** (`./rate-limit/memory.ts`): reports, the v1 API, the workspace export and the
 *   wrong-cron-secret limit (`checkRateLimit`), unchanged.
 * - **Shared through Upstash** (`./rate-limit/store.ts`, feature-plan-upstash-rate-limiting.md): the signup and
 *   sign-in limits named in `./rate-limit/limits.ts`, with a fallback to memory when Upstash is unavailable.
 */

import { consume } from './rate-limit/store';
import { ipIdentifier } from './rate-limit/identifier';
import { checkRateLimit } from './rate-limit/memory';

export { checkRateLimit };

/**
 * Extract client IP from Next.js request headers.
 * Checks x-forwarded-for (reverse proxy), x-real-ip, then falls back to 'unknown'.
 */
export function getClientIp(request: Request): string {
  return getClientIpFromHeaders(request.headers);
}

/** Same as getClientIp, for server actions (which get `headers()`, not a Request). */
export function getClientIpFromHeaders(headers: Pick<Headers, 'get'>): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

/**
 * Create a rate-limited response (HTTP 429).
 */
export function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again in ${retryAfterSeconds} seconds.`,
      retryAfter: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Remaining': '0',
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Pre-configured rate limiters for common use cases
// ---------------------------------------------------------------------------

const ONE_MINUTE = 60 * 1000;

export function checkReportRateLimit(request: Request): Response | null {
  const ip = getClientIp(request);
  const result = checkRateLimit(`report:${ip}`, 10, ONE_MINUTE);
  return result.allowed ? null : rateLimitResponse(result.retryAfterMs);
}

export function checkCronRateLimit(request: Request): Response | null {
  const ip = getClientIp(request);
  const result = checkRateLimit(`cron:${ip}`, 2, ONE_MINUTE);
  return result.allowed ? null : rateLimitResponse(result.retryAfterMs);
}

/**
 * One shared budget for every "does this workspace name exist?" lookup — the signup availability check
 * (/signup/check) and the apex workspace finder (goToWorkspace) — so neither can be used to enumerate faster.
 * Shared across instances (Upstash), 30 per clock minute per IP (IPv6 by /64).
 */
export async function checkSlugLookupRateLimit(ip: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const result = await consume('slugLookup', ipIdentifier(ip));
  return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
}
