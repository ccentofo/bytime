# Feature plan: Launch blockers (production correctness, reachability, abuse, operations)

Status: FINAL v5 (lead architect, 2026-10-22) — pre-mortem rounds 1–3 incorporated; business answers to LB-Q1–Q3
recorded (2026-10-22). Remaining risk is caught at the post-implementation audit. Follows
`BLUEPRINT-STANDARD.md`. Implemented by the dev agent; audited by the lead. Source: the 2026-10-22 whole-codebase audit,
every finding re-verified. Already fixed on branch `audit-fixes-launch` (NOT in scope): tenant migrations bundled for
signup, Stripe invoice `parent.subscription_details` fallback, `ENCRYPTION_KEY` fail-closed.

Phases land as separate commits in the order **P1, P2, P3, P4, P6, P5** (P5 last: it is the only phase gated on a
business answer; P6's migration is therefore `0007`, P5's `0008`). **Each phase gate:** `tsc`, lint, `npm run test`, `npm run test:tz`, and
`npm run test:integration` (the product owner runs integration; CI runs it on every push).

| Phase | Scope |
|---|---|
| P1 | Tenant-correct links (password reset, timesheet emails), reliable transactional email, shared send rate budget (signup "resend verification" moved to P5 — it needs Turnstile) |
| P2 | Apex vs workspace routing (marketing page, finder for login/forgot-password on the apex, demo link) |
| P3 | Fresh role checks for every admin-only write; account-security hardening |
| P4 | Expected errors as return values (incl. offline sync + timesheet context); mode-aware UI; v1 API; billing reachability |
| P5 | Signup abuse controls — merged and deployed **behind `SIGNUP_CONTROLS_ENABLED` (default off)**; switched on in production once the updated Privacy Policy (LB-D3, LB-D5) is published |
| P6 | Operations: backup retention, restore runbook, heartbeats, Sentry environments, founder-script target banner, smoke probe, runbook fixes |

---

## 0. Decisions

### Product owner (2026-10-22 — recorded, not invented)

| ID | Decision |
|---|---|
| LB-D1 | Backup retention **7 days** for every tenant Neon project (Launch max, 604800 s). Revisit on Scale. Mistake-undo backups, not DCAA retention. |
| LB-D2 | Signup abuse: **Cloudflare Turnstile + a global cap of 20 new workspaces per day**; at the cap show "We're setting up a lot of new workspaces today. Leave your email and we'll have yours ready within one business day," keep the lead, alert the founder; **≈3 workspaces per day per IP**; clean up never-verified signups; **alert at 80 Neon projects**. |
| LB-D3 | Privacy Policy: Cloudflare added as a subprocessor for the signup page (business document). |
| LB-D4 | The approver decision's prerequisite "supervisors can do admin-only actions on the server" = admin-only writes authorizing from the cached JWT role (≤ 60 s stale). Fixed in P3, before `feature-plan-certified-outputs.md` C2. |

### Business answers (2026-10-22 — recorded, not invented)

| ID | Decision |
|---|---|
| LB-D5 (Q1) | Signup retention: never-verified **7 days**, consumed **30 days**, verified-but-never-provisioned **30 days**; IP hash kept **≤ 25 hours**. **Condition:** a consumed signup row may be deleted only if its tenant row already holds the Terms version **and** acceptance time (proof of contract, kept for the life of the account). Privacy Policy updated by the business side (§2 hash sentence, §4 Cloudflare subprocessor, §7 signup retention). |
| LB-D6 (Q2) | Restore into a **copy** by default, put back only what was lost. **In-place restore** only for total corruption **and** all four: confirmed no legitimate data after the restore point; the **customer's written consent** (plus the founder's); a written record of what was erased and why; the customer notified afterwards. (Terms §8.5 promises time records are never deleted or overwritten.) |
| LB-D7 (Q3) | No paid Sentry cron monitors. Free heartbeat (`cron_runs`) + daily digest. Revisit at ~10 paying customers. |

Config (policy values, `src/lib/tenant/lifecycle-config.ts`): `TENANT_DB_HISTORY_RETENTION_SECONDS = 604_800` (env
override `NEON_HISTORY_RETENTION_SECONDS` — a Free-plan staging org rejects > 21600), `SIGNUP_DAILY_WORKSPACE_CAP = 20`,
`SIGNUP_PER_IP_WORKSPACES_PER_DAY = 3`, `NEON_PROJECT_ALERT_THRESHOLD = 80`, `UNVERIFIED_SIGNUP_RETENTION_DAYS = 7`,
`CONSUMED_SIGNUP_RETENTION_DAYS = 30`, `VERIFIED_UNPROVISIONED_RETENTION_DAYS = 30` (LB-D5).

---

## 1. Verified current state (file:line, 2026-10-22)

### Links and email
- `src/server/actions/password-reset.ts:67-68` reset link from `NEXT_PUBLIC_APP_URL` (apex). On the apex
  `verifyResetToken` (`:85`, `getDb()`) throws "No tenant in request context"; `src/app/reset-password/page.tsx:35-45`
  awaits it without try/catch → infinite spinner. `verifyResetToken` uses `getDb()`, the other two `getDbForAuth()` →
  a `billing_only` admin can't reset. `resetPassword` (`:111-180`): check-then-update in separate statements → one token
  usable twice under a race. `requestPasswordReset` is invoked from `/forgot-password` on the **workspace host**, so the
  request tenant is available there.
- `src/lib/email/send.ts:10` `APP_URL = NEXT_PUBLIC_APP_URL` → every timesheet email links to the apex. Correct helper:
  `tenantBaseUrl(slug)` (`src/lib/tenant/host.ts:21`, reads **server-only** `APP_ROOT_DOMAIN`, `host.ts:6`).
  Duplicate builders: `src/app/signup/verify/route.ts:19-23`, `src/app/api/integrations/callback/[provider]/route.ts:33-37`.
  OAuth `redirect_uri` builders (`connectors/{qbo-api,gusto-api,quickbooks-online,gusto}.ts`) correctly use the apex — **do not change**.
- Fire-and-forget sends (not awaited, not in `after()`): `signup.ts:80`, `password-reset.ts:70`,
  `periods.ts:136,346,428`. Senders never inspect Resend's `{ data, error }` (Resend 6.12.4 returns errors, doesn't throw).
  When email is disabled they return silently (`send.ts:27`).
- Resend limit 10 req/s per team (§2). `vercel.json`: daily-reminder `0 20 * * 1-5` and submission-deadline `0 20 * * *` both
  at 20:00 UTC; notice-delivery `*/10` also fires at 20:00 (and sends at 8/s, `notices.ts` `throttleMs: 125`).

### Routing
- `src/app/page.tsx` marketing page renders on workspace hosts too (with demo credentials). Demo buttons (`:23,139`) →
  apex `/login`. Apex `/login`: `LoginForm.tsx:56-59` `checkLockout` → `getDbForAuth()` throws → spinner never resets.
  `/forgot-password/page.tsx` is a client component. `isValidSlug` lives in `src/lib/tenant/provision.ts` (`'server-only'`).
  `TenantUnavailable.tsx:9` "none" copy is a placeholder. `/signup` renders on workspace hosts.

