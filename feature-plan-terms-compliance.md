# Blueprint: Terms Compliance — Trial Lifecycle, Billing States, Full Export, Workspace Deletion

> **Role for the executing developer: Senior backend engineer (multi-tenant SaaS, billing).**
> Branch: `terms-compliance` off `main`. **Do not start until §0 is filled in** (the product owner
> gets those answers from the business side). Read `AGENTS.md`; this is Next.js 16 / Auth.js v5
> beta / Drizzle — confirm APIs in `node_modules` before relying on them.
>
> The Terms of Service and Privacy Policy (drafts in the gitignored `business/legal/`) promise
> behavior that does not exist yet. This blueprint builds it. Every requirement below cites the
> clause it comes from. **Do not invent business rules**: every number or policy choice not stated
> in the Terms is a named constant whose value comes from §0.

## 0. Decisions required before starting (BLOCKING — product owner fills in)

Answered 2026-10-21. Values live in `src/lib/tenant/lifecycle-config.ts` (created ahead of Phase T2;
T2 adds `lifecycle.ts` on top of it). The Terms drafts in `business/legal/` were updated to match
(§3.2, §4.7, §9.2, §9.3 and the `[14]`/`[15]`/`[30]` placeholders).

| ID | Question | Terms basis | Answer |
|---|---|---|---|
| D1 | Trial length: exactly 30 days? Does it start at workspace creation (email verified)? | §3.1 "up to 30 days" | **30 days exactly**, starting when the workspace is provisioned (after email verification): `trial_ends_at = provisioned_at + 30d`, exact timestamp. Backfill: `max(created_at + 30d, backfill_time + 14d)` so nobody already mid-trial loses access without warning. → `TRIAL_DAYS`, `TRIAL_BACKFILL_MIN_DAYS` |
| D2 | Trial-end reminder emails: how many, and how many days before the end (e.g. 7 and 1)? | §3.2 "before the trial ends" | **Two reminders: 7 days and 1 day before the end**, plus a `trial-ended` notice at the end. → `TRIAL_REMINDER_DAYS_BEFORE = [7, 1]` |
| D3 | Days of notice before deletion (fills the `[14]` placeholder). | §3.3 | **14 days** (the contractual notice; fills `[14]`), plus a courtesy final reminder **3 days** before. `tenant:delete` checks against the 14-day notice. → `DELETION_NOTICE_DAYS`, `DELETION_FINAL_REMINDER_DAYS` |
| D4 | After the 90-day window: delete **automatically** (cron), or **founder-run** after the notice? | §3.3/§9.2 "may"; Privacy §7 "deleted" | **Founder-run** at launch (`AUTO_DELETE = false`). The cron flags due tenants in its summary; the founder runs `tenant:delete` within **7 days** of `deletion_scheduled_for` (so Privacy §7 "deleted" stays true). Revisit once deletions are routine. → `AUTO_DELETE`, `DELETION_SLA_DAYS` |
| D5 | In read-only mode (trial expired / subscription ended), who may export: admins only, or every user (employees only their own data)? | §3.2 "your Users can view and export" | **Full-workspace export: admins only.** Every user can still sign in and view; employees and supervisors keep their normal role-scoped views and downloads (no new export for them). Terms §3.2 reworded to match. → `READ_ONLY_EXPORT_ROLES = ['admin']` |
| D6 | Export during the 90 days after a subscription ends: self-service in the read-only workspace, or support-run "on request"? | §9.2 "on request" | **Self-service**: admins sign in to the read-only workspace and export it themselves. No support ticket. Terms §9.2 reworded to match. → `POST_END_SELF_SERVICE_EXPORT = true` |
| D7 | Payment grace: days overdue before suspension (fills `[15]`), and how many days of email notice precede suspension? | §4.7 | **15 days past due** before suspension (fills `[15]`), counted from the first failed charge or an unpaid invoice's due date. Notices: `payment-failed` on day 0, `suspension-warning` **3 days** before suspension, `suspended` at suspension. → `PAYMENT_GRACE_DAYS`, `SUSPENSION_NOTICE_DAYS` |
| D8 | While **suspended** (unpaid), may admins export? (The Terms promise only sign-in to pay.) | §4.7 vs §9.1 | **Yes**, admins may export while suspended. It's their audit record (§8.1); holding it hostage is a bad look. Terms §4.7 updated to say so. → `SUSPENDED_EXPORT_ALLOWED = true` |
| D9 | When does an unpaid, suspended workspace count as "terminated", starting the 90-day deletion clock? (e.g. N days suspended, or when Stripe gives up and deletes the subscription) | §9.2, §17 | **30 days after suspension** (day 45 past due). The cron cancels the Stripe subscription, sets `subscription_ended_at`, and the workspace follows the normal subscription-ended path (read-only + admin export, deletion 90 days later). Configure Stripe dunning to **not** cancel subscriptions; our cron is the only thing that terminates for non-payment. The `suspended` email states the termination date. Non-payment timeline: fail d0 → suspend d15 → terminate d45 → delete d135. → `SUSPENDED_DAYS_UNTIL_TERMINATION` |
| D10 | Who receives notices: all active admins of the workspace, the original signup email, or both? | §20.4 "administrators' email addresses" | **All active admins + the Stripe customer's billing email** (if set), deduplicated. If there's no active admin, fall back to the original signup email. (The signup email alone may belong to someone who has left.) → `NOTICE_RECIPIENTS` |
| D11 | Backup window after deletion (fills `[30]`). Engineering note: Neon keeps a deleted project restorable for a period set by Neon, and PITR history follows the project's retention setting; the value chosen must be ≥ what Neon actually retains (see T7.4). | §9.3, Privacy §7 | **30 days** (fills `[30]`). Neon's deleted-project recovery period is 7 days (Neon docs, checked 2026-10-21), so 30 is true today. Any backup system added later (e.g. long-term DCAA backups) must purge a deleted tenant within 30 days, or this value and the Terms must change first. T7.4 should still confirm PITR data goes with the project. → `BACKUP_RETENTION_DAYS` |
| D12 | Export scope: only §1 "Customer Data", or also login attempts, integration sync logs, notification preferences, API-key metadata? | §1, §9.1 | **§1 Customer Data tables + `period_events` + `notification_preferences`, `integration_entity_mappings`, `integration_sync_logs`, `integration_sync_records`** (sync logs + records show what was pushed to QuickBooks, which is useful for audit reconciliation; records reference their log, so both go together). **Excluded:** login attempts, API-key metadata, password-reset tokens (security records, not Customer Data). Column allowlists still apply. → `EXPORT_EXTRA_TABLES` |
| D13 | Terms version string to record at signup (e.g. `2026-10-draft-1`), and the final Terms/Privacy text for `/terms` and `/privacy`. | checklist #1–2 | Version format `<effective date>[-draft-N]`; current **`2026-10-21-draft-1`** (fine for staging). **Final text is not ready**: it's blocked on forming Hundred Cents LLC (mailing address, effective date). Per T9, leave `/terms` and `/privacy` as they are until the founder supplies final text, then drop `-draft-N` and use the effective date. → `TERMS_VERSION` |

