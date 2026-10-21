# Blueprint: Security Hardening — Authorization, Role Model, MFA, and Exposed Endpoints

> **Role for the executing developer: Senior application-security engineer.** This is a **P0
> production blocker**. No real customer data goes into CadenzPoint until it ships. The findings
> below were verified line by line in the code; fix them, don't re-investigate. Treat this as a
> security change: small, explicit, test-proven, and **fail-closed** everywhere.

## 1. Why this exists

In Next.js, **every export of a `'use server'` file is a public HTTP endpoint**. Anyone who can
reach the app can call it with arbitrary arguments, logged in or not. The app has 149 such exports;
**72 contain no session check**, several **trust identity supplied by the caller**, and the
`requireAdmin()` guard also admits supervisors. Separately, MFA is never enforced at sign-in.

### Verified findings (severity order)

| # | Severity | Finding | Where |
|---|---|---|---|
| F1 | 🔴 Critical | **Account takeover.** `adminResetPassword` has no session check and authorizes using a caller-supplied `adminUserId`. Combined with unguarded `getUsers` (returns ids + roles), anyone can reset any user's password. | `src/server/actions/password.ts`, `users.ts` |
| F2 | 🔴 Critical | **Self-approval / forged approvals.** `approvePeriod` / `rejectPeriod` trust a caller-supplied `reviewedBy`. An employee can pass an admin's id and approve their own timesheet. Breaks the core DCAA control. | `src/server/actions/periods.ts` |
| F3 | 🔴 Critical | **Privilege escalation.** `requireAdmin()` admits supervisors, and guards `updateUser` / `createUser`, so a supervisor can make themselves admin (also: API keys, billing, imports, integrations). | `src/lib/session.ts` |
| F4 | 🔴 Critical | **Credential exposure.** `getUserByEmail` (in a `'use server'` file, unguarded) returns the full user row, including `passwordHash` and the encrypted `totpSecret`. | `src/server/actions/users.ts` |
| F5 | 🔴 Critical | **Forged time entries.** `saveTimesheetBatch` / `saveTimesheetEntry` / `submitPeriod` take `userId` from the caller with no session check. | `timesheet.ts`, `periods.ts` |
| F6 | 🟠 High | **MFA not enforced.** Password sign-in issues a full session; `/login/mfa` is only a client-side redirect, skippable by typing any URL. `verifyMFALogin` takes a caller-supplied `userId`. | `src/auth.ts`, `LoginForm.tsx`, `mfa.ts` |
| F7 | 🟠 High | **Brute-force protection defeatable / lockout abuse.** `unlockAccount`, `recordFailedAttempt`, `recordSuccessfulLogin` are unguarded public endpoints (unlock anyone, or lock anyone out). | `src/server/actions/login-attempts.ts` |
| F8 | 🟠 High | **Data leaks (IDOR).** `/api/reports/timesheet-pdf?userId=` lets any logged-in user download anyone's timesheet. Unguarded reads expose audit history, reports, users, contracts, assignments, rates. | `src/app/api/reports/timesheet-pdf/route.ts`, many `get*` actions |
| F9 | 🟠 High | **Integration token overwrite.** `updateConnectionTokens` is an unguarded public endpoint that overwrites stored OAuth tokens. | `src/server/actions/integrations.ts` |
| F10 | 🟡 Medium | **Suspended admins can't sign in to pay.** `authorize()` calls `checkLockout()` first, which uses the strict `getDb()` and throws for suspended workspaces, so the billing wall is unreachable. | `login-attempts.ts`, `src/auth.ts` |
| F11 | 🟡 Medium | **Cron endpoints fail open.** If `CRON_SECRET` is unset, anyone can trigger them. | `src/app/api/cron/*/route.ts` |
| F12 | 🟡 Medium | **Known-password accounts creatable in production.** `seedUsers` creates demo users with `Password123!`. | `users.ts` |
| F13 | 🟡 Medium | **Page guards inconsistent.** 10 admin pages admit supervisors; `labor-categories` has no guard at all; the navbar shows supervisors the full admin menu. | `src/app/(app)/admin/*/page.tsx`, `AppNavbar.tsx` |

