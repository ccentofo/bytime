# Blueprint: Security Hardening — Round 2 (tenant-bound sessions, period-lock integrity, data exposure)

> **Role for the executing developer: Senior application-security engineer.** Continue on the
> **`security-hardening`** branch (round 1 is already committed there and must not be regressed).
> Every finding below was **verified line by line** in the current code during an independent audit.
> Implement the fixes; don't re-investigate. Same rules as round 1: authorization and data-handling
> fixes only, fail closed, and prove each fix with a test that would fail without it.

## 0. Product decision (LOCKED — changes a round-1 rule)

**Admins may approve their own timesheets** (for now; a designated-approver option may come later).
Supervisors and employees still may **not** approve or reject their own period. An admin
self-approval must remain **visibly auditable** (see R2-7).

## 1. Findings (severity order)

| ID | Sev | Finding | Where | Origin |
|---|---|---|---|---|
| R2-1 | 🔴 Critical | **Cross-tenant session replay.** One Auth.js instance and one `AUTH_SECRET` serve every tenant. `token.tenantSlug` is written at sign-in but **never compared** with the request's tenant. A user who self-signs-up (and so is admin of their own tenant) can replay their session cookie against another tenant's host: the JWT verifies, `requireAdmin()` passes on the token's role, and `getDb()` serves the **other** tenant's data. | `src/auth.ts` (jwt callback, ~L127–230), `src/lib/session.ts` | pre-existing |
| R2-2 | 🟠 High | **Period-lock bypass.** `saveTimesheetBatch` checks the lock only for the **client-supplied** `periodStart` and never bounds `dayIndex`; `entryDate = periodStart + dayIndex`. Negative/out-of-range `dayIndex`, or a `periodStart` that isn't a real period start (no period row → treated as draft), writes revisions into **submitted/approved** periods. | `src/server/actions/timesheet.ts` (`saveTimesheetBatch`) | pre-existing |
| R2-3 | 🟠 High | **Password hashes and encrypted MFA secrets sent to the browser.** `getUsers` does `db.select().from(users)` and the Users page passes the rows as client props; `updateUser` / `createUser*` return full rows via `.returning()`. | `src/server/actions/users.ts`, `src/app/(app)/admin/users/page.tsx` | pre-existing |
| R2-4 | 🟠 High | **Regression: `/api/v1/costs` returns 500 for every API client.** It calls `getDetailedCostReport`, which now requires an admin **session**; API-key requests have none. | `src/app/api/v1/costs/route.ts`, `src/server/actions/reports.ts` | **new** |
| R2-5 | 🟡 Medium | **Regression: supervisors see cost-report buttons that return `{"error":"Forbidden"}`**, and their employee-summary export shows a fake `$0` cost column. | `src/app/(app)/admin/reports/ReportsClient.tsx`, `page.tsx`, `reports.ts` (~L400), `src/lib/reports/cost-report-excel.ts` | **new** |
| R2-6 | 🟡 Medium | **Mass assignment.** Client objects are spread into DB writes, so callers can set columns they shouldn't. Worst: `updateNotificationPreferences` spreads `prefs` **after** `userId: actor.id` — any user can override `userId` and change **another user's** notification settings. Also `updateUser` (any column, incl. `passwordHash`, `totpEnabled`, `sessionVersion`; role not enum-validated; email not normalized). | `notifications.ts:38,42`, `users.ts:144`, `charge-codes.ts:99`, `assignments.ts:68`, `labor-categories.ts:154` | pre-existing / touched |
| R2-7 | 🟡 Medium | **Self-approval rule** must change per §0, with an audit marker. | `src/server/actions/periods.ts`, `ApprovalsClient.tsx`, timesheet PDF | product decision |
| R2-8 | 🟡 Medium | **Stale role for sensitive actions.** Round 1 replaced DB role lookups with the JWT role, refreshed at most every 60 s and **failing open** when that DB check errors. A demoted/deactivated admin can keep approving, resetting passwords, etc. | `src/lib/session.ts`, `src/auth.ts` | **new** (freshness) |
| R2-9 | 🟠 High | **QuickBooks/Gusto OAuth.** (a) CSRF: `state` is a fixed string (`'bytime_qbo_connect'` / `'bytime_gusto_connect'`) and the callback never validates it — an attacker can connect a victim workspace to the **attacker's** QuickBooks company and receive its synced data. (b) Broken in production: the redirect URI is the **apex** domain, where the tenant-subdomain session cookie doesn't exist and there's no tenant to save into. | `qbo-api.ts`, `gusto-api.ts`, `api/integrations/qbo-connect`, `gusto-connect`, `callback/[provider]` | pre-existing |
| R2-10 | 🟡 Medium | **"Timesheet submitted" emails go to every supervisor and admin** (no scope, no active check), leaking employee activity. | `periods.ts` (`submitPeriod`) | pre-existing |
| R2-11 | 🟡 Medium | **Bulk employee import skips the plan seat limit** (`assertSeatAvailable` only in single-user create paths). | `src/server/actions/import.ts` | pre-existing |
| R2-12 | ⚪ Low | Cleanup: status disclosed before scope check in approve/reject; report routes map **every** error to 401; guard detection relies on message prefixes; approver client handlers lack try/catch; TOTP codes replayable within the window; guard-coverage test fooled by comments and doesn't enforce order; API keys outlive their creator's admin role; supervisor read-scope excludes self while `assertCanAccessEmployee` includes self; dead code and stale comments. | see R2-12 below | mixed |

