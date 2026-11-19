# Pre-staging regression and test-gap sweep: findings and fix round

**Item:** build queue 8, step 1 (product owner, 2026-11-19: "a very rigorous amount of unit/integration tests after all of these"). **Code swept:** `main` at `4ae8c31`.

## 1. What was done
- **Lead's gates on `main`:**
  - passed: `tsc`, lint (0 errors), `db:safety`, `db:check`, `test:tz` (3,277 unit tests × 3 time zones), and the production build;
  - integration alone, under load from the auditors: 1,171 of 1,173 passed, with 2 timing flakes (§5, T-1). Both files pass 5 times in a row on their own, even under load;
  - `test:coverage` can't run: `@vitest/coverage-v8` isn't installed (§5, T-3).
- **All 10 checks files re-run on today's `main`** by a runner agent, with email disabled: **no regressions**. Two out-of-date expectations in `DATABASE-BACKUPS-BROWSER-CHECKS.md` (§5, T-2).
- **Three independent mutation auditors** on the whole codebase (unit tests only). Areas: (1) tenancy, sign-in and security; (2) billing, lifecycle and notices; (3) timekeeping, approvals, reports and data safety. **449 one-edit breaks; about 175 meaningful survivors.**
- **The lead's integration confirmation:** eight of the most serious claimed-uncovered breaks were applied **all at once**, and the full integration suite still passed **1,173 of 1,173**. With the unit results, that means **no test anywhere** catches any of these:
  1. a read-only workspace writing (`getTenantForWrite` allowing `read_only`);
  2. `getDbForWrite` skipping the write gate;
  3. a deactivated user signing in;
  4. a deactivated user keeping their session (`jwtCallback`);
  5. a revoked API key working;
  6. `tenant:delete` dropping a database another workspace uses;
  7. the workspace export stopping after its first 5,000 time entries;
  8. a lapsed trial's deletion date moving forward every day (never deleted).

  **Today's code is correct on all eight; only the safety net is missing.**

**No HIGH code defect.** There is no cross-workspace leak, no sign-in bypass, no approval-scope hole and no wrong charge. Four MEDIUM code defects are listed below.

## 2. Product-owner decisions (2026-11-19, all as recommended)
1. The admin password reset refuses the admin's **own** account; Change password is the way to change your own. This matches the MFA reset.
2. **Supervisors** get the daily and deadline timesheet reminders, like employees. That's everyone in `EXPECTED_SUBMITTER_ROLES`.
3. **No payment, trial or suspension emails while a workspace is policy-held.** They resume if the hold is lifted.
4. The admin change log records **workspace time-zone changes** and **charge-code assignments and removals**, with who and when.

## 3. How the fix round runs
Three dev sessions, **each on its own branch from the latest `main`, in its own worktree**. The areas don't share files; where a rule touches two areas, it's assigned to exactly one session below.

**Rules for every session:**
- **Tests first.** Every new test must fail under the mutation it covers. **Revert-check every one** and list the checks in the dev report.
- **Prefer unit tests** (fast suite; they run on every push), using fakes for the database where needed, as `integration/tenant-closed-jwt.test.ts` does without one. Use integration only when the rule lives in SQL or across transactions.
- **Code changes:** only the fixes listed for your session. Nothing else, no refactors. If you find something new, tell the lead; don't fix it.
- **The local Postgres is shared by all three sessions.** **Ask the lead for the integration slot before any integration run**, and say when you're done. Unit tests need no slot.
- Never push. Commit by name (no `-A`). No real Stripe, Neon, Vercel, Resend, Upstash, AWS, GitHub, QuickBooks or Gusto. Never touch acme, globex or initech or any remote database.
- **Email safety:** `.env.local` has a real Resend key, so `export RESEND_API_KEY=` (empty) in every shell. Both `node --env-file` and Next's env loader keep the empty value.
- **Finish:** every gate (tsc, lint, unit, `test:tz`, `db:safety`, build); integration for touched files 5× and under a CPU hog in your slot; then the full suite once. Write `SWEEP-FIX-<AREA>-DEV-REPORT.md` (uncommitted) and message the lead.

