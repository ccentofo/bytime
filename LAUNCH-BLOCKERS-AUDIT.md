# Launch blockers — lead audit of the implementation

**Audited:** branch `launch-blockers` at `8f20735` (15 commits) against `feature-plan-launch-blockers.md` (FINAL v5)
and `LAUNCH-BLOCKERS-IMPLEMENTATION-REPORT.md`. **Date:** 2026-10-23. **Method:** gates re-run by the lead; six
read-only auditors (P1+P2, P3, P4 core, P4 rest, P5, P6); every HIGH and the P2 finder finding re-verified by the lead
against the code / Next source.

**Verdict: NOT READY TO MERGE.** One security HIGH (§2 A1) and a set of MEDIUMs. The implementation is otherwise
strong: all 37 admin writes are fresh, the 39-entry read-only allowlist was independently traced (no writes), the v1
API has no state oracle, offline sync never deletes on failure, flag-off signup is unchanged.

## 1. Gates (re-run by the lead)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 65 warnings |
| `npm run test` / `npm run test:tz` | 876 passed; 876 × 3 time zones |
| `db:safety` | passes (`node --import tsx scripts/check-migration-safety.ts`; the `tsx` CLI can't open its IPC socket in the lead's sandbox) |
| `test:integration` | passed on the product owner's machine **with** the control-plane suites — remove that open item from the report |

## 2. Fix before merge (fix round 1)

Each item: what, where, the failure, the required fix, the test that must fail without the fix.

### A1 (HIGH, security) — Anonymous workspace-state oracle through server actions
- **Where:** ~40 converted mutations call `getDbForWrite()` **before** their guard (e.g. `api-keys.ts:72-73`
  `revokeApiKey`; `clins.ts:23,43`; `slins.ts:23,43`; `charge-codes.ts` ×8; `integrations.ts` ×4;
  `labor-categories.ts` ×4; `qbo.ts:203,255`; `migration.ts:34,96`; `contracts.ts:42,71`; `assignments.ts:67,90`;
  `api-keys.ts:21,85`; `pay-period-config.ts:252`; `users.ts:34,76,172`; `indirect-codes.ts:45`; `import.ts:32`;
  `timesheet.ts:215`; `periods.ts:174,299,388`; list is not exhaustive — find them all).
- **Failure:** `getTenantForWrite` (`context.ts:70-77`) throws `WorkspaceReadOnlyError` with a message naming the
  state; `userAction` now returns it. An unauthenticated POST of any such action (action ids are identical across
  workspaces) to `victim.<root>` returns "suspended… update billing" / "on hold" / "read-only" vs `unauthenticated` for
  a full workspace. Before P4 both were redacted to the same generic error. Breaks §3 "guards first" and the T3 rule
  that logged-out visitors never learn a workspace's billing state.
- **Fix:** in every `userAction` callback the **first awaited call is the guard** (`requireAdminFresh` /
  `requireApproverFresh` / `requireSession` …); `getDbForWrite()` only after it.
- **Test:** static test — in every exported action's `userAction` callback, the first `await` is a `require*` guard
  (allowlist only the public actions in `PUBLIC_ACTIONS`), with a fixture that puts `getDbForWrite()` first and must
  fail; plus one integration/unit test: unauthenticated call against a `billing_only` workspace returns
  `code: 'unauthenticated'` (not `read_only`).

### A2 (MEDIUM) — Recovery-code concurrency test no longer races
- **Where:** `src/__tests__/integration/account-security.test.ts:21-24` stubs `getDbForAuth` → `getTestDb()`, the global
  `postgres(…, { max: 1 })` (`setup-db.ts:41`). Both sign-ins queue on one connection; the `FOR UPDATE` at
  `auth.ts:97` is never exercised (remove it → test still green). It is the only test of single-use recovery codes.
  The header comment "row locks run for real" is wrong.
- **Fix:** per-call clients exactly like `dcaa-concurrency.test.ts:28-36` (each `getDbForAuth` call gets its own
  `postgres(TEST_DB_URL, { max: 1 })`, closed in `afterAll`).
- **Test:** temporarily remove `.for('update')` → the test must fail; restore.

