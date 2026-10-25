# Launch blockers — implementation report

**Blueprint:** `feature-plan-launch-blockers.md` (FINAL v5) · **Branch:** `launch-blockers` (not pushed, no PR) ·
**Date:** 2026-10-23 · **For:** lead systems architect (post-implementation audit) ·
**Updated:** after R12 (`LAUNCH-BLOCKERS-AUDIT.md` §7–§12) — see §11 (round 1) and §12 (round 2, R9–R12)

## 1. Summary

All six phases are implemented and committed, in the order P1 → P2 → P3 → P4 (8 commits) → P6 → P5, plus two
integration-test fix commits: 15 commits, 208 files, +13,075 / −4,087 lines. Fix round 1 added three commits (A1 alone;
A2–A12; S1–S9 + `provision:tenant`) plus one test-only fix — §11. Fix round 2 (R1–R8) is one commit, `4210dc1`, R9 `2220945`, R10 `63dd52c`, R11 `7015229` and R12 (§12) — §12. P5 ships behind `SIGNUP_CONTROLS_ENABLED`,
which is off by default and turned on nowhere. The hard rules were followed:

- No raw IP is stored.
- The Turnstile secret and IP salt are never in client code (a static test checks this).
- The OAuth `redirect_uri` builders are untouched.
- No destructive commands were run against acme/globex/initech or any remote database.
- `business/` and the Privacy Policy are untouched.

| Gate | Result (after R12) |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 65 warnings (baseline 69; P4 removed 4) |
| `npm run test` | 1028 passed / 68 files |
| `npm run test:tz` (UTC, Los Angeles, Auckland) | 1028 passed in each |
| `npm run db:safety` | passes; migrations `0007_cron_runs` and `0008_signup_controls` are additive (no new migrations in either fix round) |
| `npm run test:integration` | **passes** on the product owner's machine, including the control-plane suites and every test added or changed in fix round 1 (2026-10-23). The audit's two break-it checks (A2, A3) were run by the product owner and fail as expected — §11. **Fix round 2 changed two integration tests (`cron-heartbeat`, `signup-cleanup`); not yet run** — §12 |

## 2. Commits

| Commit | Phase |
|---|---|
| `f485394` | P1 — tenant-correct links, reliable email outcomes, shared send budget |
| `8823c6e` | P2 — apex vs workspace routing |
| `9c67db9` | P3 — fresh role checks for every admin write; account security |
| `5e3702f` | P4 (1/8) — ActionResult contract, typed expected errors, no action-to-action calls |
| `a06edda` | P4 (2/8) — timesheet, periods, offline sync |
| `4545773` | P4 (3/8) — admin setup actions |
| `353ab21` | P4 (4/8) — accounts and settings |
| `331b7f2` | P4 (5/8) — integrations, import, migration |
| `5390d28` | P4 (6/8) — mode-aware UI (read-only) |
| `e9d4154` | P4 (7/8) — v1 API never reveals workspace state; export route guards |
| `8ae59c2` | P4 (8/8) — billing reachable |
| `c8eed9a` | P6 — operations |
| `35df979` | P5 — signup abuse controls (flag off by default) |
| `9b6be30` | Integration-test fallout from P4 (see §6) |
| `8f20735` | Integration tests: vitest 2.1.9 mock-import quirk; missing `getDbForAuth` stubs (see §6) |

## 3. What each phase delivered

### P1 — Links, email, send budget
- **Links:** every email links to the right host: workspace emails to `tenantBaseUrl(slug)`, signup to the apex.
- **Email outcomes:** `deliverEmail` treats a send as successful only when Resend returns a message id. It retries a 429 once after 2 s, reports failures to Sentry with the recipient domain only, and returns `{ ok: false, reason: 'disabled' | 'error' }`.
- **Scheduling:** emails sent from server actions are queued with `after()` through `scheduleEmail`, which catches and logs callback errors.
- **Send budget:** all crons share a throttle of at most 2 sends per second (`CRON_SEND_INTERVAL_MS = 500`; notices too).
- **Password reset:**
  - workspace-host only (the apex returns a generic success and sends nothing);
  - `getDbForAuth`, so a `billing_only` admin can reset;
  - the token is consumed with a conditional claim and `session_version` is bumped in the same transaction (single use under concurrency);
  - the page no longer spins forever.

### P2 — Routing
- **Workspace `/`** redirects to `/timesheet`. Demo buttons appear only when `NEXT_PUBLIC_DEMO_URL` is set.
- **Apex `/login` and `/forgot-password`** show a workspace finder. `goToWorkspace` accepts only those two targets and shares the slug-lookup rate limit with `/signup/check`.
- **Unknown, closed or provisioning workspaces, and header mismatches,** show `TenantUnavailable`.
- **Workspace `/signup`** redirects to the apex.
- **LoginForm** resets its loading state when sign-in throws.

### P3 — Fresh roles, account security
- **37 admin writes** use `requireAdminFresh`: the 31 listed in §1 plus the 6 mapping readers that refresh tokens.
- **Static guard test:** a cached `requireAdmin()` on any action outside the 39-entry justified allowlist fails the test (with a fixture, and a check for stale allowlist entries).
- **`seedUsers` deleted.**
- **MFA setup** requires the current password.
- **Recovery codes** are consumed under `SELECT … FOR UPDATE` in one transaction.
- **Lockout:** `changePassword` / `disableMFA` check lockout before bcrypt and record failures.