**IDs:** A1-, A2- and A3- prefixes refer to auditors 1–3. The auditors' full reports are summarised here; ask the lead for any detail.

---

## 4. Session S1: tenancy, sign-in and security (branch `sweep-fix-auth`)

### Code fixes
- **A1-D1 (MEDIUM): tokens in addresses reach Sentry.**
  - **Problem:** set-password, password-reset and signup-verify tokens (64 hex characters in `?token=`, plus `&email=`) are in page URLs. The new signer is redirected to `<slug>.<root>/reset-password?token=…&email=…&welcome=1`, a 72-hour token that takes over the workspace's admin. `src/lib/sentry-scrub.ts` only knows the 43-character export token.
  - **Fix:** in `scrubString`, replace the value of any `token`, `email`, `code` or `state` query parameter (`[?&](token|email|code|state)=[^&#\s"]*`, case-insensitive, including URL-encoded `%3F`/`%26` forms) with `[Filtered]`.
  - **Tests:** a sample reset URL, a set-password URL and a verify URL in `request.url`, in a breadcrumb and in a span. The export cases must still pass. Revert-check.
- **A1-D2 (PO decision 1):** `adminResetPassword` (`src/server/actions/password.ts:90-124`) refuses `targetUserId === actor.id`, using the same wording style as `adminResetMfa` (`mfa.ts:152`). Test.
- **A1-D3:** `changePassword`, `disableMFA` and `completeMFASetup` key the lockout on the email **read from the database**, as `adminResetMfa` does, not on the JWT's `actor.email`. Test: after an email change, failures count against the current email.
- **A1-D4:** in `src/server/actions/api-keys.ts:53-54` and `integrations.ts:49,149,223,247`, authenticate (`requireAdmin*`) **before** `getDb()`. Extend the guard-first static rule to cover non-`userAction` actions if feasible; otherwise pin these.
- **A1-D5:** `checkSlugAvailable` (`signup.ts:27`) has no caller. **Delete it** and remove it from `PUBLIC_ACTIONS`.
- **A1-D6:** `checkLockout` (`login-attempts.ts:16`): if a client calls it, rate-limit it with the existing sign-in IP budget; if not, delete it. Either way, update `PUBLIC_ACTIONS`.
- **A1-D7:** `gusto.ts:96` logs the whole `/v1/token_info` response. Remove the log, or log only non-personal ids.
- **A1-D8:** `resetPassword` (`password-reset.ts:162-167`) uses `validatePassword` instead of its own 8–128 check. Test with a non-string input.

### Tests to add (each failing under its mutation)
- **HIGH:**
  - **A1-G1 / A2-G1, the write gate:** `getTenantForWrite` resolves only in `full` and throws `WorkspaceReadOnlyError` with the exact message for `read_only`, `billing_only`, `policy_hold`, closed and provisioning. `getDbForWrite` goes through `getTenantForWrite` (real `@/db`, postgres mocked).
  - **A1-G2, `jwtCallback`'s slow path:** inactive → invalidated; `sessionVersion` mismatch → invalidated; deleted user → invalidated; role re-synced; no query within 60 s; the session callback leaves `user` undefined when invalidated. `session-invalidation.test.ts` is tautological; fix it or replace it.
  - **A1-G3:** sign-in refuses an inactive user with the right password (`auth.ts:99`), and records the failure.
  - **A1-G4, v1 API keys** (`src/lib/api-auth.ts:62-86`): revoked → 403; expired → 403; creator demoted or inactive → 403; handler never runs; the lookup is by `sha256(key)`.
  - **A1-G5:** one pool per connection string: `getDbForUrl(a) !== getDbForUrl(b)`, and `getDbForUrl(a) === getDbForUrl(a)`.
