# Blueprint: API Rate Limiting — Endpoint Protection Against Abuse

## 1. Architectural Overview

### The Problem

Several API endpoints are exposed without rate limiting:

1. **Login endpoint** — The brute-force lockout protects individual accounts, but an attacker could target thousands of different emails to enumerate valid accounts or cause mass DB writes to `loginAttempts`
2. **Cron endpoints** (`/api/cron/daily-reminder`, `/api/cron/submission-deadline`) — While protected by `CRON_SECRET`, if the secret is leaked, they could be called repeatedly to spam users
3. **Report download endpoints** (`/api/reports/timesheet-pdf`, `/api/reports/cost-report-csv`, `/api/reports/cost-report-xlsx`) — PDF/Excel generation is CPU-intensive; repeated calls could DoS the server

### Design: Lightweight In-Memory Rate Limiter

For MVP, use a simple **in-memory sliding window counter** per IP address. No external dependencies (no Redis needed).

**Trade-offs:**
- ✅ Zero dependencies — no Redis or external service needed
- ✅ Works immediately — no infrastructure changes
- ❌ Not shared across multiple server instances (acceptable for MVP)
- ❌ Resets on server restart (acceptable — brute force protection uses DB-backed lockout for persistent protection)

The rate limiter is implemented as a utility module that API routes call at the top of their handlers.

### Rate Limit Configuration

| Endpoint Category | Limit | Window | Reasoning |
|---|---|---|---|
| **Login** (`signIn`) | 20 requests/minute per IP | 60 seconds | Prevents mass account enumeration |
| **Cron endpoints** | 2 requests/minute per IP | 60 seconds | Should only be called by scheduler |
| **Report downloads** | 10 requests/minute per IP | 60 seconds | Prevents resource exhaustion from PDF generation |
| **General API** (fallback) | 60 requests/minute per IP | 60 seconds | Standard API protection |

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/rate-limit.ts                            ← In-memory rate limiter utility

Files to MODIFY:
├── src/app/api/reports/timesheet-pdf/route.ts       ← Add rate limiting
├── src/app/api/reports/cost-report-csv/route.ts     ← Add rate limiting
├── src/app/api/reports/cost-report-xlsx/route.ts    ← Add rate limiting
├── src/app/api/cron/daily-reminder/route.ts         ← Add rate limiting
├── src/app/api/cron/submission-deadline/route.ts    ← Add rate limiting

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                      ← ❌ DO NOT MODIFY (login rate limiting handled differently — see note)
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/components/**                                ← ❌ DO NOT MODIFY
├── src/app/(app)/**                                 ← ❌ DO NOT MODIFY
├── src/server/actions/**                             ← ❌ DO NOT MODIFY
├── src/lib/session.ts                               ← ❌ DO NOT MODIFY
```

**Note on login rate limiting:** The `auth.ts` authorize callback already has brute-force protection via the DB-backed `loginAttempts` system. Adding in-memory IP-based rate limiting to `auth.ts` is complex because Auth.js's authorize callback doesn't have direct access to request headers. The existing DB-backed system is sufficient for MVP.

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - The rate limiter must be **stateless across restarts** (in-memory is OK).
> - Rate limit responses must return **HTTP 429 Too Many Requests** with a `Retry-After` header.
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Create Rate Limiter (A1)

#### A1. Create `src/lib/rate-limit.ts`

```typescript
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
```

---

### Phase B: Apply to API Routes (B1–B5)

#### B1. Modify `src/app/api/reports/timesheet-pdf/route.ts`

Add at the TOP of the `GET` function, before any other logic:

```typescript
import { checkReportRateLimit } from '@/lib/rate-limit';

// Inside GET handler, as first lines:
const rateLimited = checkReportRateLimit(request);
if (rateLimited) return rateLimited;
```

#### B2. Modify `src/app/api/reports/cost-report-csv/route.ts`

Same pattern:

```typescript
import { checkReportRateLimit } from '@/lib/rate-limit';

const rateLimited = checkReportRateLimit(request);
if (rateLimited) return rateLimited;
```

#### B3. Modify `src/app/api/reports/cost-report-xlsx/route.ts`

Same pattern:

```typescript
import { checkReportRateLimit } from '@/lib/rate-limit';

const rateLimited = checkReportRateLimit(request);
if (rateLimited) return rateLimited;
```

#### B4. Modify `src/app/api/cron/daily-reminder/route.ts`

```typescript
import { checkCronRateLimit } from '@/lib/rate-limit';

// Inside GET handler, as first lines (before CRON_SECRET check):
const rateLimited = checkCronRateLimit(request);
if (rateLimited) return rateLimited;
```

#### B5. Modify `src/app/api/cron/submission-deadline/route.ts`

Same pattern:

```typescript
import { checkCronRateLimit } from '@/lib/rate-limit';

const rateLimited = checkCronRateLimit(request);
if (rateLimited) return rateLimited;
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Rate Limit Checks

| Check | Expected Result |
|---|---|
| Download PDF once | Returns PDF normally |
| Download PDF 11 times rapidly | 11th request returns 429 with Retry-After header |
| Wait 60 seconds, try again | Request succeeds (window reset) |
| Hit cron endpoint 3 times rapidly | 3rd request returns 429 |
| Normal report usage (well-spaced) | No rate limiting triggered |
| Response includes correct headers | `Retry-After`, `X-RateLimit-Remaining` present |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Rate limiter blocks legitimate users | Limit too low | Increase limit (10 reports/min should be generous) |
| `getClientIp` returns 'unknown' | No proxy headers in dev | Acceptable — dev/localhost all share 'unknown' key |
| Memory leak from store | No cleanup | Cleanup runs every 5 minutes automatically |
| Rate limit not working behind proxy | IP from `x-forwarded-for` | Ensure reverse proxy passes the header |
