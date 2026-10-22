# Blueprint: Terms Compliance — Audit Fixes (v12 — CLEAN after eleven pre-mortem rounds; F4 decided)

> Follows `BLUEPRINT-STANDARD.md`. Applies to branch `terms-compliance` (commit 10a71f9) on top of
> `feature-plan-terms-compliance.md`. Business values come only from
> `src/lib/tenant/lifecycle-config.ts`. v12 incorporates eleven independent pre-mortem reviews (two of v1, one each of v2–v11) and the §0 decisions.

## 0. Decisions required (BLOCKING items marked; product owner / business side)

| ID | Question | Engineering impact | Answer |
|---|---|---|---|
| F1 | **Demo/internal workspaces** (acme, globex, initech, staging) are registered as `plan='trial'`. Should they be exempt from the trial lifecycle (no expiry, no lifecycle emails, never auto-scheduled for deletion)? | If yes: a `lifecycle_exempt` flag set by the demo seeder and `tenant:admin`. If no: demos lapse to read-only after 30 days and email `@cadenzpoint.dev`. | **Yes, exempt** (decided 2026-10-21): no expiry, no lifecycle emails, never scheduled for deletion. Guardrails: the flag is set only by the demo seeder and `tenant:admin` (never by signup, Stripe, or any customer action); `tenant:admin show` and the cron summary list every exempt tenant so it can't hide; exempt tenants show a visible "Demo" marker in the app. **Not** for real prospects: a design partner gets `extend-trial` or a comped Stripe subscription instead, so their lifecycle stays truthful. |
| F2 | **Founder-held final export** (taken before deleting a workspace): where is it stored, is it encrypted, and when is it destroyed? (It's a copy of Customer Data, so D11's 30-day backup promise applies.) | Determines whether `tenant:export` writes to a local encrypted file, and the runbook's destruction step. | **Default: don't keep one.** Customers get self-service export plus three notices during the 90 days, so a founder copy is taken only when needed (the customer asks for it to be sent, or a legal request). **If taken:** `tenant:export` writes an AES-256-encrypted file (not macOS `zip -e`, which is weak) to a local folder that is outside the repo, **not** in iCloud/Dropbox/other synced folders, and **excluded from Time Machine** (`tmutil addexclusion`), otherwise backups keep it past 30 days. Never email it unencrypted. If sending to the customer, use an expiring link and send the password separately. **Destroy** it once delivered, and in every case **within 30 days of the workspace deletion** (D11). The deletion receipt records the destroy-by date and the date it was destroyed. Legal-hold exception: keep it only as long as the legal obligation requires, and record why (Terms §9.3 now allows this). |
| F3 | **Duplicate live subscriptions** (rare: e.g. a subscription created in the Stripe dashboard): engineering prevents them at checkout and alerts the founder. Should the system also auto-cancel/refund the duplicate, or does the founder handle it manually? | Manual (recommended engineering default) = digest alert only. | **Alert only** (manual, matching the engineering default). Refunds are money decisions; an auto-cancel bug would hit real customers' cards. Founder handles the alert within 1 business day by cancelling the duplicate in the Stripe dashboard with a prorated refund. |

