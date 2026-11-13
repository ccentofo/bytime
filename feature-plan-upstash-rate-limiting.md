# Distributed rate limiting with Upstash (build queue 6)

> **Status:** **FINAL v3.3**, 2026-11-13, lead architect. **Pre-mortem CLEAN:** round 1 (1 HIGH, 12 MEDIUM; redesign in v2), round 2 (4 MEDIUM; v3), confirmation passes 1 (3 MEDIUM; v3.1) and 2 (1 MEDIUM; v3.2) were fixed, and confirmation pass 3 found only LOWs, now written in (§14). **Awaiting the product owner's answers to Q1–Q5** (§2) before the dev hand-off.
>
> **Branch:** `upstash-rate-limiting`, from `main` at `02059b0` (after 5b, PR #30). The §3 references were checked there.
>
> **Source:**
> - `LAUNCH-TRACKER.md` build queue 6, approved 2026-11-12. Decisions log 2026-11-12: Upstash; "keys must be **salted hashes that expire within 25 hours**"; "raw IPs are never stored".
> - `BUSINESS-DECISIONS.md` §4: Upstash Redis, pay-as-you-go, created through the Vercel Marketplace in us-east-1, with a $10 budget alert or cap. "Rate-limit keys never contain a raw IP address or email address. Use salted hashes. Every key expires within 25 hours."
> - The live Privacy Policy (`src/app/privacy/page.tsx:25`): "we keep a one-way, salted hash of the IP address used to sign up or sign in for up to 25 hours". Upstash is listed as a subprocessor (`:52`).
> - Earlier plans: "Distributed rate limiting (Upstash) for sign-in, MFA, and signup" (`feature-plan-security-hardening.md` §10). PRODUCTION-DEPLOY Phase 15: "The current limiter is in memory and per serverless instance, so it barely protects login/signup on Vercel."
> - Tracker note: "`login_attempts.ip_address` exists, but nothing writes to it. Drop the column or guard it so raw IPs stay unstored."
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

**Goal.** Every rate limit lives in a `Map` inside one server instance (`src/lib/rate-limit.ts:16`). On Vercel, requests spread across instances and each new instance starts empty, so the limits that guard **signing up and signing in** barely work. This item moves those limits to one shared Upstash Redis database, under the privacy rules: hashed keys, nothing kept past 25 hours, never a raw IP or email.

**In scope (as recommended in §2; each piece depends on its question)**
1. A small store for **named shared limits**, backed by Upstash, with a fallback to the in-memory limiter when Upstash is unavailable (Q1) (§6.1–§6.4).
2. **Move to Upstash (Q4):** the signup attempt limit and the workspace-name lookup limit, with today's numbers.
3. **New, on Upstash:** a per-IP limit on failed sign-ins, counted before any work and refunded on success, so parallel requests can't get around it (Q2). A per-IP limit on password-reset requests (Q3) (§6.7).
4. Every shared identifier is a keyed hash before it leaves the process, and every key expires within 25 hours by construction (§6.3).
5. Ops alerts for an Upstash outage and for missing or invalid configuration, resolved automatically, like Turnstile's (§6.6).
6. `login_attempts.ip_address`: a database rule that keeps it empty, and the code path that could write it removed (§6.8).

**Out of scope**
- **Report downloads, the v1 API (per IP and per key), the workspace export and the wrong-cron-secret limit keep today's in-memory limiter, unchanged** (Q4: cost and privacy). `cron-auth.ts` and `run-cron.ts` aren't touched.
- **Changing any existing number** (Q4).
- **The per-email sign-in lockout** (`src/server/internal/login-attempts.ts:8-9`) and **the per-email reset cap** (`src/server/actions/password-reset.ts:50`). Both are already shared, since they live in each workspace's database. One existing weakness in the lockout is recorded in §8, not changed.
- **Upstash analytics, deny lists, multi-region, dynamic limits; Edge middleware.**

## 2. Questions for the product owner

| # | Question | Lead's recommendation |
|---|---|---|
| Q1 | **When Upstash is unreachable, slow (over half a second) or misconfigured, what should happen?** (a) fall back to today's per-instance limiter and email an ops alert; (b) refuse the request; (c) allow everything. | **(a).** Protection drops to today's level instead of locking every user out of sign-in and signup during someone else's outage. The alert resolves itself an hour after Upstash recovers, as Turnstile's does. |
| Q2 | **Add a per-IP limit on failed sign-ins?** Today only the per-email lockout exists, which doesn't stop one address from trying passwords against many accounts or workspaces.<br>Proposal: **20 failed sign-ins per IP per 15 minutes, across all workspaces.** These all count as failures: a wrong password, a wrong MFA code, an unknown email, a locked account, and a workspace that doesn't exist. Successful sign-ins don't count.<br>How it's counted: every attempt is counted *before* any checking and refunded when it succeeds. That's what stops many parallel requests from slipping past.<br>Over the limit, sign-in is refused, **even with the right password**, with: **"Too many failed sign-in attempts from your network. Try again in 15 minutes."** (15 minutes is the most; the real wait is 0–15.)<br>**The trade-off:** everyone behind one public address shares one budget of 20 failures in a 15-minute window, across all workspaces. That includes an office, a VPN, a coworking space or a mobile carrier. So a run of typos, or someone else on that network attacking any workspace, can block the whole office for up to 15 minutes. A correct password can't skip the block: an attacker who has spent the budget must learn nothing from further guesses. | **Yes, 20 per 15 minutes, with this text.** A busy office rarely makes 20 failed sign-ins in 15 minutes; the per-email lockout already stops at 5 per account. If you'd rather leave more headroom for large offices, 50 is the alternative, at the cost of 2.5× more guesses per address. The earlier security plan named sign-in and MFA as this item's purpose. |
| Q3 | **Add a per-IP limit on password-reset requests?** Today it's 3 an hour per email, but one IP can request resets for any number of addresses. Each sends an email, against Resend's Free tier of 100 a day.<br>Proposal: **10 per IP per hour.** Over it, the page shows the usual generic "if that account exists…" message, and no email is sent.<br>**Privacy:** this stores a hashed IP for password-reset requests at Upstash (for at most 2 hours). The Privacy Policy says we keep a hashed IP "used to sign up or sign in". A password reset is part of signing in, but if you want it named, the business session can add "or reset a password". | **Yes.** Nothing visible to a real user; it protects the daily email quota. On the wording: optional; forward it to the business session if you want it explicit. |
| Q4 | **Which limits move to Upstash?** Every Upstash check costs 2–3 commands; the free tier is 500,000 commands a month, then $0.20 per 100,000.<br>**Moving everything:** one API integration running at its allowed 100 requests a minute all month would cost about $35–70 by itself (2 checks per request). Report downloads and API calls would also store hashed IPs at Upstash, which the Privacy Policy ("used to sign up or sign in") doesn't describe.<br>**Recommended split.** On Upstash, with today's numbers: signup attempts (8/hour/IP) and workspace-name lookups (30/minute/IP, shared by the signup check and the workspace finder), plus Q2 and Q3. Staying in memory, unchanged: reports (10/minute/IP), API (100/minute per IP and per key), export (5/hour per workspace), wrong cron secrets (2/minute/IP; the callers are probes, not users, and the secret is long and random).<br>Two small changes for the moved limits:<br>- each window starts on the clock (minute or hour), not at the first request;<br>- IPv6 addresses are grouped by their /64 network, as signup's per-IP workspace limit already does. That's stricter for IPv6 offices. | **The split.** The moved limits are low-volume, before sign-in, and the ones abuse targets; the memory ones guard callers who already proved who they are. Worst-case cost stays well under the $10 setting. |
| Q5 | **Budget setting.** `BUSINESS-DECISIONS.md` §4 says a $10 "budget alert or cap".<br>**With a hard cap,** Upstash stops answering when the cap is reached. The shared limits then fall back to per-instance memory (Q1), today's weak level, until the month resets. An attacker can reach $10 cheaply on purpose. For example, two addresses staying just under the workspace-name lookup limit all month would spend it, as would a loop of successful sign-ins with their own account, at about 4 commands each.<br>**With an alert only,** it keeps working and bills about $0.20 per 100,000 commands, so cost grows only with an attacker's effort. The alert emails you so you can react.<br>(Whether a Marketplace-created database even offers a hard cap is unverified; billing goes through Vercel.) | **An alert, not a hard cap:** a usage alert at $5 and another at $10, in whichever console offers them. Then nobody can switch the protection off by spending your budget, and a sustained flood is visible early and costs dollars, not an outage. |

If Q2 or Q3 is no, drop its row from `SHARED_LIMITS`, its §6.7 part and its tests (Q2: T17–T19, T23 and T24's sign-in cases; Q3: T20).

## 3. Verified current state (2026-11-13, `main` at `02059b0`)

### 3.1 The limiter (`src/lib/rate-limit.ts`)
- An in-memory `Map` (`:16`). Cleanup runs at most every 5 minutes (`:19-32`).
- **`checkRateLimit(key, limit, windowMs)`** (`:42-73`), **synchronous**, a fixed window starting at the key's first request, returns `{ allowed, remaining, retryAfterMs }`.
- **`getClientIp` / `getClientIpFromHeaders`** (`:77-90`): the first `x-forwarded-for` entry, then `x-real-ip`, then `'unknown'`.
- **`rateLimitResponse`** (`:95-112`): the 429 JSON `{ error, message, retryAfter }` plus `Retry-After`.
- **The presets:**
  - `checkReportRateLimit` (`:120-124`), 10/minute;
  - `checkCronRateLimit` (`:126-130`), 2/minute;
  - `checkSlugLookupRateLimit(ip)` (`:136-139`), 30/minute, key `signup-check:<ip>`.

### 3.2 Callers
| Caller | Limit | Key today | This item |
|---|---|---|---|
| 6 report routes (`checkReportRateLimit`) | 10/min | `report:<ip>` | unchanged (memory) |
| `src/lib/api-auth.ts:118-120` / `:99-102` | 100/min | `api:<ip>` / `apikey:<id>` | unchanged (memory) |
| `src/app/api/export/workspace/route.ts:34-35` | 5/hour | `export:<slug>` | unchanged (memory) |
| `src/lib/cron-auth.ts:22-29` (`rejectUnauthorizedCron`; only a **wrong** secret counts, R12), called by `src/lib/cron/run-cron.ts:21` | 2/min | `cron:<ip>` | unchanged (memory) |
| `src/app/signup/check/route.ts:7-8`, `src/server/actions/workspace-finder.ts:36` (shared budget) | 30/min | `signup-check:<ip>` | **Upstash** |
| `src/server/actions/signup.ts:75` (start), `:144` (resend), shared | 8/hour | `signup:<ip>` | **Upstash** |

### 3.3 Sign-in, lockout and password reset
- **Wiring:** `authorizeCredentials(credentials)` (`src/auth.ts:31-127`), wired as `authorize: authorizeCredentials` (`:286`). Auth.js 5.0.0-beta.31 calls `authorize(credentials, request)`, where the request is `new Request(url, { headers })` built from the incoming headers (`@auth/core/lib/actions/callback/index.js:231`).
- **Order:**
  1. workspace resolution (`:43-50`, returns `null` with nothing recorded);
  2. lockout check (`:52-55`, returns `null`);
  3. user lookup and failure (`:57-63`);
  4. bcrypt and failure (`:65-69`);
  5. MFA: `MFARequiredSignin` with no code (`:72-75`); a wrong code records a failure and throws `MFAInvalidSignin` (`:113-116`);
  6. success, recorded (`:119`).
- **A subclass's `code` reaches the form** as `result.code`, as `mfa_required` does (`src/app/login/LoginForm.tsx:80`, `:85`). Other failures show "Invalid email or password." (`:105-107`).
- **`recordFailedAttempt(db, email, ipAddress?)` and `recordSuccessfulLogin(db, email, ipAddress?)`** (`src/server/internal/login-attempts.ts:140-169`) still **accept and insert `ipAddress`**, though no caller passes it.
- **The lockout is check-then-record:** `getLockoutInfo` reads, the attempt is recorded later. Parallel requests can all pass the check (§8).
- **`requestPasswordReset(email)`** (`src/server/actions/password-reset.ts:36`): the per-email cap is at `:50-63`, with the same generic message whether or not an email is sent.

### 3.4 IP hashing today (`src/lib/signup/controls.ts`, which starts `import 'server-only'`)
- `signupIpKey(ip)` (`:44-72`): IPv4 as is; IPv6 cut to its /64; IPv4-in-IPv6 back to IPv4; `null` for junk or `'unknown'`.
- `hashSignupIp` (`:80-86`) = `sha256(SIGNUP_IP_SALT + key)` (`signups.ip_hash`).
- `isProduction()` is `NODE_ENV === 'production'` (`:14`), which is also true for a local `npm run start`.

### 3.5 Ops alerts for an outside service (`src/lib/signup/signals.ts`, server-only)
- **Module-private helpers:** `recordWindowedSignal(key, now)` (`:25-39`) and `lastSignalAt(key)` (`:42-46`), both over the control plane's `signal_counters`.
- **The Turnstile outage alert** at 3 signals within an hour (`:51-62`), through `raiseAlertWithEmail` (`src/lib/tenant/ops-alert-email.ts:14`): an immediate email, deduplicated while unresolved.
- **`resolveSignupSignals()`** (`:116-131`) runs from the notice-delivery cron (`src/app/api/cron/notice-delivery/route.ts:20`).
- **Alert kinds are free text** (`src/lib/tenant/lifecycle-store.ts:47`).
- **Deferred work** uses `after()` from `next/server` (for example `src/lib/email/schedule.ts`), which throws outside a request scope.

### 3.6 `login_attempts.ip_address`
- `varchar(45)`, nullable (`src/db/schema.ts:105`).
- No caller writes it (see §3.3 for the parameter that could). No seeder writes it (`scripts/seed-full.ts:600-616`). The local demo has 11 rows, all `NULL`.
- The table is excluded from the workspace export (`src/lib/export/allowlists.ts:7`).
- Existing check constraints are written as `check(...)` in the table's extra-config callback, and drizzle emits `CHECK ("table"."col" …)` (for example `drizzle/0014_*.sql:44`). `loginAttempts` has no extra-config callback yet.

### 3.7 Tests affected
- `unit/rate-limit.test.ts` tests `checkRateLimit`, which stays.
- `unit/cron-auth.test.ts` and `unit/cron-ops.test.ts` exercise the cron guard.
- `unit/signup-ops.test.tsx:197-200` mocks `@/lib/signup/signals` with only two exports.
- **Load `server-only` modules without mocking it:** `unit/v1-api-auth.test.ts` and `unit/export-route-auth.test.ts`. They import `rate-limit.ts`, which will import the store, hence §6.2's import rule.
- `unit/password-reset.test.ts` and `integration/password-reset.test.ts` call `requestPasswordReset` with no `next/headers` mock.
- `unit/authorize-mfa-code.test.ts`, `integration/mfa-signin.test.ts` and `integration/account-security.test.ts` call `authorizeCredentials`.
- The integration DB setup migrates (`src/__tests__/integration/setup-db.ts:48`).

### 3.8 Configuration
- `.env.example:102` has `SIGNUP_IP_SALT=`. There's no Upstash variable anywhere and no `@upstash/*` dependency.
- **Vercel env vars are set with only Production checked, and git deploys are off** (`PRODUCTION-DEPLOY.md:309-311`). Staging is its own Vercel project. Vercel crons run only on production-type deployments.
- `scripts/smoke-tenancy.sh` probes a cron with no secret and expects 401.

## 4. External behaviour (verified from source)

### 4.1 `@upstash/ratelimit` 2.2.1 (npm, published 2026-11-12; source read from the packed `dist/index.js`)
- **The constructor** (`:764-787`) defaults: `timeout` 5,000 ms, `prefix` `"@upstash/ratelimit"`, `analytics` off, `enableProtection` (deny lists) off, `dynamicLimits` off, `ephemeralCache` on.
- **The ephemeral cache:** an in-memory `Map` of *blocked* identifiers until their reset. An entry is removed only when that identifier is looked up again.
- **`limit(identifier, { rate }?)`** (about `:818-838`) races the Redis call against the timeout.
  - **On timeout it resolves `{ success: true, …, reason: "timeout" }`** (about `:920-937`), allowing the request.
  - **A Redis error rejects.**
- **`getRemaining`** has no timeout and doesn't consult the cache (reviewer probe). It isn't used in v2.
- **Single-region `fixedWindow(tokens, window)`** (`:1524-1568`):
  - the key is `prefix:identifier:<bucket>`, with bucket = `floor(now / window)`;
  - the Lua script (`:179-199`) runs `INCRBY key rate`, then `PEXPIRE key window` when the key is new;
  - `success = used <= limit`;
  - **`reset = (bucket + 1) × window`**: the exact time the next window opens;
  - a blocked result goes into the cache until `reset`.
  - **`rate: -1` refunds:** `INCRBY -1`. If that creates the key (value −1), `PEXPIRE` still runs, so every key expires within one window. Negative rates skip the cache check (`:1531`), and a successful refund pops the cache entry (`:1557-1558`).
- **`"<n> ms"` durations** are accepted (the `ms()` regex, `:149`).
- **Cost:** fixed window is 3 commands on a first call, 2 on later calls (allowed or blocked), 0 when cache-blocked (upstash.com/docs/redis/sdks/ratelimit-ts/costs, fetched 2026-11-13). Analytics would add 1, and deny lists 2.
- **Analytics would store the identifier** (`submitAnalytics`). It stays off.
- With analytics off, `pending` is `Promise.resolve()`, so no `waitUntil` is needed.

### 4.2 `@upstash/redis` 1.41.0 (packed source)
- **Credentials:** `UPSTASH_REDIS_REST_URL` or `KV_REST_API_URL`, and `UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_TOKEN` (`nodejs.js:6904-6925`).
- **`new Redis({ url })` throws `UrlError` for a URL that isn't `https`,** and the message includes the whole URL (`chunk-CGMWROAN.mjs:21`). Reviewer probe: a pasted `rediss://default:<password>@host` puts the password in the message.
- **Retries** (`:130-136`, `:173-202`): on network errors only. The loop runs `retries + 1` times (default 6 tries, about 4.3 s of backoff). `retry: false` still makes 2 tries.
- **A `signal` option:** a *function* form `signal: () => AbortSignal` makes an abort throw; a plain signal turns an abort into a fake 200 (`:186-196`).
- **A non-2xx reply throws `UpstashError("<error>, command was: <JSON>")`.** The command includes the key.
- **Also:** keep-alive is on by default; `enableTelemetry` exists (`nodejs.js:6880`).
- **Auto-pipelining is on by default** (`enableAutoPipelining ?? true`, `nodejs.js:5300`): concurrent commands are batched to `/pipeline`, and an `UpstashError` then carries the whole batch, including other callers' (hashed) keys. v3 turns it off (`enableAutoPipelining: false`), so each check is its own request and its own failure.
- **Some bad configurations pass the constructor** and fail only at request time: an `https://user:pass@host` URL, or a token with trailing whitespace. They show up as an outage, not as a config problem. The token is trimmed before use.

### 4.3 Vercel (vercel.com/docs/headers/request-headers, fetched 2026-11-13)
"`x-forwarded-for`: The public IP address of the client … we currently overwrite the `X-Forwarded-For` header and **do not forward external IPs**. This restriction is in place to prevent IP spoofing." `x-real-ip` is identical. So `getClientIp` can't be spoofed on Vercel.

### 4.4 Sentry (`@sentry/nextjs` 10.x, reviewer check)
With `sendDefaultPii` unset, no HTTP bodies are collected (`@sentry/core … defaultPiiToCollectionOptions.js`: `httpBodies: []`), and local variables are off. A fetch breadcrumb carries only the Upstash base URL.

## 5. Invariants that must not break
1. **No raw IP, email or other identifier reaches Upstash, logs or Sentry.** Every shared identifier is an HMAC before any Redis call, on every path. Error *messages* from the Upstash client are never logged or reported, only error *names* (they can contain the key, §4.2, or a URL with a password, §4.2).
2. **Every Upstash key expires within 25 hours.** The script sets the expiry whenever a counter returns exactly the increment (a new key, or 0 → 1 after a refund), so a key lives at most until its window ends plus one more window: ≤ 2 h for the hourly limits. A static test pins every Upstash window at ≤ 12 h.
3. **Today's numbers and messages are unchanged** (Q4). The memory-mode limits (reports, API, export) aren't touched at all. The moved limits change only as Q4 states: clock-aligned windows, IPv6 /64.
4. **The Privacy Policy stays true.** Hashed IPs reach Upstash only for signing up (signup attempts, workspace-name lookups) and signing in (Q2, and password-reset requests, Q3, with the optional wording in Q3). Keys last ≤ 2 h.
5. **An Upstash failure never blocks a user, never hangs a request, never becomes a 500.** Every Redis call is aborted at 500 ms, then the memory limiter decides (Q1). After an outage, the process uses memory for 30 s before trying Upstash again.
6. **Security order is unchanged.**
   - The cron guard isn't touched (R12 stays as is).
   - Signup keeps its P5 order: Terms → lengths → Turnstile → the attempt limiter → slug → per-IP workspace limit.
   - Q2's gate runs before any database or password work.
7. **Tenancy:** the shared limits are global per IP, as today; no tenant data is involved.
8. **The append-only and DCAA rules are untouched.** The `login_attempts` rule only adds a constraint.

## 6. Design

### 6.1 Shared limits (new `src/lib/rate-limit/limits.ts`)
```ts
/** The limits shared across instances through Upstash (Q4). Report, API, export and cron limits stay in memory. */
export const SHARED_LIMITS = {
  slugLookup:    { limit: 30, windowMs: 60_000 },     // signup check + workspace finder, one budget
  signup:        { limit: 8,  windowMs: 3_600_000 },  // start + resend, one budget
  signInFailure: { limit: 20, windowMs: 900_000 },    // Q2
  resetRequest:  { limit: 10, windowMs: 3_600_000 },  // Q3
} as const;
export type SharedLimit = keyof typeof SHARED_LIMITS;
```
The Redis prefix is `cp-rl:<name>`, and the memory fallback key is `shared:<name>:<hash>`.

### 6.2 The store (new `src/lib/rate-limit/store.ts`)
**Import rule:** `rate-limit.ts` imports the store, and many tests import `rate-limit.ts`, some without a `server-only` mock (`v1-api-auth`, `export-route-auth`). So the store and everything it imports at the top (`limits.ts`, `identifier.ts`, `memory.ts`, `src/lib/ip-key.ts`, the two `@upstash/*` packages) must load in plain Node: no `server-only` and no database client. `signals.ts`, which is server-only and touches the control plane, is loaded **lazily** (`await import('./signals')`) only when an outage or a config problem is noted. Only server code imports the store.

```ts
export type Decision = { allowed: boolean; retryAfterMs: number; source: 'upstash' | 'memory'; resetAt: number }; // resetAt = when this count's window ends
export async function consume(name: SharedLimit, identifier: string): Promise<Decision>; // +1
export async function refund(name: SharedLimit, identifier: string, counted: Decision): Promise<void>; // −1 in the store and window that counted it, never throws
```
1. **Hash first:** `const id = rateLimitId(identifier)` (§6.3); only `id` is used below.
2. **Mode,** decided lazily on the first call and cached per process (with a test-only reset hook):
   - **`upstash`** when a URL, a token (trimmed) and a non-empty `SIGNUP_IP_SALT` are set (either naming, §4.2; read with `||`, so an empty value counts as unset and a blank `UPSTASH_REDIS_REST_URL=` from `.env.example` can't hide the Marketplace's `KV_*` values), **and** the clients build. The dev salt is never used with Upstash. The client is built inside `try`. On a throw, for example `UrlError`, the mode is `memory` and `noteConfigMissing(['UPSTASH_REDIS_REST_URL (invalid)'])` is called. The thrown message is never logged.
   - **`memory`** otherwise. On a Vercel deployment (`process.env.VERCEL === '1'`), `memory` raises `noteConfigMissing([...names missing])`. Local dev, tests and a local `npm run start` raise nothing.
   - The `Redis` client and the `Ratelimit` objects are built in **separate** `try` blocks. A `Redis` throw means "URL invalid"; a `Ratelimit` throw is a programming error, logged by name, with mode `memory` and `noteConfigMissing(['rate-limit setup'])`.
   - **Test seam:** `__setClientFactoriesForTests({ makeRedis(opts), makeRatelimit({ name, limit, windowMs, options }) })` defaults to the real constructors. `__resetForTests()` clears the mode, the circuit, the caches **and the memory store**.
3. **Client:**
   - `makeRedis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(500), enableTelemetry: false, enableAutoPipelining: false })`: 1 try, aborted at 500 ms, an abort throws, no batching.
   - One per name: `makeRatelimit({ name, limit, windowMs, options: { redis, limiter: Ratelimit.fixedWindow(limit, \`${windowMs} ms\`), prefix: \`cp-rl:${name}\`, timeout: 500, analytics: false, enableProtection: false, ephemeralCache: cacheFor(name), enableTelemetry: false } })`.
   - `cacheFor(name)` is a module `Map`. **Before each `limit` call**, if its size is over 10,000, it's cleared, so blocked identifiers that never return can't pile up on a long-lived instance.
4. **`consume`:**
   - If the circuit is open (an outage in the last 30 s in this process), use memory.
   - Otherwise `r = await ratelimit.limit(id)` in `try`:
     - `r.reason === 'timeout'` → outage;
     - a throw → outage;
     - else `{ allowed: r.success, retryAfterMs: r.success ? 0 : Math.max(0, r.reset - Date.now()), source: 'upstash', resetAt: r.reset }`. In memory, `resetAt` is the entry's `resetAt`.
5. **`refund(name, id, counted)`:** refunds **in the store and window that counted it**.
   - **First, if `Date.now() >= counted.resetAt - 1_000`, do nothing.** The window that held the count has ended (or nearly), and a −1 there would land in the next window and give away budget. Skipping errs toward one extra counted failure, never toward extra allowance.
   - `counted.source === 'upstash'`: `ratelimit.limit(id, { rate: -1 })` in `try`, errors swallowed (logged by name), and the circuit isn't consulted.
   - `counted.source === 'memory'`: the memory counter goes down by one, never below 0.
   - So a circuit change or a window rollover can't leave a stray −1 (no budget is ever created). It can leave a stray +1: for example, a 500 ms timeout after Redis already counted means the refund goes to memory. That errs toward counting, which is harmless.
6. **Outage:** open the circuit for 30 s; `noteOutage(err)` (§6.6); the decision comes from memory. The circuit has no half-open state: after 30 s the next calls try Upstash again. A slow-but-under-500 ms Upstash adds that time to each check (a sign-in makes two: consume and refund).
7. **Memory:** the `Map` and today's `checkRateLimit` logic move to **`src/lib/rate-limit/memory.ts`** (`memoryConsume`, `memoryRefund`, `memoryReset`). `rate-limit.ts` re-exports `checkRateLimit` from it, so there's no import cycle. Shared-limit keys are `shared:${name}:${id}`.
8. **Logging:** `console.error('[rate-limit]', name, 'upstash unavailable:', err?.name ?? 'Error')`. Never the message, never the identifier.

**State table: one `consume` (refund is the same with −1, and it never refuses)**

| Circuit / mode | Upstash result | Decision | Side effects |
|---|---|---|---|
| `upstash`, closed | allowed | allowed, `source: upstash` | — |
| `upstash`, closed | blocked | refused, `retryAfterMs = reset − now` | cached until reset |
| `upstash`, closed | `reason: 'timeout'` (500 ms) | memory decides | circuit opens 30 s; `noteOutage` |
| `upstash`, closed | throws (abort at 500 ms, network, `UpstashError`) | memory decides | circuit opens 30 s; `noteOutage` |
| `upstash`, open (< 30 s since an outage) | not called | memory decides | — |
| `memory` (URL, token or salt missing, or a client didn't build) | not called | memory decides | on Vercel, `noteConfigMissing` |

### 6.3 Identifiers (new `src/lib/rate-limit/identifier.ts`)
```ts
/** HMAC-SHA256(secret, "cp-rate-limit:v1:" + value), hex. */
export function rateLimitId(value: string): string;
/** 'ip:' + the normalized IP (IPv4; IPv6 /64; IPv4-in-IPv6 → IPv4), or 'ip:unknown'. */
export function ipIdentifier(ip: string): string;
```
- **The secret is `SIGNUP_IP_SALT`.** It's already a required production secret (PRODUCTION-DEPLOY `:339`), so no new secret is needed. The label and the HMAC make a rate-limit key differ from any `signups.ip_hash`, so the two can't be joined.
- **Without the salt:** `memory` mode everywhere (never Upstash), hashing with a random per-process secret. On Vercel also `noteConfigMissing(['SIGNUP_IP_SALT'])`. The public dev salt is never used, so no key at Upstash can be reversed with it.
- **`signupIpKey` moves** into a new module without `server-only`, `src/lib/ip-key.ts`, and `controls.ts` re-exports it. So the identifier code loads in plain unit tests, and the normalization rule stays in one place.

### 6.4 Public API (`src/lib/rate-limit.ts`)
- **Unchanged:** `checkRateLimit` (re-exported from `memory.ts`), `getClientIp`, `getClientIpFromHeaders`, `rateLimitResponse`, `checkReportRateLimit` and `checkCronRateLimit`. Their callers (reports, API, export, cron) aren't edited.
- **Changed to async:** `checkSlugLookupRateLimit(ip): Promise<{ allowed; retryAfterMs }>`, through `consume('slugLookup', ...)`.

### 6.5 Callers changed (same order, same messages)
| Caller | Change |
|---|---|
| `signup/check/route.ts:8`, `workspace-finder.ts:36` | `await checkSlugLookupRateLimit(…)` |
| `signup.ts:75`, `:144` | `(await consume('signup', ipIdentifier(ip))).allowed`, same messages and position |

**A missing `await`** on these calls fails `tsc` (`.allowed` on a Promise); T13 also pins each `await`.

### 6.6 Alerts (new `src/lib/rate-limit/signals.ts`, server-only)
- **`signup/signals.ts` exports** `recordWindowedSignal(key, now)` and `lastSignalAt(key)` (no other change).
- **`noteOutage(err)`:**
  - at most **once a minute per process** (a module timestamp), it schedules `after(...)` (falling back to an unawaited promise if `after` throws outside a request scope), running `recordWindowedSignal('rate-limit-outage', now)`. **No per-signal Sentry event:** a long outage, such as a reached cap, would otherwise send one a minute per instance and use up the Sentry quota. The one Sentry message comes from `raiseAlertWithEmail` when the alert opens (`ops-alert-email.ts:27`);
  - at **3 signals within an hour** (counted across instances in the control plane), `raiseAlertWithEmail({ tenantId: null, kind: 'rate-limit-outage', summary: 'Upstash rate limiting failed 3 times within an hour; sign-in and signup limits are falling back to per-instance memory.' })`;
  - errors inside are caught and logged by name.
- **`noteConfigMissing(names)`:** at most once an hour per process, scheduled the same way: `raiseAlertWithEmail({ kind: 'rate-limit-config-missing', summary: 'Rate limiting isn't configured on this deployment (<names>); sign-in and signup limits are per-instance memory only.' })`.
- **`resolveRateLimitSignals(now)`**, called by the notice-delivery cron right after `resolveSignupSignals()`:
  - resolves `rate-limit-outage` when `lastSignalAt` is over an hour ago;
  - resolves `rate-limit-config-missing` when the cron's own environment has a URL, a token and `SIGNUP_IP_SALT`, and both the `Redis` client and the `Ratelimit` objects build (the same builder the store uses), so a `'rate-limit setup'` alert doesn't flap.

**Alert states (per kind)**

| State | Event | Result | Side effects |
|---|---|---|---|
| none | 1st–2nd outage signal within an hour | none | counter +1 |
| none | 3rd signal within an hour | open | one email (dedup while open) |
| open | more signals | open | counter +1, no new email |
| open | cron, last signal over an hour ago | resolved | `resolveAlert` |
| resolved | a new 3rd signal within an hour | a new open alert | a new email |
| none | a Vercel request in `memory` mode | open (config) | one email |
| open (config) | cron sees a valid config | resolved | — |

### 6.7 New limits (Q2, Q3)
**Q2: failed sign-ins (`src/auth.ts`).**
1. **Wiring:** `authorize: (credentials, request) => authorizeCredentials(credentials, getClientIp(request))`. The signature becomes `authorizeCredentials(credentials, ip = 'unknown')`, and the existing test callers keep working.
2. **Input types first:** `if (typeof credentials?.email !== 'string' || typeof credentials?.password !== 'string' || !credentials.email || !credentials.password) return null;`.
   - It comes before the gate, so nothing is counted and nothing is checked.
   - Auth.js accepts a JSON body (`@auth/core/lib/utils/web.js:10`), so a numeric `password` would otherwise reach bcrypt and throw.
3. **The gate, then exactly one refund site.** The existing body (from `getDbForAuth` to `recordSuccessfulLogin`) moves unchanged into `authorizeChecked(…)`, which returns the user, returns `null`, or throws. Then:
   ```ts
   const ipId = ipIdentifier(ip);
   const gate = await consume('signInFailure', ipId);
   if (!gate.allowed) throw new SignInRateLimited(); // class … extends CredentialsSignin { code = 'rate_limited' }; never refunded
   let refundDue = false;
   try {
     const user = await authorizeChecked(email, password, mfaCode); // records the success before returning
     if (user) refundDue = true;                                    // success
     return user;                                                   // null = a counted failure
   } catch (e) {
     if (e instanceof MFARequiredSignin || !(e instanceof CredentialsSignin)) refundDue = true; // MFA step, or an infrastructure error
     throw e;                                                       // MFAInvalidSignin and other CredentialsSignin keep the count
   } finally {
     if (refundDue) await refund('signInFailure', ipId, gate);      // the ONLY refund call: at most once per attempt
   }
   ```
   - **Counted:** every attempt, atomically (Upstash's script, or in-process in memory), so parallel requests can't all pass.
   - **Refunded:** success, `MFARequiredSignin`, and unexpected exceptions *thrown* by the body (a workspace-database error in `getLockoutInfo`, the user query, `recordFailedAttempt`/`recordSuccessfulLogin`, bcrypt, `decrypt` or the recovery-code transaction). So an office retrying through a workspace-database outage doesn't block itself.
   - **Kept:** workspace not found, locked, unknown user, wrong password, wrong MFA code.
   - **Kept, by the existing code:** `getDbForAuth` failures. Today that call is wrapped in a `try` that returns `null` (`src/auth.ts:43-50`), which covers an unknown or closed workspace and also a control-plane or registry outage. That stays unchanged, so those attempts count. **Accepted:** sign-in fails during a control-plane outage anyway, and the count clears within 15 minutes. Splitting "not found" from "outage" would mean matching error messages; not worth it.
   - **The refund is skipped once the window has rolled over** (§6.2 item 5), so a refund can only cancel a count made in the same window. A counter can therefore never go below 0, and budget can't be built up.
4. **No `ip` reaches `login_attempts`.** The `ipAddress` parameter is removed from `recordFailedAttempt` and `recordSuccessfulLogin` (§6.8).
5. **The form** (`LoginForm.tsx`): `if (result?.code === 'rate_limited') setError('Too many failed sign-in attempts from your network. Try again in 15 minutes.')`, placed before the generic branch.
6. **The per-email lockout is unchanged.**

**Q3: reset requests (`password-reset.ts`).**
- **Placement:** after input normalization and the workspace (slug) check, before the per-email cap: `if (!(await consume('resetRequest', ipIdentifier(getClientIpFromHeaders(await headers())))).allowed) return <the same generic success result>`. No email and no write. An early return that happens before it (no workspace) isn't counted, which is fine since it sends nothing.

### 6.8 `login_attempts.ip_address` stays empty
1. **The schema:** add the extra-config callback to `loginAttempts`: `(table) => [check('login_attempts_no_raw_ip', sql\`${table.ipAddress} IS NULL\`)]`. Then `npm run db:generate` gives the next tenant migration (`drizzle/0019_*.sql`), expected to be `ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_no_raw_ip" CHECK ("login_attempts"."ip_address" IS NULL);`. The dev confirms the generated SQL is only that statement.
2. It's expand-only, so `db:safety` passes with no opt-out, and the live code never writes the column.
3. **Remove the `ipAddress?` parameter** from `recordFailedAttempt` / `recordSuccessfulLogin` (`login-attempts.ts:140-169`) and the `ipAddress` key from their inserts.
4. **Pre-check before each environment's migration:** `SELECT count(*) FROM login_attempts WHERE ip_address IS NOT NULL` per tenant must be 0 (§12, step 5). Nothing writes the column, so 0 is expected.

## 7. States
The state tables are in §6.2 (one check) and §6.6 (alerts). There's no other persisted state.

## 8. Failure modes

| What happens | Result | Handling |
|---|---|---|
| Upstash down or slow | aborted at 500 ms, or the library's 500 ms timeout | memory decides; circuit opens for 30 s (later checks skip Upstash); `noteOutage`. Worst added latency: 500 ms, once per process per 30 s |
| A URL with `user:pass@`, or a bad token | passes construction, fails per request | shows as an outage (outage alert), not a config alert; the token is trimmed; the message is never logged |
| A cached block on one instance | that instance refuses until the window ends, even if refunds elsewhere brought the count under the limit | accepted: at most one window |
| `UpstashError` (bad token, quota or cap reached) | thrown | the same as down. The alert stays open while it persists |
| Malformed URL (e.g. a pasted `rediss://…` with a password) | `UrlError` at build time, caught | `memory` mode; config alert naming "UPSTASH_REDIS_REST_URL (invalid)"; the message (with the password) is never logged |
| Env or salt missing on Vercel | `memory` mode | config alert |
| Parallel sign-in attempts (Q2) | each is counted atomically before any work | at most 20 failures per IP per window across instances |
| Fixed-window boundary | up to 2× the limit across two adjacent windows | accepted for these low-volume limits (Q4); exact `Retry-After` |
| A refund would land in the next window | skipped (§6.2 item 5: no refund at or after `resetAt − 1 s`) | the counter never goes below 0; at worst one extra counted failure |
| A non-string email or password (JSON body) | `null` before the gate | nothing counted, nothing checked (§6.7 item 2) |
| The control plane is down during `noteOutage` | the signal write fails | caught inside `after`; logged by name; the request is unaffected |
| A blocked client keeps retrying | the ephemeral cache answers with no Redis call | the cache is cleared above 10,000 entries |
| The migration meets a non-null `ip_address` | the migration fails and the deploy stops before the new code | the §12 pre-check; 0 rows expected |
| **Existing, not changed:** the per-email lockout is check-then-record | parallel guesses at one account can pass the check together | Q2's per-IP gate bounds it to 20 per IP per window; recorded for a later hardening pass |
| Cost burn by an attacker (Q5) | 2 commands per request until the per-instance cache blocks; ~4 per own-account sign-in | with alerts and no hard cap, cost scales with the attacker's effort; you get the $5 and $10 alerts |
| Sign-in during a workspace-database outage (Q2) | the exception path refunds | no self-lockout after recovery |
| Sign-in during a control-plane outage (Q2) | `getDbForAuth` throws and the existing `catch` returns `null`, counted | sign-in was failing anyway; an office that retried 20+ times may wait up to 15 minutes after recovery (accepted, §6.7) |

## 9. Platform limits
- **Latency:** functions run in `iad1` and Upstash in us-east-1. A REST call usually takes a few milliseconds, and each one is aborted at 500 ms.
- **Fluid compute:** one `Redis` client and one `Ratelimit` per name per process, reused. Keep-alive is on; the circuit and caches are per process.
- **Commands:** 2–3 per check (§4.1). Expected volume, roughly per month: sign-ins (1 consume + 1 refund each), signups and lookups (a few), resets (a few). Thousands to tens of thousands of commands, against the 500,000 free.
- **A flood** costs 2 commands per request until the per-instance cache blocks it; Q5's alerts make it visible.
- **Key life:** at most two windows (≤ 2 h).

## 10. Blast radius

### 10.1 Changed
| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `@upstash/ratelimit` `2.2.1`, `@upstash/redis` `1.41.0`, exact |
| `src/lib/rate-limit.ts` | the `Map` moves to `memory.ts` (re-exported); `checkSlugLookupRateLimit` async through the store (§6.4) |
| `src/lib/rate-limit/{limits,store,identifier,memory,signals}.ts` (new) | §6.1–§6.3, §6.6 |
| `src/lib/ip-key.ts` (new), `src/lib/signup/controls.ts` | `signupIpKey` moves; `controls.ts` re-exports it |
| `src/lib/signup/signals.ts` | export `recordWindowedSignal`, `lastSignalAt` |
| `src/app/signup/check/route.ts`, `src/server/actions/workspace-finder.ts`, `src/server/actions/signup.ts` | §6.5 |
| `src/app/api/cron/notice-delivery/route.ts` | `resolveRateLimitSignals(now)` |
| `src/auth.ts`, `src/app/login/LoginForm.tsx` | Q2 (§6.7) |
| `src/server/actions/password-reset.ts` | Q3 |
| `src/server/internal/login-attempts.ts`, `src/db/schema.ts`, `drizzle/0019_*.sql`, `drizzle/meta/*` | §6.8 |
| `.env.example` | `UPSTASH_REDIS_REST_URL=` and `UPSTASH_REDIS_REST_TOKEN=`, blank, with a comment that `KV_REST_API_*` works too and local dev leaves them empty |
| **Existing tests to update** | see the list below |

**Existing tests to update:**
- `signup-ops.test.tsx:197-200`: also mock `@/lib/rate-limit/signals` (a separate module; don't add to the `@/lib/signup/signals` mock).
- `password-reset.test.ts` (unit and integration): mock `next/headers`.
- `authorize-mfa-code.test.ts`, `mfa-signin.test.ts`, `account-security.test.ts`: the optional `ip` argument. They should pass unchanged in memory mode; the dev confirms.
- Any test that mocks `checkSlugLookupRateLimit`: return a promise.
- Plus the new tests in §11.
- Note for future tests: callers of `authorizeCredentials` without an `ip` share the `ip:unknown` budget of 20 failures per test file (each file is its own process). Existing files stay under it (5–6 failures each). New tests that make many failures pass a distinct IP.

### 10.2 Checked, unchanged
- The report routes, `api-auth.ts`, the export route, `cron-auth.ts`, `run-cron.ts`: memory, untouched. `v1-api-auth.test.ts` and `export-route-auth.test.ts` still load the store through `rate-limit.ts`, and must pass unmodified (§6.2's import rule; T1 also checks the identifier module loads without a `server-only` mock).
- The per-email lockout logic and the reset cap.
- `hashSignupIp`, `signups.ip_hash`, Turnstile.
- The Privacy Policy and Terms text.
- The workspace export (it excludes `login_attempts`).
- Seeders (none writes `ip_address`).
- `check-build-trace.mjs`: it picks up the new migration file automatically.

### 10.3 For the lead (on this branch at audit time)
- **`PRODUCTION-DEPLOY.md`:**
  - Phase 6 env table: the Upstash URL and token (either naming) for staging and production;
  - a founder step: two Upstash databases (staging and production) through the Marketplace, in us-east-1, with the Q5 alerts;
  - a Phase 12 step (§12, step 5);
  - the Phase 15 row marked done after the merge.
- `DEPLOY-DEMO.md:264` (it lists Upstash as future work).
- `LAUNCH-TRACKER.md`.

## 11. Required tests (each must fail without the change it proves)
- **The Upstash path** is tested through `__setClientFactoriesForTests` (§6.2): `makeRedis` captures the Redis options; `makeRatelimit` receives `{ name, limit, windowMs, options }` and returns a fake whose `limit` returns allowed or blocked results, `reason: 'timeout'`, or throws, and records every identifier and `rate`. `__resetForTests()` runs in `beforeEach`.
- **The real Upstash path** is checked at staging (§12, step 5), and locally if the product owner provides a test database (§12, step 4).

| # | Scenario | Where | Asserts | Fails without |
|---|---|---|---|---|
| T1 | Hash, never raw; import rule | unit `rate-limit-identifier.test.ts` (**no** `server-only` mock) | `rateLimitId(x)` is 64 hex; it isn't `x` or `hashSignupIp(ip)`; it's stable, and differs per value. IPv6 addresses in one /64 give one id; `::ffff:203.0.113.5` equals `203.0.113.5`. Importing `@/lib/rate-limit` and `@/lib/rate-limit/store` succeeds with no `server-only` mock | §6.2 import rule, §6.3 |
| T2 | Nothing raw reaches Upstash | unit `rate-limit-store.test.ts` | for each of the 4 names, `consume` / `refund` with `ipIdentifier('198.51.100.7')`: every identifier the fake recorded matches `/^[0-9a-f]{64}$/`, and none contains `198.51.100.7` | §6.2 item 1 (revert check: pass `identifier`) |
| T3 | Construction | same | `makeRatelimit` receives, per name, `limit`/`windowMs` equal to `SHARED_LIMITS[name]` and options with `prefix 'cp-rl:<name>'`, `timeout 500`, `analytics false`, `enableProtection false`, `enableTelemetry false`, and an `ephemeralCache` Map. `makeRedis` receives `retry { retries: 0 }`, a function `signal`, `enableAutoPipelining false`, `enableTelemetry false`, and the trimmed token. No network | §6.2 item 3 |
| T4 | Expiry ≤ 25 h | static | every `SHARED_LIMITS[*].windowMs` ≤ 12 h; the longest is 1 h | invariant 2 |
| T5 | Allowed / blocked | store test | fake success → allowed, `source upstash`; fake blocked with `reset` = now + 30 s → refused, `retryAfterMs` ≈ 30,000 | §6.2 item 4 |
| T6 | Timeout → memory, not allow | store test | fake `{ success: true, reason: 'timeout' }` → `source memory`; after `limit` more calls, memory refuses | §6.2 item 4 (revert check: treat timeout as allowed) |
| T7 | Throw → memory, circuit | store test, fake timers, the factories set | the fake rejects once: `source memory`, no throw, `noteOutage` called once. The next 29 s of calls don't touch the fake; after 30 s it's called again | §6.2 items 4, 6 |
| T8 | Invalid URL | store test (factories reset to the real constructors) | `UPSTASH_REDIS_REST_URL='rediss://default:secret@x'` + a token + a salt, with the real `Redis` constructor: mode `memory`; `noteConfigMissing` called with `'UPSTASH_REDIS_REST_URL (invalid)'`; no `console.*` argument contains `secret` | §6.2 item 2 |
| T9 | Mode / config alert | store test | no env → `memory`, factories never called. `KV_REST_API_*` + salt → `upstash`. URL and token but **no salt** (or `''`) → `memory`. `VERCEL=1` with something missing → `noteConfigMissing` once, naming it. `NODE_ENV=production` without `VERCEL` → none | §6.2 item 2, §6.3 |
| T10 | Logs carry no key | store test | a throw with message `'ERR x, command was: [["evalsha","…","cp-rl:signup:<hash>:1"]]'` → the logged arguments contain the error name only | §6.2 item 8 |
| T11 | Refund | store test | with a `Decision` whose `resetAt` is in the future, `refund(…, { source: 'upstash', … })` calls the fake with `{ rate: -1 }` and the hash even while the circuit is open; a fake throw is swallowed. `refund(…, 'memory')` never calls the fake. In memory, consume ×3 + refund ×1 leaves 2 used; refund never goes below 0 | §6.2 items 5, 7 |
| T12 | Signals | unit `rate-limit-signals.test.ts`, mocked `after`, `recordWindowedSignal`, `raiseAlertWithEmail`, `@sentry/nextjs` | 50 `noteOutage` calls in a minute → 1 signal and **0** `Sentry.captureException`; count 3 → the `rate-limit-outage` email; 2 → none. `resolveRateLimitSignals`: last signal over an hour ago → resolved; under an hour → not. Config present → config resolved. notice-delivery calls it (static) | §6.6 |
| T13 | Awaits and names | static over the §6.5 files | `await checkSlugLookupRateLimit(` ×2; `await consume('signup'` ×2; none of those files calls `checkRateLimit(` | §6.5 (revert check: drop one `await` → `tsc` or the static check fails) |
| T14 | Memory limits untouched | static (file content only, no git) | the 6 report routes still call `checkReportRateLimit(`; `api-auth.ts` and the export route still call `checkRateLimit(`; `cron-auth.ts` still calls `checkCronRateLimit(`; none of these files imports `@/lib/rate-limit/store` or calls `consume(` | Q4 split |
| T15 | Shared budgets | unit, driving the real callers (memory mode, `__resetForTests` per case; `next/headers` mocked to one IP) | 15 `GET /signup/check` + 15 `goToWorkspace` calls exhaust one budget (the 31st of either is refused). Signup start + resend share 8 | §6.1 (revert check: rename one caller's limit) |
| T16 | Memory limiter unchanged | `rate-limit.test.ts` | today's four `checkRateLimit` cases still pass, plus `memoryRefund` | regression |
| T17 | (Q2) Sign-in limit | integration `signin-ip-limit.test.ts` (real tenant DB; memory mode forced by deleting `UPSTASH_*`/`KV_*` and calling `__resetForTests()` in `beforeEach`; a distinct IP per scenario; DB errors injected with the `vi.mock(…, importOriginal)` pattern of `account-security.test.ts`, not ESM spies) | 20 failed `authorizeCredentials(…, '203.0.113.9')` calls across 5 emails (4 each, under the lockout), then the 21st with the **right** password → throws code `rate_limited` and writes no `login_attempts` row. A different IP still signs in. 25 successful sign-ins from one IP all pass (refunds). A wrong MFA code counts; `MFARequiredSignin` doesn't. A locked account's attempts count. A forced database error (mock `getLockoutInfo` to throw) is refunded and rethrown | §6.7 Q2 |
| T18 | (Q2) Parallel | same | 50 concurrent wrong-password attempts from one IP → exactly 30 throw `rate_limited` and 20 return `null` | §6.7 item 2 (revert check: move the gate after bcrypt) |
| T19 | (Q2) Form text | extend `unit/login-form.test.tsx` | `code: 'rate_limited'` shows exactly the Q2 sentence | §6.7 item 5 |
| T20 | (Q3) Reset limit | integration, `next/headers` mocked to one IP, `@/lib/email/send` mocked with `flushAfter()` (the existing pattern) | 10 requests for 10 emails in one workspace send 10; the 11th returns the same generic result and sends none | §6.7 Q3 |
| T21 | `ip_address` stays empty | integration + static | insert with `ip_address '1.2.3.4'` → violates `login_attempts_no_raw_ip`; `NULL` works. `login-attempts.ts` has no `ipAddress` parameter or key (static). `db:safety` passes | §6.8 |
| T23 | (Q2) Exactly one refund, right outcomes | unit `authorize-refund.test.ts`, `@/lib/rate-limit/store` mocked (`consume` allows, `refund` spied); the auth body's DB calls mocked as `authorize-mfa-code.test.ts` does | `refund` is called **exactly once** for success, for `MFARequiredSignin`, and for an unexpected exception (a mocked `getLockoutInfo` or user query that throws `Error`, or `recordSuccessfulLogin` throwing after success). A mocked `getDbForAuth` that throws gives `null` and **zero** refunds (existing behaviour, §6.7). It's called **zero** times for: a `null` return (wrong password, unknown user, locked), `MFAInvalidSignin`, and `rate_limited` (consume refused). A numeric password returns `null` with **no** `consume` call | §6.7 items 2–3 (revert checks: add a second refund in the MFA branch → 2 calls; drop the type check → `consume` called) |
| T24 | No refund across a window | store test, fake timers | `consume` (memory and fake-upstash) → advance past `resetAt − 1 s` → `refund` does nothing (fake not called; memory count unchanged). Within the window, it refunds | §6.2 item 5 (revert check: remove the skip) |
| T22 | Regressions | existing | every test listed in §10.1 passes after its update; the report, API and export tests pass untouched | guard |

**Revert checks.** For T1–T13, T15, T17–T21 and T23–T24, the dev names the one targeted edit that makes each test fail and confirms the failure. T16 and T22 are guards; T14 is a guard over the untouched files.

## 12. Verification
1. Gates: `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`. Plus a dev and audit step, not a test (CI checks out depth 1, so there's no `main` ref): `git diff main -- src/lib/cron-auth.ts src/lib/cron/run-cron.ts src/lib/api-auth.ts src/app/api/export src/app/api/reports` is empty.
2. Integration (the integration setup migrates; the local tenants need `npm run demo:local` for the new constraint):
   ```bash
   REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
3. `npm run build`; `npm run demo:local`.
4. **Checks, run by the lead** (`UPSTASH-RATE-LIMITING-BROWSER-CHECKS.md`; preview browser plus scripts, memory mode locally):
   - (Q2) 20 failed sign-ins, then the new message in the browser; a successful sign-in from a fresh session still works after a few failures;
   - (Q3) the generic reset message, and no email, on the 11th request;
   - the signup and workspace-finder limits still trip at their numbers;
   - downloads, the API and the cron guard unchanged.
   - **Optional:** if the product owner creates a free Upstash test database and gives the lead its REST URL and token for local use, the same checks in `upstash` mode, plus a REST `SCAN` showing only `cp-rl:<name>:<64-hex>:<bucket>` keys with `PTTL` ≤ 2 windows.
5. **Staging rehearsal** (PRODUCTION-DEPLOY Phase 12, a new step the lead writes):
   - **before** deploying: confirm the staging project's Upstash env vars, and run the `login_attempts` pre-check on each staging tenant;
   - **after:** 3 failed sign-ins and 1 successful one; then the Upstash console's Data Browser shows only `cp-rl:*` keys with 64-hex hashes and TTLs ≤ 30 minutes, with no IP or email;
   - **then** remove the token from the **staging** project and redeploy: the `rate-limit-config-missing` email arrives and sign-in still works. Restore the token and redeploy: the alert resolves at the next notice-delivery run.

## 13. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
1. Write the impact analysis (`UPSTASH-RATE-LIMITING-IMPACT-ANALYSIS.md`, uncommitted) before coding, and stop for the lead's review.
2. Invariant 1: every shared identifier goes through `rateLimitId` inside the store; Upstash error messages are never logged or reported.
3. Don't touch the report, API or export limits (Q4). The numbers come only from `SHARED_LIMITS`.
4. No Upstash analytics, deny lists, dynamic limits or multi-region. Pin the exact package versions.
5. Commit on `upstash-rate-limiting` only, staging files by name. Never push.

## 14. Pre-mortem log
- **Round 1** (2026-11-13; two independent reviewers: runtime, security and privacy; blast radius, tests and scope). **1 HIGH, 12 MEDIUM, 12 LOW. All fixed in v2, mostly by a redesign.**
  - HIGH: the Q2 gate was peek-then-consume, so parallel requests passed together. It's now consume-first with refunds on success or MFA-required, verified in the 2.2.1 fixed-window Lua; T18 runs 50 in parallel.
  - MEDIUM, scope and cost (Q4): moving the API and reports would cost about $35–70 a month for one busy integration, and would store hashed IPs the Privacy Policy doesn't describe. That became the split: only sign-up and sign-in limits move (cron failures too in v2; kept in memory from v3). It also resolves the privacy finding.
  - MEDIUM: the sliding window's `Retry-After` understated the wait. It's now a fixed window with an exact reset.
  - MEDIUM: IPv6 /64 grouping and the algorithm change weren't told to the product owner. Now in Q4.
  - MEDIUM: T18 couldn't pass because of the lockout. Now 5 emails × 4, and locked attempts count by design.
  - MEDIUM: `new Redis` throws `UrlError` with the full URL (a pasted password). Lazy, caught, never logged; T8.
  - MEDIUM: the `ipAddress` parameter was left open next to a CHECK that would 500 every sign-in. It's removed; T21 is static.
  - MEDIUM: unmocked `server-only` in importing tests. `signupIpKey` moves to a plain module; the store and its top-level imports have no `server-only` (the alerts load lazily), so tests importing `rate-limit.ts` keep loading. T1 checks it.
  - MEDIUM: missed test updates (`signup-ops`, `password-reset`, the MFA tests, `lastSignalAt`). Listed.
  - MEDIUM: floating promises on Vercel. Now `after()` with a fallback.
  - MEDIUM: the preview-deploy check was impossible (Production-only env vars). Now the staging project.
  - LOW: `retry: false` still makes 2 tries; an abortable fetch with a function signal; a 30 s circuit; the cache cap; `VERCEL=1` for "production"; `recordWindowedSignal(key, now)`; the budget cap (Q5); the drizzle SQL form; the missing-`await` hazard in cron (T13/T14); the smoke-script re-run; line references.
- **Round 2** (2026-11-13; two fresh reviewers, same split). **0 HIGH, 4 MEDIUM, 17 LOW. All fixed in v3.** Both confirmed the redesign's core: the fixed-window refund Lua, abort semantics, the `rate_limited` code path, `after()` in Auth.js, no MFA oracle, drizzle generating exactly the one constraint.
  - MEDIUM: per-signal Sentry events would use up the quota in a long outage. Removed; the alert's one message stays.
  - MEDIUM: a hard $10 cap can be reached on purpose to switch protection off. Q5 now recommends alerts at $5 and $10, not a cap.
  - MEDIUM: Q2 didn't tell you a shared office address shares one budget, and that a correct password can't skip the block. Now stated, with 50 as the alternative.
  - MEDIUM: T3 couldn't see the fixed-window settings or the Redis options. Now a two-factory test seam.
  - LOW:
    - the refund goes to the store that counted it;
    - key life is ≤ 2 windows (wording);
    - cron stays in memory (privacy and command cost);
    - no dev salt with Upstash (salt required for the mode);
    - the memory module breaks the import cycle;
    - auto-pipelining off;
    - a `user:pass@` URL or bad token shows as an outage;
    - exceptions refund;
    - cache and circuit edge cases documented;
    - 500 ms timeouts;
    - the separate mock for `rate-limit/signals`;
    - test isolation (reset hook, distinct IPs);
    - Q3's privacy note;
    - Q3's placement;
    - the email-mock pattern;
    - the publish date;
    - `DEPLOY-DEMO.md`.
- **Confirmation pass 1** (2026-11-13, one fresh reviewer). It confirmed every round-2 fix. **3 MEDIUM, 4 LOW, all fixed in v3.1:**
  - MEDIUM: the refund sites were ambiguous. Two refunds for one MFA step would push Upstash below 0 and build unlimited budget. Now one `finally` site behind one flag; T23 pins exactly-once.
  - MEDIUM: a refund landing in the next window compounded the budget, and a numeric JSON password could force the "unexpected exception" refund. Refunds are now skipped once the window has rolled over (the counter can't go below 0; T24), and non-string credentials return `null` before the gate.
  - MEDIUM: T13/T14 relied on `git diff main`, which doesn't exist in CI's shallow checkout. Now content-only checks, with the git diff as a dev and audit step.
  - LOW: stale wording; `resolveRateLimitSignals(now)`; §3.3 line drift; env read with `||` (empty = unset); the config alert resolution builds the `Ratelimit` too (no flapping); T17/T18 force memory mode and use the existing mock pattern.
- **Confirmation pass 2** (2026-11-13, one fresh reviewer). It confirmed the single refund site (every outcome traced: at most one refund) and the window-rollover skip (the counter stays ≥ 0, no budget accumulates). **1 MEDIUM, 4 LOW, fixed in v3.2:**
  - MEDIUM: a `getDbForAuth` failure returns `null` in today's code, so it counts, and isn't refunded as T23 and §8 claimed. That covers a control-plane outage. Now stated and accepted (§6.7, §8), with T23 using `getLockoutInfo` instead.
  - LOW: the stray +1 wording; T11 needs a future `resetAt`; T15 now drives the real callers; table order.
- **Confirmation pass 3** (2026-11-13, one fresh reviewer). **CLEAN: 0 HIGH, 0 MEDIUM, 4 LOW, written into v3.3.** It verified every v3.2 fix against the code, that T15/T23 are buildable and fail on their reverts, the library behaviours, that no URL, token or key is logged, that existing tests stay under the shared default budget, and that CI stays in memory mode. The LOWs: the `SHARED_LIMITS` name and the Q2 drop list; the `getDbForAuth` wording in §8; a note on the `ip:unknown` budget for future tests; where the cache-size check runs.