Anything else ambiguous you hit while building: **stop and ask**; do not pick a business value.

## 1. Requirements (from the Terms and the launch checklist)

| # | Requirement | Source |
|---|---|---|
| R1 | Trial ≤ D1 days, ≤ 10 users, no card. | §3.1 (seat limit already enforced by `PLANS.trial.seatLimit`) |
| R2 | When the trial ends without a subscription, the workspace is **read-only**: view and export allowed, no entering or changing time. | §3.2 |
| R3 | Email admins before the trial ends (D2). | §3.2 |
| R4 | 90 days after trial end without purchase: deletion, with ≥ D3 days' email notice. | §3.3, Privacy §7 |
| R5 | Founder can extend or end a trial. | §3.4, checklist #4 |
| R6 | Customer can cancel in billing settings; cancellation takes effect at the end of the paid term. | §4.4, §17.2 (Stripe portal already supports this — verify config) |
| R7 | Suspend only after a failed payment / D7 days overdue **and** after email notice. While suspended, admins can sign in, pay, and access is restored. | §4.7 |
| R8 | One admin export of **all** Customer Data, including **every revision** of every time entry, approvals, users, contract/charge-code setup; documented CSV format. | §9.1, checklist #5 |
| R9 | For 90 days after a subscription ends, keep data and allow export (D6); then deletion (D4). | §9.2, §17.4 |
| R10 | Documented, tested deletion that **permanently deletes the workspace database**. | checklist #6 |
| R11 | Time records are never deleted or overwritten during the subscription. | §8.5, checklist #12 |
| R12 | Record Terms acceptance (version + timestamp) at signup; show the notice. | checklist #2 |
| R13 | Every support link → `support@cadenzpoint.com`. | checklist #3 |
| R14 | Notices to admins must be provable (we must be able to show an email was sent and when). | §3.2, §3.3, §4.7 |

