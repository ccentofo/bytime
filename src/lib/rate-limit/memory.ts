/**
 * The in-process limiter (feature-plan-upstash-rate-limiting.md §6.2 item 7). One `Map` per server instance; a fixed
 * window that starts at the key's first request; a refused call isn't counted. Used directly by the report, API,
 * export and cron limits (through `checkRateLimit`), and as the fallback for the shared limits when Upstash isn't
 * configured or is unavailable.
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

/** One counted request: today's `checkRateLimit` logic, plus the end of the window that holds the count. */
export function memoryConsume(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number; resetAt: number } {
  cleanup();

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    // New window
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0, resetAt };
  }

  if (entry.count >= limit) {
    // Rate limited (not counted)
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now, resetAt: entry.resetAt };
  }

  // Increment
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0, resetAt: entry.resetAt };
}

/** Take one count back, in the current window only, never below 0. */
export function memoryRefund(key: string): void {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= Date.now() || entry.count <= 0) return;
  entry.count -= 1;
}

/** Test hook: forget every counter. */
export function memoryReset(): void {
  store.clear();
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
  const { allowed, remaining, retryAfterMs } = memoryConsume(key, limit, windowMs);
  return { allowed, remaining, retryAfterMs };
}