- **MEDIUM:**
  - **A1-G6:** the 27 admin actions in the auditor's list must use an **admin-level** guard, not just any guard. Add an `ADMIN_ACTIONS` static rule (each must call `requireAdmin*`/`requireApprover*` as appropriate), or extend `fresh-admin-writes.test.ts`. The list: `createApiKey`, `revokeApiKey`, `deleteApiKey`, `startCheckout`, `openBillingPortal`, `previewChargeCodeCategoryImpact`, `reactivateChargeCode`, `previewRateChangeImpact`, `bulkImportEmployees`, `bulkImportContracts`, `bulkImportClins`, `bulkImportLaborCategories`, `bulkImportAssignments`, `disconnectIntegration`, `startQuickBooksConnect`, `validateMigrationData`, `validateMigrationPeriods`, `importMigrationData`, `importMigrationPeriods`, `adminResetMfa`, `adminResetPassword`, `updateUser`, `createUserWithPassword`, `setUserApprover`, `updatePayPeriodConfig`, `updateWorkspaceTimezone`, `updateWorkweekStartDay`.
  - **A1-G7 / A2-G9:** `getDbForAuth` refuses a closed workspace.
  - **A1-G8:** `getTenantState` with a forged header → `mismatch`.
  - **A1-G9:** AES-GCM uses a random IV (`encrypt(x) !== encrypt(x)`, with different IV bytes).
  - **A1-G10:** the lockout query filters by email (two emails; one's failures don't lock the other).
  - **A1-G11:** a new `registry.test.ts`: an unknown slug isn't cached; the 60-second TTL; `invalidateTenant` re-queries; a tombstone gets `dbUrl ''`.
  - **A1-G12:** `isValidSlug` refuses `a.b`, 64 characters and non-ASCII.
  - **A1-G13:** `changePassword` bumps `sessionVersion`.
  - **A1-G14:** `updateUser` bumps `sessionVersion` on a role-only and on an active-only change.
  - **A1-G15:** the audit CSV, cell history and timesheet reads pass a supervisor's scope.
- **LOW:**
  - **A1-G16:** password reset: the per-email 3/hour limit, active users only, `usedAt`, and the minimum length.
  - **A1-G17:** signup: the terms gate, an invalid slug refused, and resend only for pending rows.
  - **A1-G18:** the verify page escapes HTML, and a resume binds `signupEmail`.
  - **A1-G20:** TOTP: a code 2 steps old is rejected, and the returned step is correct.
  - **A1-G21:** the export route uses `getTenantForExport`, and its 5-per-hour limit.
  - **A1-G22:** `getTenantForBilling` refuses deleting and deleted workspaces.
  - **A1-G23:** remove `getTenantForBilling` from the guard test's `GUARD_PATTERN`: it doesn't authenticate, and every billing action already calls `requireAdmin*`.
  - **A1-G24:** pin the client IP as the first XFF entry.
  - **A1-G25:** the scrub of null-prototype objects.

---

## 5. Session S2: billing, lifecycle, notices and the founder's commands (branch `sweep-fix-billing`)

### Code fixes
- **A2-D1 (PO decision 3): no payment, trial or suspension emails while a workspace is policy-held.**
  - The DUNNING branch must not queue `payment-failed` while `suspensionReason === 'policy'`.
  - `isNoticeSuperseded` supersedes pending `payment-failed`, `suspension-warning`, `suspended`, trial reminders and `trial-ended` while a policy hold is on. Re-queue them through the normal lifecycle once the hold is lifted.
  - Deletion notices and `export-ready` are **not** affected.
  - Tests for each, including that the emails resume after `unsuspend`.