## 2. Current state (verified — don't re-investigate)

- **Control plane** `src/db/control-plane/schema.ts`: `tenants` has `status`
  (`provisioning|active|suspended|deleting`), `plan` (default `'trial'`), Stripe ids,
  `subscriptionStatus`, `createdAt`. **No** trial date, admin contact, Terms acceptance, Neon project
  id, or lifecycle timestamps. Migrations in `drizzle/control-plane/` (baseline idx 1), applied by
  `scripts/migrate-all.ts`; `npm run db:generate:cp` generates.
- **Trial expiry is enforced nowhere**; a trial tenant stays `active` forever.
- **Stripe webhook** `src/app/api/stripe/webhook/route.ts`: any non-`active`/`trialing` status and
  `subscription.deleted` → `suspended` immediately; `invoice.payment_failed` → `suspended`
  immediately, no email. Cancellation is indistinguishable from non-payment. No event-ordering guard.
  `applySubscriptionState` is in `src/lib/billing/tenant-billing.ts`.
- **Suspended UX**: `src/app/(app)/layout.tsx` renders `BillingWall` for every `(app)` route,
  including for logged-out visitors (no sign-in link). `BillingWall` only opens the Stripe portal,
  which fails when there's no Stripe customer (`openBillingPortal` throws). `TenantUnavailable.tsx`
  has a dead `suspended` branch and `mailto:support@example.com`.
- **Access gates** (`src/lib/tenant/context.ts`, `src/db/index.ts`): `getDb()` → active only;
  `getDbForAuth()` / `getTenantForBilling()` → active or suspended.
- **Exports today** are all latest-revision and filtered (cost CSV/XLSX, timesheet PDF, payroll CSV,
  API v1). The audit trail (`src/server/actions/audit.ts`) is the only all-revisions view, and it
  inner-joins `clins` (drops indirect entries), omits `chargeCodeId`, caps at 500 rows, and has no
  download.
- **Approval history is overwritten**: `submitPeriod` nulls `reviewedAt/By/Comment`;
  approve/reject overwrite them (`src/server/actions/periods.ts`). Past reject/resubmit cycles are lost.
- **Deletion**: nothing. `src/lib/tenant/neon.ts` has no delete; the Neon project id is discarded
  after creation (project name is `cadenzpoint-<slug>`). `deleting` is never set.
- **Email**: Resend via `src/lib/email/client.ts`, templates in `src/lib/email/templates/`, senders
  in `src/lib/email/send.ts`; fire-and-forget, no send log. No billing/trial/deletion templates.
- **Crons**: `vercel.json` has two; `src/app/api/cron/submission-deadline/route.ts` is the pattern
  (CRON_SECRET check, iterate `controlDb` tenants, `getDbForUrl(decrypt(...))`).
- **Zip**: `jszip` is only a transitive dependency (via exceljs); `papaparse` is a direct one.

## 3. Design

### 3.1 Access modes (one function decides)
Add `getTenantAccess(tenant, now)` in `src/lib/tenant/lifecycle.ts`, a **pure function** of the
tenant row and the clock, returning:

| Mode | When | Users can |
|---|---|---|
| `full` | active, and (paid subscription active/trialing **or** trial not yet ended) | everything |
| `read_only` | trial ended without a subscription (R2), **or** subscription ended and within the 90-day window (R9, per D6) | sign in, view, export (per D5/D6); **no writes** |
| `billing_only` | suspended for non-payment (R7) | admins: sign in, billing, (export if D8 = yes); others: a "workspace on hold" screen |
| `closed` | `deleting`/deleted, or past the 90-day window awaiting deletion | nothing (TenantUnavailable "Workspace closed") |

