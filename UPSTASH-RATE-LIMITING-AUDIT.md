# Audit: shared rate limits with Upstash (build queue 6)

> **Verdict: READY** at `0315163` (fix round 1 verified). No HIGH or MEDIUM remains in the code. The checks were **run by Planning** against the finished code (product owner's process, 2026-11-13), and the results with evidence are in §6 for the product owner to review.
>
> **Audited:** `c3e3ad8`, then fix round 1 at `0315163`, on `upstash-rate-limiting`, against `feature-plan-upstash-rate-limiting.md` FINAL v3.3 plus the approved implementation details F1–F3 and D1–D9 (`LAUNCH-TRACKER.md`, item 6 note).
>
> **Lead:** CadenzPoint Planning, 2026-11-13.

## 1. Scope check
- **Files:** 36 in the dev commit, all in the blueprint's §10.1 set or its tests, plus the migration snapshot and the lockfile (only the two pinned `@upstash/*` packages and their two dependencies).
- **No product change outside Q1–Q5:**
  - the report, API, export and cron files are untouched against `02059b0` (an empty diff);
  - the 429 bodies and messages are unchanged;
  - the only new user-facing text is Q2's sign-in message, word for word.
- **Fix round 1** (`0315163`): one line in `src/auth.ts`, one read-only test hook in `memory.ts`, and tests.

## 2. Gates (lead, at `c3e3ad8` and again at `0315163`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `eslint` on the changed files | 0 errors; 3 warnings, all on pre-existing lines of `LoginForm.tsx` |
| `npm run test` | 238 files, 2,621 tests (then **2,629** after the fix round), all passed |
| `npm run db:safety` | ✓; `drizzle/0019_huge_starfox.sql` is exactly `ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_no_raw_ip" CHECK ("login_attempts"."ip_address" IS NULL);` |
| Dev's report | integration 90 files / 738 tests passed (2 isolation files need env not set here); `npm run build` ✓; `test:tz` ✓ in 3 zones |

## 3. Independent review
- **Break-it** (`/tmp/6-breakit/breakit.mjs`, uncommitted; exact-text mutations of product code, each run against its test file, two of them against the integration suites on the real database): **15 of 15 caught** at `c3e3ad8`, and **16 of 16** at `0315163`. The 16th is the new wiring pin. The mutations:
  - **Hashing and Upstash settings:** the raw identifier sent; a timeout treated as allowed; a refund across a window; auto-pipelining on; the circuit never opening; the salt not required; a 1 s timeout.
  - **Sign-in refunds:** success not refunded; MFA-required not refunded; exceptions not refunded; the length check removed; the provider dropping the IP.
  - **The rest:** the form message changed; the outage threshold; the sign-in limit at 21; the reset gate removed.
- **Auditor A (runtime, security and privacy; own worktree):**
  - **Real packages, stubbed `fetch`** (`@upstash/redis` 1.41.0 and `@upstash/ratelimit` 2.2.1, no network):
    - every key is `cp-rl:signInFailure:<64 hex>:<bucket>`, and the raw IP is never in a body, URL or header;
    - single requests, one try;
    - 40 concurrent calls → exactly 20 allowed;
    - a refund returns the counter to 0;
    - an Upstash error logs only `UpstashError`;
    - a hang is aborted at about 500 ms (no unhandled rejection);
    - a `rediss://…:password@…` URL → memory mode, a config alert, nothing logged.
  - **Its own mutations:** 24 of 30 caught.
  - **Found:** one MEDIUM (§4, M1) and five test-gap LOWs.
- **Auditor B (tests, scope, migration, checks and deploy steps; own worktree):**
  - **Code, tests and migration clean:** 20 of 20 of its own reverts failed their tests; the migration snapshot and journal are consistent; nothing else writes `ip_address`.
  - **Its five MEDIUMs were in Planning's checks file and step 12.14.** I'd already found and fixed three of them while running the checks (§6).

## 4. Findings
| # | Severity | Where | Finding | Status |
|---|---|---|---|---|
| M1 | MEDIUM | `src/auth.ts` (F2) | The 255-character check ran on the raw email, before lowercasing. Some characters grow when lowercased: `'İ'.repeat(240)+'@example.com'` is 252 characters raw and 492 lowercased. It passed, the `varchar(255)` insert threw, and the attempt was refunded, giving unlimited uncounted attempts (database cost; no password guessing). | **Fixed (FR1):** checked on the normalized email; a T23 case; my own revert fails it |
| L1 | LOW | provider wiring | Dropping `getClientIp(request)` (every user in one `ip:unknown` bucket) broke no test | **Fixed (FR2):** static pin; break-it now catches it |
| L2 | LOW | store | The 10,000-entry cache cap was untested | **Fixed (FR3)** |
| L3 | LOW | password reset | Nothing pinned the gate before `getDbForAuth()` (D5) | **Fixed (FR4):** static order check |
| L4 | LOW | signals | A `'rate-limit setup'` failure could have been resolved as a valid config | **Fixed (FR5):** negative case |
| L5 | LOW | memory | `memoryRefund`'s own window check was unexercised | **Fixed (FR6):** via a read-only test hook |
| L6 | LOW | static | Window values weren't pinned literally | **Fixed (FR7):** literal `toEqual` |
| D1–D5 | MEDIUM (Planning's docs) | checks file and step 12.14 | The failure code read `credentials`, not `CredentialsSignin`; check B used the wrong address bucket; check F's admin sign-in hit the lockout; check D couldn't show the limit (fake emails send nothing, and there's no email provider locally); 12.14.4 "open a page" never touches the limiter, and deleting one token variable isn't enough if both exist | **Fixed by the lead** in the checks file and PRODUCTION-DEPLOY 12.14 |
| D6–D7 | LOW (Planning's docs) | helper; 12.14.2 | The helper printed `ok` for a missing redirect; the third failure's text shows the lockout countdown | Fixed |

Not verified locally (by design): the real Upstash service. Staging step 12.14 checks the key format, the TTLs, that no IP appears, and the config alert, before production.

## 5. Fix round 1 (`0315163`)
- **FR1–FR7** as listed in §4. The dev reported 7 of 7 reverts caught, and I re-verified FR1 with my own revert (T23's `İ` case fails).
- **After the fix:** 2,629 unit tests pass; `tsc` is clean; the dev ran `signin-ip-limit`, `mfa-signin` and `account-security` against Postgres (20 tests passed); break-it 16 of 16.

### CI fix (`2de8379`, test-only; 2026-11-15)
- **What failed in CI:** a pre-existing, date-dependent test unrelated to this item: `charge-code-actions.test.ts`, "rejects a save for a future date". It saved `todayIndex + 1` in today's pay period. On a period's last day (2026-11-15 was one), that index is past the period, so the day-index check answered first. It would have failed on `main` that day too.
- **Fix:** the test now saves tomorrow in tomorrow's own period. No product code changed.
- **Verified:**
  - the dev ran it on the real date, plus faked mid-period and end-of-month dates, with an original-code control;
  - the lead ran it on 2026-11-15: 12/12 passed.

## 6. Checks run by Planning (2026-11-13; local memory mode; the preview browser plus `/tmp/url-check.sh`)
Setup:
- `npm run demo:local` applied migration 0019; `tenant_acme` has `login_attempts_no_raw_ip`;
- the app ran through the preview tool (`npm run dev`), at `c3e3ad8`, hot-reloaded to `0315163` for the re-runs.

| Check | What was done | Result |
|---|---|---|
| A. Failed sign-ins per IP (Q2) | 20 wrong-password sign-ins from `203.0.113.10`, then the right password; then a different IP | 20 × `credentials`, then **`rate_limited`** with the correct password; the other IP **`ok`**. Re-run at `0315163` (`203.0.113.50`): same |
| B. The message in the browser (Q2) | Exhausted the browser's loopback buckets (`::1`, `127.0.0.1`; the dev server supplies `x-forwarded-for` from the socket, so the browser is not in `unknown`), then signed in as `sarah.wilson` with the **right** password by real clicks | The page shows exactly **"Too many failed sign-in attempts from your network. Try again in 15 minutes."** (screenshot taken in the session) |
| C. Successes not counted (refunds) | 25 correct sign-ins from one IP; then 3 failures and a correct one | 25 × `ok`; 3 × `credentials`, then **`ok`** |
| D. Reset requests per IP, silent (Q3) | In the browser, 10 requests for non-existent emails, then an 11th for `sarah.wilson`; DB token count; then a server restart and one control request | All 11 showed **"If an account exists with that email, we've sent a password reset link. …"**; sarah's tokens **0** after the 11th; **1** after the control request. The limit refused the 11th silently |
| E. Workspace-name lookups (Q4, now shared) | 31 `/signup/check` calls from one IP | 30 × `200`, then **`429`** |
| F. Memory limits unchanged (Q4) | 11 cost-CSV requests as admin | `signed in as admin`, 10 × `200`, then **`429`**: identical to before |

**How the checks were done:**
- B and D were real clicks and typing in the preview browser; the others were scripted HTTP requests against the same local server.
- The first run of F showed ten 401s, because my first helper version had locked the admin account through the per-email lockout. After fixing the helper and waiting out the lockout, F passed as shown.

**Cleanup:** the demo was reset and the helper removed; nothing is left running.