### Roles (P3)
- Admin-only exported actions on the cached `requireAdmin()` that **write** (directly or through helpers):
  `assignments.ts` assignUserToClin, unassignUserFromClin; `charge-codes.ts` createCostClass, createChargeCode,
  updateChargeCode, deactivateChargeCode, assignChargeCodeToUser, unassignChargeCodeFromUser,
  autobridgeChargeCodesFromClins, **assignAllUnderClin (`:177`)**; `clins.ts` createClin, updateClin; `contracts.ts`
  createContract, updateContract; `indirect-codes.ts` createIndirectCode, updateIndirectCode, seedIndirectCodes;
  `integrations.ts` toggleAutoSync, saveMapping, deleteMapping; `labor-categories.ts` createLaborCategory,
  updateLaborCategory, assignUserToLaborCategory, endUserLaborCategoryAssignment; `qbo.ts` importQboClasses,
  importQboChargeCodes, **triggerQBOSync** (→ `executeSyncOperation`, `src/lib/integrations/sync-engine.ts:147`
  `getDbForWrite` + pushes approved time to QBO); `gusto.ts` **triggerGustoSync** (same); `slins.ts` createSlin,
  updateSlin; `users.ts` **unlockUserAccount** (→ `src/server/internal/login-attempts.ts:46-54`), `seedUsers`
  (dead, hard-coded `Password123!` — delete). `requireAdminFresh` = `withFreshRole` (`src/lib/session.ts:99-114`).
- `mfa.ts:40-71 completeMFASetup` accepts a client secret with only a session; `auth.ts:91-102` recovery codes
  read→splice→write (race); `mfa.ts:89` changePassword/disableMFA password checks unthrottled.
- Server actions call other exported actions: `qbo.ts:208,262` → createCostClass/createChargeCode;
  `charge-codes.ts:185` → assignChargeCodeToUser; `migration.ts:144` importMigrationData → validateMigrationData;
  `pay-period-config.ts:37` getCurrentEffectiveConfig → getEffectiveConfigAt; `pay-period-config.ts:45`
  getPayPeriodConfig → getCurrentEffectiveConfig; `signup.ts:50` startSignup → checkSlugAvailable.
- Mapping readers on cached `requireAdmin()` that **write** via token refresh: `qbo.ts` fetchQBOEmployeesForMapping,
  fetchQBOCustomersForMapping, fetchQBOServiceItemsForMapping, fetchQBOVendorsForMapping, fetchQBOClassesForMapping
  (`ensureValidToken` writes the refreshed token, `qbo-api.ts`), `gusto.ts` fetchGustoEmployeesForMapping
  (`ensureValidGustoToken`, `gusto-api.ts:167`).
- v1 auth failures return **different** 401 bodies (missing header / bad format / bad prefix, `api-auth.ts:31-52`).
- About 80 plain `throw new Error(...)` for expected conditions in actions and the helpers they call (e.g. `periods.ts`
  14, `timesheet.ts` 14, `validation.ts` 19, `users.ts` 6, `billing.ts` 8, `internal/seats.ts` 1, `internal/periods.ts` 2).
- Demo recipients: `SEED_EMAIL_DOMAINS` (`src/db/clear-tenant-data.ts:46`, `cadenzpoint.dev`, `bytime.dev`).