Store **facts**, derive the mode: `trialEndsAt`, `subscriptionEndedAt`, `suspendedAt`,
`pastDueSince`, `deletionScheduledFor`, `deletedAt`. `status` stays as the coarse gate (`active` /
`suspended` / `deleting` / new `deleted`), and the mode refines it. Unit-test the function
exhaustively (table-driven, injected `now`).

### 3.2 Write gate
Reads keep using `getDb()` (now allowed in `full` and `read_only`). **Every write** goes through a
new `getDbForWrite()` (`src/db/index.ts`) that throws `WorkspaceReadOnlyError` unless the mode is
`full`. Enforce with the existing guard-coverage test: any exported action in
`src/server/actions/` whose body calls `.insert(` / `.update(` / `.delete(` must obtain its client
from `getDbForWrite()` (allowlist with justifications: login-attempt writes in `src/server/internal`,
notification preferences only if D5 says users keep settings, password change, MFA setup —
security functions must keep working in `read_only`). The UI shows a read-only banner with the reason
and a "Subscribe" button for admins, and disables entry controls; the server gate is the real control.

### 3.3 Notices are logged and idempotent (R14)
New control-plane table `tenant_notices (id, tenant_id, kind, scheduled_for, sent_at, recipients
text[], provider_message_id)`, unique on `(tenant_id, kind, scheduled_for)`. Every lifecycle email is
sent through `sendTenantNotice(tenant, kind, scheduledFor)`, which inserts the row first (unique
constraint = no duplicate sends on cron retries), sends to the admins resolved per D10, then records
`sent_at` and the Resend message id. This is our proof of notice.

## 4. Phases (build and test each before the next)

### T1 — Control-plane schema (additive only)
Add to `tenants` (all nullable): `trial_ends_at`, `past_due_since`, `suspended_at`,
`subscription_ended_at`, `deletion_scheduled_for`, `deleted_at` (timestamptz);
`neon_project_id` (varchar); `terms_version`, `terms_accepted_at`; `last_stripe_event_at`
(timestamptz, for ordering); `signup_email` and `billing_email` (varchar, for D10 notice recipients:
`signup_email` copied from the `signups` row at provisioning, `billing_email` kept current from Stripe
in T5). Add `'deleted'` to `tenant_status` (`ALTER TYPE … ADD VALUE` is
additive). Add `tenant_notices` (§3.3). Add `terms_version`, `terms_accepted_at` to `signups`.
Generate with `npm run db:generate:cp`; `npm run db:safety` must pass.
**Backfill** (one-off script `scripts/backfill-trial-dates.ts`, idempotent): for `plan = 'trial'`
and no Stripe subscription, `trial_ends_at = max(created_at + TRIAL_DAYS, now + TRIAL_BACKFILL_MIN_DAYS)`
(D1); `signup_email` from the matching consumed `signups` row (by slug). Run it in staging and production
right after the migration (add it to PRODUCTION-DEPLOY.md).

### T2 — Lifecycle config + access function
`src/lib/tenant/lifecycle-config.ts`: every §0 value as a named, documented constant
(`TRIAL_DAYS`, `TRIAL_REMINDER_DAYS_BEFORE: number[]`, `DELETION_NOTICE_DAYS`,
`POST_END_RETENTION_DAYS = 90` (§3.3/§9.2), `PAYMENT_GRACE_DAYS`, `SUSPENSION_NOTICE_DAYS`,
`AUTO_DELETE: boolean`, `READ_ONLY_EXPORT_ROLES`, `SUSPENDED_EXPORT_ALLOWED`, …).
`src/lib/tenant/lifecycle.ts`: `getTenantAccess()` (§3.1) plus `nextLifecycleActions(tenant, now)`,
a pure function returning which notices are due and whether a state change is due. Table-driven
unit tests for both, covering every boundary (day before/of/after each deadline).

### T3 — Enforce the modes
- `src/lib/tenant/context.ts`: extend `TenantState` with the access mode; `getTenantOrThrow()` serves
  `full` and `read_only`; add `getTenantForWrite()` (full only).
- `src/db/index.ts`: `getDb()` uses the read gate; add `getDbForWrite()` (§3.2). Convert every write
  path. Extend `server-action-guards.test.ts` per §3.2.