### P4 — Expected errors as results, modes, v1 API, billing
- **ActionResult contract:** `userAction` returns `{ ok, data }` or `{ ok: false, code, error }` for `AuthorizationError`, `WorkspaceReadOnlyError`, `ConflictError` and `UserFacingError`. It rethrows Next control flow (`unstable_rethrow`) and bugs; bugs reach Sentry through `onRequestError`. The client `runAction` shows a generic message for anything unexpected.
- **Throw conversion:** all ~80 `throw new Error` for expected conditions became typed errors, and a static test bans new ones.
- **Action-to-action calls:** the 7 listed calls became internal functions; static tests ban actions-module imports and same-file action calls, and enforce the internal-writer rule.
- **Every client call site checks its result,** enforced by a per-call-site static test.
- **Offline sync** never deletes queued hours on a failure. `conflict` / `validation` mark the item with an error; `read_only` / `forbidden` / `unauthenticated` pause the loop.
- **Read-only mode in the UI:** admin write controls and Approve/Reject are disabled with a tooltip (`WorkspaceModeProvider`, `WriteButton`). This is visibility only; the server write gate is unchanged.
- **v1 API:** order is rate limit → `getTenantState` → key validated against `getDbForUrl(tenant.dbUrl)` → `billing_only` / `policy_hold` → 403 `workspace_unavailable`, and only after a valid key. Every auth failure returns the identical 401 `{ error: 'Invalid API key.' }` with `WWW-Authenticate: Bearer`. The whole handler is in one try (generic 500, logged, Sentry).
- **Export route:** `AuthorizationError` maps to 401 / 403.
- **Billing:**
  - admin Billing nav item;
  - plans are computed on the server (`purchasable`), and a static test bans client value imports of `@/lib/billing/plans`;
  - after checkout the page says "Thanks — your subscription is being activated" and refreshes once after 5 s;
  - sign-out on the three hold screens.

### P6 — Operations
- **Retention (LB-D1):**
  - new Neon projects are created with `history_retention_seconds = 604800` (`NEON_HISTORY_RETENTION_SECONDS` override; an invalid value throws);
  - `npm run backfill:neon-retention`: `--check` is GET only; tenants without a project id are listed for manual action; a `deleting` tenant's 404 is skipped; any failure exits non-zero.
- **`RESTORE.md` (LB-D6):**
  - default: restore into a branch, connect read-only, re-enter rows through the app;
  - in-place restore only with all four conditions, the record written via `tenant:admin audit-note`, plus a customer notice template;
  - fix-forward for a bad migration;
  - a monthly drill on a named throwaway workspace.