### Errors and modes (P4)
- Next 16 production redacts thrown server-action errors (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106-111`);
  expected errors must be returned (`.../01-getting-started/10-error-handling.md`). Most actions throw; clients render
  `String(error)`; `ContractsClient` / `AssignmentsClient` have no catch; `TimesheetToolbar.tsx:190-246` masks messages.
- **Live callers that treat "no throw" as success:** `src/lib/offline/sync-service.ts:154-176`
  (`syncQueue.bulkDelete` after `saveTimesheetBatch` — started at `BiWeeklyTimesheetClient.tsx:68`),
  `src/components/timesheet/TimesheetContext.tsx:209-235` (dispatches `MARK_SAVED`).
- About 78 integration assertions `rejects.toThrow` against actions that will change (e.g. `authorization.test.ts` 19,
  `period-lock-integrity.test.ts` 13, `tenant-admin.test.ts` 9). Static guard test: `server-action-guards.test.ts:282-296`
  checks the guard precedes the first query anywhere in the exported function body (already includes nested callbacks).
- Only the timesheet honors read-only mode. v1 API: `validateApiKey` (`src/lib/api-auth.ts:22`) calls `getDb()` first,
  outside any try → every v1 route (including `costs`) 500s for an unknown/suspended workspace and leaks existence.
  `src/app/api/export/workspace/route.ts:16` `requireAdminFresh()` outside try → 500 for unauthenticated.
- Billing: no nav item (`AppNavbar.tsx:29-42`); `BillingClient` reads `PLANS[k].priceId` (env, undefined in the browser);
  post-checkout banner races the webhook; hold screens lack sign-out.

### Signup (P5)
- `signup.ts:38-43` in-memory 8/h/IP (per instance). No CAPTCHA, cap, or `companyName` length cap. Verify route
  provisions (`verify/route.ts`), issues the set-password link (`:154`), marks consumed after provisioning (`:149`).
  `provisionTenant` writes the tenant row (`status=provisioning`, `created_at = now`, `signup_email`) **before**
  migrations (`provision.ts:68-76`); resume is signer-bound. `scripts/provision-tenant.ts:21` passes no Terms data and
  sends no set-password link.

### Operations (P6)
- Tenant Neon projects created without `history_retention_seconds` (Neon default 1 day).
- Digest only on news (`ops-digest.ts`); daily-reminder/submission-deadline inline cron auth, `console.error` only,
  email exempt demo tenants' `@cadenzpoint.dev` users (domain we don't own).
- `scripts/smoke-tenancy.sh:76-77` runs the real daily-reminder. Sentry configs set no `environment`.
- Founder scripts don't show their target. `provision:tenant` without `NEON_API_KEY` creates a DB on the admin server
  (`neon.ts:142-145`: `DEV_TENANT_ADMIN_DATABASE_URL` takes precedence over `CONTROL_PLANE_DATABASE_URL`).
- `scripts/migrate-all.ts:38` skips `deleting`; a `deleting` tenant past deletion step 5 (DB gone, tombstone pending,
  `delete-tenant.ts:330-340`) still has `db_url_encrypted`.

---

## 2. Verified external facts

| Fact | Source |
|---|---|
| Resend `emails.send` → `{ data, error }`; API errors don't throw | `node_modules/resend/dist/index.d.cts:121,183` |
| Resend: "The default maximum rate limit is 10 requests per second per team" — across all API keys | resend.com/docs/api-reference/rate-limit, fetched 2026-10-22 |
| Next 16 `after()` in Server Functions / Route Handlers; **throws outside a request scope** | `node_modules/next/dist/docs/.../04-functions/after.md`; `node_modules/next/dist/server/after/after.js:13-16` |
| `'use server'` files may export only async functions; keep the `export async function` declaration form | Next docs (`use-server` directive) — dev agent confirms in `node_modules/next/dist/docs` |
| `unstable_rethrow` must be used so `redirect()` / `notFound()` aren't swallowed by catch blocks | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_rethrow.md` |
| Turnstile siteverify `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` (`secret`, `response`, opt. `remoteip`, `idempotency_key`) → `success`, `error-codes`, `hostname`, `action`, `challenge_ts`; token 300 s, **single use** (`timeout-or-duplicate`); test keys: sitekey `1x00000000000000000000AA` pass / `2x00000000000000000000AB` fail; secret `1x0000000000000000000000000000000AA` pass / `2x0000000000000000000000000000000AA` fail / `3x0000000000000000000000000000000AA` spent; dummy token `XXXX.DUMMY.TOKEN.XXXX` | developers.cloudflare.com/turnstile (server-side-validation, troubleshooting/testing), fetched 2026-10-22 |
| Turnstile CSP origins | dev agent confirms on Cloudflare's Turnstile CSP page before shipping |
| Neon `history_retention_seconds` (int s) inside `project` on `POST /projects` and `PATCH /projects/{id}`; Free max 21600, Launch 604800, Scale 2592000 | api-docs.neon.tech createproject / updateproject, fetched 2026-10-22 |
| Neon `GET /projects` pagination (`limit`, `cursor`) — dev agent confirms max limit | api-docs.neon.tech listprojects |
| Sentry 10.57 `withMonitor`/`captureCheckIn`; flush before a serverless function returns | `node_modules/@sentry/core/build/types/exports.d.ts:101-110` |
| Vercel overwrites `X-Forwarded-For` at the edge "to prevent IP spoofing" → the first value is the client IP; trust it only on Vercel | vercel.com/docs/headers/request-headers (verified in pre-mortem round 3) |

---

## 3. Invariants

DCAA unchanged (nothing here writes entries; offline sync must never drop unsynced hours). Security: guards first;
identity from session; tenant binding by host; no secret to the browser (Turnstile secret, IP salt server-only); server
write gate unchanged — UI mode gating is visibility only; never store a raw IP; v1 API never reveals whether a workspace
exists. Emails never claim success without a provider id. Lifecycle notice outbox semantics unchanged (only its
throttle value changes). Calendar dates unchanged.

---

## 4. Design

### P1 — Links, email, rate budget
1. `host.ts`: `tenantBaseUrl(slug)` (server-only, unchanged) + `apexBaseUrl()`; replace the two duplicate builders.
2. Password reset:
   - `requestPasswordReset`: `slug = await getTenantSlug()`; empty → return the generic success (no email); link =
     `${tenantBaseUrl(slug)}/reset-password?...`.
   - `verifyResetToken`: if `getTenantSlug()` is empty → `{ valid: false }` (explicit pre-check, not catching by message);
     else `getDbForAuth()`.
   - `resetPassword`: one transaction: `UPDATE password_reset_tokens SET used_at = $now WHERE id = $id AND used_at IS NULL
     AND expires_at > $now RETURNING id` (zero rows → "Invalid or expired reset link"), then the password/sessionVersion
     update in the same tx, using a SQL increment (`session_version = session_version + 1`), not read-modify-write.
   - Reset page: try/catch → invalid-link state.
3. `send.ts`: every function takes `appUrl` (no module constant). Callers: `periods.ts` → `tenantBaseUrl(request slug)`;
   crons → `tenantBaseUrl(tenant.slug)`. Signup verification keeps the apex.
4. Send outcome contract: `type SendOutcome = { ok: true; id: string } | { ok: false; reason: 'disabled' | 'error' }`.
   Check `{ data, error }`; `error` or missing `data.id` → `console.error` (error name, recipient **domain** only) +
   `Sentry.captureMessage`; disabled → `{ ok:false, reason:'disabled' }` (no Sentry noise). Thrown network errors same as
   `error`. Server actions schedule sends with `after(async () => { … })`; crons await.
5. **Shared Resend budget:** `src/lib/email/rate.ts` `sendThrottle()` = at most **2 sends/second per cron sender**
   (sleep between sends); daily-reminder, submission-deadline and notice-delivery each use it, so three concurrent crons
   stay ≤ 6/s, leaving headroom for user-triggered `after()` sends at the 20:00 UTC deadline. 429 → back off 2 s and retry once; still failing → count as failed. `notices.ts` `throttleMs`
   becomes 500 ms (outbox semantics otherwise unchanged).
6. *(Moved to P5 — needs Turnstile.)* Signup "Resend verification": the check-email screen renders a **new Turnstile widget**; `resendSignupVerification
   ({ email, slug, token })` verifies Turnstile, finds the **same pending row**, rotates `verify_token_hash` (old link
   invalid), extends `expires_at`, re-sends; does **not** count toward the per-IP workspace limit (counts only toward the
   existing in-memory attempt limiter). Public action → added to `PUBLIC_ACTIONS` in the guard test with a justification.
7. *(P5, flag on.)* **Turnstile tokens are single use:** the client calls `turnstile.reset()` after **every** non-success response (signup
   form and resend screen), so a retry after e.g. "name taken" gets a fresh token. Server classifies error codes:
   `timeout-or-duplicate` / `invalid-input-response` = user failures (never count toward the outage alert);
   network errors / `internal-error` = outage signals.

### P2 — Apex vs workspace routing
- `src/app/page.tsx` (server): workspace host → `redirect('/timesheet')`; apex → marketing page.
- Demo buttons → `NEXT_PUBLIC_DEMO_URL` (hidden when unset). Demo credentials text only on the apex page.
- Apex `/login` and `/forgot-password`: server page wrapper; on the apex render a **Find your workspace** form that posts
  to a server action `goToWorkspace(slug, target)` — `target` must be exactly `'/login'` or `'/forgot-password'`
  (anything else refused: prevents `https://acme.root@evil.com` open redirects); public action, added to `PUBLIC_ACTIONS`
  with a justification — which validates with `isValidSlug` (moved to a pure module
  `src/lib/tenant/slug-rules.ts`, re-exported from provision.ts) and calls `redirect(tenantBaseUrl(slug) + target)`
  (server-side, where `APP_ROOT_DOMAIN` exists). Unknown slug → same page with "No workspace with that name" (the finder
  is already as revealing as `checkSlugAvailable`; acceptable — state it in code comments).
- Workspace `/login` and `/forgot-password` for unknown/closed/provisioning → `TenantUnavailable` (server check via
  `getTenantState()`).
- `/signup` on a workspace host → `redirect(apexBaseUrl() + '/signup')`.
- `LoginForm`: try/finally around `checkLockout`/`signIn`.
- `TenantUnavailable` "none" copy uses `APP_ROOT_DOMAIN` (server-rendered).

### P3 — Fresh roles; account security
- Every admin-only exported action that **writes**, directly or via helpers (full list §1: the 31 incl. triggerQBOSync,
  triggerGustoSync, unlockUserAccount, assignAllUnderClin, **plus the 6 token-refreshing mapping readers = 37**) →
  `requireAdminFresh()`. Delete `seedUsers`. Rule: any DB write, including credential bookkeeping, disqualifies an
  action from the read-only allowlist.
- Guard test (rewrite in `server-action-guards.test.ts`): **`requireAdmin()` is banned in every exported action** unless
  the action is in an explicit `ADMIN_READ_ONLY_ALLOWLIST` (each entry with a one-line justification that it performs no
  write and calls no writing helper). Mutation-test: add `requireAdmin()` to a writer → test fails.
- `completeMFASetup`: requires current password (reject if `passwordHash` is null with "Set a password first");
  check lockout **before** bcrypt.
- Recovery codes: in one transaction `SELECT … FOR UPDATE` the user row, verify, then
  `UPDATE users SET totp_recovery_codes = $remaining WHERE id = $id` (row lock serializes concurrent uses).
- changePassword / disableMFA failures counted via `login-attempts` (shared with sign-in lockout — intended; stated in a
  comment); lockout checked before bcrypt.

### P4 — Expected errors as results; modes; v1 API; billing
1. **Contract** `src/lib/action-result.ts`:
   `ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code: 'unauthenticated' | 'forbidden' | 'read_only' | 'conflict' | 'validation' | 'not_found' }`;
   `userAction(fn)` catches only `AuthorizationError`, `WorkspaceReadOnlyError`, `UserFacingError` (new, in
   `src/lib/errors.ts`), `ConflictError` (new; replaces the ad-hoc conflict throws at `periods.ts:237`,
   `timesheet.ts:410`); calls `unstable_rethrow(err)` first; anything else is rethrown (Sentry + generic).
   **Expected-error conversion:** every expected-condition `throw new Error(...)` reachable from a converted action
   (inventory §1: actions, `src/lib/validation.ts`, the internal helpers they call) becomes `UserFacingError` (or
   `ConflictError`), including unique-violation mappings (23505 → `ConflictError` with the existing message). Static
   check: no `throw new Error(` in `src/server/actions/**`, `src/lib/validation.ts`, `src/server/internal/**` except an
   explicit allowlist of true invariant violations (each justified). Exported
   actions keep `export async function …(…) { return userAction(async () => { …guard first… }) }`. **No matcher change
   needed** in the guard test — add a fixture proving a missing guard inside `userAction` is still caught.
2. **Action-to-action calls are removed.** Shared logic moves to internal functions in `src/server/internal/*`
   (`createCostClassInternal`, `createChargeCodeInternal`, `assignChargeCodeToUserInternal`,
   `validateMigrationDataInternal`, `getEffectiveConfigAtInternal` / `getCurrentEffectiveConfigInternal`,
   `checkSlugAvailableInternal`, …; all seven call sites in §1); exported actions wrap
   them; `qbo.ts` imports and `assignAllUnderClin` call the internal versions (and `assignAllUnderClin` reports real
   per-code results). Also existing cross-imports: `employee-dashboard.ts:7` (`getCurrentEffectiveConfig`) and
   `qbo.ts:10` (`getMappings`) move to internal readers. Static test: no `src/server/actions/*.ts` file imports another
   actions module **and** no exported action calls another exported action in the same file. Internal writers take a
   `TenantWriter` passed from the guarded action (never obtain their own client), throw typed errors (never return a
   failure from inside a transaction). **Internal static rule** (separate from the action write-gate, which requires
   `getDbForWrite(` in the body and must not be applied literally): every function in `src/server/internal/**` that
   writes takes a `TenantWriter`/`DbTx` parameter and contains no `getDb*(`/`getDbForUrl(` call; the mass-assignment check
   also covers these files. The scanner (`parseExportedFunctions`) is extended to match `export function` as well as
   `export async function`.
3. **Callers check results:** `runAction(promise, opts)` (`src/lib/run-action.ts`, client) for UI mutations.
   `sync-service.ts`: on `!r.ok` keep the queue items, mark them `error` with the message, never `bulkDelete`;
   `code === 'read_only'|'forbidden'` stops the sync loop until the next app load; conflicts stay queued for the user.
   `TimesheetContext.tsx`: `saveAll` and `submitTimesheet` **return `ActionResult`** (no longer `Promise<void>`);
   `MARK_SAVED` and `SET_PERIOD_STATUS 'submitted'` dispatch **only on `r.ok`** (a no-op save returns `{ ok: true, data:
   undefined }`); `TimesheetToolbar` shows `r.error` and
   never the success toast on failure. Static test runs **per call site**: every awaited call of a converted action must
   have its result consumed (`runAction(...)`, or the result read for `.ok`) — a file that checks one call and ignores
   another fails. The check scans `'use client'` files **and** `src/lib/offline/sync-service.ts` and
   `TimesheetToolbar.tsx` (whose `await saveAll()` / `submitTimesheet()` results must be read). Offline queue items increment `attempts` and set `lastError` on `validation`/`conflict` (the queue has
   no status column, `src/lib/offline/db.ts:48-49`); the existing attempt cap stops endless 30 s retries; pause list =
   `read_only | forbidden | unauthenticated`. (The offline path is dormant today — `saveOfflineEntry` has no callers —
   but must stay safe.)
4. Convert: all exported **mutations** (`src/server/actions/*` writers + saveTimesheetBatch/submit/approve/reject).
   Actions that already return `{ success, error }` (`startSignup`, `requestPasswordReset`, `resetPassword`, password,
   MFA) also move to `ActionResult` for one contract (update `signup-terms.test.ts` and their clients). Reads used by
   server components keep throwing. Update the ~78 integration assertions to `{ ok:false, code }`.
5. **Mode-aware UI:** `WorkspaceModeProvider` in `AppShellWrapper` (value from the layout's `getTenantState()` — a
   per-render snapshot, refreshed on navigation/refresh; stated). `useCanWrite()`; admin write controls and Approve/Reject
   disabled with a tooltip when `mode !== 'full'`.
6. **v1 API:** whole handler in try. `validateApiKey(request, tenant)` no longer calls `getDb()`. **Every** auth
   failure — missing header, bad format, bad prefix, unknown workspace, wrong key — returns the **one identical** 401
   body `{ error: 'Invalid API key.' }` with header `WWW-Authenticate: Bearer` (usage hint moves to the API docs).
   Order: rate limit →
   `getTenantState()`: `none|unknown|closed|provisioning|mismatch` → the **identical 401 body a well-formed wrong key
   gets** ("Invalid API key.") → validate the key against `getDbForUrl(tenant.dbUrl)` (lastUsedAt bookkeeping as today)
   → bad key → that same 401 → **only after a valid key**: `billing_only|policy_hold` → 403
   `{ error: 'workspace_unavailable' }` (existing app access rule: data reads only in `full`/`read_only`) → handler.
   An unauthenticated caller can never learn whether a workspace exists or is suspended. Errors → generic 500 +
   `console.error` + Sentry.
7. Export route: `AuthorizationError` → 401/403.
8. **Billing:** Billing nav item (admin); `getTenantBillingInfo()` returns `plans[{ key, label, seatLimit, purchasable }]`
   computed server-side; static test: no `'use client'` file has a **value** import of `@/lib/billing/plans`
   (`import type` allowed); post-checkout copy "Thanks —
   your subscription is being activated" + one `router.refresh()` after 5 s; sign-out on BillingWall / OnHoldScreen /
   PolicyHoldScreen.

### P5 — Signup abuse controls (LB-D2, LB-D5; production switch-on gated on the published Privacy Policy)

**Feature flag `SIGNUP_CONTROLS_ENABLED`** (server env, default off): off → signup behaves exactly as today (no
Turnstile script or widget, no IP hashing, no cap/waitlist, no resend action, no signup cleanup); the migration, the
Neon-80 quota alert (LB-D2, not a retention question) and the ip_hash nulling job still run. On → everything below. The
flag is read server-side only; the client receives a boolean prop from the server page.

Control-plane migration `0008_signup_controls` (additive; creates `signal_counters (key varchar pk, window_start
timestamptz, count int)`): `signups` gains `ip_hash varchar(64) null`,
`verified_at timestamptz null`, `waitlisted_at timestamptz null`, `provisioned_at timestamptz null`; `tenants` already
has `created_at`. No separate waitlist table — a waitlisted signup **is** a verified signup row (it already holds email,
company, slug, timezone, Terms version + acceptance time).

- **IP source:** the first `x-forwarded-for` value (§2: Vercel overwrites it). IPv6 addresses are reduced to their
  **/64 prefix** before hashing (one subscriber holds a whole /64). In production an `'unknown'` IP **fails closed**
  ("Verification failed — please try again"), never one shared bucket.
- **IP hashing:** `sha256(SIGNUP_IP_SALT + ip)`; `SIGNUP_IP_SALT` required in production (missing → signup fails closed
  + `signup-config-missing` alert), dev default allowed. Raw IP never stored. The **10-minute notice-delivery cron**
  (and `startSignup`, opportunistically) sets `ip_hash = null` on rows older than 24 h → bound ≈ 24 h 10 min (tested).
- **Turnstile** (`src/lib/turnstile.ts`, injectable verifier for tests): widget on `/signup` and on the check-email
  resend; server verify with `remoteip` + `idempotency_key`; `success !== true` or network error → refuse ("Verification
  failed — please try again"). Missing secret in production → refuse + alert. **Outage signals** (network /
  `internal-error`, never user errors) are counted in a control-plane counter row (`cron_runs`-style table
  `signal_counters (key pk, window_start, count)`); an `ops_alerts` row `turnstile-outage` is raised **only when** ≥ 3
  occur within an hour. **Resolution:** the 10-minute notice-delivery cron resolves `turnstile-outage` once
  `signal_counters` shows no outage signal for an hour, and resolves `signup-config-missing` once the required env
  (secret, salt) is present at cron time; a later occurrence then raises a new row and a new immediate email.
  Turnstile's returned `hostname` must equal the apex host (`APP_ROOT_DOMAIN`), else refuse.
- `startSignup` order: Terms → lengths (`companyName` 1–120, email ≤ 254) → Turnstile → existing in-memory attempt
  limiter → slug availability → **per-IP workspace limit**: count signups with this `ip_hash` and `verified_at` within
  24 h ≥ `SIGNUP_PER_IP_WORKSPACES_PER_DAY` → refuse → insert pending row → verification email via `after`.
- **Verify GET** (`signup/verify/route.ts`) **writes nothing** (email link scanners open links): waitlisted → waitlist
  message; invalid/expired → existing redirect; otherwise → the existing confirm page.
- **Verify POST**: **first**, if the row has `waitlisted_at` → render the waitlist
  message regardless of `expires_at` (no provisioning, ever, from this path — the founder provisions waitlisted rows).
  Otherwise token valid and unexpired → **existing "tenant already active → mark consumed, redirect to `/login`" step
  (`route.ts:150-154`) unchanged** → set `verified_at = coalesce(verified_at, now)` (set once; reopening never slides
  the window) → **resume check**: if a tenant row for this slug exists with
  `signup_email = email` → continue provisioning (never cap or IP-limit a resume) → else **per-IP re-check** (verified
  workspaces from this `ip_hash` in 24 h, excluding this row ≥ limit → refuse, row stays unconsumed; a non-resume row
  whose `ip_hash` is already **null** → refused "This link has expired — please sign up again") → else **slug check**
  (slug taken by another tenant → consumed, "name just taken", existing — checked **before** the cap so the waitlist never
  holds an unprovisionable slug) → else **cap check**:
  tenants created in the last 24 h (any status) ≥ `SIGNUP_DAILY_WORKSPACE_CAP` → set `waitlisted_at`, keep the row
  **unconsumed**, raise `signup-cap-reached` (dedup per UTC day), render the LB-D2 waitlist message → else provision
  (unchanged, signer-bound).
- **Resend verification** (moved from P1 §6, flag on only): `resendSignupVerification({ email, slug, token })` —
  Turnstile first; acts only on a **pending, unverified, non-waitlisted** row matching email + slug (the newest if
  several); rotates `verify_token_hash`, extends `expires_at` to at most `created_at + 24 h` (never beyond — the IP hash
  lives 24 h); re-sends. Response is **always generic** ("If that signup is waiting, we've sent a new link") — no
  enumeration. Counts only toward the in-memory attempt limiter. `startSignup` returns the server-derived slug so the
  check-email screen can call it. Added to `PUBLIC_ACTIONS` with a justification.
- **Founder provisioning of the waitlist:** `tenant:admin waitlist list` and `tenant:admin waitlist provision <signupId>
  --yes`: loads the verified, waitlisted row → `provisionTenant({ slug, name, adminEmail, adminName: email.split('@')[0],
  timezone, termsVersion, termsAcceptedAt })` → marks consumed + `provisioned_at` → issues the set-password token
  (`issueSetPasswordToken`) and **awaits** the welcome/set-password email (new template). On `!ok` it prints the
  set-password URL and exits non-zero so the founder can relay it. Refuses unverified or already-provisioned rows.
  Bypasses the cap (founder decision) but prints the current 24 h count. **Environment guards:** refuses when
  `APP_ROOT_DOMAIN` or `NEXT_PUBLIC_APP_URL` is unset or localhost while the control plane is non-loopback, and prints
  the link host in the target banner.
- **`createLocalDevDatabase` itself refuses a non-loopback admin URL** (covers every caller: `provision:tenant`,
  `waitlist provision`, signup in a misconfigured env).
- **Immediate alerts:** the first `signup-cap-reached` per UTC day, `signup-config-missing`, and `turnstile-outage`
  also send an immediate `OPS_ALERT_EMAIL` (outcome checked; failure → Sentry) and `Sentry.captureMessage` — not only the
  next daily digest.
- **Cleanup + quota** (daily lifecycle cron, **before** the digest): delete unverified rows past
  `UNVERIFIED_SIGNUP_RETENTION_DAYS`; delete consumed rows past `CONSUMED_SIGNUP_RETENTION_DAYS` **only where the
  matching tenant row (by slug + signup email) has non-null `terms_version` and `terms_accepted_at`** (LB-D5) — otherwise
  keep the row and raise ops alert `signup-terms-not-copied` (listing the slug) so the founder can fix it; delete verified,
  unconsumed rows past `VERIFIED_UNPROVISIONED_RETENTION_DAYS` (listed in the digest 3 days before);
  Neon project count via paginated `GET /projects` ≥ threshold → `neon-project-quota` alert (auto-resolves below);
  list failure → `neon-project-quota-check-failed` alert (its `occurrences`/`first_seen_at` show consecutive days;
  resolved on success). These steps run even when the tenant loop was `incomplete`.
- CSP: Turnstile origins in `script-src`/`frame-src` (confirmed list).

### P6 — Operations
1. **Retention:** `createNeonDatabase` sends `history_retention_seconds` (config, env override). `scripts/backfill-neon-retention.ts`
   (`npm run backfill:neon-retention`, react-server condition): PATCH every non-deleted tenant with `neon_project_id`;
   **list tenants without `neon_project_id`** as needing manual action; `--check`; idempotent; target banner; exit
   non-zero on any failure.
2. **Restore runbook** (`RESTORE.md`, linked from PRODUCTION-DEPLOY Phase 14): default (LB-D6) = restore the tenant
   project's history into a **new branch** at the chosen time, connect read-only, export/recover the needed rows, and
   re-enter them through normal app flows (corrections with reason codes) — the live database is never rewound. In-place
   restore (LB-D6) only for total corruption and only with **all four**: (1) confirmed no legitimate data after the
   restore point, (2) the customer's written consent plus the founder's, (3) a written record of what was erased and
   why — recorded via a `tenant:admin` audit note referencing the consent, (4) the customer notified afterwards (the
   runbook includes the notice template). Bad
   migration: write and deploy a **fix-forward** migration; never re-run a broken migration. Monthly drill: named
   throwaway tenant, branch restore, verify row counts. (No `set-db-url` command in this blueprint.)
3. **Heartbeats (LB-D7):** control-plane `cron_runs (name pk, last_started_at, last_succeeded_at, last_summary
   jsonb)` (P6's own migration `0007_cron_runs`), written by each of the four crons (start + success). The daily digest is **always sent**
   (a short "all quiet" version when there is no news) and lists any cron whose `last_succeeded_at` is older than its
   per-cron limit — notice-delivery 1 h, tenant-lifecycle 26 h, submission-deadline 26 h, daily-reminder **74 h**
   (Mon–Fri schedule; avoids a Monday false alarm) — and any cron with **no `cron_runs` row** ("never ran"). The runbook says: "no digest by 15:00 UTC → the
   lifecycle cron is down; investigate." Optional `SENTRY_CRON_MONITORS=1` (off; revisit at ~10 paying customers) wraps each cron in `Sentry.withMonitor` (with
   `?probe=1` returning **before** the monitor) + `Sentry.flush(2000)`.
4. daily-reminder / submission-deadline: `rejectUnauthorizedCron`; `maxDuration = 300`; 240 s time budget with
   `incomplete` in the JSON summary + Sentry message when stopped early; per-tenant failures → `Sentry.captureException`
   (tenant slug tag) and counted; shared send throttle (P1 §5). **Fair rotation:** tenants are processed in slug order
   starting **after** the last fully processed slug saved in `cron_runs.last_summary.cursor` (wrapping around), so a
   budget stop never starves the same tail tenants every day. An incomplete run raises ops alert `cron-incomplete:<name>`
   (immediate email, resolved by the next complete run). **Recipients whose address is in `SEED_EMAIL_DOMAINS` are
   skipped** (demo mail to domains we don't own) — tenant-level `lifecycle_exempt` is **not** used to suppress
   reminders (it can cover comped real customers).
5. **Founder-script target banner** `scripts/lib/target.ts`: prints `Target control plane: host/db` (no credentials),
   boxed warning when non-loopback; used by every founder script. `provision:tenant` without `NEON_API_KEY` refuses
   unless the **admin URL actually used** (`DEV_TENANT_ADMIN_DATABASE_URL ?? CONTROL_PLANE_DATABASE_URL`) is loopback.
6. **Smoke probe:** cron routes accept `?probe=1` → after auth, `200 {"probe":"ok"}`, no work, no monitor, no
   `cron_runs` write. `smoke-tenancy.sh` uses it.
7. **Sentry environments:** `SENTRY_ENVIRONMENT` (server/edge), `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (client) →
   `environment`; fix client traces-sample-rate env name.
8. **migrate-all:** include `deleting` tenants. For a `deleting` tenant that fails to connect, decide "gone" only by a
   **confirmed absence**: `neonProjectExists(neon_project_id) === false` (Neon API 404, `src/lib/tenant/neon.ts`) or, for
   local/shared DBs, `databaseExists(...) === false` → **skipped (database deleted)**; anything else (transient DNS,
   timeouts) → FAILED as today. `backfill-neon-retention` applies the same rule (a 404 PATCH on a `deleting` tenant is
   skipped, not a failure).
9. **Runbook corrections** (PRODUCTION-DEPLOY.md / MIGRATIONS.md / .env.example): Phase 2.1 stale branch; Phase 1d
   set-exempt + `TRUNCATE tenant_notices` moved after the control-plane migration and before the first deploy of new
   code (explicit commands); backfills via npm scripts; reconcile rollback guidance (fix-forward only); Vercel Instant
   Rollback note (promote the next deploy manually); new env vars (`NEXT_PUBLIC_DEMO_URL`, Turnstile keys,
   `SIGNUP_IP_SALT`, Sentry environment, `NEON_HISTORY_RETENTION_SECONDS`, `SENTRY_CRON_MONITORS`); remove the stale
   "NOT used yet" header and unused `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

---

## 5. State machines

### Signup
| State | Event | Next | Side effects |
|---|---|---|---|
| — | start: Turnstile fail / network error / missing secret (prod) | — | none; failure counted; alert on threshold / config |
| — | start: per-IP verified workspaces ≥ 3 in 24 h | — | none |
| — | start OK | pending | row (ip_hash), verification email (after) |
| pending | resend (new Turnstile; flag on) | pending | token rotated, old link dead, expiry extended to ≤ created + 24 h, email re-sent, generic response |
| pending | verify GET (any) | unchanged | no writes; confirm page / waitlist message / expired redirect |
| pending | verify POST, `ip_hash` already null, not a resume | pending | "link expired — sign up again" |
| pending | verify, link expired | pending | "link expired — sign up again"; cleanup later |
| pending | verify OK, existing tenant row for slug + same signer (resume) | provisioning→active | resume provisioning (no cap check) |
| pending | verify POST, tenant for slug already active with this signer | consumed | redirect `/login` (existing) |
| pending | verify OK, slug taken by another tenant (checked before the cap) | consumed | "name just taken" (existing) |
| pending | verify OK, cap reached | waitlisted (verified, unconsumed) | `waitlisted_at`, alert (once/day), waitlist message |
| pending | verify OK, under cap | provisioning→active | provision, consumed, set-password redirect (existing) |
| provisioning | verify POST timed out, user retries same link | provisioning→active | resume (cap skipped) |
| waitlisted | founder `waitlist provision` | active | provision with Terms + timezone, consumed, `provisioned_at`, set-password email |
| waitlisted | user opens the link again (any time, even after expiry, even under the cap) | waitlisted | waitlist message; never provisions |
| pending | verify OK, per-IP verified ≥ limit (not a resume) | pending (unconsumed, `verified_at` set) | refused with message; falls under the 30-day verified-unprovisioned retention but is **not** listed as waitlisted in the digest |
| verified, unconsumed | older than `VERIFIED_UNPROVISIONED_RETENTION_DAYS` | deleted | listed in digest 3 days before |
| any unverified | older than retention | deleted | cleanup |
| consumed | older than retention | deleted | cleanup (tenant row keeps signup email) |

### Password reset token
| State | Event | Next |
|---|---|---|
| issued | verify (valid) | issued |
| issued | reset (conditional consume) | used (+ password, sessionVersion in the same tx) |
| issued | concurrent second reset | first wins; second zero rows → error |
| issued | expired | dead |

### Offline sync item (P4)
| State | Event | Next |
|---|---|---|
| queued | sync → `{ ok: true }` | removed, local entry synced |
| queued | sync → `{ ok:false, code: conflict|validation }` | queued; queue item `attempts`+1, `lastError` = message; local entry `syncStatus='error'` (user resolves) |
| queued | sync → `{ ok:false, code: read_only|forbidden|unauthenticated }` | queued, sync loop paused until next app load |
| queued | network failure | queued (existing retry) |

---

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Resend `{ error }` / throw / 429 | logged + Sentry (429 retried once after 2 s); the triggering action unaffected |
| `after()` callback throws | caught inside; logged |
| Three crons sending at 20:00 | ≤ 2/s each → ≤ 6/s total (Resend limit 10/s per team) |
| Cron hits time budget | stops, `incomplete: true`, Sentry message + `cron-incomplete` alert; next run starts after the saved cursor (reminders missed today are not re-sent — stated) |
| IPv6 rotation within a /64 | same hash (prefix hashed) |
| Resend used to outlive the IP hash | expiry capped at created + 24 h; null-hash non-resume verify refused |
| Email scanner opens the verify link | GET writes nothing |
| Turnstile alert open from a past outage | resolved by the cron after an hour quiet; a new outage alerts again |
| Turnstile down | fail closed; outage alert after 3 outage signals/hour (immediate email + Sentry); user errors never count |
| Spent Turnstile token on retry | client resets the widget after every failure; no loop |
| Founder env has localhost URLs / no Neon key | `waitlist provision` and `createLocalDevDatabase` refuse |
| Waitlist welcome email fails | command prints the link and exits non-zero |
| Missing Turnstile secret / IP salt in production | fail closed + alert |
| Cap fills between start and verify | verify caps (except resumes) |
| Concurrent verifies at the cap edge | overshoot ≤ concurrent requests (documented); Neon 80 alert is the backstop |
| Founder provisions a waitlisted signup whose slug was taken meanwhile | `ProvisionConflictError` → command reports it; founder contacts the lead |
| Neon list fails | alert with day count; resolves on success |
| Retention PATCH fails for one project | others continue; non-zero exit; listed |
| Offline sync gets `{ ok:false }` | items kept (never deleted) |
| migrate-all meets a deleted DB of a `deleting` tenant | skipped, not failed |
| Demoted admin within 60 s | every admin write refused (fresh check) |
| P5 merged before the Privacy Policy update | flag off in production → signup as today |

---

## 7. Platform limits

`after()` within the action's max duration. Crons: `maxDuration = 300`, 240 s budget, ≤ 2 sends/s → ≤ 480 emails per
run per cron **shared across all tenants** (the cursor rotation keeps it fair; Resend's batch API is the follow-up when
`cron-incomplete` alerts start recurring). Turnstile
adds one outbound call per signup. Neon list: a few calls/day.

---

## 8. Blast radius

Source: `src/lib/tenant/host.ts`, `src/lib/tenant/slug-rules.ts` (new), `src/lib/tenant/provision.ts` (re-export),
`src/server/actions/password-reset.ts`, `src/app/reset-password/page.tsx`, `src/app/forgot-password/*`,
`src/lib/email/{send,send-signup,rate}.ts`, `src/lib/tenant/notices.ts` (throttle value),
`src/server/actions/{periods,signup,mfa,users,charge-codes,qbo,gusto,assignments,clins,contracts,indirect-codes,integrations,labor-categories,slins,billing,…all mutations}.ts`,
`src/server/internal/*` (new internal functions), `src/auth.ts`, `src/lib/{action-result,errors,run-action,turnstile}.ts`
(new), `src/lib/validation.ts`, `src/lib/offline/sync-service.ts`, `src/components/timesheet/TimesheetContext.tsx`,
`TimesheetToolbar.tsx`, every admin client component (results + disabled states), `src/app/(app)/{AppShellWrapper,layout,BillingWall,OnHoldScreen,PolicyHoldScreen,TenantUnavailable}.tsx`,
`src/app/page.tsx`, `src/app/login/*`, `src/app/signup/*` (form, check-email resend, verify route, waitlist page),
`src/app/api/v1/**`, `src/lib/api-auth.ts`, `src/app/api/export/workspace/route.ts`, `src/components/shell/AppNavbar.tsx`,
`src/app/(app)/admin/billing/*`, `src/db/control-plane/schema.ts` + migrations `0007_cron_runs` (P6) and `0008_signup_controls` (P5), `src/lib/tenant/lifecycle-config.ts`,
`src/lib/tenant/lifecycle-runner.ts` + `src/app/api/cron/tenant-lifecycle/route.ts` (cleanup/quota before digest),
`src/lib/tenant/ops-digest.ts` (always send, cron staleness), `src/lib/tenant/neon.ts`, `src/lib/tenant/admin-commands.ts`
(waitlist), `src/lib/email/templates/*` (welcome/set-password), the four cron routes, `src/lib/cron-auth.ts` (probe),
`sentry.*.config.ts`, `src/instrumentation-client.ts`, `next.config.ts` (CSP), `src/app/(app)/profile/{MFASetup,ProfileClient}.tsx`
(current-password field; `ActionResult` consumers), `src/lib/integrations/connectors/{qbo-api,gusto-api}.ts`,
`src/lib/rate-limit.ts` (IPv6 /64, unknown IP), `src/server/actions/{migration,pay-period-config,employee-dashboard}.ts`.
Scripts: `scripts/tenant-admin.ts`, `scripts/backfill-neon-retention.ts` (new), `scripts/lib/target.ts` (new) + every
founder script, `scripts/provision-tenant.ts`, `scripts/migrate-all.ts`, `scripts/smoke-tenancy.sh`.
Tests that change: the ~78 `rejects.toThrow` integration assertions (authorization, period-lock-integrity, tenant-admin,
calendar-dates-*, charge-code-actions, fresh-authorization, mass-assignment, dcaa-concurrency, …), `signup-terms.test.ts`
(Turnstile verifier injected), integration `@/lib/email/send` mocks (return `{ ok:true, id }`), a shared `next/server`
`after` mock (runs the callback immediately) added to integration setup; `server-action-guards.test.ts`; ops-digest
and notices unit tests (digest always sent, 500 ms throttle); signup verify integration tests (GET no-write, POST order).
Docs: `.env.example`, `PRODUCTION-DEPLOY.md`, `RESTORE.md` (new), `MIGRATIONS.md`, `TENANT-DELETION.md` (link).
Business side (not engineering): Privacy Policy §2, §4, §7 (LB-D3, LB-D5).

---

## 9. Required test matrix (each fails without its fix)

| Area | Scenario |
|---|---|
| Reset | link on workspace host; apex request sends nothing; apex verify → invalid (no throw); billing_only admin verifies + resets; concurrent double reset → one succeeds; expired refused; sessionVersion bumped |
| Emails | an `after()` callback that throws is caught and logged; each timesheet email carries `tenantBaseUrl(slug)`; `{ error }` → `{ ok:false }` + Sentry, action still OK; missing id = failure; disabled → `{ ok:false, reason:'disabled' }` no Sentry; scheduled via `after` (mock asserts callback); 429 retried once; throttle ≤ 2/s (fake timers) |
| Resend verification (P5, flag on) | new Turnstile required; token rotated (old link invalid); expiry never beyond created + 24 h; waitlisted / verified / unknown → same generic response, nothing sent; not counted toward per-IP workspace limit |
| Routing | workspace `/` → `/timesheet`; apex `/` marketing; apex `/login` finder → `goToWorkspace` redirects to the slug host; `goToWorkspace` with a target other than `/login`/`/forgot-password` refused; invalid slug message; workspace `/signup` → apex; unknown workspace `/login` → TenantUnavailable; demo button hidden without env; LoginForm resets loading on throw |
| Roles | each of the 37 admin writes (incl. the 6 token-refreshing mapping readers) refuses a JWT-admin whose DB role is supervisor; guard test fails when `requireAdmin()` is added to any non-allowlisted action (mutation) |
| Account security | MFA setup without current password refused; null passwordHash handled; concurrent recovery code → one succeeds; 6th bad password on changePassword/disableMFA refused |
| Action results | known errors → `{ ok:false, code, error }`; unexpected DB error → generic (no SQL text); `redirect()` inside an action still redirects (rethrow); missing guard inside `userAction` caught by the guard test (fixture); no actions module imports another; none of the 7 listed action-to-action calls remain; client static check flags an unchecked awaited action; static check flags a new `throw new Error(` in actions/validation/internal; "seat limit reached" / "period locked" reach the client verbatim in production mode; internal writer that calls `getDbForWrite` flagged; `export function` scanned |
| Offline sync | `{ ok:false, conflict }` keeps queue items with error status; `read_only` pauses the loop and keeps items; success removes them |
| Timesheet context | failed save: no `MARK_SAVED`, server message shown, no success toast; failed submit: status not set to submitted, no success toast; per-call-site static check flags an ignored result in a file that checks another call |
| Modes | read_only: admin write buttons + Approve/Reject disabled (static render) |
| v1 API | no header, malformed header, bad prefix — each on an unknown **and** an existing workspace → identical 401 body + `WWW-Authenticate`; unknown workspace, closed workspace and bad key → identical 401 body; **billing_only + bad/no key → the same 401**; billing_only + valid key → 403 workspace_unavailable; DB failure → generic 500 + logged |
| Export route | unauthenticated → 401 |
| Billing | admin-only Billing nav; Subscribe enabled from server `purchasable`; no client import of plans (static); sign-out on 3 hold screens |
| Signup | flag off → signup as today, no Turnstile script in the page, no ip_hash written; verify GET writes nothing (no `verified_at`, no waitlisting); already-active tenant + same signer → consumed + `/login`; null-ip_hash non-resume verify refused; IPv6 addresses in one /64 share a hash; `'unknown'` IP refused in production; reopening a verified link doesn't move `verified_at`; Turnstile `hostname` mismatch refused; slug taken at the cap → "name just taken", not waitlisted; after `turnstile-outage` resolves, a second outage sends a new email; `signup-config-missing` resolves once env present; Turnstile fail/pass/spent keys; second submit after "name taken" succeeds with a reset widget token; user-error codes don't count toward the outage alert; 3 outage signals in an hour → alert + immediate email, auto-resolve after an hour; 4th **verify** from one ip_hash in 24 h refused even when all were started at 0 verified; waitlisted link reopened after 25 h and under the cap → waitlist message, no provisioning; expired non-waitlisted link → expired message; cap alert deduplicated per UTC day; missing secret (prod) → refused + alert; missing salt (prod) → refused + alert; raw IP never stored (assert column values); 4th verified workspace from one IP hash in 24 h refused; resume at cap provisions; cap at verify → waitlisted (unconsumed, alert once/day); waitlisted link reopened → waitlist message; `companyName` > 120 refused |
| Waitlist | `waitlist provision` passes Terms version/time + timezone + adminName (tenant row has them), awaits the set-password email, marks provisioned; email failure → prints link, non-zero exit; refuses unverified / provisioned rows; slug conflict reported; refuses localhost app URLs against a non-loopback control plane; `createLocalDevDatabase` refuses a non-loopback admin URL |
| Cleanup/quota | consumed signup whose tenant row lacks Terms version/time → kept + `signup-terms-not-copied` alert; with Terms copied → deleted after 30 d; unverified + consumed + verified-unprovisioned retention deletes (digest lists the latter 3 days before); ip_hash nulled within 24 h 10 min (notice-delivery cron + startSignup); Neon ≥ 80 alert / < 80 resolve; list failure alert with occurrences; runs when the tenant loop was incomplete (fetch mocked) |
| Retention | create sends `history_retention_seconds`; env override honored; backfill PATCHes, `--check` no calls, tenants without project id listed, failure → non-zero |
| Heartbeat | each cron writes `cron_runs` start/success; digest always sent; stale cron listed per its own limit (daily-reminder not flagged on a Monday); missing `cron_runs` row listed as never ran; `?probe=1` → 200, no work, no `cron_runs` write; with `SENTRY_CRON_MONITORS=1` `withMonitor` + flush called |
| Crons | reminders: `SEED_EMAIL_DOMAINS` recipients skipped, a lifecycle-exempt real tenant still gets reminders; budget stop → next run starts after the saved cursor (the starved tenant is served first); incomplete run → `cron-incomplete` alert, resolved by a complete run; time budget → `incomplete` + Sentry; per-tenant failure → Sentry + count; shared auth 401 |
| Ops | migrate-all includes `deleting`; confirmed-deleted DB (Neon 404 / no `pg_database` row) of a `deleting` tenant → skipped; transient connect error → FAILED; backfill `--check` with a `deleting` 404 → skipped; target banner prints host without credentials; `provision:tenant` w/o NEON key refuses a non-loopback **admin** URL |

---

## 10. Verification

```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety
CONTROL_PLANE_DATABASE_URL="$(grep '^CONTROL_PLANE_DATABASE_URL=' .env.local | cut -d= -f2-)" ENCRYPTION_KEY="$(grep '^ENCRYPTION_KEY=' .env.local | cut -d= -f2-)" TZ=America/New_York npm run test:integration
npm run build && node scripts/check-build-trace.mjs
npm run demo:local && npm run demo:local
```
Manual: reset from `acme.localhost:3000/forgot-password` completes on `acme.localhost`; apex `/login` finder; read-only
test workspace shows disabled controls; signup with Turnstile test keys (pass, fail), cap path by setting the cap to 0
locally, `tenant:admin waitlist provision`. Staging (Phase 12): real Turnstile keys, digest arrives daily, Sentry shows
`staging`, `backfill:neon-retention --check`.

---

## 11. Dev-agent hand-off rules

`BLUEPRINT-STANDARD.md` §3 in full. Phase by phase, report after each with the commands run and their results. P4:
convert one feature area per commit; keep the guard tests green; never let a client treat a returned failure as success.
Never change OAuth `redirect_uri` builders; never store a raw IP; Turnstile secret and IP salt never in client files.
**P5 lands last, behind `SIGNUP_CONTROLS_ENABLED`; the flag must not be turned on in production until the business
side has published the updated Privacy Policy (LB-D3, LB-D5).** Implement LB-D5–D7 as recorded.

**Known LOWs to handle during implementation** (checked at the post-implementation audit): `verifyResetToken`'s
empty-slug pre-check must also treat a `getTenantSlug()` host/header-mismatch throw (`context.ts:20-22`) as
`{ valid: false }`; `goToWorkspace` uses the same in-memory limiter as `checkSlugAvailable`; Turnstile CSP origins and
Neon `GET /projects` max `limit` confirmed from the vendor docs and cited in the PR.