- `src/app/(app)/layout.tsx`: route by mode. `read_only` → normal app + banner + disabled entry.
  `billing_only` → **logged-out visitors are redirected to `/login`** (not shown the wall); admins
  get the billing wall with **Subscribe** (checkout when there's no Stripe customer) and
  **Manage billing** (portal when there is), plus Export if D8 = yes; others get "on hold, contact your
  admin". `closed` → TenantUnavailable.
- Remove the dead `suspended` branch and stale TODO in `TenantUnavailable.tsx`.
- Registry cache: status changes must take effect promptly. Make the webhook and lifecycle cron call
  `invalidateTenant(slug)`, and document the ≤ 60 s propagation on other instances (acceptable).

### T4 — Trial lifecycle
- Provisioning (`src/lib/tenant/provision.ts` / `registry.ts`): set `trial_ends_at = now + TRIAL_DAYS`
  for trial tenants.
- New cron `src/app/api/cron/tenant-lifecycle/route.ts` (daily; add to `vercel.json`), CRON_SECRET
  fail-closed like the others. For each tenant, `nextLifecycleActions()` → send due notices via
  `sendTenantNotice` (trial reminders D2; deletion notice D3 days before `deletion_scheduled_for`;
  payment notices D7) and apply due state changes (set `deletion_scheduled_for =
  trial_ends_at + 90d` when the trial ends unpurchased; suspend after grace; mark for deletion per
  D4). Idempotent: safe to run twice the same day. Per-tenant try/catch so one failure doesn't stop
  the run; log a summary.
- **Founder digest (D4)**: because deletions are founder-run, the cron emails `OPS_ALERT_EMAIL` (new env
  var; document it in `.env.example` and PRODUCTION-DEPLOY.md) whenever any tenant is due for deletion,
  overdue against `DELETION_SLA_DAYS`, or failed in the run. No email when there's nothing to do. A log
  line alone would go unread.
- Email templates (React, `src/lib/email/templates/`): `trial-ending`, `trial-ended`,
  `payment-failed`, `suspension-warning`, `suspended`, `subscription-ended`, `deletion-scheduled`.
  Links go to the **tenant's** subdomain (not the apex `APP_URL`). Wording: plain, states the date,
  what happens, and how to export/subscribe. Product owner reviews copy.
- Founder tooling: `scripts/tenant-admin.ts` (`npm run tenant:admin -- <command> <slug> …`):
  `extend-trial <days>`, `end-trial`, `show` (all lifecycle fields + notices sent). Uses the control
  plane directly; prints before/after; requires `--yes` for changes.

### T5 — Billing lifecycle (webhook)
- Ordering/idempotency: ignore an event older than `last_stripe_event_at`; update it on apply.
- `customer.subscription.created/updated` with `active`/`trialing` → clear `past_due_since`,
  `suspended_at`, `subscription_ended_at`, `deletion_scheduled_for`; status `active`; plan from
  price (R7 "access is restored once payment is received").
- `invoice.payment_failed` / status `past_due`/`unpaid` → set `past_due_since` (if unset), **stay
  active**, send `payment-failed` notice. Suspension happens in the cron after `PAYMENT_GRACE_DAYS`
  with prior notice (R7), not in the webhook.
- `customer.subscription.deleted` / `canceled` → `subscription_ended_at = now`, status `active` with
  mode `read_only` (R9), `deletion_scheduled_for = now + 90d`, send `subscription-ended`.
  **Idempotent with D9 termination**: the lifecycle cron terminates an unpaid workspace
  `SUSPENDED_DAYS_UNTIL_TERMINATION` days after suspension by cancelling the Stripe subscription and
  setting `subscription_ended_at` itself; the resulting `subscription.deleted` webhook must **not** move
  `subscription_ended_at` or `deletion_scheduled_for` if they're already set, and must not re-send the
  notice (the `tenant_notices` unique key also prevents that).
- Re-subscribing from the read-only workspace (Subscribe → checkout) during the 90-day window restores
  `full` via the `active` branch above, which clears the end/deletion dates.
- `checkout.session.completed` → link `stripeCustomerId` if missing (fixes paying from the wall when
  there was no customer) and set `billing_email` from `customer_details.email`.
- `customer.updated` → refresh `billing_email` (D10).
- Update PRODUCTION-DEPLOY.md 9.2 so the webhook subscribes to every event this handler now uses.
- Tests: a table of event sequences (fail → retry success; fail → grace expiry → suspend → pay →
  restore; cancel → end of term → read-only → 90 days → closed; out-of-order delivery).

### T6 — Full workspace export (R8)
- Route `GET /api/export/workspace` (Route Handler, streams a `.zip`): `requireAdminFresh()` — admins
  only in every mode (D5); allowed in `full`, `read_only` (D6, self-service) and `billing_only` (D8).
  Rate-limit to a few per hour per tenant. Add `jszip` (or `fflate`) as a **direct** dependency.
- Contents: one CSV per table (papaparse `unparse`), UTF-8 with BOM, ISO-8601 UTC timestamps, plus
  `README.md` (data dictionary: every file, every column, meaning, and how revisions work) and
  `manifest.json` (tenant slug, generated_at, row counts, app version, schema migration index).
- **Every revision**: `timesheet_entries.csv` is the raw append-only table, every row, including
  revision_number, change_reason_code, comment, created_at, created_by (+ created_by email), with
  charge_code / CLIN / SLIN / indirect code resolved to human labels in extra columns. Also
  `timesheet_entries_current.csv` (latest revision per cell) for convenience.
- Tables per D12; at minimum (§1 Customer Data): users, contracts, clins, slins, charge_codes,
  cost_classes, indirect_charge_codes, labor_categories, user_assignments, user_charge_codes,
  user_labor_categories, pay_period_config, timesheet_periods, period_events (T8), timesheet_entries,
  plus `EXPORT_EXTRA_TABLES` from `lifecycle-config.ts` (D12).
- **Never exported**: `users.password_hash`, `totp_secret`, `totp_recovery_codes`,
  `totp_last_used_step`, `session_version`; `api_keys.key_hash`; `password_reset_tokens` (whole
  table); `integration_connections.access_token_encrypted` / `refresh_token_encrypted`. Implement as
  an **explicit column allowlist per table** (not a denylist), so a future secret column is excluded
  by default. Test: export a seeded workspace; assert every revision row is present, row counts match,
  and no secret column name appears in any CSV header.
- Memory: stream table by table (keyset pagination, 5k rows per batch); don't load everything at once.
- UI: "Export all workspace data" on the admin settings (or billing) page, with a note on what's
  included; also on the read-only banner and billing wall where allowed.

### T7 — Workspace deletion (R10)
- Persist `neon_project_id` at creation (`neon.ts` / `provision.ts`). For existing tenants, a
  backfill that looks the project up by name `cadenzpoint-<slug>` via the Neon API.
- `src/lib/tenant/neon.ts`: `deleteNeonProject(projectId)` (DELETE `/projects/{id}`; verify the
  endpoint and response in Neon API v2 docs; treat 404 as already deleted). Local dev: drop the
  `tenant_<slug>` database.
- `scripts/delete-tenant.ts` (`npm run tenant:delete -- <slug> --yes`), founder-run (and called by
  the cron only if D4 = automatic). Steps, each idempotent, each logged:
  1. Refuse unless `deletion_scheduled_for <= now` and the deletion notice was sent ≥ D3 days ago
     (override flag `--force-with-reason "<text>"`, logged).
  2. Set status `deleting` (blocks all access), invalidate the cache.
  3. Cancel any Stripe subscription; leave the Stripe customer (billing/tax records, Privacy §7).
  4. Delete the Neon project (or the local DB).
  5. Tombstone the registry row: status `deleted`, `deleted_at`, and **null out
     `db_url_encrypted`**. Keep slug, name, Stripe ids, dates, and `tenant_notices` (proof of notice
     and of deletion). Decide slug reuse: keep the slug reserved (prevents someone re-registering a
     deleted company's subdomain and receiving its users' bookmarks).
  6. Print a deletion receipt (tenant, timestamps, Neon project id, notices sent).
- **Runbook** `TENANT-DELETION.md`: when it's allowed, how to take a final export first (and whether
  to send it to the customer), the command, how to verify (Neon console shows the project gone;
  connection fails), the backup window (T7.4), and what is retained and why.