## 2. The access model (LOCKED — confirmed by the product owner)

| Role | May do |
|---|---|
| **Employee** | Their own timesheet, submissions, profile, password, MFA, notification preferences, own dashboard and own timesheet PDF. |
| **Supervisor = approver** | Everything an employee can do **plus** view, approve, and reject timesheets, view audit history, and view hours-based reports **only for employees in their scope** (employees sharing an active CLIN assignment, per `getSupervisedEmployeeIds`). **Nothing else.** |
| **Admin** | Everything: configuration, users, roles, contracts/CLINs/charge codes, assignments, billing, API keys, imports/migration, integrations, setup, payroll export, and **all** reports including cost/dollar reports. |

Two consequences to apply consistently:
- **Dollar figures (labor rates, costs, funded/ceiling values, cost reports, contract dashboard) are
  admin-only.** Supervisors get hours, not money.
- **Identity always comes from the session — never from a parameter.** "Who is acting" is
  `requireSession()` / `requireApprover()` / `requireAdmin()`'s return value, full stop.

## 3. Architecture rules (apply everywhere)

**R1 — Guard helpers** (`src/lib/session.ts`):
```ts
export async function requireSession(): Promise<SessionUser>;   // any signed-in user (MFA is now part of sign-in)
export async function requireAdmin(): Promise<SessionUser>;     // role === 'admin' ONLY
export async function requireApprover(): Promise<SessionUser>;  // role === 'admin' || 'supervisor'

/** Employee ids the actor may see in approver contexts: 'all' for admins, scoped ids for supervisors. */
export async function getEmployeeScope(actor: SessionUser): Promise<'all' | string[]>;

/** Throws unless the actor is the employee, an admin, or a supervisor with the employee in scope. */
export async function assertCanAccessEmployee(actor: SessionUser, employeeId: string): Promise<void>;
```
Error messages: `Unauthorized` (no session) vs `Forbidden` (wrong role/scope). Never leak whether a
target record exists when the caller isn't allowed to see it.

**R2 — `'use server'` files export ONLY intentionally client-callable actions.** Every internal helper
moves to a plain server module with **no** `'use server'` directive (e.g. `src/server/internal/*.ts`),
importable by server code but not callable over HTTP. Mark these modules `import 'server-only'`.

**R3 — No identity parameters.** Remove `userId` (meaning "the actor"), `adminUserId`, `reviewedBy`,
`createdByUserId`, `assignedBy` from action signatures. Where an admin or approver acts on *another*
user, name the parameter for what it is (`targetUserId`, `employeeId`) and authorize it with
`requireAdmin()` or `assertCanAccessEmployee()`.

**R4 — Fail closed.** Missing session, missing role, unknown scope, missing secret → deny.

## 4. Action-by-action plan

Apply R1–R4 to every export. The table assigns each one a target. "Callers" means: update every
client/server call site (TypeScript errors after the signature changes will find them).

### PUBLIC — intentionally callable without a session (allowlist; keep minimal)
| File | Actions | Notes |
|---|---|---|
| `signup.ts` | `checkSlugAvailable`, `startSignup` | Already IP rate-limited |
| `password-reset.ts` | `requestPasswordReset`, `verifyResetToken`, `resetPassword` | Token-based; must not reveal whether an email exists |
| `login-attempts.ts` | `checkLockout` | Pre-login lockout banner only; read-only; switch to `getDbForAuth` (F10) |

### SELF — `requireSession()`, act only on the session user (drop the actor `userId` param)
`timesheet.ts`: `getChargeCodesForUser`, `getTimesheetEntries`, `getRevisionMap`, `saveTimesheetBatch`.
**Delete `saveTimesheetEntry`** (legacy CLIN-only path, no UI callers; an extra unguarded write path).
`periods.ts`: `submitPeriod`; `getPeriodStatus` → self-only wrapper (keep an internal variant for server use).
`employee-dashboard.ts`: `getEmployeeDashboardData`.
`notifications.ts`: `getNotificationPreferences`, `updateNotificationPreferences`.
`password.ts`: `changePassword`, `getPasswordInfo`.
`mfa.ts`: `initMFASetup`, `completeMFASetup`, `disableMFA`, `getMFAStatus` (already use `auth()`; switch to `requireSession()`).
`pay-period-config.ts` reads needed by the employee timesheet: `getEffectiveConfigAt`, `getCurrentEffectiveConfig`, `getPayPeriodConfig`, `getNeighborPeriod` → `requireSession()`.

