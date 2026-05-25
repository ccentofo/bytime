/**
 * In-memory sliding window rate limiter.
 * Tracks request counts per IP address within a configurable time window.
 *
 * Limitations:
 * - Not shared across server instances (OK for single-instance MVP)
 * - Resets on server restart (OK — DB-backed brute force protection covers auth)
 * - Memory grows with unique IPs (cleanup runs automatically)
 */

type RateLimitEntry = {
  count: number;
  resetAt: number; // Unix timestamp (ms)
};

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}

/**
 * Check if a request should be rate limited.
 *
 * @param key - Unique identifier (typically IP address + endpoint)
 * @param limit - Maximum number of requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns Object with `allowed` boolean, `remaining` count, and `retryAfterMs`
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
} {
  cleanup();

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    // New window
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (entry.count >= limit) {
    // Rate limited
    const retryAfterMs = entry.resetAt - now;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  // Increment
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 };
}

/**
 * Extract client IP from Next.js request headers.
 * Checks x-forwarded-for (reverse proxy), x-real-ip, then falls back to 'unknown'.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = request.headers.get('x-real-ip');
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