- T7.4 Backups: document Neon's actual post-deletion retention (deleted-project recovery window and
  PITR) from Neon's docs, so D11's value is true. If Neon retains longer than D11, flag it to the
  product owner before launch — don't silently pick a number.
- Test: provision a throwaway tenant locally, delete it, assert the DB is gone, the registry row is a
  tombstone, the subdomain shows "Workspace closed", and a second run is a no-op.

### T8 — DCAA hardening that the Terms rely on
- **Database-level append-only (R11, checklist #12)**: migration adding a trigger on
  `timesheet_entries` that raises on `UPDATE` and on `DELETE` unless the session sets
  `SET LOCAL cadenzpoint.allow_entry_delete = 'on'` (used only by the integration test cleanup
  helper, which must run its deletes inside a transaction so `SET LOCAL` applies). Workspace
  deletion drops the whole database, so it's unaffected. Test: an UPDATE and a DELETE fail; INSERT
  works; the app's save path still works; the integration suite's cleanup still works.
- **Approval history (keep it from now on)**: append-only tenant table `period_events (id,
  period_id, user_id, event 'submitted'|'approved'|'rejected', actor_id, comment,
  completeness_snapshot, created_at)`, written in the same transaction as each `submitPeriod` /
  `approvePeriod` / `rejectPeriod`. Same trigger protection. Exported in T6. Existing period rows
  stay as the current-state view; no backfill (history before this ships doesn't exist).

### T9 — Signup Terms acceptance and support links (R12, R13)
- Signup form: "By creating a workspace you agree to the Terms of Service and Privacy Policy" with
  links; record `terms_version` (D13) and `terms_accepted_at` on the `signups` row, copied to
  `tenants` at provisioning.
- Replace every `support@example.com` and address-less "contact support" with
  `support@cadenzpoint.com` (grep the whole repo).
- `/terms` and `/privacy`: render the final text from D13 (static pages; footer
  "© 2026 Hundred Cents LLC"). If the final text isn't ready, leave the pages and say so.

## 5. Guardrails
- **Additive migrations only** (expand/contract). `npm run db:safety` passes for both roots.
- Don't weaken any round 1/2 security control. Every new action/route is guarded before any query;
  the guard-coverage test stays green and gains the write-gate rule.
- Security functions (sign-in, password change/reset, MFA) keep working in `read_only` and
  `billing_only`.
- Deletion is irreversible: every destructive step requires the explicit flag, refuses without
  logged notice, and prints what it will do before doing it.
- Emails are logged and idempotent; a cron retry never double-sends.
- No business value hardcoded outside `lifecycle-config.ts`.

## 6. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test
npm run test:integration   # TEST_DATABASE_URL, TEST_DATABASE_URL_2, CONTROL_PLANE_DATABASE_URL
npm run db:safety
npm run build              # Turbopack, locally
```
Manual (local multi-tenant setup, `LOCAL-MULTITENANT-TESTING.md`), using `tenant:admin` to move
the clock-relevant dates instead of waiting:
- Trial: set `trial_ends_at` to yesterday → entry disabled + banner; saving via the server action is
  rejected; export works; reminder and trial-ended emails logged once each even if the cron runs twice.
- Payment: simulate `invoice.payment_failed` (Stripe CLI) → still active + email; push
  `past_due_since` past grace → suspended after notice; admin signs in, pays (test card) → restored.
  Logged-out visitor on a suspended tenant is sent to `/login`.
- Cancel: cancel in the portal → at term end, read-only + export; push dates → closed.
- Export: download from a seeded tenant; open in a spreadsheet; every revision present; no secrets.
- Deletion: `tenant:delete` on a throwaway tenant; DB gone; tombstone; "Workspace closed"; re-run no-op.

## 7. Report back
Files changed; tests proving each R#; tsc/lint/unit/integration/build output; §0 values used;
anything you stopped on.

## 8. Out of scope
- Shutdown-of-service notice (§9.4) and Terms/price-change broadcast (§4.5, §18): `sendTenantNotice`
  makes these a small follow-up (a founder script that notices every tenant's admins).
- Breach-notification process (§10.2): operational runbook, not code.
- Recording sign-in IP addresses (checklist #11): small, separate; needs a Privacy Policy edit.
- Distributed rate limiting.