### APPROVER — `requireApprover()` + scope (supervisors see only their employees)
| File | Action | Change |
|---|---|---|
| `periods.ts` | `approvePeriod`, `rejectPeriod` | Reviewer = session actor; `assertCanAccessEmployee(actor, period.userId)`; **an actor may never approve or reject their own period** (admins included) |
| `periods.ts` | `getScopedPeriods`, `getScopedPendingApprovals` | Drop the `scopedEmployeeIds` param; derive with `getEmployeeScope(actor)` |
| `periods.ts` | `getPendingApprovals`, `getAllPeriods` | Make admin-only, or remove if the scoped versions cover all callers |
| `timesheet.ts` | `getTimesheetForReview(employeeId, periodStart)` | `assertCanAccessEmployee` |
| `audit.ts` | all 6 actions | Results filtered to `getEmployeeScope(actor)`; `getCellRevisionHistory` → `assertCanAccessEmployee`; filter options list only in-scope users/contracts/CLINs |
| `reports.ts` | `getTimesheetReportData(employeeId, …)` | Self, or `assertCanAccessEmployee` |
| `reports.ts` | `getEmployeeSummaryReport`, `getReportFilterOptions` | Scoped to `getEmployeeScope(actor)`; hours only |
| `src/app/api/reports/timesheet-pdf/route.ts` | — | `requireSession()` + `assertCanAccessEmployee(actor, userId)` (F8) |

### ADMIN — `requireAdmin()` (admin only)
Everything currently using `requireAdmin()` stays on it (the helper itself becomes admin-only), plus
these currently-unguarded reads, which feed admin pages or expose configuration/money:
- `assignments.ts`: `getAssignments`, `getAssignmentsForUser`
- `charge-codes.ts`: `listCostClasses`, `listChargeCodes`, `getUserChargeCodeIds`, `getChargeCodeAssignments`
- `clins.ts`: `getClinsByContract` · `slins.ts`: `getSlinsByClin` · `contracts.ts`: `getContracts`, `getContractById`
- `dashboard.ts`: `getContractSummaries`, `getPeriodCostReport` (dollars)
- `indirect-codes.ts`: `getIndirectChargeCodes`, `getActiveIndirectCodes` (if the timesheet needs active indirect codes, it already gets them via `getChargeCodesForUser`)
- `labor-categories.ts`: `getLaborCategoriesByClin`, `getAllLaborCategories`, `getUserLaborCategoryAssignments`, `getAssignableLaborCategories` (rates = dollars)
- `pay-period-config.ts`: `getConfigHistory`, `getPendingConfigChange`
- `reports.ts`: `getDetailedCostReport` (dollars) · `users.ts`: `getUsers`
- `src/app/api/reports/cost-report-csv` and `cost-report-xlsx` routes → admin-only (dollars)

If an approver page genuinely needs one of these (e.g. a contract name for a filter), give it a
**scoped, dollar-free** approver variant instead of loosening the admin guard.

**Admin-action rules (inside the admin guard):**
- `updateUser`: an admin **cannot change their own role or deactivate themselves**, and nobody can
  demote or deactivate the **last active admin**. Role or active changes bump `sessionVersion`
  (existing behavior; keep it).
- `adminResetPassword(targetUserId, newPassword)`: actor from session (drop `adminUserId`); bump the
  target's `sessionVersion` so their existing sessions end.
- `createApiKey`: creator from session (drop `createdByUserId`).
- `assignUserToClin`, `assignChargeCodeToUser`, `assignAllUnderClin`, `assignUserToLaborCategory`:
  `assignedBy` from session (drop the param).