## 2. Fixes

> **⚠️ GUARDRAILS (all items)**
> - Read `AGENTS.md`; confirm Next.js 16 / Auth.js v5 beta / Drizzle APIs in `node_modules`.
> - **Do not change business behavior** beyond what each item specifies. Append-only revisions,
>   reason codes, charge-code denormalization, the `user_assignments` sync, and scope semantics stay.
> - Fail closed. Never weaken a guard to make a test pass.
> - Every item ships with a test that fails on the current code and passes after the fix.

### R2-1 — Tenant-bound sessions (do this first)
Auth.js runs the `jwt` callback on every `auth()` call (confirmed in
`node_modules/@auth/core/lib/actions/session.js`: a `null` return yields no session and clears the cookie).
1. In the `jwt` callback, on **every** non-sign-in invocation and **before** the 60-second
   "recently checked" early return: resolve the request tenant with `getTenantSlug()` (dynamic
   import, as the callback already does). If `token.tenantSlug` is empty, if `getTenantSlug()`
   throws (header tampering), or if the two differ → **return `null`**. This check needs no DB query.
2. Defense in depth: in `getSessionUser()` (`src/lib/session.ts`), return `null` if
   `session.user.tenantSlug` ≠ `await getTenantSlug()`.
3. Extract the jwt callback body into an exported function (e.g. `jwtCallback`, mirroring how
   `authorizeCredentials` was extracted) so it can be unit-tested.
4. Tests: (a) a token for tenant A on a request for tenant B returns `null` on **both** the slow
   path and the 60-second fast path; (b) a token with an empty `tenantSlug` returns `null`;
   (c) matching tenant passes; (d) `getSessionUser()` returns `null` on mismatch; (e) an integration
   test where the session mock carries tenant A's slug and the request resolves tenant B, calling a
   guarded action (e.g. `getUsers`) → `Unauthorized`.

### R2-2 — Period-lock integrity
In `saveTimesheetBatch`, before any write:
1. `const config = await getEffectiveConfigAt(periodStart)`; reject unless `periodStart` (start of
   day) equals `getPeriodStartForDate(periodStart, config)`.
2. `const numDays = getNumDaysInPeriod(periodStart, config)`; reject unless every `cell.dayIndex` is
   an **integer** with `0 <= dayIndex < numDays`.
3. Keep `assertPeriodEditable` (now provably covering every entry) and the future-date check.
4. Tests: `dayIndex = -1` and `dayIndex = numDays` rejected; a non-period-start `periodStart`
   rejected; a fractional `dayIndex` rejected; an attempt to write into an **approved** prior period
   via a neighboring draft period is rejected; normal saves still succeed.
5. `src/lib/offline/sync-service.ts` hardcodes semi-monthly period math, but nothing ever queues
   offline entries (`saveOfflineEntry` has no callers), so it's dormant. Don't build it out; add a
   comment that the server-side check above now makes any future sync safe.

### R2-3 — Never send secrets to the browser
1. Define one safe column set for users (e.g. `SAFE_USER_COLUMNS` in `src/server/internal/users.ts`:
   id, email, fullName, role, isActive, flsaExempt, totpEnabled, createdAt, updatedAt,
   passwordChangedAt — whatever the UI actually renders) and use it in `getUsers`, and in
   `.returning()` for `updateUser`, `createUser`, `createUserWithPassword`.
2. Sweep `src/server/actions` and `src/app` for any other `select()` / `.returning()` on `users`
   without an explicit column list and fix them.