- **Heartbeats (LB-D7):**
  - migration `0007_cron_runs`;
  - every cron goes through `runCron`: auth → `?probe=1` (200, no work, no write) → `cron_runs` start/success → optional `SENTRY_CRON_MONITORS=1` (`withMonitor` + `flush(2000)`);
  - the daily digest is always sent (an "all quiet" version when there's no news) and lists crons overdue by their own limit (daily-reminder 74 h) or never run.
- **Reminder crons:**
  - shared cron auth, `maxDuration = 300`, a 240 s budget;
  - fair rotation by a slug cursor;
  - a budget stop records `incomplete`, sends a Sentry message and raises the immediate-email alert `cron-incomplete:<name>`, which the next complete run resolves;
  - per-tenant failures go to Sentry with a tenant tag;
  - `SEED_EMAIL_DOMAINS` recipients are skipped (`lifecycle_exempt` is not used).
- **Founder-script safety:**
  - every founder script prints its target control plane (no credentials; a boxed warning when remote);
  - `provision:tenant` without a Neon key refuses a non-loopback admin URL.
- **migrate-all** includes `deleting` tenants and skips one only on confirmed absence (Neon 404 / no `pg_database` row).
- **Sentry:** environments are set; the browser trace sample rate now reads `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`.
- **Docs:** runbook, `MIGRATIONS.md` and `.env.example` corrections, as listed in §4 item 9.

### P5 — Signup abuse controls (behind `SIGNUP_CONTROLS_ENABLED`, default off)
- **Flag off:** signup works exactly as before. These still run: migration `0008`, the 80-Neon-project alert, IP-hash clearing, and "a waitlisted link never self-provisions".
- **`startSignup` order:** Terms → lengths → Turnstile (`remoteip`, `idempotency_key`, apex hostname) → attempt limiter → slug → per-IP limit (3 verified per 24 h) → row with `ip_hash = sha256(SIGNUP_IP_SALT + ip or IPv6 /64)` → email. An `'unknown'` IP fails closed in production.
- **Verify GET** writes nothing.
- **Verify POST order:** waitlisted (first, regardless of expiry) → existing already-active step → `verified_at` set once → signer-bound resume (no cap or IP check) → null IP hash refused → per-IP re-check → slug (before the cap) → daily cap 20 → waitlisted, plus `signup-cap-reached` once per UTC day.
- **`resendSignupVerification`:** Turnstile-gated; rotates the token; expiry ≤ created + 24 h; always the same generic answer; doesn't count toward the per-IP limit.
- **Immediate-email alerts:** `turnstile-outage` (at least 3 outage signals per hour in `signal_counters`; resolved after an hour quiet), `signup-config-missing`, and `signup-cap-reached`.
- **Daily cleanup** (before the digest, even after an incomplete run): never-verified rows after 7 d; consumed rows after 30 d only when the tenant row holds the Terms version and time (else `signup-terms-not-copied`); verified-but-never-provisioned after 30 d. Plus the paginated Neon project count against the 80 threshold.
- **`tenant:admin waitlist list` / `provision`:** passes the Terms version, time, timezone and admin name; awaits the set-password email, printing the link and exiting non-zero if it fails; refuses localhost links against a remote control plane.
- **`createLocalDevDatabase`** refuses a non-loopback admin URL.
- **CSP:** Turnstile origin in `script-src` / `frame-src`.

## 4. §9 test matrix

Every row has tests. Each was checked by running it against the old code or a deliberate break, and confirmed to fail.

| §9 row | Where | Breaks caught |
|---|---|---|
| Reset, Emails | `unit/{password-reset,email-send,email-schedule-throttle}`, `integration/{password-reset,submission-emails}` | P1 phase checks |
| Routing | `unit/{routing,login-form}` | old code fails |
| Roles, Account security | `unit/{fresh-admin-writes,account-security,server-action-guards}`, `integration/{fresh-admin-writes,account-security}` | old code fails; fixture |
| Action results, Offline sync, Timesheet context, Modes | `unit/{action-result,action-results-static,sync-service,timesheet-results,workspace-mode}` | fixtures + old code |
| v1 API, Export route | `unit/{v1-api-auth,export-route-auth}`, `integration/costs-api` | 4 breaks + old code |
| Billing | `unit/billing-ui`, `integration/billing-checkout` | old code fails |
| Retention, Heartbeat, Crons, Ops | `unit/{ops-retention-scripts,cron-ops,reminder-crons,ops-digest-alerts}`, `integration/{cron-heartbeat,tenant-admin}` | 16/16 |
| Signup, Resend, Waitlist, Cleanup/quota | `unit/{signup-controls,signup-verify,signup-ops}`, `integration/signup-controls` | 21/21 |

The resend-matches-a-waitlisted-row case can only be caught by the integration test, because the unit fake ignores `WHERE` clauses. That test exists.

## 5. Deviations from the blueprint — ruled

Lead audit §4: all twelve accepted, one partially. #10 is accepted for the missing-secret skip outside production only;
the test-secret skip in production was rejected and fixed (S5). #1 is moot: `audit-fixes-launch` was merged to main
as PR #7. #6 needed A11's follow-up.

1. **Branch base.** `launch-blockers` was branched from `audit-fixes-launch` (`86af568`), not `main`, because main doesn't have the blueprint commit or its "already fixed" baseline, and `git fetch` was blocked in the sandbox.
2. **P4 write gate.** `unlockUserAccount` has a one-function `getDbForAuth` exception in `write-gate-boundaries.test.ts`; the internal writer now takes its database client from the caller.
3. **P4 v1 API.** The 403s for a revoked key, an expired key, and a key whose creator is no longer an admin were kept. They only respond to a real key, so they reveal nothing to an unauthenticated caller. There's no API docs page, so the usage hint moved to the "API key created" dialog.
4. **P6 `tenant:admin audit-note`** (new, append-only). RESTORE.md's in-place condition (3) needs a `tenant:admin` audit note, and none existed.
5. **P6 immediate-email alerts** (new mechanism). `raiseAlert` now reports `{ opened }`, and `raiseAlertWithEmail` emails only when an incident is newly opened. P5 reuses it.
6. **P6 `db:migrate:all` / `db:migrate:check`** now use `--conditions=react-server`, like the other founder scripts, so the deleted-database check can reuse `classifyDatabase`. The deploy workflows call the npm scripts and are unchanged.
7. **P6 smoke test** probed daily-reminder only: two requests, because of the 2-per-minute cron rate limit. The other crons use the same `runCron` path, which unit tests cover. *Resolved by R12 (§12): only failed attempts are rate-limited now, so the smoke test probes all four crons.*
8. **P5 waitlist copy.** The LB-D2 sentence is shown word for word ("…Leave your email and we'll have yours ready…"), followed by a line saying the person is already on the list. Their email is already known by then.
9. **P5 env names chosen:** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
10. **P5 dev convenience.** Outside production, a missing Turnstile secret skips verification, and Cloudflare's test secrets skip the hostname check.
11. **P5 outage resolution.** A second `signal_counters` key stores the last outage signal's time, so "quiet for an hour" is exact.
12. **P5 flag scope.** Waitlisted links never self-provision even with the flag off, so turning the flag off can't release waitlisted rows. The runbook leaves `SIGNUP_CONTROLS_ENABLED` unset in staging and production until the product owner decides.

## 6. Integration-test findings (after the first real run)

- **41 failures:** `userAction` checked `instanceof WorkspaceReadOnlyError` imported from `@/lib/tenant/context`, which 23 integration files partially mock. The class moved to `@/lib/errors` and is re-exported from `context.ts` (same class). No behavior change.
- **Missing mocks:** `calendar-dates-fixes` (v1 API auth path) and `charge-code-actions` (`getDbForAuth`, used by fresh guards since P3).
- **vitest 2.1.9 bug, reproduced on its own:** when several calls concurrently `await import()` a mocked module, only the first gets the mock; the rest get the real module (`["mocked","real","real","real"]`). This made the two concurrency tests (recovery code, last admin) refuse for the wrong reason. The production code is correct. The tests were adjusted so the real guards and row locks stay under test, matching the existing workaround in `dcaa-concurrency.test.ts`. Upgrading vitest is a separate dependency decision.

## 7. Vendor confirmations (fetched 2026-10-22)

- **Turnstile CSP:** `https://challenges.cloudflare.com` in `script-src` and `frame-src`; `connect-src 'self'` only for pre-clearance mode. Source: developers.cloudflare.com/turnstile/reference/content-security-policy/
- **Neon `GET /projects`:** `limit` is 1–400 (default 10); pagination returns `pagination.cursor`, passed back as `?cursor=`. Source: api-docs.neon.tech/reference/listprojects

## 8. Open items

- **A12 `BillingWall` checkout status: ruled and done** (audit §7 accepted the proposal; R3, §12). `BillingClient`
  reads `status` with `useSearchParams()` when the `checkoutStatus` prop is absent. The ruling asks for `npm run build`
  to confirm no Suspense-boundary error; that is in the product owner's pre-PR checks (it can't run in my sandbox).
  The `(app)` layout reads the session, so the route renders dynamically and `useSearchParams` needs no boundary there
  (`use-search-params.md` "Dynamic Rendering"); the billing page is `force-dynamic`.