### A3 (MEDIUM) — Last-admin race deadlocks; its test never races
- **Where:** `users.ts` `updateUser` (~121-146) locks the target row, then the other admins → two admins demoting each
  other lock in opposite orders → Postgres 40P01 → generic error + Sentry (invariant holds). `authorization.test.ts` 5b
  runs both calls on the single `max: 1` client.
- **Fix:** lock **all active admin rows in one statement ordered by id** (`… WHERE role='admin' AND is_active ORDER BY
  id FOR UPDATE`) before the target check; give 5b per-call connections.
- **Test:** 5b with real concurrency: exactly one demotion succeeds, the other gets the existing last-admin message (no
  deadlock error).

### A4 (MEDIUM) — Apex workspace finder shows an error on every successful lookup
- **Where:** `src/components/auth/WorkspaceFinder.tsx:25`. Verified in Next 16
  (`server-action-reducer.js` ~222-227): a cross-origin `redirect()` rejects the client promise, then hard-navigates;
  the bare `catch` shows "Something went wrong" and re-enables the button during navigation.
- **Fix:** `goToWorkspace` returns `ActionResult<{ url: string }>` (still validated server-side, URL built from env);
  the client calls `window.location.assign(url)` on `ok`. Keep the target allowlist and rate limit.
- **Test:** unit — finder on `ok` navigates and shows no error; action returns the tenant URL for a valid slug and the
  same refusal for an invalid target.

### A5 (MEDIUM) — Bulk import returns raw SQL / params to the client
- **Where:** `src/server/actions/import.ts:88,143,191,249,316` `message: String(error)`. Drizzle messages include the
  SQL and params (for employees, the bcrypt hash). Breaks §9 "unexpected DB error → generic (no SQL text)".
- **Fix:** as `migration.ts:65-73`: unique violation → friendly row message; `UserFacingError`/`ConflictError` and
  date-parse failures → their message; anything else → "Could not import this row." + `console.error` (+ Sentry).
- **Test:** a row that overflows a varchar returns the generic message and no `insert into` / `params` text.

### A6 (MEDIUM) — Friendly messages for common duplicates
- **Where:** unmapped unique constraints: `users.email` (`createUser`, `createUserWithPassword`),
  `contracts.contract_number`, `charge_codes.code` (incl. `createChargeCodeInternal` from the QBO import), indirect
  code / cost class name, `clin_slin`, `clin_lcat`, `user_lcat_effective`.