- `seedUsers`: **refuse when `NODE_ENV === 'production'`** (or delete it if nothing calls it).

### INTERNAL — move out of `'use server'` files (R2); not callable over HTTP
| Helper | New home (suggested) | Used by |
|---|---|---|
| `getUserByEmail` | `src/server/internal/users.ts` — and **select explicit columns, never `passwordHash`/`totpSecret`** unless a caller truly needs them | auth |
| `recordFailedAttempt`, `recordSuccessfulLogin`, `getFailedAttemptCount`, `unlockAccount` | `src/server/internal/login-attempts.ts`, using **`getDbForAuth`** (F10) | `authorize()`; `unlockUserAccount` (admin action) |
| `getSupervisedEmployeeIds`, `getSupervisorScopeInfo` | `src/server/internal/supervisor-scope.ts` | `getEmployeeScope`, approvals UI (via a session-scoped action) |
| `isNotificationEnabled` | `src/server/internal/notifications.ts` | email senders |
| `updateConnectionTokens` | `src/server/internal/integrations.ts` | OAuth callback / token refresh |
| `getSetupStatusInternal` | `src/server/internal/setup.ts` | `(app)/layout.tsx` |
| `getPeriodStatus` (any-user variant) | `src/server/internal/periods.ts` | `saveTimesheetBatch` period-lock check |
| `verifyMFALogin` | replaced by MFA-in-sign-in (§5); TOTP/recovery verification becomes an internal helper | `authorize()` |

If a page needs `getSupervisorScopeInfo` for display, expose a thin `getMyScopeInfo()` action that
calls it for the **session** user.

## 5. MFA — make the code part of sign-in (F6)

Auth.js `5.0.0-beta.31` supports custom `CredentialsSignin` error codes (verify against
`node_modules/@auth/core/errors.d.ts` and `node_modules/next-auth/lib/client.d.ts`). Use them so
**no session exists until both factors pass**:

1. `authorize({ email, password, mfaCode? })`:
   - Lockout check → user lookup (`getDbForAuth`) → bcrypt verify (unchanged order and failure handling).
   - If `user.totpEnabled` and **no `mfaCode`** → throw a `CredentialsSignin` subclass with
     `code = 'mfa_required'`. **No session is issued.**
   - If `mfaCode` is present → verify TOTP, or a recovery code (consume it on use). On failure →
     `recordFailedAttempt` (counts toward lockout) and throw `code = 'mfa_invalid'`.
   - Only then return the user.