- **Fix round 2 integration: not yet run.** `cron-heartbeat` (per-tenant `resumes`, and a pre-R1 `resume` summary read
  as a map) and `signup-cleanup` (R5 row; corrected header) need the integration command.
- **Fix round 1 integration: done.** The new and changed integration tests pass. The first run caught one test-setup
  gap: `duplicates-and-import-errors` needed a `getTenantOrThrow` stub for `createUser`'s seat check. Fixed in
  `40835dd`; test-only. The A2/A3 break-it checks were run by the product owner (§11).
- **Not yet verified (sandbox limits; the audit's "after round 2" product-owner checks):**
  - `npm run build && node scripts/check-build-trace.mjs` (also confirms R3 raises no Suspense-boundary error);
  - `npm run demo:local` ×2;
  - the §10 manual browser checks (reset on `acme.localhost`, apex finder, read-only controls, Turnstile test keys,
    cap = 0, `waitlist provision`);
  - staging (Phase 12).
- **RESTORE.md's Neon branch API field** (`branch.parent_timestamp`): kept as "confirm before first use" (ruling §5).
- **Read-only actions that still throw** (ruling §5): `validateMigrationData` and `generatePayrollExportCSV` are
  converted by `feature-plan-certified-outputs.md` C1/C7; `checkLockout`, `verifyResetToken` and `checkSlugAvailable`
  stay (their callers handle them).
- **`provision:tenant` set-password link:** still not sent. The ruling covers the Terms record only, and the admin
  still uses the invite or "Forgot password" flow.
- **Closed in fix round 1:** the integration run (control-plane suites ran, then the fix-round tests passed); `signup-cap-reached` accumulation (S6);
  false Terms alerts (S1); `provision:tenant` Terms data (§5 ruling); `getTenantForBilling` plain errors and
  `initMFASetup` (A12).

## 9. Unrelated bugs noticed (not fixed — ruling: leave)

- `QBOConfigClient` has an unused `toggleAutoSync` import.
- The offline sync code (currently not used) assumes semimonthly pay periods. Lead's note for when the offline path is
  turned on: one forbidden cell pauses the queue forever, and the paused state is never shown.

## 10. To reproduce

```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety
CONTROL_PLANE_DATABASE_URL="$(grep '^CONTROL_PLANE_DATABASE_URL=' .env.local | cut -d= -f2-)" ENCRYPTION_KEY="$(grep '^ENCRYPTION_KEY=' .env.local | cut -d= -f2-)" TZ=America/New_York npm run test:integration
```

## 11. Fix round 1 (`LAUNCH-BLOCKERS-AUDIT.md` §2, §3, §5)

Three commits on `launch-blockers`, plus a test-only fix (`40835dd`), not pushed. Every fix has the test the audit
names. "Break-it" means the fix was removed or reverted with the test in place, and the test was confirmed to fail.
Rows marked *integration* run against Postgres; they pass on the product owner's machine. The product owner ran the
Postgres-only break-it checks (A2, A3).

| Item | Commit | Test(s) | Break-it result |
|---|---|---|---|
| **A1** guard is the first await in every mutation (22 actions reordered) | `a06828c` | `unit/server-action-guards` (rule + fixture: `getDbForWrite` first / `Promise.all` → flagged); `unit/guard-first-oracle` (anonymous call on a `billing_only` workspace → `unauthenticated`, write gate never reached, ×22) | old code: 32 failing |
| A2 recovery-code race on separate connections, 5 rounds | `e7b70a2` | *integration* `account-security` | `.for('update')` removed at `src/auth.ts:97` → fails with `round N: ["ok","ok"]` (both sign-ins used the code); restored → passes. Run by the product owner |
| A3 `updateUser` locks all active admins in one statement ordered by id | `e7b70a2` | *integration* `authorization` 5b (per-call connections, 5 rounds; no deadlock; one winner) | old order restored (target row locked first) → fails (deadlock 40P01 / assertion); restored → passes. Run by the product owner |
| A4 `goToWorkspace` → `ActionResult<{ url }>`; finder uses `window.location.assign` | `e7b70a2` | `unit/workspace-finder` (ok → navigates, no error, stays loading; refusal → message); `unit/routing` (URL for a valid slug; same refusal for any bad target) | old code: 10 failing |
| A5 import row errors never show SQL | `e7b70a2` | `unit/import-duplicate-errors` (overflow → generic, no SQL/params; bad date → named field); *integration* `duplicates-and-import-errors` (real varchar overflow) | old code: 11 failing (with A6) |
| A6 known duplicates → `conflict` with a specific message | `e7b70a2` | `unit/import-duplicate-errors` (every constraint in `DUPLICATE_ENTITY_MESSAGES`); *integration* `duplicates-and-import-errors` (email, contract number, charge code) | old code: 11 failing (with A5) |
| A7 Gusto auto-match counts successes only; stops on a pause code (QBO checked: no loop) | `e7b70a2` | `unit/gusto-auto-match` (all fail → no success toast; `read_only` stops after one; mixed → counts successes) | old code: 3 failing |
| A8 per-call-site check is function-scoped; `runAction` results must be consumed; awaited void wrappers flagged | `e7b70a2` | `unit/action-results-static` (fixtures: same variable name in another function; ternary; destructuring; unconsumed `runAction`; void wrapper) | removing the `TimesheetToolbar` check → fails; old Gusto wrapper → fails |
| A9 `verifyResetToken` pre-check asserted; cron link + throttle wiring asserted | `e7b70a2` | `unit/password-reset` (no `getDbForAuth` on apex / mismatch); `unit/reminder-crons` (each send's `appUrl` is the tenant host; one throttle awaited before each send) | pre-check removed: 2 failing; throttle or link mutants (×4): each fails |
| A10 sweep never stalls; employee sub-cursor; budget checked per employee | `e7b70a2` | `unit/cron-ops` (`[a, b]`, `a` always stops → second run reaches `b`; resume after the saved employee); `unit/reminder-crons` (per-employee check, `stoppedAfter`, `gt(users.id, …)` on resume) | 4/4 mutants caught |
| A11 `NEON_API_KEY` in both migrate steps of both workflows; missing key → explicit FAILED detail; Phase 11 lists it | `e7b70a2` | `unit/ops-retention-scripts` (missing key → "NEON_API_KEY missing — cannot confirm deletion"; workflow static check) | key check removed: fails |
| A12 reset page renders email as-is | `e7b70a2` | `unit/reset-password-page` (email with `%`) | decode reinstated: fails |
| A12 approve/reject notification after commit is caught | `e7b70a2` | *integration* `submission-emails` (prep fails → both decisions ok and committed) | passes (integration) |
| A12 `NEON_HISTORY_RETENTION_SECONDS` bounded 3600–604800 | `e7b70a2` | `unit/ops-retention-scripts` | old bound (≥ 0): fails |
| A12 `getTenantForBilling` → `UserFacingError`; `initMFASetup` → `ActionResult` | `e7b70a2` | `unit/billing-mfa-results` | old code: 7 failing |
| A12 `errors.ts` comment; stale fake `WorkspaceReadOnlyError` mocks removed | `e7b70a2` | — | — |
| A12 static: every v1 route uses `handleApiRequest` | `e7b70a2` | `unit/v1-api-auth` | a route skipping the wrapper: fails |
| A12 `BillingWall` `checkoutStatus` | — | — | blocked in round 1 (layouts get no `searchParams`); ruled in audit §7 and done in round 2 as R3 (§12) |
| S1 consumed-row rule on slug; alert resolves on delete; `provisioned_at` on verify success | `2e7afad` | `unit/signup-ops` (5 cases + decision table); `unit/signup-verify`; *integration* `signup-cleanup` | 3/3 mutants caught |
| S2 site key is required config (page alerts); `www.<root>` is the apex; hostname-mismatch alert at 3/hour | `2e7afad` | `unit/signup-controls`; `unit/signup-ops` (page alert) | 4/4 mutants caught |
| S3 `turnstile-secret-rejected`: raised at once; resolved by a successful siteverify or an hour quiet, never by "env present" | `2e7afad` | `unit/signup-controls` | 3/3 mutants caught |
| S4 destructive cleanup against a DB (scoped by an injectable filter) + windows, cap count, resend, config resolution, ip_hash nulling | `2e7afad` | *integration* `signup-cleanup` | passes (integration) |
| S5 test secret in production → refused + `turnstile-secret-rejected` | `2e7afad` | `unit/signup-controls` | fails |
| S6 past-day `signup-cap-reached` alerts resolve | `2e7afad` | `unit/signup-ops`; *integration* `signup-cleanup` | fails |
| S7 resend `UPDATE` repeats the pending predicates; nothing sent on 0 rows | `2e7afad` | `unit/signup-controls`; *integration* `signup-cleanup` | fails |
| S8 embedded IPv4 in IPv6 → that IPv4 | `2e7afad` | `unit/signup-controls` | fails |
| S9 waitlist issues the token before marking provisioned; recovery path printed on failure | `2e7afad` | `unit/signup-ops` | fails |
| §5 `provision:tenant` Terms record (or `--no-terms-record` + audit note) | `2e7afad` | `unit/ops-retention-scripts` (parser + script wiring); *integration* `tenant-admin` (`terms-recorded` / founder note) | terms made optional: fails |

| (test-only) `duplicates-and-import-errors` stubs `getTenantOrThrow` for `createUser`'s seat check | `40835dd` | — | — |

**Notes on how items were implemented:**
- A6's duplicate mapping lives in one place: `userAction`, via `DUPLICATE_ENTITY_MESSAGES` in `src/lib/db-errors.ts`.
  It covers every action, including `createChargeCodeInternal` reached from the QBO import. Unknown unique
  violations still surface as bugs.
- A3's 5b also accepts "Your access has changed" for the loser. If the winner commits before the loser's fresh role
  check, the loser is already demoted and is refused by that check instead.
- A5 hoisted a mis-indented `getDbForWrite()` out of each import loop. It was inside the `for`, after the guard.

## 12. Fix round 2 (`LAUNCH-BLOCKERS-AUDIT.md` §7)

One commit, `4210dc1`, not pushed. Backlog items in §7 were not touched. Every item has the test §7 names. Break-it:
the fix was undone in the source with the test in place, the test was run and failed, the file was restored and the
test passed again (done for all ten mutations below; `git status` clean of source changes afterwards). Gates at
`4210dc1`: tsc clean; lint 0 errors / 65 warnings; 1007 unit tests / 64 files, ×4 runs (default + three zones);
db:safety passes. Integration tests changed in this round still need the product owner's run (§8).

| Item | Change | Test(s) | Break-it result |
|---|---|---|---|
| **R1** (A10) per-tenant sub-cursor | `tenant-sweep.ts`: `resumes: { [slug]: afterUserId }` in `cron_runs.last_summary` — set on a stop, deleted on `done` or tenant failure, kept for tenants the run didn't reach; dropped for slugs no longer swept. `heartbeat.ts` `readCronState` returns `{ cursor, resumes }` and reads a pre-R1 `resume` as a one-entry map. Both reminder routes write `resumes`. | `unit/cron-ops`: simulated daily runs, clock ticks per employee: `[a, b]` both always stopping → each tenant's reached-employee set grows every time it's served until complete (`a` 3,3,6,6,9,9,10; `b` 0,3,3,6,6,9,10); `a`=20, `b`=4, `c`=4, budget 6 → `a` completes within 12 runs; set/delete/keep/drop table. *integration* `cron-heartbeat` (round-trip; pre-R1 summary) | single-slot behaviour restored (a stop clears the other tenants' entries) → 3 failing; restored → pass |
| **R2** (S9) waitlist re-run resumes | `waitlist.ts`: if the slug's tenant is `active` and its `signup_email` equals the row's email (case-insensitive), provisioning is skipped and the run continues: token → row marked consumed/provisioned → email. Otherwise it provisions as before (a different signer still gets "taken"). The "(it resumes)" advice is now true. | `unit/signup-ops`: token issue fails once (row untouched) → re-run with the tenant active for this signer → provision not called again, email sent, row set `consumedAt` + `provisionedAt`; another signer's active tenant → "taken by someone else", no token | resume branch disabled → fails with "The workspace name "newco" was taken by someone else meanwhile"; restored → passes |
| **R3** (A12) BillingWall checkout status | `BillingClient`: `checkoutStatus = prop ?? useSearchParams().get('status')` (per the ruling) | `unit/billing-ui`: `BillingWall` rendered with `?status=success` and no prop → "being activated" + exactly one refresh after 5 s; `?status=cancelled` → cancelled note, no refresh | URL fallback removed → 2 failing; restored → pass |
| **R4** role + `isActive` in one call | `updateUser` refuses `role` and `isActive` together (validation: "Change the role and the active status separately."), before any transaction. Confirmed the UI never sends both (`UsersClient.tsx:107,201,216`). | new `unit/update-user-role-and-active`: `{isActive:true, role:'employee'}` and two other combinations → refused, no transaction; each alone still reaches the transaction | check disabled → 3 failing; restored → pass |
| **R5** (S1) provisioning row never deleted as "different signer" | `consumedRowDecision(row: { email, provisionedAt }, tenant)`: signer mismatch + row `provisioned_at` set → `keep` (+ `signup-terms-not-copied`). `backfill-trial-dates.ts` picks the row with `provisioned_at` first, then the earliest consumed. | `unit/signup-ops`: decision-table case (mismatch + `provisioned_at` → keep, with or without tenant Terms; own tenant → Terms rule unchanged) and through the cleanup (kept, listed, alert raised); static check of the backfill order. *integration* `signup-cleanup`: new row `consumedProvisionedMismatch` survives, alert open | decision: `provisioned_at` ignored → fails (`'delete'` vs `'keep'`); backfill: `orderBy` removed → fails; restored → pass |
| **R6** (S7, S4) | Resend `UPDATE` predicates asserted: the fake control DB now records an update's `.where()`, rendered with drizzle's `PgDialect`. `signup-cleanup` header now says which steps act on the whole control plane (past-day cap alerts, quiet signal alerts + `signup-config-missing`, `ip_hash` nulling), as production does. | `unit/signup-controls`: WHERE contains `id = $1`, `consumed_at is null`, `verified_at is null`, `waitlisted_at is null` | `waitlisted_at` predicate removed from the UPDATE → fails; restored → passes |
| **R7** (A5-class) sync errors sanitised | `import-errors.ts`: the A5 sanitiser is now `safeErrorMessage(error, { fallback, duplicateFallback?, logLabel, report? })`; `importRowMessage` wraps it (behaviour unchanged). `gusto.ts:208` per-record error → "Could not sync this employee."; `sync-engine.ts` catch `error_summary` → "The sync failed." (`report: false`: the error is rethrown to the caller). `sync-engine.ts:243` ("First error: …") only carries connector strings, now sanitised at their source. | new `unit/integration-sync-errors`: a Drizzle-style "Failed query: … params: …" error writing a Gusto sync record → generic per-record error; the same error mid-sync → `error_summary` "The sync failed.", error still rethrown; neither contains SQL, params or the secret param | `String(error)` restored at each site → each fails (raw "Failed query: insert into …" in the record / summary); restored → pass |
| **R8** `provision:tenant` audit-write failure | `scripts/provision-tenant.ts`: "Provisioning failed" only around `provisionTenant`; the registry lookup + `recordProvisionTerms` have their own catch, which prints `provisionRecordFailedMessage` ("Workspace "<slug>" created, but recording the Terms/audit note failed (…). Record it with `tenant:admin audit-note`:" plus the exact command and note text) and exits 1. | `unit/ops-retention-scripts`: message for a Terms record and for `--no-terms-record`; script structure (static) | the round-1 script restored → fails; restored → passes |

**Things the architect should know:**
- **R7 changes what admins see for provider failures.** The sanitiser keeps only `UserFacingError` / `ConflictError`
  messages and known duplicates. A Gusto or QBO HTTP failure (e.g. "Gusto API POST … failed: 422 {body}") thrown
  mid-sync now shows "The sync failed." in the sync log, like any other unexpected error. The full error still goes to
  the server log and, via the caller, to Sentry. QBO's per-record batch fault messages (`quickbooks-online.ts:185`) and
  the "not mapped" skip messages are plain strings from the provider response or our own text, so they still show.
- **R1 drops entries for slugs that are no longer swept** (e.g. a suspended tenant), so the summary can't grow without
  bound. Such a tenant starts again from its first employee when it comes back.
- **R2 resumes only an `active` tenant.** A tenant still `provisioning` goes through `provisionTenant`, which resumes it
  itself (signer-bound, as before).
- **R8's hand-recorded note is a `founder-note` audit event, not `terms-recorded`.** That is what `tenant:admin
  audit-note` writes. The Terms version and acceptance time on the tenant row are written by `provisionTenant` before
  this step, so they are not affected by the failure.

### R9 (audit §8, as ruled) — commit `2220945`

One commit, not pushed. Gates at `2220945`: tsc clean; lint 0 errors / 65 warnings; 1015 unit tests / 65 files, ×4
runs; db:safety passes. No integration test changed.

**Change.**
- New `src/lib/integrations/provider-errors.ts`: `connectionExpiredError`, `providerHttpError`, `providerRefreshError`.
  The raw status and response body go to `console.error` and Sentry only, never into the message.
- **QuickBooks sync refreshes its token** (ruling, QuickBooks only): `executeSyncOperation` calls
  `ensureValidToken(connectionId)` after the `running` sync-log row is inserted and before the push, and pushes with
  the returned token. This fixes the existing bug where a sync more than an hour after the last refresh failed. Gusto's
  sync is unchanged (it makes no provider call).
- **Reconnect message** ("Your {QuickBooks|Gusto} connection has expired — reconnect it on the Integrations page."):
  - token refresh 400 or 401 (`qbo-api.ts`, `gusto-api.ts` refresh);
  - no stored tokens (both `ensureValid…Token`);
  - a 401 from any QuickBooks query / create / batch or Gusto GET / GET raw / POST.
- **Other HTTP failures:** "{QuickBooks|Gusto} returned an error (HTTP {status}). Try again; if it keeps happening,
  reconnect the integration." (status only).
- **Missing or inactive connection** (`sync-engine.ts`): "This integration is disconnected — reconnect it on the
  Integrations page."
- **Unchanged, per the ruling:** the OAuth code exchange (`qbo-api.ts:84`, `gusto-api.ts:85`), "No company found"
  (`gusto-api.ts:276`), the missing client id/secret errors (plain `Error`), and "No connector registered".
  `fetchQBOCompanyInfo` already falls back to "Unknown Company" on any failure and was left as is.

**Tests:** new `unit/integration-provider-errors`, driven through the real actions with `fetch` stubbed:
1. QuickBooks sync, expired token, refresh → 401: the action result and the sync log `error_summary` both carry the
   reconnect message. No response-body text appears in either, and nothing is pushed.
2. QuickBooks sync, valid token, batch → 500: the HTTP-status message in both; no refresh is made.
3. QuickBooks sync, expired token, refresh succeeds: the batch call carries `Bearer <new token>`, the new tokens are
   stored, and the sync succeeds (the stale-token bug).
4. A mapping action (`fetchQBOEmployeesForMapping`) whose refresh returns 401: the reconnect message in its result.

Also covered: a batch 401 → reconnect; refresh 400 → reconnect and refresh 503 → status message; an inactive
connection → "disconnected"; Gusto GET 401 → reconnect and 502 → status message.

**Break-it** (each fix undone in the source, test run, file restored and re-run green):
- refresh removed from the sync → (1) and (3) fail;
- refresh error back to a plain `Error` → (1), (4) and the 400/503 case fail;
- the 401 rule removed → the batch-401 and Gusto cases fail;
- batch error back to a plain `Error` → (2) and batch-401 fail;
- "not found" back to a plain `Error` → the disconnected case fails;
- Gusto GET back to a plain `Error` → the Gusto case fails;
- the refresh moved before the `running` row → (1) fails (no sync-log row for the failure).

**Backlog (ruling):** two concurrent refreshes of one connection can race on refresh-token rotation (also true today on
the mapping page). Serialise per connection with an advisory lock later. The sync now refreshes too, so a sync started
while a mapping page is refreshing can hit this race.

### R10 (audit §9) — commit `63dd52c`

**Cause:** the product owner's `npm run build` failed with "Invalid segment configuration export detected". Both
reminder routes exported `maxDuration = REMINDER_CRON_MAX_DURATION_S`, an imported constant. Next reads route segment
config statically, so it must be a literal.

**Change:** `export const maxDuration = 300;` in `src/app/api/cron/daily-reminder/route.ts` and
`src/app/api/cron/submission-deadline/route.ts`, with a comment pointing at the test. The now-unused import is removed.
No other segment config export under `src/app` was non-literal.

**Test:** new `unit/route-segment-config`:
- every `export const (maxDuration|dynamic|revalidate|runtime|fetchCache|preferredRegion|dynamicParams)` under
  `src/app` is a literal (string, number, boolean, or an array of strings);
- a guard that the scan actually finds the known exports;
- a fixture: an identifier, member access, an arithmetic expression and a template literal are flagged; literals and a
  commented-out line pass;
- both reminder routes' literal equals `REMINDER_CRON_MAX_DURATION_S`.

**Break-it:**
- the identifier restored in `daily-reminder` → 2 failing (the literal scan and the equality check);
- the `submission-deadline` literal changed to 299 → the equality check fails;
- each file restored → passes.

**Gates at `63dd52c`:** tsc clean; lint 0 errors / 65 warnings; 1019 unit tests / 66 files, ×4 runs; db:safety
passes.

**Not verified here:** `npm run build && node scripts/check-build-trace.mjs`, which audit §9 says must pass. It can't run
in my sandbox: Turbopack fails with "binding to a port — Operation not permitted", and `fonts.googleapis.com` is blocked.
It stays with the product owner.

### R11 (audit §11) — commit `7015229`

**Fix:** both sites now pass the ISO string with a cast, as `notices.ts` does:
- `src/app/signup/verify/route.ts`: `coalesce(${signups.verifiedAt}, ${now.toISOString()}::timestamptz)`;
- `src/lib/signup/signals.ts`, both `CASE` expressions: `${stale.toISOString()}::timestamptz` and
  `${now.toISOString()}::timestamptz`.

Integration tests are unchanged and kept. As the audit notes, they can't catch this class.

**Test:** new `unit/sql-template-params`, with a scanner in `src/__tests__/helpers/sql-template-scanner.ts`. The
scanner is a small tokenizer: strings, comments and nested templates are skipped correctly, and multi-line and nested
templates are included.
- **What it scans:** every drizzle `sql` template (and aliases such as `sql as dsql`) in `src/` and `scripts/`. It also
  scans every postgres-js client in the same file that is passed to `drizzle(client)`. Drizzle installs the
  pass-through on that client's own serializers: `migrate-tenant.ts` is one, and so are the seed and backfill scripts.
- **What each `${…}` must be:**
  - a real `<table>.<column>`, checked against the exported drizzle tables and columns (`table.<col>` is allowed in
    the schema files' index callbacks), so a value like `${row.createdAt}` can't pass;
  - or `….toISOString()` followed by `::timestamptz` / `::date`;
  - or a nested drizzle `sql` fragment (its own interpolations are checked);
  - or on the allowlist.
- **Allowlist (5 entries, each justified in the test):**
  - the advisory-lock keys in `locked.ts`, `periods.ts` and `migrate-tenant.ts`;
  - the heartbeat cron `name` in `heartbeat.ts`;
  - the signal-counter key string in `signals.ts:44`.
  A further test fails if any allowlist entry is no longer used.
- **A guard against matching nothing:** more than 50 templates are scanned, and the four ISO-cast sites are found.
- **Fixtures:**
  - fail: `${now}`, `${stale}`, `${row.createdAt}`, an ISO string without a cast, a raw value in a nested fragment, an
    aliased `dsql`, and a postgres-js client passed to `drizzle()`;
  - pass: the fixed forms, and a postgres-js client that is never passed to drizzle.

**Break-it:**
- the verify route back to `${now}` → fails, naming `verify/route.ts:209 ${now}`;
- `signals.ts` back to `${stale}` / `${now}` → fails, naming both;
- the cast dropped from one ISO string → fails, naming `signals.ts:32`;
- each file restored → passes.

**Gates at `7015229`:** tsc clean; lint 0 errors / 65 warnings; 1023 unit tests / 67 files, ×4 runs; db:safety passes.

**Notes:**
- **The scan found one more raw `${now}`, in `scripts/register-tenant.ts:40,44`** (postgres-js `tx` templates in the
  seeding scripts). It is not affected: that client is never passed to drizzle, so postgres-js's own Date serializer
  applies. It is outside the check, and was left unchanged.
- **Known limit:** a client is recognised as drizzle-wrapped only when passed as `drizzle(<identifier>`.
  `workspace-export.ts:73` wraps `Object.assign(conn, …)`, so its `conn` templates are not checked. They have no
  interpolations today.
- **Product owner:** reopen the same verify link (its `verified_at` was never written) and continue the manual checks.

### R12 (audit §12, CI finding) — the commit that adds this section

**Cause:** `rejectUnauthorizedCron` applied the 2/min/IP cron rate limit before checking the secret, so authenticated
calls used up the budget. In CI, two `cron-heartbeat` tests got 429 (they passed locally only because of timing). In
production, the third cron at 20:00 UTC on one instance would have been refused, and that day's run lost.

**Fix** (`src/lib/cron-auth.ts`):
- the secret is checked first, with `crypto.timingSafeEqual`; lengths are compared first, because `timingSafeEqual`
  throws on unequal lengths;
- a correct secret returns at once and never touches the rate limiter;
- only a failed attempt calls `checkCronRateLimit`: within the limit it gets 401, past it 429. Failed attempts include a
  missing or wrong secret, and any call in production when `CRON_SECRET` is unset (still fail-closed);
- local dev without `CRON_SECRET` stays open. It is no longer rate-limited either, because it isn't a failed attempt.

**Smoke test (optional item, done):** `scripts/smoke-tenancy.sh` sends one unauthenticated probe (expects 401), then
probes all four crons (`notice-delivery`, `tenant-lifecycle`, `submission-deadline`, `daily-reminder`) with the secret.
Each must return 200 with body `{"probe":"ok"}`. `bash -n` passes. It was not run against a deployment.

**Tests:** new `unit/cron-auth`, with the real in-memory rate limiter and one IP per test:
- 5 authorized calls in a row from one IP (`x-cron-secret` and `Bearer`) all pass;
- 3 wrong-secret calls → 401, 401, 429, and a correct call after that still passes (a further wrong one stays 429);
- a wrong secret of a different length, or of the same length → 401, with no throw;
- production without `CRON_SECRET` → 401, 401, 429;
- local dev without `CRON_SECRET` → open.

The two `cron-heartbeat` integration tests are unchanged.

**Break-it:**
- rate limit restored before the secret check → all 5 tests fail;
- successful calls counted too → 2 fail;
- length check removed (`timingSafeEqual` throws) → 2 fail;
- the file restored → all pass.

**Gates:** tsc clean; lint 0 errors / 65 warnings; 1028 unit tests / 68 files, ×4 runs; db:safety passes.

**CI:** the branch was pushed after this commit so CI re-runs the integration suite, including the two `cron-heartbeat`
tests.