- **A2-D2:** `AUTO_DELETE` (`lifecycle-config.ts:42`) is never read. **Remove it** and its doc. Deletion stays founder-run (`tenant:delete`).
- **A2-D3:** after a control-plane rebuild, the first seat sync writes a false "changed outside the sync" digest line. **Docs only:** note it in RESTORE.md's control-plane section ("expected once per workspace after a rebuild"). No code change.
- **A2-D4:** `openBillingPortal` (`billing.ts:90-103`) refuses a closed workspace, like `startCheckout`. Test.
- **A2-D5:** `force-notice-sent --anchor <bad>` refuses cleanly ("--anchor must be an ISO date-time") instead of crashing. Test.
- **A2-D6:** a trial workspace policy-held before its trial ends gets no deletion date until the hold is lifted. That's intended: a policy hold keeps data. **Document it** in TENANT-DELETION.md. No code change.

### Tests to add
- **HIGH:**
  - **A2-G2:** `tenant:delete` refuses when another non-deleted workspace uses the same database URL, and when a sibling's URL can't be decrypted (`delete-tenant.ts:248-258`). The database still exists and the status is unchanged.
- **MEDIUM:**
  - **A2-G3:** a lapsed trial's deletion date is set **once** (`lifecycle.ts`, `if (D === null)`): trial ended 80 days ago with D set → no new D, and `readyForDeletion` at D.
  - **A2-G4:** termination after exactly 30 days suspended (not at 29 d 23 h; yes at 30 d); pin the constant.
  - **A2-G6:** a pending deletion notice is superseded once D is cleared (a trial-lapsed tenant subscribes).
  - **A2-G7:** the digest lists "Ready for deletion", with "OVERDUE", the "blocked" and stuck-deleting lists; an open alert means no "All quiet".
- **LOW:**
  - **A2-G8:** the exact-instant edges: closed at exactly D; trial at exactly T.
  - **A2-G10:** no trial notices while suspended; `blocked-transition` waits 2 days; the `DELETION_SLA_DAYS` overdue flag.
  - Auditor 2's possibly-uncovered integration items: P08 (`Math.max(1, …)` in seat sync).

(A2-G1, the write gate, is S1's. A2-G5, the reminder crons, is S3's.)

---

## 6. Session S3: timekeeping, approvals, reports, data safety and test hygiene (branch `sweep-fix-timekeeping`)

### Code fixes
- **A3-D1 (MEDIUM):** `/api/v1/timesheets` (`src/app/api/v1/timesheets/route.ts:79,83`).
  - Order by a unique key last (`users.fullName, entryDate, <entry id>`), so pages never overlap or skip.
  - `meta.total` is the true total count, not the page length.
  - Tests: tied rows across pages appear exactly once, and the total is correct.
- **A3-D2 (MEDIUM):** `importQboChargeCodes` and `importQboClasses` (`src/server/actions/qbo.ts:198-246`) validate each item with `validateChargeCodeInput` (active CLIN and contract, UUIDs, lengths, work location), and run in **one transaction** (all or nothing). Tests: a closed contract's CLIN is refused; a duplicate halfway through rolls everything back.
- **A3-D3, D4, D5:** invalid query parameters return **400**, not 500:
  - `/api/v1/periods` `status`;
  - `/api/v1/timesheets` `page`, `pageSize` and `userId`;
  - the cost-report CSV and XLSX `contractId` (UUID check, as `/api/v1/costs` does).

  A test each.
- **A3-D6 and D9 (PO decision 4):** `updateWorkspaceTimezone` (`workspace-settings.ts:28`), and charge-code assign and `unassignChargeCodeFromUser` (`charge-codes.ts:296`), write `admin_change_log` entries the way the workweek change does. Add them to the log registry, and validate the UUIDs in `unassignChargeCodeFromUser`. Tests.
- **A3-D7 (PO decision 2):** the daily and submission-deadline reminders (`daily-reminder/route.ts:96`, `submission-deadline/route.ts:108`) select everyone in `EXPECTED_SUBMITTER_ROLES` (employee and supervisor), not just `role='employee'`. Tests.
- **A3-D8:** `scripts/check-migration-safety.ts`:
  - flag `ADD CONSTRAINT`, `DROP INDEX`, `DROP CONSTRAINT`, `DROP TRIGGER`, `TRUNCATE` and `DELETE`;
  - an allow comment waives **only the pattern it names**, not the whole statement chunk;
  - add a unit test for the script.

  Check that every existing migration still passes or carries a correct named allow; add allows only where the existing migration was reviewed as safe, citing it.