3. Test: `getUsers()`, `updateUser()`, and `createUserWithPassword()` results contain no
   `passwordHash`, `totpSecret`, or `totpRecoveryCodes` keys.

### R2-4 — Restore `/api/v1/costs`
Move the query body of `getDetailedCostReport` into `src/server/internal/reports.ts`
(`getDetailedCostReportData`). The server action keeps `requireAdmin()` and calls it; the v1 route
calls the internal helper **after** `validateApiKey()` succeeds. Test: a valid API key gets 200
with data; no/invalid key gets 401.

### R2-5 — Reports UI for supervisors
1. `reports/page.tsx` passes the user's role to `ReportsClient`.
2. For non-admins, hide the **Detailed Cost Report** card and any cost-only filter (e.g. Contract),
   and change copy like "hours & cost" to "hours".
3. `getEmployeeSummaryReport` **omits** cost fields for non-admins (don't return `0`), and the Excel
   generator takes an `includeCost` flag so the cost column and total are absent for supervisors.

### R2-6 — Kill mass assignment
For each spread listed in R2-6, build the write object from an **explicit allowlist** of fields:
- `updateNotificationPreferences`: only the five boolean preference keys, each coerced to boolean;
  `userId` always `actor.id`.
- `updateUser`: only `fullName`, `email`, `role`, `isActive`, `flsaExempt`. Validate `role` with the
  existing `validateEnum(…, USER_ROLES)`; validate and lower-case `email` exactly as `createUser`
  does. Make the **last-active-admin check and the update atomic** (one transaction that locks the
  active-admin rows, e.g. `SELECT … FOR UPDATE`, then counts and updates).
- `updateChargeCode`, `assignUserToClin` (`assignments.ts`), `assignUserToLaborCategory`: allowlist
  the fields each form legitimately sends.
- Add an assertion to the guard-coverage test (or a sibling test) that fails if a `'use server'`
  file spreads a function parameter (`...data`, `...prefs`, `...input`, etc.) into `.values()` or
  `.set()`.
- Tests: notification prefs can't target another user; `updateUser` ignores/rejects `passwordHash`,
  `sessionVersion`, `totpEnabled`; an invalid role is rejected; email is normalized.

### R2-7 — Admin self-approval (per §0)
1. `approvePeriod` / `rejectPeriod`: allow `period.userId === actor.id` **only when
   `actor.role === 'admin'`**; supervisors and employees still get `Forbidden` for their own period.
   Admins' own periods must appear in their approval queue.
2. `ApprovalsClient.tsx`: enable the approve/reject buttons on an admin's own period, labelled
   clearly (e.g. "Approve (self)").
3. Auditability: wherever an approval is shown (approvals list/drawer, timesheet PDF), display
   **"Self-approved"** when `reviewedBy === userId`. No schema change needed: the existing
   `reviewedBy` column already records it.
4. Update round 1's integration tests: admin self-approval succeeds; supervisor and employee
   self-approval still fail.

### R2-8 — Fresh authorization for sensitive actions
1. Add `requireAdminFresh()` and `requireApproverFresh()` in `src/lib/session.ts`. They call the
   existing guard, then re-read `role` and `isActive` for the session user from the tenant DB, and
   deny if the user is inactive or no longer holds the required role. Fail **closed** on DB error.
2. Use them in: `approvePeriod`, `rejectPeriod`, `adminResetPassword`, `updateUser`, `createUser`,
   `createUserWithPassword`, `createApiKey`, `revokeApiKey`, `deleteApiKey`, every `bulkImport*`,
   every `migration.ts` write, `createConnection` / `disconnectIntegration`, `updatePayPeriodConfig`,
   `startCheckout`, `openBillingPortal`.
3. Test: a user demoted to employee in the DB (token still says admin) is denied by
   `adminResetPassword` and `approvePeriod`; a deactivated admin is denied.

### R2-9 — OAuth: signed state + working multi-tenant callback
Design (apply to QuickBooks and Gusto):
1. **Connect** (on the tenant host; `requireAdminFresh`): generate a random nonce, set it in an
   `httpOnly`, `Secure`, `SameSite=Lax`, host-only cookie with a 10-minute expiry, and build
   `state` = base64url(JSON `{ tenantSlug, userId, provider, nonce, exp }`) + `.` + HMAC-SHA256 over
   it, keyed with a dedicated secret (`OAUTH_STATE_SECRET`, or one derived from `AUTH_SECRET`).
2. **Apex callback** (`/api/integrations/callback/[provider]`, the single redirect URI registered
   with Intuit/Gusto): verify the signature and `exp` (constant-time compare), then 302 to
   `https://<tenantSlug>.<APP_ROOT_DOMAIN>/api/integrations/complete/[provider]` carrying `code`,
   `realmId` (QBO), and `state`. Validate `tenantSlug` (`isValidSlug`) before building the URL,
   and never redirect anywhere else.
3. **Tenant complete route** (`requireAdminFresh`): re-verify the signature and `exp`; require
   `state.userId === actor.id`, `state.tenantSlug === getTenantSlug()`, and `state.nonce` equal to
   the nonce cookie (then delete the cookie, so it's single-use). Only then exchange the code
   (using the **same apex redirect URI** in the token request) and call `createConnection`.
4. Tests: missing, forged, expired, or reused `state` rejected; a state minted for a different user
   or tenant rejected; a valid round-trip connects.
5. Document the new env var in `.env.example` and the deploy guide if you add one.

### R2-10 — Scope the submission emails
`submitPeriod` notifies only **active** admins plus **active** supervisors whose scope includes the
submitter (use the internal scope helper), never the submitter themselves, and still respects each
recipient's `emailOnSubmit` preference. Test: an out-of-scope supervisor receives no email.

### R2-11 — Seat limit on bulk import
Before inserting, count the employees the batch would create (excluding rows that match existing
users) and reject the **whole batch** if it would exceed the plan's seat limit (reuse the logic
behind `assertSeatAvailable`). Test: a batch over the limit is rejected and creates nothing.

### R2-12 — Lower-severity cleanup
- `approvePeriod` / `rejectPeriod`: run the self/scope check **immediately after** loading the
  period; out-of-scope → the same `Period not found` as a missing row.
- Introduce a typed `AuthorizationError` (with `kind: 'unauthenticated' | 'forbidden'`) thrown by all
  guards; `guardErrorResponse` uses `instanceof` (not message prefixes). Report routes return 500
  for non-authorization errors instead of 401.
- `ApprovalsClient` (`openReview`) and `AuditTrailClient` (filter/entries/history loaders): catch
  errors and show an inline notification instead of crashing to the error page.
- TOTP replay protection: store the last accepted time-step per user (additive migration, e.g.
  `users.totp_last_used_step`), and reject a code whose step is ≤ the stored one.
- Strengthen `server-action-guards.test.ts`: strip comments before matching, and require the guard
  call to appear **before** the first `db.`/`tx.` query in the body.
- `validateApiKey`: reject a key whose creator is no longer an active admin.
- Make supervisor **read** scope include themselves (their own audit entries/reports), consistent
  with `assertCanAccessEmployee`; approval self-rules stay as in R2-7.
- Delete dead code (`updateConnectionTokens` and `getFailedAttemptCount` have no callers) and fix
  stale comments (`date-utils.ts` mentioning `saveTimesheetEntry`; `periods.ts` "returns to
  'draft'"). Have the self-scoped timesheet readers call the shared internal helpers instead of
  duplicating them.

## 3. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test
npm run test:integration   # TEST_DATABASE_URL, TEST_DATABASE_URL_2, CONTROL_PLANE_DATABASE_URL set (throwaway DBs)
npm run db:safety          # passes; the TOTP column must be an additive migration
grep -rnE "\.\.\.(data|prefs|input)\b" src/server/actions   # no spreads into DB writes
```
Manual (browser):
- Sign in on tenant A, copy the session cookie, and send a request to tenant B with it
  (`curl -H "Cookie: …" https://<b>.localhost:3000/admin/users`) → redirected to login, no data.
- Supervisor on Reports: no cost card; summary export has no cost column.
- Admin approves their own timesheet → succeeds and shows "Self-approved"; a supervisor can't.
- QuickBooks connect round-trip works on a tenant subdomain (sandbox), and a tampered `state` fails.

## 4. Report back
Files changed; for each R2 item, the test(s) that prove it; tsc/lint/unit/integration output;
anything you stopped on or deviated from.

## 5. Out of scope (tracked elsewhere)
- Terms-compliance features: trial expiry, full export with every revision, workspace deletion.
- **Offline time entry is advertised on the landing page but not implemented** (the offline store is
  read-only). Product decision: build it or remove the claim.
- Session-version check failing open on DB errors for non-sensitive reads (R2-8 covers sensitive actions).
- Distributed rate limiting (Upstash).