| F4 | **Trial-end reminders that couldn't be delivered.** Terms §3.2 says "We will email your administrators before the trial ends." If email is down for the trial's last 7 days, no reminder reaches them before the read-only switch. Should the trial end be **pushed back** until a reminder has actually been delivered (e.g. to delivery + 1 day), or does the trial end on schedule regardless (and the founder is alerted)? | Chosen option needs no new facts: the trial ends at `trial_ends_at`; an undelivered reminder raises the existing alert. (Push back was evaluated and rejected.) | **On schedule** (decided 2026-10-21). The trial ends at `trial_ends_at` regardless; an undelivered reminder raises the existing founder alert, and the founder may run `tenant:admin extend-trial` by hand. Why: the consequence is mild and reversible (read-only, view + export still work, 90 days to subscribe, subscribing restores full access at once), trials are free, and push back adds machinery for a rare event. Terms §3.2 is reworded so it stays true: reminders are a courtesy, and the trial ends on schedule even if they can't be delivered. **Do not build push back.** |
| F5 | **What can a workspace do while suspended for a policy breach** (Terms §6/§7, §17.3 — not non-payment)? The spec currently treats it like a non-payment suspension (admins see the billing screen and can export; everyone else is on hold). Should a policy-suspended workspace's admins be able to export, or is access fully blocked until the founder decides? (§9.2 withholds the 90-day export window for such breaches.) | Export allowed = today's billing_only behavior. Blocked = a separate `closed`-like mode for policy suspensions. | **Block export by default; the founder decides case by case** (decided 2026-10-22). A breach suspension exists to stop something (probing other customers' data, abuse, false time records, a possibly compromised admin), so a full download must wait until it's understood. Matches the Terms: §9.2 already withholds the post-termination export for §6/§7 breaches, and §4.7's export-while-suspended promise covers non-payment only — no Terms change. Blocking is reversible (data is append-only; nothing is deleted while suspended). Honest mistakes (e.g. CUI pasted into a comment): once fixed, allow export or lift the suspension. Serious cases: the founder takes the export (F2 rules) and sends it to a verified contact. **Engineering:** suspension reason tracked (nonpayment / policy); breach-suspended admins can sign in but see a "workspace on hold — contact support@cadenzpoint.com" screen (no export, no billing); everyone else sees the same screen; `tenant:admin set-policy-export <slug> on\|off --reason` (audited: who, when, why); admins are emailed when the suspension starts (§17.3); non-payment suspensions unchanged. **Done when:** a breach-suspended test workspace's admin sees the hold screen and gets an error from the export endpoint; after the command the same admin can export and the change is in the audit log. |

Everything else below is engineering.

## 1. Why (verified findings, re-checked in code)

1. Paying customers treated as lapsed trials (`lifecycle.ts:85-97`, `:145`): first `past_due` → read_only;
   cron sends `trial-ended`, sets a past deletion date → closed; admin can't pay.
2. D9 termination undone next day (no `subscription_ended_at` guard; facts not cleared).
3. Ended subscription with no `trial_ends_at` keeps `full`.
4. Stripe events ordered by 1-second `event.created`; events from any subscription applied; failed
   Stripe cancel swallowed.
5. Resend returns `{ error }` without throwing; failures recorded as sent; failed rows never retried;
   delete script accepts any old notice.
6. Deletion tool can't run (`tsx` + `server-only`), and tombstones without deleting the data.
7. Export CSV malformed; whole zip buffered against Vercel's 4.5 MB cap; formula injection.
8. Write-gate gaps (assignments, sync engine, integrations, connectors, token refresh); guard regex
   misses multi-line chains.
9. Demo seeder breaks under the T8 trigger.
10. Smaller: concurrent approve/reject; save vs submit; TRUNCATE; extend-trial; reminder crons; emails
    without dates; same-plan re-subscribe; webhook on deleting/deleted tenants; final export at deletion;
    empty DB URL in `jwtCallback`; no R12 test.

## 2. Verified external facts and platform limits

| Fact | Source |
|---|---|
| Stripe SDK 17.7.0, API `2025-02-24.acacia`. Statuses: `active, canceled, incomplete, incomplete_expired, past_due, paused, trialing, unpaid`. `paused` only when a Stripe trial ends without a payment method. `unpaid`: no further invoice attempts. Retries exhausted → `canceled` or `unpaid` per settings. `pause_collection` keeps `active`. `ended_at`, `current_period_end` exist. A canceled subscription carries no "was ever active" flag. | `node_modules/stripe/types/Subscriptions.d.ts` (:140, :175, :216-220, :720) |
| `invoice.subscription` may be null (one-off invoices) | `Invoices.d.ts:415` |
| `subscriptions.retrieve/list/cancel`, `invoices.voidInvoice` / `markUncollectible`, `expand:['latest_invoice']` (→ `hosted_invoice_url`); `list` default page size 10 (use `limit:100`) | `node_modules/stripe/types/*Resource.d.ts` |
| Stripe SDK defaults: 80 s timeout, 2 network retries — override per call inside locked sections | `node_modules/stripe/cjs/stripe.core.js:17,80` |
| Resend 6.12.4 `emails.send` returns `{ data, error }` (API errors don't throw; network errors may). Rate limit **10 requests/second per team** → `429`. `idempotencyKey` (1–256 chars) is remembered **24 hours**; same key with a different body → `409 invalid_idempotent_request`; in-flight duplicate → `409 concurrent_idempotent_requests` ("try again later"). | resend.com/docs/api-reference/introduction; resend.com/docs/api-reference/errors; `node_modules/resend/dist/index.d.cts:121,183` |
| Vercel: buffered body max 4.5 MB; **streamed responses exempt**; Pro max duration 800 s (Fluid compute); memory 2 GB default / 4 GB max; crons are not retried on timeout | vercel.com/docs/functions/limitations; vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions |
| Next 16 Route Handlers: `new Response(ReadableStream)` with pull pattern; `maxDuration` segment config; `after()` runs after the response | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, `.../04-functions/after.md` |
| Control-plane client pool: `max: 5` per instance on the Neon pooled URL; `pg_advisory_xact_lock` works through Neon's transaction-mode pooler | `src/db/control-plane/index.ts:11`; Postgres semantics |
| fflate 0.8.3: `Zip`, `ZipDeflate`, `push(chunk, final)`, `ondata`, `end()`; **no Zip64** (>4 GiB or >65,535 entries corrupts); add files one at a time | `node_modules/fflate` types |
| papaparse 5.5.3: `escapeFormulae` accepts a RegExp; `unparse({fields,data:[]})` → `"a,b\r\n"`; `unparse([headers])` → `"a,b"`; `parse` strips BOM; trailing CRLF yields an empty row unless `skipEmptyLines` | `node_modules/papaparse/papaparse.js:380`; reproduced |
| postgres-js 3.4.9 `sql.reserve()` dedicated connection, no idle timeout while reserved; `tx.execute(sql\`SET LOCAL …\`)` works in drizzle transactions | `node_modules/postgres`; `src/__tests__/integration/helpers.ts` |
| Resend 6.12.4 has **no per-call timeout or abort** (`PostOptions` = `query`, `headers` only) → wrap sends in `Promise.race` with a 10 s timer; the idempotency key makes an orphaned request safe | `node_modules/resend/dist/index.d.cts` |
| postgres-js/Drizzle parse `timestamptz` to JS `Date` (millisecond precision) while SQL `now()` stores microseconds → **never use timestamp equality as a concurrency guard** | Postgres/postgres-js semantics |
| Advisory-lock waits honor `lock_timeout` (SQLSTATE `55P03`); Stripe per-request `{ timeout, maxNetworkRetries }` supported | Postgres docs; `node_modules/stripe` |
| OpenSSL-compatible encryption verified: `"Salted__"` + 8-byte salt + aes-256-cbc with key/IV = `pbkdf2Sync(pw, salt, 600000, 48, 'sha256')` split 32/16 decrypts with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256` (OpenSSL 3.6.2 and macOS LibreSSL 3.3.6) | reviewer reproduction |
| `tsx` cannot import `server-only` modules; run scripts with `node --conditions=react-server --import tsx` | reproduced; `package.json` `provision:tenant` |
| Demo/staging tenants are databases inside the control-plane Neon project | `DEPLOY-DEMO.md`, `PRODUCTION-DEPLOY.md:11-19` |
| `saveTimesheetBatch` is not one transaction today (separate inserts; editability read through `getDb()` helpers) | `src/server/actions/timesheet.ts:180-395` |

**Connection pools:** locked sections (webhook, cron, delivery, deletion) use a **dedicated** small
control-plane client (`max: 3`, `prepare: false` like `src/db/control-plane/index.ts` because of Neon's
transaction pooler; separate from the request-path pool of 5), so a burst of webhook events for one
tenant can never starve page loads or `jwtCallback`.

**Latency budget for locked sections:** lock wait ≤ 5 s (`SET LOCAL lock_timeout='5s'`), statements ≤ 10 s
(`statement_timeout`), each Stripe call `{ timeout: 5000, maxNetworkRetries: 0 }`. A locked section makes at most
3 Stripe calls (subscriptions list + open-invoices list + one retrieve/cancel), so it holds a pool connection
≤ ~20 s worst case. Invoice voiding
after a termination cancel happens **after commit, outside the lock** (it is idempotent), so it doesn't count.

**Verify in staging (not knowable from docs/types):** ACH initial-payment statuses (Terms §4.3); Neon's
`idle_in_transaction_session_timeout`; whether a portal card update retries an open invoice (not relied on);
what `subscriptions.list({customer})` returns for a **deleted** customer (the design doesn't depend on it — see §4.3 rule 4).

## 3. Invariants (must not break)
DCAA: append-only entries, reason codes, period lock, charge-code denormalization, period_events history.
Security: guard before any query, identity from session, tenant binding, no secrets exported, write gate.
Calendar-date model. Notices: never recorded as sent without a provider message id (a founder override is
recorded separately as `forced_at`, never as `sent_at`); never sent when
superseded; **the real deadline is never earlier than the date a notice stated**; the exact message sent is stored.
Exempt (F1) tenants are always visible, never hidden.

## 4. Billing / lifecycle state machine (LOCKED)

### 4.1 Facts
Control-plane `tenants` (existing): `status` (provisioning|active|suspended|deleting|deleted), `trial_ends_at`,
`stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `past_due_since`, `suspended_at`,
`subscription_ended_at`, `deletion_scheduled_for`, `deleted_at`. **NEW (additive):**
- `first_good_at timestamptz` — set the first time the tracked subscription is GOOD, never cleared.
- `current_period_end timestamptz` — from every Stripe read (drives reconcile).
- `suspension_reason varchar` (`nonpayment` | `policy`).
- `lifecycle_exempt boolean not null default false` (F1).
- `stripe_customer_deleted_at timestamptz` (the customer id is never nulled).
- `lifecycle_checked_at timestamptz` (cron rotation); `lifecycle_failures integer not null default 0`.
- `lifecycle_version integer not null default 0` — **the only concurrency guard**: every lifecycle UPDATE is
  `… WHERE id=$t AND lifecycle_version=$v` and sets `lifecycle_version = $v + 1`; zero rows → re-read and
  re-evaluate (never a silent no-op), **at most 3 times**, then skip (cron) / 503 (webhook) and raise an alert.
  **Every** writer of lifecycle facts — webhook, cron, notice delivery (D push), `tenant:admin` commands,
  checkout's customer replacement, `deleteTenant`, provisioning, backfills — takes
  `pg_advisory_xact_lock(hashtext('tenant:' || id))` and bumps `lifecycle_version`. Notices are enqueued only
  after the guarded UPDATE returned a row, in the same transaction. Timestamps are never compared for equality.

**Time rule:** every lifecycle timestamp is written from the injected JS `now` (never SQL `now()`), and JS
comparisons use `getTime()`.

**Deletion-date rule:** every writer that sets `deletion_scheduled_for` uses
`D = max(computed, now + DELETION_NOTICE_DAYS)` — a newly set deletion date is never in the past and always leaves
room for the 14-day notice (covers `set-exempt off` on an old demo, a late-enabled cron, a late-found
cancellation).
- Partial unique index on `stripe_customer_id` where not null.
- Stop writing `last_stripe_event_at`.

Backfill (migration or script, idempotent): `first_good_at = updated_at` for rows whose `subscription_status`
is GOOD or DUNNING; `suspension_reason = 'nonpayment'` for suspended rows with `past_due_since`, else `'policy'`.

One shared mapper `toLifecycleFacts(row)`; the registry's `TenantRecord` carries every field above. Used by
the registry, crons, webhook, `getDbForAuth`, `jwtCallback`, scripts.

Sets: `GOOD = {active, trialing}`; `DUNNING = {past_due, unpaid}`; `LIVE = GOOD ∪ DUNNING ∪ {paused}`.
`paused` is "can't happen" (no Stripe trials) → `full`, never starts grace, alert.
`hasSubscribed = first_good_at != null || subscription_ended_at != null || subscription_status ∈ LIVE`.
**Cycle anchor** A = `subscription_ended_at` if set, else `trial_ends_at`.

### 4.2 Access mode `getTenantAccess(facts, now)` — first match wins
| # | Condition | Mode |
|---|---|---|
| 1 | `status ∈ {provisioning, deleting, deleted}` | closed |
| 2 | `deletion_scheduled_for != null && now ≥ deletion_scheduled_for` | closed |
| 3 | `status = suspended` | `suspension_reason = 'policy'` → **policy_hold** (F5: hold screen for everyone, no billing, export only if `policy_export_allowed`); otherwise **billing_only** (non-payment: admins see billing + export) |
| 4 | `subscription_ended_at != null` | read_only |
| 5 | `subscription_status ∈ LIVE` | full |
| 6 | `lifecycle_exempt` | full |
| 7 | not `hasSubscribed` and `trial_ends_at != null` and `now < trial_ends_at` | full |
| 8 | not `hasSubscribed` and `trial_ends_at != null` and `now ≥ trial_ends_at` | read_only |
| 9 | not `hasSubscribed` and `trial_ends_at == null` | full (the cron raises a deduplicated "missing trial date" alert — data error, never silently free; `getTenantAccess` stays pure) |
| 10 | otherwise (default; e.g. `first_good_at` set, status canceled/incomplete, ended null — the cron repairs it) | read_only |

Trials end on schedule (F4): no reminder delivery gates the switch to read-only.

The app shows a visible **Demo** marker for exempt tenants.

### 4.3 Webhook (`src/app/api/stripe/webhook/route.ts`)
Common rules:
1. Verify the signature on the raw body first.
2. Resolve the tenant: `checkout.session.completed` by `session.metadata.slug`; everything else by
   `stripe_customer_id`. No tenant → 200 ignore. `status ∈ {provisioning, deleting, deleted}` → 200, but if
   Stripe shows a LIVE subscription for that customer → write an alert (below).
3. **Locked section** (one control-plane transaction; every statement uses the passed `tx`, never `controlDb`):
   `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='10s'`,
   `pg_advisory_xact_lock(hashtext('tenant:' || tenant_id))`, re-read the row — **if its
   `stripe_customer_id` no longer equals the event's customer (checkout replaced it), return 200 and ignore** —
   Stripe read (rule 4), write
   facts and enqueue notices, commit. Lock timeout → return **503** (Stripe retries; safe because every
   attempt re-reads Stripe).
4. **Stripe read and selection (never the mirror):** `subscriptions.list({customer, status:'all', limit:100})`;
   **whenever the tracked id is absent from the result (or the call fails with `resource_missing`) →
   `retrieve(stripe_subscription_id)`** and include it. A `resource_missing` from a customer-scoped list is treated as
   an empty list **only if** `stripe_customer_deleted_at` is set or `customers.retrieve` returns `deleted: true`;
   otherwise it is an error (e.g. wrong Stripe key or test/live mismatch) → fail and skip/stop, never "empty". (Covers deleted customers regardless of how Stripe
   lists them.)
   If `first_good_at` is set, `subscription_ended_at` is null and **nothing is LIVE**: apply the canceled row using
   the newest canceled subscription's `ended_at` (if none exists — e.g. `retrieve` also returns `resource_missing` —
   use `now` and raise an alert, never throw every run) (a lost `subscription.deleted` followed by a new checkout can't
   hide the old cancellation).
   tracked' = tracked if GOOD; else the newest GOOD; else tracked if LIVE; else the newest LIVE; else the
   newest `incomplete`; else tracked (or the newest,
   if nothing is tracked); none → bookkeeping only. **Always write `stripe_subscription_id = tracked'.id` and
   `current_period_end`.** More than one LIVE → alert "duplicate live subscriptions" (F3: founder cancels the
   duplicate with a prorated refund within 1 business day).
5. Every UPDATE includes `AND status IN ('active','suspended')`.
6. After commit: `invalidateTenant(slug)`; deliver enqueued notices with `after()`; delivery errors are
   swallowed (left for the cron) and never turn a webhook into a 500.

**Alerts** are persisted rows in a NEW control-plane table `ops_alerts (id, scope varchar not null (tenant id
or 'global'), tenant_id nullable, kind, dedup_key varchar not null default '', detail jsonb, first_seen_at, last_seen_at, occurrences,
resolved_at, resolution_note)` with a partial unique index on `(scope, kind, dedup_key) WHERE resolved_at IS NULL`
(plain columns, so Drizzle's `onConflictDoUpdate` can target it — **with `targetWhere: isNull(resolvedAt)`**, or
Postgres rejects the upsert with 42P10; the integration test raises the same alert twice);
raising an alert is an upsert (bump `last_seen_at`, `occurrences`). The cron auto-resolves condition-based
alerts when the condition clears (e.g. email enabled again, notice delivered, duplicate subscription gone);
`tenant:admin resolve-alert <id> --note` resolves manually. The founder digest reads unresolved alerts. Kinds (each with its auto-resolve condition where condition-based): duplicate live
subscriptions (resolves when ≤ 1 LIVE); `pending-payment` (resolves when no processing observation is > 10 days old);
`pending-invoice-void` (resolves when no open invoice remains on the subscription); tenant lifecycle failing (resolves
when the failure counter resets); LIVE subscription on a deleting/deleted tenant; checkout customer conflict; paused status;
`invoice.paid` on a non-LIVE subscription; missing trial date; undeliverable notice > 2 days; blocked
transition; cron incomplete run; Stripe cancel failure.

| Retrieved status of tracked' | Effect | Notice |
|---|---|---|
| GOOD | `subscription_status`, plan from price, `first_good_at = coalesce(first_good_at, now)`; clear `past_due_since, subscription_ended_at, deletion_scheduled_for`; if `suspension_reason ≠ 'policy'`: clear `suspended_at, suspension_reason`, `status='active'` | — |
| DUNNING, `subscription_ended_at` null | `subscription_status`; `first_good_at = coalesce(first_good_at, now)` (past_due implies it was active); `past_due_since = coalesce(past_due_since, now)` | `payment-failed` (A=P) |
| DUNNING, `subscription_ended_at` set | `subscription_status` only | — |
| `canceled`, `first_good_at` set, `subscription_ended_at` **set** (normal `subscription.deleted` after our own termination cancel, or a duplicate) | `subscription_status` only; never move E or D; no new notice | — |
| `canceled`, `first_good_at` set, `subscription_ended_at` null | `subscription_ended_at = S.ended_at`, `deletion_scheduled_for = ended_at + 90d`, clear `past_due_since`; if `suspension_reason ≠ 'policy'`: clear `suspended_at, suspension_reason`, `status='active'`; if `policy`: stays suspended (§9.2: no export window for a §6/§7 breach) + alert | `subscription-ended` (A=E) |
| `canceled` with `first_good_at` null, `incomplete`, `incomplete_expired` | `subscription_status` only (trial rules) | — |
| `paused` | `subscription_status`; alert | — |

Event-specific: `invoice.paid` / `invoice.payment_failed` with `invoice.subscription == null` → 200 ignore;
`invoice.paid` whose subscription is not LIVE → alert. `checkout.session.completed`: set `stripe_customer_id`
only `WHERE stripe_customer_id IS NULL OR stripe_customer_deleted_at IS NOT NULL` (clearing
`stripe_customer_deleted_at`; any other different non-null id → alert, no overwrite); `billing_email` from
`customer_details.email`; then common rules. `customer.updated`: `billing_email = customer.email` only if
non-null. `customer.deleted`: run the common rules first (rule 4 falls back to `retrieve`), then set
`stripe_customer_deleted_at … WHERE stripe_customer_id = $eventCustomer`; never null the id. `charge.dispute.*`: ignored (founder handles disputes in
Stripe). Subscribed events: `customer.subscription.created/updated/deleted`, `invoice.paid`,
`invoice.payment_failed`, `checkout.session.completed`, `customer.updated`, `customer.deleted`.
`cancel_at_period_end=true` stays `active` → full until the subscription ends (§17.2).

### 4.4 Daily cron (`src/app/api/cron/tenant-lifecycle/route.ts`)
`export const maxDuration = 800`. Candidates ordered by `lifecycle_checked_at` (oldest first, nulls first);
stop starting new tenants after 600 s; after the tenant's transaction (committed or rolled back), **one separate statement** writes
`lifecycle_checked_at = now` and `lifecycle_failures = failed ? lifecycle_failures + 1 : 0`, and — also outside the
rolled-back transaction — upserts the "tenant lifecycle failing" alert when the counter reaches 3 and auto-resolves
it when the counter resets. A lock-timeout skip counts as a failure (a tenant that is always contended must surface).
(a tenant that always throws can't starve the rest); record "incomplete run" as an
alert if stopped early. **Notice delivery has its own cron** `src/app/api/cron/notice-delivery/route.ts`, every **10 minutes**
(`vercel.json`; Pro), `maxDuration = 300`, CRON_SECRET fail-closed: it delivers every pending notice, throttled
to ≤ 8 sends/second (Resend allows 10/s per team). Within one claim, step 4 retries `429` and
`concurrent_idempotent_requests` with backoff (up to 3 tries, ≤ 20 s) before releasing. The lifecycle cron
also calls `deliverNotice` right after its own enqueues.
Exempt tenants skip lifecycle rules; the run summary (logged) and every digest list them.

Per tenant, inside the same locked-section rules as §4.3 (lock, timeouts, `tx` only, 503-equivalent = skip
and retry next run). **Reconcile reports `paymentProcessing`** = any **open invoice of the customer** whose
`payment_intent.status === 'processing'` — from `invoices.list({customer, status:'open', limit:100,
expand:['data.payment_intent']})` (not just `latest_invoice`: a dunning subscription keeps issuing renewal invoices,
and the customer may be paying an older one), **paginating while `has_more`**. An ACH payment in flight (Terms §4.3);
passed to `nextLifecycleActions`. "Processing" = `payment_intent.status === 'processing'`, **or**
`requires_action` **only** when `payment_intent.next_action?.type === 'verify_with_microdeposits'` and that invoice's
microdeposit observation is less than 10 days old (ACH bank verification; `PaymentIntents.d.ts:605,614`). Any other
`requires_action` (e.g. a card's 3D Secure the customer ignores) is **not** processing, so a non-payer can't stall
suspension forever.
**Observations are a dedicated fact, never an alert:** NEW control-plane table
`payment_pending_observations (tenant_id, invoice_id, kind ∈ {processing, microdeposit}, first_seen_at,
primary key (tenant_id, invoice_id, kind))`. Reconcile inserts `ON CONFLICT DO NOTHING` the first time it sees an
invoice in that state, and deletes the row only once the invoice is no longer open (paid/void/uncollectible) — so
the window is cumulative per invoice: restarting microdeposits, or resolving any alert, never resets it.
Observations are written in their own statement after the tenant transaction (a rollback can't drop them). With no
row yet, first-seen = now (defers; safe). The `pending-payment` alert is raised (and kept) only while an invoice is **processing now** and its
`processing` observation is older than 10 days; a `processing` row is deleted once that invoice's PaymentIntent is
no longer processing (so a later retry starts fresh and a failed ACH payment never raises a false alert). Alerts are
notifications only; resolving one has no effect on lifecycle state. **Bounds:** microdeposit deferral ≤ 10 days (+1
cron day; Stripe also expires unverified microdeposits); processing deferral is bounded only by Stripe settlement
(ACH ≤ ~4 business days; SEPA, if ever enabled, ≤ ~14) — the alert is the backstop and the founder's action is to
investigate in Stripe. Rows are deleted only after a successful, fully paginated listing; observation rows older than
10 days with no recent reconcile are re-checked with `invoices.retrieve`; a tenant's rows are deleted at the
deletion tombstone (step 6). Observation writes are exempt from the tenant advisory lock (insert-if-absent / delete
is order-safe). `deleteTenant` steps 3–5 also insert observations (same statement), so they work without the cron. The invoices list is always called; a
`resource_missing` response is treated as an empty list only under the same deleted-customer check as §4.3 rule 4
(so a deleted customer can never make reconcile fail forever, a misconfigured key never reads as "no invoices", and
a real processing payment is never hidden).
(`Invoice.payment_intent` exists on API `2025-02-24.acacia`, `Invoices.d.ts:346`; it is replaced by
`invoice.payments` in the later `basil` API — revisit on any SDK/API upgrade.)
1. **Reconcile** when the tenant has a Stripe customer AND any of: mirror DUNNING; mirror `incomplete`;
   customer set (and not deleted) but no tracked subscription; suspended for nonpayment; ended but Stripe not canceled; mirror GOOD
   with `current_period_end < now − 1 day`; `first_good_at` set with `subscription_ended_at` null and mirror not LIVE;
   `now ≥ D` (due for deletion); a `deletion-aborted` audit event since the last check. Reconcile = §4.3 rule 4 + transition table.
2. Evaluate pure `nextLifecycleActions(facts, notices, now)` on the reconciled facts. `sent(kind, A)` = a
   non-superseded row with `sent_at`.

| Phase | Rule | Action |
|---|---|---|
| Trial, not `hasSubscribed`, not exempt | `now ∈ [T−7d, T−1d)` | enqueue `trial-reminder-7d` (A=T) |
| | `now ∈ [T−1d, T)` | enqueue `trial-reminder-1d` (A=T) |
| | `now ≥ T` | enqueue `trial-ended` (A=T); if D null → `D = T + 90d` (deletion-date rule applies) |
| Dunning (**`status='active'`**, P set, not ended) | `now ≥ P+12d` | enqueue `suspension-warning` (A=P) |
| | warning sent at w, `now ≥ max(P+15d, w+3d)`, **no payment processing** | `status='suspended', suspended_at=now, suspension_reason='nonpayment'` (`WHERE … AND status='active' AND lifecycle_version=$v` — never re-suspends, never overwrites a `policy` reason); enqueue `suspended` (A=suspended_at) |
| Suspended, reason nonpayment | `suspended` sent, `now ≥ suspended_at+30d`, **no payment processing** (else defer; re-checked daily) | **terminate** (guard: `lifecycle_version`): `subscription_ended_at=now, D=now+90d`, clear P/suspended/reason, `status='active'`; enqueue `subscription-ended`. Then, **for each LIVE subscription, in its own locked section**: re-read the row (must still be ended), `retrieve` the subscription, (`retrieve` with `expand:['latest_invoice.payment_intent']` plus the open-invoices list filtered by
`invoice.subscription`) cancel it **only if it is DUNNING or paused and none of its open invoices has a payment
processing**; if it is GOOD, apply the GOOD transition in that same section (customer paid). After commit, void/mark-uncollectible the cancelled subscriptions' open invoices (idempotent); before voiding, raise an `ops_alerts` row `kind='pending-invoice-void'` (detail = subscription id) that the cron retries every run and resolves only when no open invoice remains. |
| Ended / trial-lapsed (anchor A, D set) | `now ≥ D−14d` | enqueue `deletion-notice` (A) |
| | `deletion-notice` sent at s and `D < s+14d` | `D = s+14d` (before the next rule) |
| | `now ≥ D−3d` and deletion-notice sent | enqueue `deletion-final-reminder` (A) |
| | `now ≥ D`, `sent('deletion-notice', A) ≤ D−14d` | `readyForDeletion` → digest (D4); the cron reconciles due tenants first and lists any with a GOOD/`incomplete`/processing subscription as "blocked: payment activity" instead (deletion step 4 is the authoritative gate) |
| Ended, Stripe still LIVE | — | retry cancel + void per subscription as above (decide from `retrieve`; `resource_missing`/canceled = success; GOOD = skip) |

Trial end (F4, on schedule): the trial ends at `trial_ends_at` whether or not a reminder was delivered;
after provisioning and the one-time backfill, `trial_ends_at` is changed only by `tenant:admin extend-trial` /
`end-trial`. A trial reminder still undeliverable
after 2 days — **or superseded at T without ever being delivered** — raises the deduplicated "undeliverable
trial reminder" alert so the founder can choose to `extend-trial`.
Transitions that wait on a notice never proceed without it (Terms §4.7 "after notice"); after 2 days
undeliverable → alert "blocked transition". `tenant:admin force-notice-sent <slug> <kind> --reason` (refuses if the notice row doesn't exist or is superseded) sets the notice's `forced_at`,
`forced_reason`, `forced_audit_id` (audit event) and unblocks; `sent(kind, A)` = `sent_at` **or** `forced_at`, and
the notice time used for the D push and the deletion precondition is `coalesce(sent_at, forced_at)`. Forced notices
are listed in every digest. If email is disabled in production/staging, the cron raises an alert every run and
logs a startup warning.

Founder digest (`OPS_ALERT_EMAIL`) is sent when there is anything to report: unresolved alerts, tenants ready
or overdue (`DELETION_SLA_DAYS`) for deletion, tenants sitting in `status='deleting'` (an abandoned run), notices
pending > 24 h, plus the exempt list. Its own send
checks `data?.id`; on failure it raises an alert and retries next run.

### 4.5 Notice outbox
`tenant_notices` gains (additive): `attempts int not null default 0`, `last_attempt_at`, `last_error text`,
`superseded_at`, `payload jsonb` (the frozen message: to, subject, html, stated facts), `payload_frozen_at`,
`first_attempt_at` (first send attempt of the current generation), `idempotency_generation int not null default 0`,
`forced_at`, `forced_reason`, `forced_audit_id`. Unique key `(tenant_id, kind, scheduled_for=A)`.
- **Enqueue** (inside the state transaction): `INSERT … (recipients '{}')
  ON CONFLICT (tenant_id, kind, scheduled_for) DO UPDATE SET superseded_at = NULL, payload = NULL,
  payload_frozen_at = NULL, forced_at = NULL, forced_reason = NULL, forced_audit_id = NULL,
  idempotency_generation = tenant_notices.idempotency_generation + 1
  WHERE tenant_notices.sent_at IS NULL AND tenant_notices.superseded_at IS NOT NULL` — revival also resets
  `first_attempt_at`, `attempts`, `last_error` (a superseded, never-sent row
  is revived with a fresh payload and key; a sent row is never touched).
- **Deliver(id)** — after commit; the supersede check and the send happen under the tenant lock so a
  concurrent recovery can't slip between them:
  1. Begin a locked section (tenant advisory lock, timeouts as §4.3). Claim: `UPDATE … SET attempts=attempts+1,
     last_attempt_at=now() WHERE id=$1 AND sent_at IS NULL AND forced_at IS NULL AND superseded_at IS NULL AND (last_attempt_at IS NULL
     OR last_attempt_at < now()-interval '10 minutes') RETURNING`.
  2. Supersede check on current facts → `superseded_at=now`, commit, stop: trial-reminder-N(T): `hasSubscribed`
     or exempt or `trial_ends_at≠T` or `now≥T` (7d also if `now≥T−1d`); trial-ended(T): `hasSubscribed` or exempt
     or `trial_ends_at≠T`; payment-failed/suspension-warning(P): `past_due_since≠P` or ended; suspended(Sa):
     `suspended_at≠Sa`; subscription-ended(E): `subscription_ended_at≠E`; deletion-notice/final(A): anchor ≠ A or
     D null; any kind: status deleting/deleted.
  3. **Freeze once:** if `payload` is null (or `first_attempt_at` older than 23 h → increment
     `idempotency_generation`, clear `first_attempt_at`, and re-freeze): for `deletion-notice` first set `D = max(D, now+14d)`; render from
     current facts (stated suspension date `max(P+15d, now+3d)`); resolve recipients (D10: active admins +
     `billing_email`, and the signup email whenever there is no active admin); store `payload`,
     `payload_frozen_at`. Commit (releases the lock and pool connection).
  4. Set `first_attempt_at = coalesce(first_attempt_at, now)`. Send exactly the frozen payload with
     `idempotencyKey = ${id}:${idempotency_generation}`, wrapped in
     `Promise.race` with a 10 s timer (Resend has no per-call timeout; a timed-out request is safe to retry with
     the same key). Only if `data?.id`: set `sent_at, provider_message_id, recipients`. `409
     concurrent_idempotent_requests` / `429` / network error → `last_error`, retry later. `409
     invalid_idempotent_request` → bug (payload changed under the same key) → alert. No recipients / email
     disabled → `last_error`.
  - Accepted window: between step 3's commit and step 4's send (≤ 10 s), a recovery can't un-send a frozen
    message; the next retry's supersede check catches anything not yet sent. Documented, not hidden.
- Digest ignores superseded rows; every "sent" predicate excludes superseded rows; forced rows are never
  claimed or sent and never count toward "pending > 24 h" / "undeliverable" alerts.
- Audit events (forced deletion, force-notice-sent, policy suspend/unsuspend, founder export taken/destroyed,
  exempt flag changes) go in a NEW control-plane table `tenant_audit_events (id, tenant_id, kind, detail text,
  actor text, created_at)`.

### 4.6 Failure modes → required behavior
| Failure | Behavior |
|---|---|
| Resend `{error}` / throws / 429 / concurrent 409 | pending + `last_error`; retried with the identical frozen payload |
| Crash/timeout after Resend accepted, before `sent_at` | the 10-minute delivery cron retries well within 23 h of the first attempt, reusing key + payload → no duplicate; only after 23 h of failures does a new generation start (possible duplicate, accepted) |
| Webhook race | advisory lock serializes read+write per tenant |
| Lock contention / slow Stripe | 5 s lock timeout → 503 → Stripe retries; Stripe calls 5 s, no SDK retries |
| Lost `invoice.paid` or `subscription.deleted` | daily reconcile (DUNNING, suspended, ended, GOOD past period end, canceled-not-ended) |
| `customer.deleted` before `subscription.deleted` | common rules run first via `retrieve`; id never nulled |
| Cron terminate vs GOOD webhook / customer pays the open invoice | lock + `lifecycle_version` serialize; each cancel re-reads the row and `retrieve`s the subscription in its own locked section; GOOD → never cancelled |
| Timestamp precision | no timestamp-equality guards; `lifecycle_version` only; JS `now` written everywhere |
| Stripe customer deleted | id kept + `stripe_customer_deleted_at`; checkout creates a new customer and replaces the id (audit); portal refused until then |
| Deletion vs webhook | `deleteTenant` uses the same lock and reconciles first; webhook UPDATEs require active/suspended |
| Payment after termination | open invoices voided at termination/deletion; any `invoice.paid` on a non-LIVE sub → alert |
| Duplicate live subscriptions | checkout blocked via Stripe list (LIVE or incomplete); webhook alert (F3) |
| Missed cron days / timeout | catch up; rotation by `lifecycle_checked_at`; incomplete-run alert; notice periods never shortened |
| Undeliverable notice / email disabled | dependent transition waits; alert after 2 days / every run |

## 5. Other fixes

### 5.1 Write gate
- `getDbForWrite(): Promise<WriteDb>` returns a branded type; `WriteTx` = a transaction opened on a `WriteDb`.
  Internal writers take `WriteDb | WriteTx`, so passing a read client is a compile error. `getDb()` returns a
  `ReadDb` type that **omits** `insert`/`update`/`delete`/`transaction`/`execute` (reads that need raw SQL use a
  narrow `readSql` helper), so writing through it doesn't compile; `getDbForAuth()` returns an `AuthDb` type
  permitting writes only for the allowlisted credential modules (the guard test remains as a second net).
- Convert: `assignments.ts` (both actions), `sync-engine.ts executeSyncOperation`,
  `internal/integrations.ts saveIntegrationConnection` (called by `src/app/api/integrations/complete/[provider]/route.ts`),
  connector writes (`quickbooks-online.ts`, `gusto.ts` methods, sync-record inserts), token refresh
  (`qbo-api.ts ensureValidToken`, `gusto-api.ts ensureValidGustoToken`) — obtain the write client **before**
  calling the provider's refresh endpoint so a rotated refresh token is never lost.
- Guard test: regex `\b(db|tx)\s*\.\s*(insert|update|delete)\s*\(` plus `execute(sql\`\s*(insert|update|delete)`;
  file-level rule for `src/server/internal/**` and `src/lib/integrations/**`: a file containing a write pattern
  must not call `getDb(` (allowlist: `internal/login-attempts.ts` uses `getDbForAuth`). Mutation-test it.
  Named out of scope: `src/lib/api-auth.ts` `lastUsedAt` bookkeeping.
- Locked-section rule (test): files implementing locked sections (`src/lib/billing/**`, lifecycle cron,
  `src/lib/tenant/notices.ts`, `deleteTenant`) never reference `controlDb` inside a function that receives `tx`.
- Tests assert **no write happened** (e.g. no `integration_connections` update), not just an error.

### 5.2 Export
- Builder `src/lib/export/workspace-export.ts`: takes an explicit postgres-js connection; no `headers()`,
  `getDb()`, session, or `next/*` imports. Used by the route and `tenant:export`.
- Snapshot: a per-request client on the tenant's **direct** host; `sql.reserve()`; `BEGIN ISOLATION LEVEL
  REPEATABLE READ READ ONLY`; reads are keyset-paginated by primary key (5,000 rows) and driven by an async
  generator; `COMMIT`; on error, `cancel()`, or `request.signal` abort → `ROLLBACK`, release, `end()` the client.
  Migration info via `to_regclass('drizzle.__drizzle_migrations')` first (a 42P01 must never abort the transaction).
- Stream: fflate `Zip` + `ZipDeflate`, one file at a time, pull-based `ReadableStream`;
  `export const maxDuration = 800` (Pro + Fluid; staging must be on Pro). Abort with an error before 65,535
  entries or 4 GiB (no Zip64); fallback is `tenant:export`.
- **On any error after headers: never call `zip.end()`; `controller.error(err)`; report to Sentry** — the archive
  then has no central directory and won't open. `manifest.json` (row counts) is written last.
- CSV: BOM; header `Papa.unparse([headers])`; every line ends `\r\n`; `escapeFormulae:
  /^[=+@\t\r]|^-(?!\d+(\.\d+)?$)/`; README documents the leading `'` prefix and each column's meaning
  (`ExportColumn.description`, asserted by the allowlist test). Select only allowlisted columns. Add `workspace_settings`.
- Tests: round-trip parse (`skipEmptyLines`) equals source with escaped cells as `'…`; DDE payload
  `-2+3+cmd|' /C calc'!A0` escaped; laziness (table queries happen only as chunks are pulled); mid-stream error
  yields a non-openable archive; client abort releases the connection; no secret column in any header.

### 5.3 Deletion (`scripts/delete-tenant.ts` → exported `deleteTenant({...})`, thin CLI)
Order; each step idempotent; resumable while `status='deleting'`:
1. Preconditions: `deletion_scheduled_for ≤ now` and a non-superseded `deletion-notice` for the **current anchor**
   sent ≥ 14 d before D (or `--force-with-reason`, recorded in `tenant_audit_events`). Refuse exempt tenants
   unless `--include-exempt`.
2. Classify the database from the decrypted URL (requires `ENCRYPTION_KEY`), **in this order** (in local development the control plane is also local, so a tenant whose host is
`localhost`/`127.0.0.1`/`[::1]` is classified **local** before the shared-project check):
   **shared-project** (endpoint host, minus `-pooler`, equals the control plane's) → refuse unless
   `--drop-shared-database` (then `DROP DATABASE` on the direct host, refusing if the name equals the control-plane
   DB; Neon history keeps it for the PITR window, which must be ≤ D11); **local** (`localhost`, `127.0.0.1`,
   `[::1]`); **dedicated Neon project** (`neon_project_id` set). Anything else → fail before any change.
3. Locked section (tenant advisory lock): reconcile (§4.3 rule 4) **and apply the §4.3 transition table to the
   reconciled facts in the same section** (so a GOOD subscription clears `subscription_ended_at` and D immediately).
   `deleteTenant`'s reconcile writes are allowed while `status='deleting'` — an explicit exception to §4.3 rule 5.
   **Abort if any subscription is GOOD or `incomplete`, or any open invoice has a payment processing**; **re-evaluate the
   step 1 preconditions on the reconciled facts** (D ≤ now, current-anchor deletion-notice sent ≥ 14 d before D,
   not exempt — reconcile can move the anchor and D); only then set `status='deleting'` (guard: `lifecycle_version`).
   **A resumed run re-executes steps 3–4.** **Every abort in steps 3, 4 or 5 while `status='deleting'` does the same
   restore** under the tenant lock: re-run step 3's reconcile + transition table (so a subscription that turned GOOD
   meanwhile clears end/D at once), set `status` back to `'active'` (or `'suspended'` when
   `suspension_reason='policy'`), version bump, audit event `deletion-aborted`, alert — and **commit** (an abort is
   a committed state change, never a thrown rollback that would discard the restore). A tenant is never left stuck in
   `deleting`.
4. Stripe (every run, including resumes): list all subscriptions, and the customer's open invoices with
   `expand:['data.payment_intent']` — applying the same deleted-customer rule as §4.3 rule 4: a `resource_missing`
   from either list is treated as empty only for a confirmed-deleted customer (subscriptions still `retrieve` the
   tracked id); otherwise stop. Steps 3–5 read the same `payment_pending_observations`. **If any subscription is GOOD or `incomplete`, or any open invoice has a payment
   processing, or an unresolved `pending-invoice-void` alert exists → stop before step 5** with the restore described above.
   Otherwise cancel every DUNNING/paused one and void/mark-uncollectible open invoices
   (`resource_missing`/canceled = ok). Other failure → stop (status stays `deleting`; re-run resumes).
5. **Immediately before the destructive call, repeat step 4's list as a preflight** (same abort rule).
   Delete the database. Neon: preflight `GET /projects/{id}` and `GET /projects/{id}/endpoints`; require an
   endpoint host to equal the tenant URL host (minus `-pooler`) and that it is NOT the control-plane's project;
   `DELETE`; confirm `GET` → 404 (on resume, a 404 without preflight is accepted). Local: drop the DB **named in
   the tenant URL** on that URL's host:port (refuse if it differs from the admin URL's or equals the
   control-plane/admin DB); `DROP DATABASE … WITH (FORCE)` (open pooled connections would otherwise block it);
   confirm via `pg_database`.
6. Tombstone (`status='deleted'`, `deleted_at`, `db_url_encrypted=null`) only after step 5 is confirmed.
   Receipt includes, if a founder export was taken, its destroy-by date (deletion + `BACKUP_RETENTION_DAYS`).

**Founder export (F2)** — `tenant:export -- <slug> <out-dir>`: not taken by default; when taken (customer
request or legal hold): refuses `deleted`; writes **AES-256 encrypted** output (OpenSSL-compatible
`aes-256-cbc` with PBKDF2-HMAC-SHA256, 600,000 iterations, random salt — decryptable with
`openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000`); password generated and printed once (never stored);
refuses an output path inside the repo, under `~/Documents`, `~/Desktop` (both sync when "Desktop & Documents in
iCloud" is on), `~/Library/Mobile Documents`, `~/Library/CloudStorage`, or any iCloud/Dropbox/OneDrive/Google
Drive folder; **runs** `tmutil addexclusion <dir>` and verifies with `tmutil isexcluded`, failing if it can't; deletes partial output and exits non-zero on error; records
`founder-export-taken` (path, destroy-by = export time + 30 d) in `tenant_audit_events`; at workspace deletion the
destroy-by date becomes `min(existing, deletion + 30 d)`. `tenant:admin export-destroyed <slug>
[--legal-hold "<reason>"]` records destruction (or a hold). The digest alerts when a taken export passes its
destroy-by date without a destroyed or legal-hold record. Runbook (TENANT-DELETION.md): never email the file
unencrypted; send via an expiring link with the password separately; destroy once delivered, and always by the
destroy-by date. Decrypt command spelled out: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <file> -out <file>.zip`.

Scripts run with `node --conditions=react-server --import tsx`: `tenant:delete`, `tenant:export`,
`tenant:admin`, `backfill:trial-dates`, `backfill:neon-project-ids`.

### 5.4 Seeder and test cleanup
One shared `clearTenantData(tx)` (used by `seedRichData` and `cleanupTestData`) in a transaction with
`SET LOCAL cadenzpoint.allow_entry_delete='on'`, clearing in FK order including `period_events`,
`integration_connections`, `pay_period_config`, `password_reset_tokens`, and resetting `workspace_settings`.
`seedRichData` refuses unless the DB is empty, every `users.email` ends in one of `@cadenzpoint.dev`,
`@bytime.dev`, or the seeder's domain, or `--wipe-demo-data` is passed. `seed-demo` accepts and forwards
`--wipe-demo-data`; `setup-local-demo.sh` passes it only for a localhost URL. The demo seeder sets
`lifecycle_exempt = true` (F1) and records an audit event. Tests: refuse path; wipe path; seed twice after
creating an integration connection and a period event.

### 5.5 DCAA and concurrency
- New tenant migration (generated `--custom`): `BEFORE TRUNCATE … FOR EACH STATEMENT` triggers on
  `timesheet_entries` and `period_events`.
- approve/reject: `UPDATE … WHERE id=$1 AND status='submitted' RETURNING`; resubmit:
  `status IN ('draft','rejected')`; zero rows → throw "This timesheet was just reviewed by someone else; refresh."
  inside the transaction (no `period_events` row).
- **Save vs submit:** both `saveTimesheetBatch` and `submitPeriod` take
  `pg_advisory_xact_lock(hashtext('timesheet:' || user_id))` in the tenant DB (per user, not per period — periods
  can overlap across a schedule change; contention is one user's own tabs). The whole save
  becomes **one transaction** (editability check, revision reads, inserts all on `tx`; `assertEntryDatesEditable`
  and revision helpers accept `tx`). Behavior change, intended: a save is all-or-nothing. A `23505` is caught
  outside the transaction and mapped to the existing conflict message; the first-submit insert race maps to a
  friendly error.

### 5.6 Founder tooling, crons, emails, billing UI, auth, R12
- `tenant:admin`: `extend-trial` (refuse if `hasSubscribed` or suspended; `trial_ends_at = max(now,
  trial_ends_at) + N`; clear D when never subscribed), `end-trial` (`trial_ends_at = now`), `suspend <slug> --reason`
  (policy; audit), `unsuspend <slug>`, `set-exempt <slug> on|off --reason` (audit; **on** also clears D and supersedes every pending notice, since
  closed (row 2) precedes exempt (row 6); **off** re-applies the deletion clock: an ended or trial-lapsed tenant
  gets `D = max(anchor + 90 d, now + 14 d)`), `force-notice-sent`,
  `export-destroyed`, `show` (all facts, notices, alerts, audit). All note the 60 s registry cache.
- Daily-reminder and submission-deadline crons: only tenants whose mode is `full`.
- Emails state their dates (frozen at first delivery): trial end; suspension date; termination date (D9);
  deletion date; export instructions.
- Billing: `startCheckout` refuses in `closed` mode or while `status='deleting'`, and refuses if Stripe lists any LIVE **or `incomplete`** subscription ("payment pending")
  → portal; creating the Stripe customer uses an idempotency key and `UPDATE … WHERE stripe_customer_id IS NULL
  RETURNING` (re-read on conflict). If `stripe_customer_deleted_at` is set: create a new customer (idempotency key
  includes the old id), then **under the tenant advisory lock** `UPDATE … SET stripe_customer_id=$new,
  stripe_customer_deleted_at=NULL, lifecycle_version=lifecycle_version+1 WHERE id=$t AND stripe_customer_id=$old`,
  audit the old id; the portal is refused while the customer is deleted. In DUNNING/suspended the billing wall shows **Pay outstanding balance**
  (`latest_invoice.hosted_invoice_url`) plus Manage billing. Subscribe is enabled for the current plan whenever
  nothing is LIVE or incomplete. PRODUCTION-DEPLOY 9.3: portal allows payment-method update, invoice history,
  cancel **at period end**, plan switch; 9.5: retries exhausted → leave past due.
- `jwtCallback`: after the tenant-binding check, compute the mode from the cached registry record (no extra
  query); `deleting`/`deleted` → return `null`; other closed → skip the DB check. `clientFor('')` throws; test
  asserts no client is constructed.
- R12: `startSignup` without `termsAccepted:true` rejected; with it, version + timestamp stored.
- **F5 (policy hold):** new fact `policy_export_allowed boolean not null default false` (control-plane migration 0006);
  `canExport(facts)` = not closed, and for `policy_hold` only when allowed; `getTenantForExport` throws
  `ExportNotAllowedError` → the export route returns **403**; `getTenantOrThrow`/`getTenantForWrite`/`getTenantForBilling`
  reject a policy hold; the app layout shows `PolicyHoldScreen` to every signed-in user (an admin also gets the export
  link when allowed). `tenant:admin suspend` sets `policy_export_allowed=false` and enqueues the `policy-suspended`
  notice (A = `suspended_at`; superseded once the hold ends or changes) in the same locked transaction, then delivers it;
  `unsuspend` resets the flag; `set-policy-export <slug> on|off --reason` (policy holds only; audit
  `policy-export-allowed` / `policy-export-blocked` with actor and reason).

## 6. Blast radius
`src/lib/tenant/{lifecycle,notices,registry,context}.ts`, `src/lib/billing/*`, webhook + 3 cron routes,
`src/server/actions/{billing,assignments,periods,timesheet,signup}.ts`, `src/lib/integrations/**`,
`src/server/internal/{integrations,periods}.ts`, `src/app/api/integrations/complete/[provider]/route.ts`,
`src/db/index.ts`, `src/auth.ts`, export route + `src/lib/export/*`, app shell (Demo marker),
`scripts/{delete-tenant,tenant-admin,backfill-*,seed-full,seed-demo}.ts`, `scripts/setup-local-demo.sh`, new
`scripts/tenant-export.ts`; control-plane migration (new columns, `ops_alerts`, `tenant_audit_events`,
`payment_pending_observations`, outbox columns, unique index, backfills) + tenant migration (TRUNCATE triggers); `src/__tests__/integration/helpers.ts`;
guard test; `package.json` scripts; `.env.example`; `PRODUCTION-DEPLOY.md` (9.2 events, 9.3, 9.5, staging on
Pro, backfills, rehearsal steps); `TENANT-DELETION.md`; export README. Existing `tenant_notices` rows from 10a71f9
use old anchors: pre-launch, truncate them in staging. Deploy runbook: before enabling the lifecycle cron, mark the
existing demo tenants exempt (`tenant:admin set-exempt … on`) or re-seed them.

## 7. Required test matrix (each fails without its fix)
- **Access (unit, table):** every row of §4.2, incl. converted past old trial; dunning day 1/14 = full; terminated
  = read_only; canceled after GOOD with null trial; canceled never-GOOD during trial = trial rules; past D =
  closed; incomplete during trial; paused; exempt; T null → full + alert.
- **Cron (unit + integration):** converted never gets trial notices; nearest trial reminder only; suspend waits
  for warning+3d; terminate waits for `suspended` sent; no re-suspension after termination; D push ≥ 14 d; ready
  only with a current-anchor notice; reconcile skips suspend/terminate when Stripe is `active`; lost
  `subscription.deleted` caught by reconcile; canceled-not-ended repair; blocked-transition alert; time budget
  stops cleanly and rotation resumes with the oldest; exempt tenants listed, untouched.
- **Webhook (unit with mocked Stripe + integration):** concurrent stale read commits last → final = latest read;
  same-second created/updated; S2 active before S1 deleted; two LIVE → alert row; untracked old sub ignored;
  `invoice.paid` restores; DUNNING after termination doesn't restart grace; policy suspension survives
  `invoice.paid` and a cancel; one-off invoice ignored; `invoice.paid` on canceled sub → alert;
  `customer.deleted` before `subscription.deleted` → read_only; checkout links by slug and never overwrites;
  `cancel_at_period_end` stays full then read_only; deleting tenant with LIVE sub → alert; lock timeout → 503;
  inline delivery failure doesn't 500; no `controlDb` use inside a locked section.
- **Outbox (integration):** `{error}`/throw/429/concurrent-409 → pending, retried with an identical body, then
  sent; never sent without provider id; idempotency key reused within 23 h, new generation after; concurrent
  deliver → one send; each supersede predicate (incl. deleting tenant, extend-trial, exempt); revived superseded
  row; stated deletion date ≥ sent_at + 14 d; D10 fallback when a billing email exists; digest send failure →
  alert.
- **Billing:** checkout refused while LIVE or incomplete; concurrent first checkouts create one customer; Pay-now
  link shown in dunning.
- **v12 low items (audit):** `pending-payment` auto-resolves once the invoice closes; no false alert after an ACH
  payment fails on an invoice that stays open; `deleteTenant` defers on a microdeposit invoice that has no row yet;
  integration cleanup resets `payment_pending_observations`.
- **v12 additions:** resolving the `pending-payment` alert does not restart the microdeposit window; re-initiated
  microdeposits on the same invoice keep the original window; observations survive a rolled-back tenant transaction
  and are deleted when the invoice closes; `resource_missing` with a non-deleted customer (bad key) fails instead of
  reading as empty; a lock-timeout skip increments `lifecycle_failures`.
- **v11 additions:** a card `requires_action` (3DS) older than the warning window does not defer suspension; ACH
  microdeposit `requires_action` defers for at most 10 days; deletion steps 4/5 treat `resource_missing` lists as
  empty and complete for a deleted customer; `lifecycle_failures` survives a rolled-back tenant transaction and its
  alert auto-resolves.
- **v10 additions:** a deleted Stripe customer at D reconciles (empty invoices list) and deletes; `has_more`
  pagination of open invoices; `requires_action` counts as processing; a tenant failing 3 cron runs in a row raises
  an alert and the counter resets on success; an abort in step 4/5 re-applies the transition table and commits the
  restore.
- **v9 additions:** ACH processing on a non-latest open invoice defers terminate and blocks deletion; a resumed
  deletion that finds a GOOD subscription in step 3 restores status (policy → suspended) and access becomes `full`
  immediately (end/D cleared in the same section); a resume with nothing blocking completes; payment processing
  > 10 days → alert; `deleting` tenants listed in the digest; `set-exempt off` on an ended tenant re-sets D;
  deletion blocked by an unresolved `pending-invoice-void`.
- **v8 additions:** suspend and terminate deferred while an ACH payment is processing; per-subscription cancel
  skipped while processing; a GOOD/incomplete/processing subscription appearing after `deleting` → no drop,
  `status` restored to active, alert; resumed deletion re-runs steps 3–4; preflight before the destructive call;
  revival resets attempt fields; `set-exempt on` clears D and supersedes notices; trial reminder superseded
  unsent → alert; `ops_alerts` with empty dedup key upserts; access table rows 9–10 restored.
- **v6 additions:** a newly set D is never in the past (`set-exempt off` on an old demo → D = now + 14 d);
  deletion aborts and `readyForDeletion` is withheld while a subscription is `incomplete` or a payment is
  processing; a forced notice is never sent later and doesn't trigger pending alerts; revival clears forced fields;
  invoice-void failure leaves a `pending-invoice-void` alert that is retried and resolved; deleted customer with no
  tracked subscription doesn't fail reconcile; same alert raised twice upserts.
- **v5 additions:** a suspended tenant is not re-suspended and `suspended_at` stays put (D9 still fires at +30 d);
  policy suspension in dunning keeps `reason=policy`; a GOOD duplicate is selected over a DUNNING tracked
  subscription and blocks deletion; `customer.deleted` for an old customer after checkout replaced it is ignored;
  `force-notice-sent` sets `forced_at` (never `sent_at`) and unblocks; `extend-trial` and a cron section serialize on the tenant lock
  (no lost update) and D stays null after the extension; version retries capped at 3 → alert; timed-out Resend
  call retried by the 10-minute delivery cron with the same key; lost `incomplete→active` caught by reconcile;
  `lifecycle_checked_at` set on failure; trial ends on schedule when no reminder could be delivered (alert raised, access read_only at T).
- **Concurrency/precision:** a µs-precision `past_due_since` written by SQL still suspends (version guard);
  version conflict re-reads and re-evaluates; terminate cancel skipped when the subscription became GOOD.
- **Stripe customer deleted:** delete customer → re-subscribe → ends `full`; portal refused meanwhile.
- **Webhook additions:** canceled-after-our-termination is a no-op; lost `subscription.deleted` + new incomplete
  checkout still records the old cancellation; DUNNING-first sets `first_good_at` (cancel gets the export window);
  paused → alert; checkout customer conflict → alert.
- **Cron additions:** termination cancels + voids, failure → alert + retry, `resource_missing` = success;
  deletion-final-reminder; lost `invoice.payment_failed` caught by stale `current_period_end`; email disabled →
  one deduplicated alert, auto-resolved when re-enabled; `force-notice-sent` unblocks; overdue-for-deletion digest;
  undeliverable trial reminder → alert, trial still ends at T; `resolve-alert`.
- **Outbox additions:** `409 invalid_idempotent_request` → alert; revived row gets a new payload and key; stated
  deletion date ≥ `payload_frozen_at` + 14 d AND real D ≥ `sent_at` + 14 d; Resend timeout path.
- **Deletion (local/integration, `deleteTenant`):** classification order (shared refused without flag; local;
  dedicated; unknown fails before any change); refusals (D in future; no notice; old-anchor notice; exempt);
  preconditions re-checked after reconcile; Stripe failure leaves `deleting` and a re-run resumes; tombstone only
  after confirmed delete; Neon preflight host mismatch refused; `WITH (FORCE)` drop with an open connection.
- **Founder export:** encrypted output decrypts with the documented openssl command; refuses repo/Documents/
  Desktop/cloud paths; Time Machine exclusion verified; destroy-by alert (export-time + 30 d, tightened at deletion).
- **Write gate / seeder / DCAA:** each named test in §5.1–§5.5, plus: writing through `ReadDb` fails to compile
  (type test); first-submit vs save race; all-or-nothing save; deletion vs GOOD webhook race; policy
  suspend/unsuspend; Demo marker shown for exempt tenants.

## 8. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety
# product owner's machine:
TZ=America/New_York TEST_DATABASE_URL=… TEST_DATABASE_URL_2=… CONTROL_PLANE_DATABASE_URL=… npm run test:integration
npm run build
npm run demo:local && npm run demo:local
```
**Staging rehearsal** (Phase 12): Stripe test mode + Stripe CLI; shift dates with `tenant:admin` (our clock is
wall time, so Stripe test clocks don't move our deadlines); exercise trial → convert → card fails → warning →
suspend → pay-now → restored; cancel at period end → read-only → export → deletion notice → `tenant:delete` on a
throwaway tenant; `customer.deleted` from the dashboard; download a >50 MB export through Vercel; confirm ACH
statuses and Neon's idle-in-transaction timeout.