### Tests to add
- **HIGH:**
  - **A3-G1:** the workspace export's keyset pagination. With more than one batch (an injectable `BATCH_SIZE` is fine), every row appears exactly once, and the manifest row counts equal the table counts (`workspace-export.ts:138-142,229-233`).
- **MEDIUM:**
  - **A3-G2:** the detailed cost report's contract filter (`reports.ts:72-74`) and `/api/v1/costs?contractId=` return only that contract's rows.
  - **A3-G3:** `/api/v1/timesheets/approved` excludes submitted and draft periods, and an entry the day after an approved period.
  - **A3-G4:** submit is refused before the last weekday, with the date, and for an empty timesheet; nothing is written (`periods.ts:221,249`).
  - **A3-G5:** export column completeness: every schema column of each exported table is either exported or on an explicit never-exported list, so a new column forces a decision.
  - **A3-G6:** the tenant and control-plane journals have strictly increasing `when` and `idx`, and the SQL files match the entries one to one.
  - **A3-G7:** payroll reads from the workweek start (`payroll-data.ts:101`), if `payroll-flsa`'s boundary-week test doesn't already catch it (check by mutation).
  - **A2-G5:** the reminder crons email only `full` workspaces. Make the mode mock configurable, and assert no batch for `read_only`, `billing_only`, `policy_hold` or closed.
- **LOW:**
  - **A3-G8:** a rejected period's PDF has no approval line.
  - **A3-G9:** an inactive admin or supervisor can't approve and isn't in `eligibleApprovers`.
  - **A3-G10:** the reminder schedule: deadline −1 or −3 days sends nothing; no daily reminder on Saturday.
  - **A3-G11:** supervisor → admin also clears approval scope.
  - **A3-G12:** the export secret check also checks keys against a forbidden list.
  - **A3-G13:** an `effectiveFrom` of today is refused.
  - **A3-G14:** `openExportSnapshot` sends `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` on the direct (non-pooler) host.

### Test hygiene (S3 owns these)
- **T-1, two flaky integration tests:** both failed in a full-suite run under load and passed 5 times in a row alone. Make each deterministic, with no wall-clock race:
  - `backup-locks.test.ts` "S21 … FR6: an unconfirmed failing count still runs the handshake": the expected "Waiting for the backup run to finish…" log was missing;
  - `export-failures.test.ts` "T20 … a stalled stream": with `deadlineMs: 1_500`, the deadline can land before the upload starts. Make the deadline fire only after the stalled upload has begun.

  Prove each deterministic under the CPU hog **while another integration file runs in parallel** (in your slot).
- **T-2:** `DATABASE-BACKUPS-BROWSER-CHECKS.md` has two out-of-date expectations:
  - B.1: the bundle is now about 4.6 MB, grown by 3c, 3c-2 and 3d;
  - C, row `digest BACKUPS_EXPECTED=1`: a third line, `"Disaster runs in the last 7 days: none."`, added by `5c2c8f3`.

  Update the text.
- **T-3:** add `@vitest/coverage-v8` as a dev dependency, pinned to the installed vitest's version, so `npm run test:coverage` works. Run it once and attach the summary to the dev report.

---

## 7. After the fix round
- The lead audits each branch: diff read, gates, integration alone, and a break-it run of the new tests' mutations.
- The product owner pushes and merges each branch's PR after the lead's READY.
- Then: the account setup (PRODUCTION-DEPLOY Phases 3–11) and the staging rehearsal (Phase 12).