- **Fix:** `isUniqueViolation(err, '<constraint>')` → `ConflictError` with a specific message ("A user with that email
  already exists.", …).
- **Test:** one per constraint family (duplicate email, contract number, charge code) → `{ ok:false, code:'conflict' }`
  with the message.

### A7 (MEDIUM) — Gusto auto-match counts failed saves as matched
- **Where:** `src/app/(app)/admin/integrations/gusto/GustoConfigClient.tsx:138-147` (`handleSaveMapping` returns
  `void`; `matched++` regardless).
- **Fix:** `handleSaveMapping` returns `ok`; count successes only; stop the loop on `forbidden` / `read_only` /
  `unauthenticated`. Check the QBO config client for the same pattern.
- **Test:** all saves fail → no success toast; pause code stops the loop.

### A8 (MEDIUM) — Per-call-site static check is file-scoped
- **Where:** `action-results-static.test.ts` `uncheckedCallSites` (~150-153): `<var>.ok` anywhere later in the file
  counts. Removing the `if (!result.ok)` from `TimesheetToolbar.tsx` `handleSave` (:182-186) leaves the test green.
- **Fix:** search for `.ok` only within the enclosing function body (from the call to the end of that function); also
  require a `runAction(...)` result to be used when the caller needs it, and flag wrappers that swallow results (A7's
  shape: a helper returning `void` around an action).
- **Test:** fixture reusing one variable name across two functions, one unchecked → flagged.

### A9 (MEDIUM) — Two §9 tests pass without their fix
- **`verifyResetToken` pre-check** (`unit/password-reset.test.ts:97,102`): the `getDbForAuth` mock always returns the
  fake db, so deleting the pre-check keeps the tests green. **Fix:** assert
  `expect(getDbForAuth).not.toHaveBeenCalled()` (apex and header-mismatch), as the `requestPasswordReset` test does.
- **Cron link + throttle wiring** (`unit/reminder-crons.test.ts:41,43`): `createSendThrottle` and `tenantBaseUrl` are
  stubbed with no assertions. **Fix:** assert each send's `appUrl` is the tenant URL and the throttle is awaited once per
  send, before the send.

### A10 (MEDIUM) — Reminder rotation stalls on one oversized tenant
- **Where:** `src/lib/cron/tenant-sweep.ts:66-77`: a tenant needing more than the budget allows (~480 sends) returns
  `'stopped'` with `processed === 0` → cursor never moves → every later tenant starves daily; the alert opens once.
  Also `daily-reminder/route.ts:80-103`, `submission-deadline/route.ts:83-121` check `outOfTime()` only before a send,
  so a big tenant with no sends can run past `maxDuration`.
- **Fix:** if a run stops inside the first tenant of its rotation, still advance the cursor past it (it is served first
  on wrap-around); add an employee-level sub-cursor in `last_summary` so the stopped tenant resumes mid-way; check
  `outOfTime()` at the top of each employee iteration.
- **Test:** tenants `[a, b]`, `a` always stops → the second run reaches `b`; a stopped tenant resumes at the saved
  employee.

### A11 (MEDIUM) — Deploys blocked by a half-deleted tenant
- **Where:** `.github/workflows/deploy-prod.yml:31-40`, `deploy-staging.yml` (same): migrate steps lack
  `NEON_API_KEY` → `neonProjectExists` throws → "not confirmed" → FAILED → every deploy fails while a `deleting` tenant
  whose project is gone exists.
- **Fix:** add `NEON_API_KEY: ${{ secrets.NEON_API_KEY }}` to both migrate steps in both workflows; list it under the
  GitHub Environment secrets in PRODUCTION-DEPLOY (Phase 11); when the key is missing, the FAILED detail says
  "NEON_API_KEY missing — cannot confirm deletion".
- **Test:** unit — missing key produces that detail.

### A12 (LOW, cheap, real) — fix in the same round
- `src/app/reset-password/page.tsx`: `decodeURIComponent(email)` on an already-decoded value → an email containing `%`
  crashes the page. Render `email` directly. Test it.
- `periods.ts:348-372`, `:435-462`: approve/reject email preparation after commit is not caught → a transient error
  reports failure for a committed decision. Wrap like submit's (`:280`) or move it into the `scheduleEmail` callback.
- `lifecycle-config.ts:67-73`: `NEON_HISTORY_RETENTION_SECONDS` accepts 0 and has no ceiling → bound to 3600–604800.
- `getTenantForBilling` plain `Error`s (`context.ts:111-126`) → `UserFacingError`; `initMFASetup` → `ActionResult`
  (`MFASetup.tsx` shows a redacted digest today).
- `BillingWall.tsx`: pass `checkoutStatus` so a suspended admin returning from Checkout sees "being activated" + the
  5 s refresh.
- `src/lib/errors.ts:22` misplaced comment; remove the leftover fake `WorkspaceReadOnlyError` classes in
  `billing-checkout.test.ts:21` and `unit/password-reset.test.ts:10`.
- Static test: every `src/app/api/v1/**/route.ts` goes through `handleApiRequest`.

## 3. Fix before `SIGNUP_CONTROLS_ENABLED` is turned on (same round preferred)

- **S1 (MEDIUM) Consumed-row cleanup rule** (`src/lib/signup/maintenance.ts:61-71`) — blueprint gap (lead's), replaces
  the LB-D5 join. Join `tenants` on **slug only** (tenant rows are never hard-deleted). **Delete** when (tenant
  `signup_email` = row email **and** the tenant has `terms_version` + `terms_accepted_at`) **or** (tenant
  `signup_email` is non-null and different — this signer never got that workspace; no contract exists). **Keep +
  `signup-terms-not-copied`** when the matching tenant lacks Terms data, its `signup_email` is NULL (legacy), or no
  tenant has the slug. **Resolve** the alert for a slug once its row is deleted. Set `provisioned_at` on the verify
  success path too.
- **S2 (MEDIUM) Silent total-refusal configs:** missing `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (button disabled forever,
  `signup/page.tsx:26`) → include it in `missingSignupConfig()` and raise `signup-config-missing` from the page;
  hostname mismatch (`turnstile.ts:82-83`) → accept `www.<root>` as the apex (matches `host.ts:13`) and count other
  mismatches toward an alert threshold.
- **S3 (MEDIUM) Rejected secret alert loop:** `invalid-input-secret` gets its own kind `turnstile-secret-rejected`,
  resolved only after a successful siteverify or an hour without recurrence (not by "env present").
- **S4 (MEDIUM) Destructive cleanup untested against a DB:** integration test with back-dated `test-lc-signup-*` rows
  (cleanup scoped by an injectable filter) proving the 7 d / 30 d / 30 d windows, `isNull(consumedAt)` on the
  unverified step, and S1's join. Also cover: the outage window logic, the daily-cap count query, resend for consumed /
  > 24 h rows (no email sent), `signup-config-missing` resolution, and `startSignup`'s opportunistic ip_hash nulling.
- **S5 (LOW) Test secrets in production:** `turnstile.ts:52,82` skips the hostname check for Cloudflare test secrets
  even in production → in production, a test secret refuses + raises `turnstile-secret-rejected`. (Deviation #10 is
  accepted only for the missing-secret skip outside production.)
- **S6 (LOW)** `signup-cap-reached`: daily maintenance resolves rows whose dedup day is before today.
- **S7 (LOW)** Resend `UPDATE` (`actions/signup.ts:164-167`) repeats the `isNull(verifiedAt/waitlistedAt/consumedAt)`
  predicates.
- **S8 (LOW)** `controls.ts:43-56`: map `::ffff:hhhh:hhhh` and embedded-IPv4 forms to IPv4 instead of the shared `::/64`
  bucket / refusal.
- **S9 (LOW)** `waitlist.ts:84-88`: mark the row provisioned **after** issuing the set-password token, or print the
  forgot-password recovery path if issuing fails.

## 4. Rulings on the dev's deviations (report §5)

All accepted, with one partial: #1 branch base (moot — `audit-fixes-launch` was merged to main as PR #7, `7946b31`,
whose parent is this branch's base `86af568`; no rebase needed); #2 `unlockUserAccount` auth client
(same as before); #3 403s for revoked/expired/creator-not-admin keys (require a real key hash match; come before the
suspension check); #4 `tenant:admin audit-note`; #5 `raiseAlertWithEmail` (dedup verified under concurrency); #6
`react-server` conditions (but see A11); #7 smoke probes daily-reminder only (static test covers all four routes); #8
waitlist copy; #9 env names; **#10 accepted for the missing-secret skip outside production only — the test-secret skip
in production is rejected (S5)**; #11 extra counter key; #12 waitlisted links never self-provision with the flag off.

## 5. Rulings on the report's open items (§8)

- Integration run: verified by the product owner with control-plane suites — close.
- `signup-cap-reached` accumulation → S6. False Terms alerts → S1.
- `provision:tenant` passes no Terms data → **fix in this round**: require `--terms-version <v> --terms-accepted-at
  <ISO>` (from the customer's signed agreement), recorded on the tenant row and audited; refuse without them unless
  `--no-terms-record` is passed, which writes a `tenant:admin` audit note "provisioned without a Terms record". (A
  founder-provisioned workspace otherwise has no proof of contract — LB-D5.)
- `getTenantForBilling` plain errors → A12. RESTORE.md branch-API field: keep "confirm before first use".
- Read-only actions that still throw: `initMFASetup` → A12; `validateMigrationData` and `generatePayrollExportCSV` are
  converted by `feature-plan-certified-outputs.md` C1/C7; `checkLockout`, `verifyResetToken`, `checkSlugAvailable`
  stay (callers handle them).
- Unrelated bugs (unused import; offline semimonthly assumption): leave; offline note for the future: one forbidden
  cell pauses the queue forever and the paused state is never shown — fix when the offline path is turned on.

## 6. Known LOWs not required now (post-launch backlog)

Guard-test write detection is a closed list (`controlDb.update` etc. unseen); `throw new Error(` ban misses
`throw Error(` / other error types; action-to-action check misses `../actions` and passing an action by reference;
internal-writer rule only sees `db|tx|executor|writer`; v1 timing difference reveals only existence (already public);
fixed-window outage counter; per-IP count includes refused/name-taken rows (blueprint wording); concurrent verify POSTs
can orphan a Neon project (pre-existing, flag-independent — worth a slug advisory lock later); cron rate limit 2/min/IP
can drop one of three 20:00 crons on a shared instance (pre-existing — consider limiting failed-auth requests only);
`cron-heartbeat` integration test writes a real `notice-delivery` row; `provision-customer.sh` echoes its
`DATABASE_URL`; static assertion that `provision-tenant.ts` passes `localDevAdminUrl()`; Modes test doesn't cover the
layout → provider wiring.

---

## 7. Re-audit of fix round 1 (`a06828c`, `e7b70a2`, `2e7afad`, `40835dd`) — 2026-10-23

**Gates (re-run by the lead):** `tsc` clean; lint 0 errors; 990 unit tests pass, ×3 time zones; `db:safety` passes;
integration passed on the product owner's machine incl. control-plane suites and the A2/A3 break-it checks.
**A1 verified independently by the lead:** every exported `userAction` callback's first `await` is a `require*`
guard; the only exceptions are the public `requestPasswordReset`, `resendSignupVerification`, `goToWorkspace`.
Two read-only re-auditors verified A2–A12 and S1–S9 + §5 item by item.

**Ruling on the blocked A12 item:** accepted as proposed — `BillingClient` reads `status` via `useSearchParams()` when
the `checkoutStatus` prop is absent (Next 16 layouts get no `searchParams`; the docs recommend exactly this). Confirm
with `npm run build` that no Suspense-boundary error is raised.

### Fix round 2 (small; required before merge)

- **R1 (MEDIUM, A10)** `src/lib/cron/tenant-sweep.ts`: the sub-cursor has one slot — a stop in tenant X overwrites Y's
  saved position, so with two oversized tenants (or one oversized + others over budget) tails starve permanently.
  **Fix:** `last_summary.resumes: { [slug]: afterUserId }` — set on a stop, delete on `done` or tenant failure, keep
  entries the run didn't reach. **Test:** `[a, b]` both always stopping → each tenant's reached-employee set grows every
  run until complete; `a`=20, `b`=4, `c`=4 with budget 6 → `a` eventually completes.
- **R2 (MEDIUM, S9)** `src/lib/tenant/waitlist.ts:78-95`: the "re-run (it resumes)" advice is false — the tenant is
  already `active`, so a re-run reports "name taken". **Fix:** a re-run resumes: if the tenant for `row.slug` is
  `active` and its `signup_email` equals `row.email`, skip provisioning, issue the token, mark the row
  consumed/provisioned. **Test:** token issue fails once → re-run succeeds and sends the email; row ends consumed.
- **R3 (A12)** BillingWall checkout status per the ruling above. **Test:** wall render with `?status=success` shows
  "being activated" and schedules one refresh.
- **R4 (LOW)** `users.ts:121-138`: `{ isActive: true, role: <non-admin> }` still locks the target before the admins →
  refuse role and `isActive` changes in the same call (the UI never sends both). **Test:** that call is refused.
- **R5 (LOW)** S1 safety: never delete a consumed row as "different signer" when the row itself has `provisioned_at`
  set — keep + `signup-terms-not-copied` instead (guards a wrong legacy backfill, `scripts/backfill-trial-dates.ts:82-86`).
  Also order that backfill by earliest consumed row, preferring `provisioned_at`. **Test:** decision-table case.
- **R6 (LOW)** S7: assert the resend `UPDATE`'s pending predicates (unit mock asserts the WHERE, or an integration race).
  S4: correct the `signup-cleanup` header — some steps act on the whole control plane (past-day cap alerts, quiet
  signal alerts, ip_hash nulling), exactly as production does.
- **R7 (LOW, A5-class)** `src/lib/integrations/connectors/gusto.ts:208`, `src/lib/integrations/sync-engine.ts:243,266`:
  `String(error)` reaches `integration_sync_logs.error_summary` (shown in the admin UI and the export) → route through
  the same sanitiser as `importRowMessage`. **Test:** a DB error in a sync produces no SQL/params in the log row.
- **R8 (LOW)** `provision:tenant`: when the post-provision audit write fails, say "Workspace created, but recording the
  Terms/audit note failed — record it with `tenant:admin audit-note`" (not "Provisioning failed").

### Backlog (not now)
A8 checker blind spots (object-type return annotations, regex literals with `{`); malformed import rows reported as
bugs (fine) and `importQboChargeCodes` stopping part-way on a duplicate without naming the item; tighten A3 test to
require the last-admin message in at least one round.

### After round 2 — product owner checks before the PR
`npm run build && node scripts/check-build-trace.mjs`; `npm run demo:local` (twice); §10 manual browser checks (reset
on `acme.localhost`, apex finder navigates with no error flash, read-only controls disabled, Turnstile test keys with
the flag on locally, cap = 0 → waitlist, `tenant:admin waitlist provision`).

---

## 8. Verification of fix round 2 (`4210dc1`) — 2026-10-23

**Gates (lead):** `tsc` clean; lint 0 errors; 1007 unit tests pass. R1–R8 accepted as reported (§12 of the
implementation report). Notes ruled: R1 dropping saved positions for tenants no longer swept — accepted (a returning
tenant restarts from its first employee); R8 hand-recorded note is a "founder note" — accepted (the Terms fields are
written before that step).

### R9 (one item, required before merge) — provider errors must stay actionable
R7 routes every sync error through `safeErrorMessage`, so provider failures (token refresh 400/401 at
`qbo-api.ts:121`, `gusto-api.ts:126`; "Connection has no stored tokens" at `:150`/`:154`; API failures at
`qbo-api.ts:208,247,280`, `gusto-api.ts:215,231,249`; `sync-engine.ts:156` connection not found) now all read "The sync
failed." — the admin is never told to reconnect. **Fix:** at the connector boundary throw `UserFacingError`s (keep the
raw status/body only in `console.error` + Sentry):
- token refresh 400/401 or no stored tokens → "Your {QuickBooks|Gusto} connection has expired — reconnect it on the
  Integrations page.";
- other provider HTTP failures → "{QuickBooks|Gusto} returned an error (HTTP {status}). Try again; if it keeps
  happening, reconnect the integration." (status only — never the response body);
- connection not found/inactive → "This integration is disconnected — reconnect it on the Integrations page.";
- missing client id/secret env stays a plain `Error` (operator bug).
`safeErrorMessage` already passes `UserFacingError` messages through, so the sync log and the action result show them.
**Test:** a refresh 401 → sync log `error_summary` and the action result carry the reconnect message, with no response
body text; a 500 from the provider → the HTTP-status message.

### R9 ruling (dev question, 2026-10-23) — replaces R9's test line
Verified: `executeSyncOperation` uses the stored access token as-is (`sync-engine.ts:178-179`); refresh runs only on
the mapping actions; a Gusto sync never calls Gusto (`gusto.ts:181-187`). So a QuickBooks sync more than an hour after
the last refresh fails today (existing bug).
- **Refresh in the sync, QuickBooks only:** `executeSyncOperation` calls `ensureValidToken(connectionId)` for the
  QuickBooks connector **after** the `running` sync-log row is inserted and before the push, and uses the returned
  token. Gusto's sync is unchanged (no provider call, so no refresh — avoids a pointless refresh-token rotation).
- **401 from any QuickBooks or Gusto API call** (query/create/batch/GET/POST, after a refresh) → the "connection has
  expired — reconnect" message (a 401 right after a refresh means authorization was revoked).
- **Tests:** (1) QuickBooks sync with an expired token whose refresh returns 401 → sync log `error_summary` and the
  action result carry the reconnect message, no response body text; (2) QuickBooks sync with a valid token whose batch
  call returns 500 → the HTTP-status message; (3) QuickBooks sync with an expired token and a successful refresh → the
  push uses the new token and the sync succeeds (the stale-token bug); (4) a mapping action whose refresh returns 401 →
  the reconnect message in its result.
- **Leave unchanged:** OAuth code-exchange failures (`qbo-api.ts:83`, `gusto-api.ts:84`) and "No company found"
  (`gusto-api.ts:287`) — setup-time, not sync-time.
- **Backlog:** two concurrent refreshes of one connection can race on refresh-token rotation (pre-existing on the mapping
  page too) — serialize per connection with an advisory lock later.

## 9. Build check (product owner, after R9 `2220945`) — R10

Full integration run: passed (product owner). `npm run build` fails: "Invalid segment configuration export detected".
**Cause (lead):** route segment config must be a literal Next can read statically
(`node_modules/next/dist/build/analysis/get-page-static-info.js:226`); `src/app/api/cron/daily-reminder/route.ts:28`
and `src/app/api/cron/submission-deadline/route.ts:29` export `maxDuration = REMINDER_CRON_MAX_DURATION_S` (imported).
**R10 fix:** `export const maxDuration = 300;` (literal) in both routes. **Tests:** a static test that every
`export const (maxDuration|dynamic|revalidate|runtime|fetchCache|preferredRegion|dynamicParams)` under `src/app` is
assigned a literal (fixture with an identifier must fail), and that both reminder routes' literal equals
`REMINDER_CRON_MAX_DURATION_S`. Then `npm run build && node scripts/check-build-trace.mjs` must pass.

## 10. Status after R10 (`63dd52c`) — 2026-10-23

R10 verified: both reminder routes export a literal `maxDuration = 300`; 1019 unit tests pass; `tsc` clean;
`npm run build` passes (product owner) and `node scripts/check-build-trace.mjs` passes on that build (all 15 tenant
migrations in the signup route's trace). Full integration run passed (product owner).
**Code audit: CLEAN for merge.** Remaining before the PR: `npm run demo:local` twice and the §10 manual browser
checks (product owner). `SIGNUP_CONTROLS_ENABLED` stays off in staging/production until the updated Privacy Policy is
published (LB-D3, LB-D5).

## 11. Manual check finding (product owner, flag on) — R11, required before merge

`POST /signup/verify` → 500: `Failed query: update "signups" set "verified_at" = coalesce("signups"."verified_at", $1)`
→ `TypeError … Received an instance of Date`. **Cause (lead):** drizzle's postgres-js driver replaces the timestamptz
serializer with a pass-through (`node_modules/drizzle-orm/postgres-js/driver.js:16-19`) because column encoders map
dates; a raw `Date` interpolated into a `sql` fragment skips the column encoder, postgres-js infers type 1184
(`postgres/src/types.js:223`) and the pass-through hands the `Date` object to the wire encoder → crash. Same class as the
`notices.ts` bug fixed earlier. Integration tests pass anyway (most likely the test runner's module loading makes the
driver's `instanceof Date` false, so the value goes as text) — **the integration suite cannot catch this class; a
static check must.**
- **Sites (lead's full scan of every `sql` template in `src/` and `scripts/`, multi-line included):**
  `src/app/signup/verify/route.ts:207` (`${now}`) and `src/lib/signup/signals.ts:30-31` (`${stale}`, `${now}` — the
  outage / hostname-mismatch counter crashes on every second signal, so those alerts can never fire). No others.
- **Fix:** `${now.toISOString()}::timestamptz` (and `${stale.toISOString()}::timestamptz`), as `notices.ts` does.
- **Test:** static test over every `sql` template in `src/` and `scripts/`: each `${…}` must be a column reference
  (`table.column`), end in `.toISOString()` followed by a `::timestamptz`/`::date` cast, or be on a small justified
  allowlist (advisory-lock keys, the heartbeat `name`); fixtures with `${now}` and `${stale}` must fail. Keep the
  existing integration tests.
- **Product owner:** after the fix, reopen the same verify link (its `verified_at` was never written) and continue the
  manual checks.

**R11 verified (`7015229`, 2026-10-25):** both sites use ISO + `::timestamptz`; the lead's independent scan finds only
the allowlisted lock keys / heartbeat `name`; `unit/sql-template-params` passes and its fixtures fail as required;
1023 unit tests pass. Accepted: the wider scan of raw clients later wrapped by `drizzle()`; `scripts/register-tenant.ts`
left alone (its client is never drizzle-wrapped, so postgres-js serializes the Date itself). Backlog: clients wrapped
via `Object.assign` (`workspace-export.ts:73`) aren't recognized by the scan — no interpolations there today.