2. `LoginForm`: on `result.code === 'mfa_required'`, reveal a 6-digit code field (and a "use a
   recovery code" toggle), keep the email/password in component state, and re-submit
   `signIn('credentials', { email, password, mfaCode })`. Show `mfa_invalid` as "Invalid code."
3. Delete the `/login/mfa` page, `MFAVerifyForm`, and the `verifyMFALogin` action. Remove
   `totpEnabled` from the JWT/session if nothing else needs it.
4. Keep the existing TOTP library and recovery-code storage; only the flow changes.

## 6. Other fixes
- **F10 suspended login:** covered by moving the login-attempt helpers to `getDbForAuth`.
- **F11 cron:** in both cron routes, deny when `CRON_SECRET` is unset **in production**
  (`NODE_ENV === 'production'`); keep the Vercel `Authorization: Bearer` support.
- **F13 pages & nav:**
  - Approver pages (`requireApprover` semantics): `approvals`, `audit-trail`, `reports`.
  - Admin-only pages: every other page under `src/app/(app)/admin/`, **including adding a guard to
    `labor-categories`**. `notifications` is personal settings → any signed-in user (correct as is).
  - Add one server helper for page guards (e.g. `requirePageRole('admin' | 'approver')` that
    redirects to `/login` or `/timesheet`) and use it in every admin page instead of inline checks.
  - `AppNavbar`: supervisors see only Approvals, Audit Trail, Reports; admins see everything.

## 7. Tests (the proof)

### 7a. Guard-coverage test (prevents regressions forever)
Add `src/__tests__/unit/server-action-guards.test.ts` that reads every `src/server/actions/*.ts`
`'use server'` file and, for each exported function:
- asserts its body calls `requireSession`, `requireAdmin`, `requireApprover`, or `getTenantForBilling`,
  **or** that it appears in an explicit `PUBLIC_ACTIONS` allowlist in the test (each entry with a
  one-line justification); and
- asserts no exported signature contains the parameter names `adminUserId`, `reviewedBy`,
  `createdByUserId`, or `assignedBy`.
A new unguarded action must fail CI.

### 7b. Integration tests (real actions, real guards)
**Important:** mock **`@/auth`** (the `auth()` session source) and `@/db`'s `getDb`, **not**
`@/lib/session`, so the real `requireAdmin` / `requireApprover` / scope logic runs. Update
`charge-code-actions.test.ts` the same way: its current session mock mirrors the old
"admin or supervisor" rule and would hide this regression.

Required cases (`src/__tests__/integration/authorization.test.ts`):
1. Unauthenticated: `adminResetPassword`, `getUsers`, `saveTimesheetBatch`, `approvePeriod` all reject.
2. Employee cannot approve or reject **their own** period, nor anyone else's.
3. Supervisor approves an **in-scope** employee's period; an **out-of-scope** one is rejected; a
   supervisor cannot approve their own period.
4. Supervisor cannot: `updateUser` (incl. self-promotion to admin), `createUser`, `createApiKey`,
   `bulkImportEmployees`, `startCheckout`, `listChargeCodes`.
5. Admin cannot change their own role, deactivate themselves, or demote the last admin.
6. `saveTimesheetBatch` always writes for the session user (no way to target another user).
7. Employee A cannot read employee B via `getTimesheetForReview`, `getTimesheetReportData`, or the
   timesheet-pdf route; a supervisor can only for in-scope employees.
8. `getAuditEntries` for a supervisor returns only in-scope employees' entries.
9. MFA: sign-in for an MFA user **without a code** yields `mfa_required` and **no session**; a valid
   code signs in; an invalid code is rejected and counted toward lockout; a recovery code works once.
10. A suspended workspace's admin can complete sign-in (and lands on the billing wall).
11. Cron route without the secret in production returns 401.
12. `adminResetPassword` invalidates the target's existing sessions (`sessionVersion` bumped).

## 8. Guardrails
- Next.js 16 + Auth.js v5 beta — confirm APIs in `node_modules` before relying on them; read `AGENTS.md`.
- **Don't change business logic beyond authorization**: append-only revisions, period locks, reason
  codes, charge-code denormalization, and the `user_assignments` sync must all behave exactly as before.
- Don't weaken a guard to make a page or test work; give the caller a correctly scoped action instead.
- Every write path keeps its existing validation; authorization is added in front of it.
- `npm run build`, `npm run lint` (no new errors), `npm run test`, `npm run test:integration` all pass.

## 9. Verification checklist
```bash
npx tsc --noEmit && npm run lint && npm run test
npm run test:integration          # with TEST_DATABASE_URL, TEST_DATABASE_URL_2, CONTROL_PLANE_DATABASE_URL set
grep -rn "role !== 'admin' && role !== 'supervisor'" src/app       # only approver pages / requireApprover
grep -rnE "adminUserId|reviewedBy|createdByUserId" src/server/actions   # no hits in signatures
```
Manual (browser), signed in as each role:
- **Employee:** admin pages redirect away; timesheet, submit, profile, MFA setup work.
- **Supervisor:** nav shows only Approvals / Audit Trail / Reports; sees only in-scope employees;
  admin pages redirect away; cannot approve own timesheet.
- **Admin:** everything works as before.
- **MFA user:** after entering the password, the code field appears in place; navigating to
  `/timesheet` before entering it redirects to login (no session exists).

## 10. Out of scope (follow-ups)
- Session-version check currently **fails open** on database errors (`src/auth.ts`); consider
  fail-closed with a short cache once monitoring is in place.
- Distributed rate limiting (Upstash) for sign-in, MFA, and signup.
- An admin "act on behalf of an employee" timesheet feature, if ever needed, should be a separate,
  audited action.
