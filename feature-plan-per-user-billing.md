# Per-user billing (build queue 3a)

> **Status:** **FINAL v3.7**, 2026-11-15, lead architect. **Pre-mortem CLEAN** (confirmation pass 7: no HIGH or MEDIUM; its 11 LOWs are written in). **Accepted by the product owner on 2026-11-15, with Q1–Q11 all as recommended** (§2). Ready for the dev.
> - Pre-mortem round 1 (3 HIGH, 11 MEDIUM) is fixed in v2.
> - Round 2 (10 MEDIUM) is fixed in v3, including a simpler quantity-sync design (§15).
> - Confirmation pass 1 (5 distinct MEDIUM) is fixed in v3.1.
> - Confirmation pass 2 (1 MEDIUM) is fixed in v3.2.
> - Confirmation pass 3 (4 MEDIUM, all in invoiced dunning) is fixed in v3.3 by a simpler model: invoiced grace follows the invoices' due dates.
> - Confirmation pass 4 (2 HIGH, 1 MEDIUM, in the invoiced precedence) is fixed in v3.4 with explicit pseudo-code.
> - Confirmation pass 5 (1 MEDIUM) is fixed in v3.5.
> - Confirmation pass 6 (1 MEDIUM) is fixed in v3.6.
> - Confirmation pass 7: **CLEAN**.
>
> **Branch:** `per-user-billing`, from `main` at `f958be9` (after Upstash, PR #31). The §3 references were checked there.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §1 (Decided 2026-11-10): per-user pricing, the customer-facing strings, the Stripe configuration, billing rules 1–9.
> - `LAUNCH-TRACKER.md` build queue 3a, approved 2026-11-11. Decisions log 2026-11-11: "Part 2b split: Integrations + Landing now; Billing moves to a new per-user billing blueprint". The landing Pricing section waits for this item (`feature-plan-ux-integrations-billing.md` L2).
> - The approved Billing page design: `ux-mockups/ux4-batch2b.html`, screen Billing (`UX-4-AUDIT.md` §10, "approved as is"; prices were business placeholders).
> - Terms of Service §4.1–4.3, §4.7, §4.8 (`business/legal/terms-of-service.md:72-104`):
>   - per-user fees with a monthly minimum;
>   - prorated added users;
>   - card or ACH;
>   - annual invoices net 30;
>   - "If a payment fails or an invoice is unpaid when due, we will notify your administrators by email", then 15 days of grace;
>   - fees are non-refundable.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

Replace the flat Starter / Pro / Enterprise tiers with the per-user model in `BUSINESS-DECISIONS.md` §1:

1. **Plans:**
   - Trial: 10 users.
   - Standard monthly and Standard annual: up to 100 users, on one Stripe Product with two graduated tiered Prices.
   - Enterprise: no limit; the founder creates these by hand.
2. **Seat cap:** user 101 on Standard is refused with the exact business message.
3. **Quantity sync:** the Stripe subscription quantity follows the count of active users. It rises at once with prorations (rule 3) and comes down at renewal (rule 4, Q1). A daily check corrects drift and reports corrections in the founder digest.
4. **Checkout:** server-set quantity, card **and** ACH, promotion codes allowed.
5. **Send-invoice subscriptions** (founder-made, net 30) follow the same lifecycle, with the 15-day grace counted from the invoice due date. The founder gets a supported way to attach them to a workspace.
6. **The Billing page redesign** (the approved mockup, adapted to per-user plans), the Users page seat wording, and the **landing Pricing section**.

**Out of scope:**
- Stripe Tax (a founder and accountant item).
- Self-serve Enterprise.
- Self-serve switching between monthly and annual (Q2).
- Usage-based billing.
- Any change to the trial length or to the grace, suspension or deletion periods.
- Any change to what deactivation does to a user's records.

## 2. Questions for the product owner

Each question carries the lead's recommendation. The blueprint is written to the recommendation; a different answer changes only the named section.

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **When removed users leave the bill.** Rule 2 says to update the Stripe quantity whenever a user is deactivated. Rule 4 says removals take effect at the next renewal, with no mid-term credit. Lowering Stripe's quantity at once means a user re-added later in the same term is charged again: an annual customer who swaps one contractor for another in month 3 pays for that seat twice for months 3–12. | **Hold, then drop before renewal.** During a term the Stripe quantity only goes up. In the last day before renewal it comes down to the real count, so the renewal bills the active users. A re-added user costs nothing within the term, except after the drop in the last day, when it's prorated for the hours left (cents; on an invoiced subscription that's a small separate invoice). The Billing page says "Billed for {q} users until {date}" while the quantity is held above the count. | §6.4, §6.10 |
| Q2 | **Switching between monthly and annual.** Should customers switch themselves in **Manage billing** (Stripe's portal)? If they can, an annual→monthly switch credits the unused part of a non-refundable annual fee (Terms §4.8). Making the switch wait for the period end attaches a Stripe "schedule" that would reset the user count at renewal. | **Not self-serve at launch.** The portal keeps payment method, invoices and cancel-at-period-end only. A customer who wants to switch emails support, and the founder does it in the Stripe Dashboard at the period end (§12 runbook). | §6.8, §12 |
| Q3 | **How a workspace becomes Enterprise.** The founder creates Enterprise subscriptions by hand, possibly on a custom price. How does the app learn there's no user limit? | A founder command **`tenant:admin set-plan <slug> enterprise --yes`** (audited; `standard` undoes it). The app never overwrites it. The quantity sync touches **only** subscriptions on the two Standard prices, never a custom price. | §6.2, §6.4 |
| Q4 | **Overdue invoice email.** For an invoiced (send-invoice) customer, today's "Payment failed" email says "We couldn't process the latest payment". That's wrong: nothing was charged. | **An invoiced variant:** subject "Invoice overdue for {workspace}", body "The invoice for **{workspace}** is past due. Your workspace is still fully active. If payment isn't received, it will be suspended on or after **{date}**, after a further reminder.", button "Pay the invoice" (it opens the Billing page; Stripe's own invoice email holds the direct payment link for a payer who isn't a workspace user). It's sent when an invoice passes its due date unpaid, even if Stripe still shows the subscription active (§6.2). | §6.7 |
| Q5 | **When the quantity reaches Stripe.** Every user change could hit Stripe at once, but Stripe allows at most 20 invoices per subscription per day, and annual customers would get an emailed invoice per user added. | **Within 10 minutes, batched:** changes made close together become one Stripe update, and one invoice for annual. Side effect: a user removed in roughly the last 15 minutes before a renewal (the 10-minute cadence plus a 5-minute safety margin) is billed for the next term. | §6.5 |
| Q6 | **Payment that fails while the subscription stays active.** With ACH, Stripe can activate a subscription while the bank payment is still clearing. If the bank later rejects it, Stripe voids the invoice and the subscription stays active, unpaid. Terms §4.7 promises admins an email when a payment fails. | **Email the admins** (a new notice: subject "Payment not received for {workspace}", body "The latest payment for **{workspace}** didn't go through. Please update your payment method in Billing, or contact support@cadenzpoint.com.", button "Go to Billing") **and** alert the founder in the digest. A voided amount is lost unless the founder re-invoices it in Stripe. | §6.9 |
| Q7 | **New on-screen wording:** the Billing page tiles and buttons, the landing Pricing heading and its "Up to 100 users" line, and the 100-user message also used by bulk import. | Accept the strings in §6.10 and §6.11. The business's §1 strings are used exactly. | §6.10, §6.11 |
| Q8 | **The Users page calls paid users "free seats".** Today it says "7 active · 93 of 100 seats free" and "Uses 1 of 93 free seats". On Standard each user above 5 costs money. | Standard: **"7 active · up to 100"**, with no line in the Add user drawer. Enterprise: "7 active". Trial: unchanged. | §6.12 |
| Q9 | **`FOUNDING` and annual billing.** The code is "20% off ($8 / user / month)". Should it also apply to the annual price ($6.80 / user / month for two annual invoices)? | **Ask the business side.** The founder sets this in Stripe (the coupon's "applies to products/prices"); no code depends on it. | §12 |
| Q10 | **Users added during payment grace.** While an account is overdue (a failed charge, or an invoice past its due date), the app doesn't change its quantity (an update would raise more invoices on an account that isn't paying). Users added during the grace are billed from the day payment recovers, not the day they were added. Likewise, users removed before a renewal that falls during the grace stay on that renewal (the drop happens only on an active subscription). | **Accept.** It's a small under-charge on accounts that are already late, and it keeps the dunning simple. | §6.4, F6 |
| Q11 | **Failed payment on an invoiced subscription.** Terms §4.7: "If a payment fails or an invoice is unpaid when due, we will notify your administrators by email." An invoiced payer can try a card or bank payment on Stripe's invoice page before the due date, and it can fail. | **Email the admins** with the Q6 notice in that case too (one email per failed invoice). The text "Please update your payment method in Billing, or contact support@cadenzpoint.com." still fits: invoiced customers pay through the invoice link or contact support. Stripe documents `invoice.payment_failed` as firing "whenever an invoice payment attempt fails"; staging confirms it for hosted-page attempts (§12). If it doesn't fire there, the lead brings you a follow-up before launch. | §6.9 |

## 3. Verified current state (2026-11-15, `main` at `f958be9`)

### 3.1 Plans and seat limits
- `src/lib/billing/plans.ts:1-16`:
  - `PlanKey = 'trial' | 'starter' | 'pro' | 'enterprise'`;
  - `PLANS` maps each key to `{ label, priceId, seatLimit }`: Trial 10, Starter 25, Pro 100, Enterprise unlimited, with price IDs from `STRIPE_PRICE_STARTER` / `_PRO` / `_ENTERPRISE`;
  - `planForPriceId` maps an unknown price to `'trial'`.
- `src/server/internal/seats.ts:16-44`:
  - `getSeatUsage` takes the limit from the **cached registry** `tenant.plan` (`getTenantOrThrow`, which throws in `billing_only`, `src/lib/tenant/context.ts:49`) and counts `users.is_active = true`;
  - `assertSeatsAvailable(n, tx)` throws `Your ${planLabel} plan allows ${limit} active users (you currently have ${n}). This would add ${m} more. Upgrade in Billing to add more.`
- Callers of `assertSeatsAvailable`. Each runs inside its transaction **after `lockUserRulesExclusive(tx)`**, so concurrent adds can't pass the cap:
  - `updateUser` reactivation (`src/server/actions/users.ts:191`);
  - `createUserWithPassword` (`:330`);
  - `bulkImportEmployees` (`src/server/actions/import.ts:162`).
- The Users page seat line:
  - `UsersClient.tsx:214` (`freeSeats`), `:488` ("{n} active · {free} of {limit} seats free"), `:625` ("Uses 1 of {free} free seats");
  - pinned by `src/__tests__/unit/users-admin-page.test.tsx:70,134`;
  - the data comes from `getSeatUsage` (`admin/users/page.tsx:18`).

### 3.2 Writers of `users.is_active` and new users (the quantity triggers)
The static test `src/__tests__/unit/user-rules-lock.test.ts:16-22` enumerates the writers of `users.role`, `is_active` and `approver_id`.

| Writer | File | Changes the billable count? |
|---|---|---|
| `updateUser` | `src/server/actions/users.ts:116` | yes, when `isActive` changes (logged at `:271`) |
| `createUserWithPassword` | `users.ts:303` | yes (+1) |
| `setUserApprover` | `users.ts:362` | no |
| `bulkImportEmployees` | `src/server/actions/import.ts` (transaction at `:155`) | yes (+created) |
| `provisionTenant` | `src/lib/tenant/provision.ts:91` | first admin of a new trial workspace; no subscription |

Also checked:
- These scripts create users: `scripts/seed-users.ts:40-45`, `scripts/seed-full.ts:92`, `scripts/seed-tenant.ts:92` and `scripts/provision-customer-db.ts:29`. They write either local/demo workspaces or a first admin, and none of those has a Stripe subscription.
- `src/auth.ts:124,145`, `password.ts`, `password-reset.ts` and `mfa.ts` update other user columns, not `is_active`.

### 3.3 Checkout, portal and billing info (`src/server/actions/billing.ts`)
- **`startCheckout(plan)`** (`:27-62`):
  - runs `requireAdminFresh`, then `getTenantForBilling`;
  - refuses closed and policy-held workspaces;
  - calls `ensureStripeCustomer`, then an authoritative Stripe duplicate check (`BLOCKS_NEW_CHECKOUT`: LIVE or `incomplete`);
  - creates the session with `line_items: [{ price, quantity: 1 }]`, with no `payment_method_types` (Dashboard default; card today) and no `allow_promotion_codes`.
- **`ensureStripeCustomer`** (`src/lib/billing/tenant-billing.ts:14-43`) is the **only** way a workspace gets a Stripe customer, and only checkout calls it. `tenant:admin` (`scripts/tenant-admin.ts:173-255`) has no customer command.
- **`openBillingPortal()`** (`:64-78`) uses the Dashboard's default portal configuration.
- **`getTenantBillingInfo()`** (`:107-141`):
  - reads the control-plane row only;
  - `payUrl` comes from the latest invoice when the subscription is DUNNING or suspended for non-payment.
  - It runs in `billing_only` from `BillingWall` (`src/app/(app)/BillingWall.tsx:15-16`; the comment at `:7-13` says "getDb() rejects `billing_only`").

### 3.4 Webhook and the lifecycle state machine
- **Webhook** (`src/app/api/stripe/webhook/route.ts`):
  - events: `SUBSCRIPTION_EVENTS` (`:21-29`) and `customer.updated`;
  - checkout events find the tenant by `metadata.slug` (`:72-78`), every other event by customer id (`:79-90`);
  - **an unknown customer is ignored silently** (`:94`);
  - every event re-reads Stripe under `withTenantLock` and runs `reconcileInLock` (`:100-161`).
- **`src/lib/billing/stripe-state.ts`:**
  - `toSnapshot` (`:18-30`) keeps the id, status, created, endedAt, `current_period_end` and plan (from the first item's price; unknown means `null`, i.e. "leave as is");
  - `IN_LOCK = { timeout: 5000, maxNetworkRetries: 0 }` (`:12`);
  - `readCustomerSubscriptions` (`:53-76`);
  - `readOpenInvoices` (`:88-115`, expands `data.payment_intent`);
  - `retrieveSubscription` (`:131-138`, with no expand; also used by `lifecycle-runner.ts:326` and `delete-tenant.ts:303`).
- **`src/lib/billing/subscription-transitions.ts`:**
  - `selectTracked` (`:32-48`);
  - `computeSubscriptionTransition` (`:73-142`): GOOD writes `plan` if mapped (`:108`); **DUNNING sets `pastDueSince = f.pastDueSince ?? now`** (`:121-128`) and enqueues the `payment-failed` notice with that anchor.
- **`src/lib/tenant/lifecycle.ts`:**
  - `shouldReconcile` (`:220-234`) re-reads a GOOD mirror only when `currentPeriodEnd < now − 1 day`;
  - suspension (`:323-335`) happens at `pastDueSince + 15` (`lifecycle-config.ts:118-121`: "Counted from `past_due_since`: the first failed charge, or the due date of an unpaid invoice"), after the `suspension-warning` notice, and never while a payment is processing;
  - `isNoticeSuperseded` (`:178-205`) has a `default: false`.
- **`src/lib/billing/reconcile.ts:26-72`** is the shared in-lock applier.
- **Notices** (`src/lib/tenant/notices.ts`):
  - `enqueueNotice` (`:47-61`) is unique per `(tenant, kind, scheduled_for)`;
  - `payment-failed` renders at `:113-117` with `src/lib/email/templates/payment-failed.tsx`;
  - recipients and time zone come from the row's own tenant DB via `getDbForUrl(decrypt(row.dbUrlEncrypted))` (`:71-88`).
- **`tenants` row** (`src/db/control-plane/schema.ts:12-72`): `plan varchar(40) default 'trial'`, the Stripe ids and the lifecycle facts. Every lifecycle write goes through `updateTenantGuarded` (with the `lifecycle_version` guard).
- **`withTenantLock`** (`src/db/control-plane/locked.ts:57-72`): `pg_advisory_xact_lock(hashtext('tenant:'||id))` on a dedicated 3-connection pool (`:21`), with `lock_timeout` 5 s and `statement_timeout` 10 s.

### 3.5 Crons, the digest, tenant DB clients
- **`vercel.json` has 4 crons:**
  - `daily-reminder`;
  - `submission-deadline`;
  - `tenant-lifecycle` (13:00 UTC; maxDuration 800, start budget 600 s);
  - `notice-delivery` (`*/10`).
- **Heartbeat registry:** `src/lib/cron/heartbeat.ts:14-31`. `cron-ops.test.ts:106` checks `vercel.json` against the schedules.
- **`sendOpsDigest`** (`src/lib/tenant/ops-digest.ts:73-…`) lists unresolved `ops_alerts` and more; it is always sent.
- **`raiseAlertWithEmail`** (`src/lib/tenant/ops-alert-email.ts:14`) emails immediately. `raiseAlert` (`lifecycle-store`) only shows in the digest.
- **Tenant DB from a cron:** `getDbForUrl(decrypt(tenant.dbUrlEncrypted!))` (`src/app/api/cron/daily-reminder/route.ts:80`). `clientFor` (`src/db/index.ts:27-41`) uses `connect_timeout: 10` and has no statement timeout.

### 3.6 UI and copy
- **Billing page:** `src/app/(app)/settings/billing/page.tsx` and `BillingClient.tsx:1-164`:
  - plan label, "Up to N active users", raw status badge, a card per plan;
  - `sectionOrder = headerOrder + 1` (`:35`);
  - `BillingWall` renders it with `headerOrder={2}`.
- **Landing:** `src/app/page.tsx`:
  - header comment `:50`: "No Pricing yet (it arrives with per-user billing)";
  - the Features section is at `:116-132`;
  - the business-owned copy lives in `src/lib/marketing/landing-copy.ts`.
- **Demo workspaces:** `lifecycle_exempt`, `plan 'trial'`, `trial_ends_at` NULL (`scripts/register-tenant.ts:29-30`).

### 3.7 Configuration and docs
- `.env.example:133-135`: `STRIPE_PRICE_STARTER` / `_PRO` / `_ENTERPRISE`.
- `PRODUCTION-DEPLOY.md`:
  - env table `:329`;
  - Phase 9.1, 9.2 ("select exactly these eight"), 9.3 ("plan switching between your three prices"), 9.5, and the 9.x "✅ Check … three price IDs" line;
  - staging 12.8 and 12.8b.
- `DEPLOY-DEMO.md` Part 10 (`STRIPE_PRICE_*`).

### 3.8 Tests that name the old plans or the changed functions
`src/__tests__/`:
- `unit/billing-ui.test.tsx:49-52,90-100`;
- `unit/auth-landmarks.test.tsx:41`;
- `unit/subscription-transitions.test.ts:12`;
- `unit/users-admin-page.test.tsx:70,134`;
- `unit/users-admin-actions.test.ts:50` (mocks `@/server/internal/seats`);
- `unit/server-action-guards.test.ts:125` (the `getTenantBillingInfo` allowlist reason);
- `unit/cron-ops.test.ts:106`;
- `integration/billing-checkout.test.ts:4-5,51-117`;
- `integration/authorization.test.ts:245`;
- `integration/bulk-import-seat-limit.test.ts:34`;
- `integration/lifecycle-helpers.ts:72-79` and `integration/provision.test.ts:28` (both delete `tenants` rows);
- `server/tenant-resolution.test.ts:37-42`;
- `unit/action-result.test.ts:11,66-72` (calls `assertSeatsAvailable(1, executor)`).

**Suites that call the seat-taking actions** (`createUserWithPassword`, `updateUser`, `bulkImportEmployees`) and today mock `@/lib/tenant/context` with a `plan`. Several use a non-UUID tenant id (`'test-tenant-id'`: `users-ux4c.test.ts:27`, `no-secrets-leaked.test.ts:26`, `mass-assignment.test.ts:33`, `duplicates-and-import-errors.test.ts:37`).
- **Integration:**
  - `approval-scope`, `approver-rules`, `authorization`;
  - `bulk-import-seat-limit`, `duplicates-and-import-errors`, `mass-assignment`, `no-secrets-leaked`;
  - `setup-import`, `user-rules-lock`, `users-ux4c`.
- **Unit:**
  - `admin-change-log-writer`, `approval-decisions`, `guard-first-oracle`;
  - `import-page`, `import-row-errors`, `setup-import-rules`;
  - `update-user-role-and-active`, `user-rules-lock`;
  - `users-admin-actions`, `users-admin-page`, `users-row-actions`.
- A real `readPlanFresh` or `markSeatSyncDue` in these suites would fail: a uuid error, no control plane, or a missing row. They get the seam in §10.1.

The fake Stripe (`integration/fakes/fake-stripe.ts`) has no `subscriptions.update`, no items, no invoice `due_date`, and no params capture. Its `op()` throws before any state change.

## 4. External behaviour (verified from source)

Stripe SDK `stripe@17.7.0`, API `2025-02-24.acacia` (`node_modules/stripe/types/lib.d.ts:30`); docs fetched 2026-11-15. "Test-mode check" items are proven at staging (§12), never assumed.

### 4.1 Subscriptions and prorations
1. **Graduated tiers:** each tier's `quantity × unit + flat` is summed, and tier 1's flat amount is always billed (docs.stripe.com/subscriptions/pricing-models/tiered-pricing).
2. **Prorations** are time-based, to the second (docs.stripe.com/billing/subscriptions/prorations).
   - At this API version subscriptions use **classic** billing mode: the SDK has no `billing_mode`. Prorations are computed from the quantity before and after each change. §6.4 never lowers the quantity mid-term, so no credit is ever created. Never set `billing_mode: flexible`.
   - *Test-mode check:* whether a change inside the flat tier with `always_invoice` emits a $0 invoice. §6.4 never asks Stripe to prorate inside the flat tier.
3. **`proration_behavior`:** `'always_invoice' | 'create_prorations' | 'none'`, default `create_prorations` (`types/SubscriptionsResource.d.ts:1018,1705`).
   - `create_prorations` leaves the items for the next invoice.
   - `always_invoice` invoices now.
   - `none`: "customers are billed the full amount at the new price when the next invoice is generated". A decrease gives no credit and the next renewal bills fewer; an increase costs nothing now and bills more from the next renewal.
4. **`payment_behavior`:** default `allow_incomplete`. With `always_invoice` on `charge_automatically`, a failed payment means "the subscription change request succeeds and the subscription transitions to `past_due`" (docs.stripe.com/billing/subscriptions/change-price#immediate-payment).
   - `pending_if_incomplete` doesn't support `us_bank_account` or `send_invoice` (docs.stripe.com/billing/subscriptions/pending-updates), so it isn't used.
   - **Upgrade invoices have `auto_advance` off "from the outset"**, and `auto_advance=false` prevents "emailing the invoice" (docs.stripe.com/billing/invoices/subscription). So on a send-invoice subscription the app sends the proration invoice itself (§6.4 step 8), and charge-automatically upgrade invoices get no Smart Retries.
   - *Test-mode checks:*
     - whether a send-invoice proration invoice is `draft` or `open` after the update;
     - what Stripe's status does when such an invoice (`auto_advance: false`) becomes overdue. The app no longer depends on it: invoiced dunning follows due dates (§6.2).
   - **Status resolution:** with Stripe's default, "Stripe uses the most recent non-voided invoice. Other outstanding invoices don't prevent the subscription from becoming `active`" (docs.stripe.com/billing/subscriptions/overview). That's why invoiced dunning reads the invoices themselves (§6.2).
5. **Quantity update:** `subscriptions.update(id, { items: [{ id: itemId, quantity }], proration_behavior, payment_behavior, expand })` (`SubscriptionsResource.d.ts:1265,1290`). Without the item `id` a new item is added.
   - `incomplete` "can only have metadata and default_source updated", and `canceled` is terminal (`types/Subscriptions.d.ts:210-222`).
   - *Test-mode check:* quantity updates on `past_due`. §6.4 syncs `past_due` only for an invoiced subscription with nothing overdue.
6. **Fields at acacia:**
   - `subscription.current_period_start` and `current_period_end` (`Subscriptions.d.ts:90,95`; basil moved them to items);
   - `items.data[].quantity?` (`SubscriptionItems.d.ts:90`) and `.price.id`, `.price.recurring.interval` (`Prices.d.ts:37,109,251`);
   - `collection_method` (`Subscriptions.d.ts:75`), `days_until_due` (`:105`), `cancel_at_period_end`, `latest_invoice` (a string unless expanded);
   - `invoice.due_date: number | null` (`types/Invoices.d.ts:259`), `invoice.status`, `invoice.billing_reason`;
   - `invoices.finalizeInvoice` and `invoices.sendInvoice` (`InvoicesResource.d.ts`).
7. **Concurrency:** concurrent mutations of one object return 429 `code: 'lock_timeout'`, unprocessed. The SDK throws `StripeRateLimitError` with `code === 'lock_timeout'` (docs.stripe.com/rate-limits#object-lock-timeouts; `esm/RequestSender.js:98-99`). Stripe advises: "make sure that mutations on the same object are queued up and run sequentially."
8. **Rate limits** (docs.stripe.com/rate-limits):
   - "10 new invoices per subscription, per minute; 20 new invoices per subscription, per day; 200 quantity updates per subscription, per hour";
   - global 100 requests/s live, 25 in test.
9. **Errors:**
   - the SDK **throws** (`esm/RequestSender.js:107`): `err.type` is the class name, plus `err.code`, `err.statusCode`, `err.requestId` (`types/Errors.d.ts:115-169`); a missing object is `code === 'resource_missing'`;
   - the SDK auto-retries 409, 5xx and `stripe-should-retry`, with `maxNetworkRetries` defaulting to 2 (`esm/stripe.core.js:77`);
   - idempotency keys expire after 24 h, and a reused key requires identical params (docs.stripe.com/api/idempotent_requests).

### 4.2 Checkout (mode `subscription`)
- **Payment methods:** `payment_method_types: ['card', 'us_bank_account']` (`types/Checkout/SessionsResource.d.ts:193,2137`).
  - `payment_method_options.us_bank_account.verification_method: 'automatic' | 'instant'` (`:2036,2064`).
  - `financial_connections.permissions` must include `'payment_method'` (`:2044-2057`).
- **Promotion codes:** `allow_promotion_codes: true` (`:20`), never combined with `discounts`.
- **Quantity:** `line_items[].quantity` is set by the server (`:695`). `adjustable_quantity` stays unset. Tiered prices are supported in subscription Checkout (docs.stripe.com/payments/subscriptions). *Test-mode check:* quantity > 1.
- **ACH:** "a subscription can become `active` while its first payment is still processing". A pending payment can also leave it `incomplete`. Both are handled.
  - **Events:** `checkout.session.completed`, then `checkout.session.async_payment_succeeded` or `_failed`.
  - For delayed methods, "If the payment fails later, Stripe voids the invoice but the subscription remains `active`" (docs.stripe.com/billing/subscriptions/overview). *Test-mode check.*

### 4.3 Send-invoice subscriptions
- "Subscriptions with `collection_method=send_invoice` are automatically activated regardless of the first Invoice status" (`Subscriptions.d.ts:73`).
- They are `active` while the invoice is open. A subscription "becomes `past_due` when its invoice is not paid by the due date". After that, the Dashboard setting decides: cancel, mark `unpaid`, or leave it past due (docs.stripe.com/billing/collection-method).
- There's no `invoice.upcoming` event, and `invoice.payment_failed` can't be relied on. The signal is `customer.subscription.updated` → `past_due` (docs.stripe.com/billing/subscriptions/webhooks).
- The portal can only cancel send-invoice subscriptions (docs.stripe.com/customer-management, Limitations).

### 4.4 Customer portal
- `features.subscription_update.{ enabled, default_allowed_updates }` (`types/BillingPortal/ConfigurationsResource.d.ts:176-224`). Quantity and plan switching are off by default. The Dashboard edits the **default** configuration, which `openBillingPortal` uses.

### 4.5 Next.js `after()` (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`)
- Runs after the response, in Server Functions too. Throws outside a request scope.
- The integration setup runs it immediately (`src/__tests__/integration/setup-db.ts:14-24`). This blueprint doesn't add new `after()` calls.

## 5. Invariants that must not break
1. **Security:**
   - every billing action keeps `requireAdminFresh` / `requireAdmin` first, before any query;
   - the tenant comes from the request host, never from input;
   - price IDs and Stripe ids never reach the client, and client components import only `plan-copy.ts` (no env reads).
2. **A user change never fails or rolls back because of billing.** The tenant transaction commits on its own. The due mark is best-effort with a hard timeout, and the daily check is the backstop.
3. **The seat cap is enforced inside the existing transactions, after `lockUserRulesExclusive`.**
4. **Lifecycle writes stay on the existing path:** only `reconcileInLock` / `updateTenantGuarded` with the `lifecycle_version` guard. The seat-sync bookkeeping lives in its own table, never bumps `lifecycle_version`, and takes its own lock.
5. **The webhook never trusts payload state:** it re-reads Stripe under the tenant lock.
6. **The app updates only what it sold, on an account that isn't overdue:**
   - an item on one of the two Standard prices;
   - on an `active` subscription, or a `past_due` invoiced one with nothing overdue;
   - and only while the row's `pastDueSince` is null.

   Never a canceled, incomplete, overdue or custom-price subscription.
7. **No double charge:**
   - every Stripe update follows a fresh read in the same locked section;
   - nothing is sent when the quantity already matches;
   - the quantity never goes down mid-term, so a re-added user isn't charged again within the term (§6.4). The one exception: after the drop in the last day, a re-add is prorated for the hours left (Q1).
8. **The admin of a workspace suspended for non-payment can always reach Billing and pay:** no tenant-DB accessor that refuses `billing_only` on that path.
9. **DCAA and records:** deactivation keeps records and logs (unchanged). Billing touches no timesheet, revision or lock.
10. **Terms §4.7:**
    - admins are emailed when a payment fails or an invoice is unpaid when due;
    - the grace is 15 days from the first failed charge or the invoice due date, after the notices;
    - ACH in flight never suspends.

## 6. Design

### 6.1 Plan model
**`src/lib/billing/plan-copy.ts`:** new, client-safe, pure strings, no imports, no env.
```ts
export const PLAN_SEAT_LIMIT = { trial: 10, standard: 100, enterprise: null } as const;
export const PRICE_COPY = {
  trial:           { price: 'Free for 30 days', detail: 'Up to 10 users. No credit card required.' },
  standardMonthly: { price: '$10 / user / month', detail: '$50 minimum (covers up to 5 users)' },
  standardAnnual:  { price: '$8.50 / user / month, billed annually', detail: '$510 minimum per year (covers up to 5 users)' },
  enterprise:      { price: 'Contact us', detail: 'More than 100 users, invoicing, or custom terms' },
} as const;
export const STANDARD_USERS_LINE = 'Up to 100 users';                 // §1 "Users" column (Q7)
export const ENTERPRISE_MAILTO = 'mailto:support@cadenzpoint.com?subject=CadenzPoint%20Enterprise';
export const STANDARD_CAP_MESSAGE = 'Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.';
/** Tier 1 of both Standard prices covers this many users for the flat amount (BUSINESS-DECISIONS.md §1). */
export const STANDARD_FLAT_TIER_USERS = 5;
```
A unit test pins every string byte for byte against §1, and `TRIAL_DAYS === 30` against "Free for 30 days".

**`src/lib/billing/plans.ts`:** server-only (`import 'server-only'`).
- `type PlanKey = 'trial' | 'standard' | 'enterprise'`; `type BillingInterval = 'month' | 'year'`.
- `standardPriceIds(): { month: string | null; year: string | null }` reads `STRIPE_PRICE_STANDARD_MONTHLY` / `STRIPE_PRICE_STANDARD_ANNUAL`, with empty treated as null.
- `priceInfo(priceId): { interval: BillingInterval } | null`: null when it isn't a Standard price.
- `seatLimitFor(plan: string): number | null`:
  - `enterprise` → null;
  - `standard`, and the legacy `starter` / `pro` → 100 (the legacy values only appear in the deploy window right after the migration);
  - anything else, including unknown values → 10 (today's fallback, `seats.ts:20`).
- `displayPlan(plan: string): PlanKey`: `enterprise`; `standard` (also legacy `starter` and `pro`); else `trial`.

`STRIPE_PRICE_STARTER` / `_PRO` / `_ENTERPRISE` are removed everywhere (§10).

### 6.2 Plan facts on the tenant row, and the founder commands
**Control-plane migration** `drizzle/control-plane/00NN_per_user_billing.sql`:
- `ALTER TABLE tenants ADD COLUMN plan_interval varchar(10)`: `'month'` | `'year'` | null, written with `plan`.
- `ALTER TABLE tenants ADD COLUMN subscription_cancel_at_period_end boolean NOT NULL DEFAULT false`.
- `ALTER TABLE tenants ADD COLUMN collection_method varchar(30)`.
- `UPDATE tenants SET plan = 'standard' WHERE plan IN ('starter', 'pro')`. This affects dev and staging rows only; production isn't live.
  - The migration runs before the new code deploys. In that window old code maps `'standard'` to the trial limit; acceptable on dev and staging. New code maps any leftover legacy value to 100 (§6.1).
  - `'enterprise'` rows stay.
- The new table `tenant_seat_billing` (§6.5), with an FK to `tenants.id` **`ON DELETE CASCADE`** (tests delete tenant rows; production tombstones them and never deletes).

**Snapshot and transition** (`stripe-state.ts`, `subscription-transitions.ts`, `reconcile.ts`):
- **`StripeSubSnapshot` gains:**
  - `plan` and `interval`, from a new `planForSubscription(items)` in `plans.ts`, which replaces `planForPriceId` in `toSnapshot` (`stripe-state.ts:21`): `{ plan: 'standard', interval }` when **some** item is on a Standard price, else null (leave the plan as it is);
  - `cancelAtPeriodEnd: boolean`;
  - `collectionMethod: string | null`.
  - `toSnapshot` tolerates any shape. There's no new expand, so the in-lock call count is unchanged.
- **The transition patch gains:**
  - `planInterval`, written with `plan` on GOOD, only when the price is a Standard price;
  - `subscriptionCancelAtPeriodEnd` and `collectionMethod`, from every tracked read.
- **Invoiced (send_invoice) subscriptions follow their invoices' due dates** (rule 8; Terms §4.3 net 30, §4.7 "unpaid when due … 15 days later"). Charge-automatically subscriptions keep today's rule unchanged: `P = f.pastDueSince ?? now` on first DUNNING sight.
  - **The invoice facts.** For a tracked send_invoice subscription that is GOOD or DUNNING, `reconcileInLock` computes `invoiceOverdueSince` from the subscription's **open** invoices (drafts don't count):
    - the earliest `due_date <= now`;
    - **and** any open invoice with `due_date === null` that **has failed** (`f.pastDueSince` set, or the tenant ended, or `attempt_count > 0` and not processing; `OpenInvoiceState` gains `attemptCount`). That's a charge-automatically invoice left open after the founder switched the subscription to invoicing; open invoices keep their collection method, `InvoicesResource.d.ts:783`, and charge invoices have no due date, `Invoices.d.ts:257`) counts as overdue since `f.pastDueSince ?? f.subscriptionEndedAt ?? now`. That mirrors the charge rule, so a debt is never dropped by a switch. On an ended tenant it falls on or before the end, so it counts as **old debt** and never revives the tenant;
    - `invoiceOverdueSince` = the earliest of these, or null when none.
    - **One pure helper and one predicate** (in `subscription-transitions.ts`, unit-tested, U4), used everywhere "overdue" appears (the transition, `toCancel`, the DUNNING-filter exclusion, `cancelInOwnSection`, `choosePayInvoice`):
      - `isOverdue(inv, cutoff) = inv.dueDate === null || inv.dueDate <= cutoff`;
      - `computeInvoiceOverdueSince(invoices, subId, pastDueSince, endedAt, now)`.
    - It's computed **on every reconcile** of such a subscription, whatever Stripe's status, so it is never stale.
    - It isn't computed for canceled, incomplete or paused subscriptions (no wasted in-lock call).
    - `resource_missing` from the list is treated as empty only for a confirmed-deleted customer, as `readOpenInvoices` does (`stripe-state.ts:109-112`); any other error throws.
    - Source: `opts.loadOpenInvoices`, a **lazy loader** the lifecycle runner passes. `reconcileInLock` calls it only for a send_invoice subscription. The runner reuses the memoized result for `paymentProcessing` and observations, with the `customerDeleted` flag the reconcile learned, so the in-lock call count is unchanged.
    - Otherwise (the webhook): one `invoices.list({ subscription: tracked.id, status: 'open', limit: 100 }, IN_LOCK)`. Webhook in-lock calls stay at 3 or fewer: the subscription list, an optional tracked retrieve, and this list.
    - It's computed for ended tenants too (the no-revival guard below needs it). It's skipped only when `allowDeleting` is true (`deleteTenant`), which gives `skipped`.
    - `OpenInvoiceState` gains `dueDate: Date | null` and `hostedUrl`. A read failure throws, and the event or run is retried (as for any in-lock Stripe error).
  - **`computeSubscriptionTransition` gets the optional input `invoiceFacts`:** `{ kind: 'charge' }` (default: not send_invoice), `{ kind: 'skipped' }` (send_invoice under `allowDeleting`), or `{ kind: 'invoiced', overdueSince: Date | null }`.
    - For `charge` the existing branches run unchanged.
    - For send_invoice, **this branch runs instead of the generic GOOD and DUNNING branches and returns**, so they never touch its dunning or suspension fields. In pseudo-code, after the common `stripeSubscriptionId` / `subscriptionStatus` / `currentPeriodEnd` (+ cancel flag, collection method) fields:
      ```ts
      const sendInvoice = tracked.collectionMethod === 'send_invoice' && invoiceFacts.kind !== 'charge';
      if (sendInvoice && (isGood(tracked.status) || isDunning(tracked.status))) {
        if (invoiceFacts.kind === 'skipped') {             // deleteTenant: write no dunning/suspension field
          if (isGood(tracked.status) && tracked.plan) { p.plan = tracked.plan; p.planInterval = tracked.interval; }
          return result;
        }
        const P2 = invoiceFacts.overdueSince;              // §6.2 invoice facts, or null
        if (f.subscriptionEndedAt !== null) {
          // Ended. Old debt (overdue on or before the end): status only, never revive (D9 sticks).
          if (P2 !== null && P2.getTime() <= f.subscriptionEndedAt.getTime()) return result;
          // Nothing overdue, or a debt newer than the end (a new subscription): a new life.
          p.subscriptionEndedAt = null;
        }
        p.firstGoodAt = f.firstGoodAt ?? now;
        if (isGood(tracked.status) && tracked.plan) { p.plan = tracked.plan; p.planInterval = tracked.interval; }
        p.deletionScheduledFor = null;                     // as the GOOD branch: no deletion while subscribed
        const P1 = f.subscriptionEndedAt !== null ? null : f.pastDueSince;
        const suspendedNonpayment = notPolicy && f.status === 'suspended';
        const unsuspend = () => { if (suspendedNonpayment) {
          p.status = 'active'; p.suspendedAt = null; p.suspensionReason = null; } };
        if (P2 === null) {                                 // nothing overdue
          p.pastDueSince = null; unsuspend();
        } else if (suspendedNonpayment && P1 !== null && P2.getTime() < P1.getTime()) {
          // keep P1 while suspended (an earlier anchor can't reach a suspended workspace in practice)
        } else {
          p.pastDueSince = P2;
          result.notices.push({ kind: 'payment-failed', anchor: P2 }); // every reconcile, like the DUNNING branch:
                                                           // enqueueNotice dedups and revives a superseded unsent row
          if (P1 !== null && P2.getTime() > P1.getTime()) unsuspend(); // old debt paid: fresh grace for the newer one
        }
        return result;
      }
      ```
    - **What this guarantees:**
      - Stripe's status never starts or ends an invoiced grace; only the due dates do.
      - A suspension for an overdue invoice stays, with `suspendedAt` unchanged, while that invoice is unpaid, even if Stripe says `active`. The daily runs never unsuspend and re-suspend.
      - Paying the old debt while a newer invoice is overdue lifts the suspension and restarts the 15-day clock from the newer due date, with a new warning (Terms §4.7).
      - A terminated invoiced tenant that still owes **the debt it was terminated for** is never revived by a GOOD read. A new subscription after the end revives normally, and its own grace starts from its own due date.
      - GOOD-only facts (`plan`, `planInterval`) are written while an invoice is merely open, so a new invoiced customer is on Standard from day one.
    - **Termination of an invoiced tenant** (`lifecycle-runner.ts:249-251`):
      - `toCancel` also includes the tracked subscription when the tenant is ended, `collectionMethod === 'send_invoice'`, the subscription is LIVE (GOOD included), and the memoized invoices show an open invoice for it with `isOverdue(inv, subscriptionEndedAt)`.
      - The existing DUNNING filter **excludes** send_invoice subscriptions with no `isOverdue(inv, subscriptionEndedAt)` invoice: Stripe's `past_due` there isn't a debt. It uses the same cutoff as the rule above. A debt newer than the end has already revived the tenant in the same run's reconcile.
      - The list is de-duplicated (a `Set`).
      - `cancelInOwnSection` (`:320-357`), for a send_invoice subscription, **moves its `readOpenInvoices` call ahead of the GOOD check** (today the GOOD branch returns before any invoice read, `:328-334`).
        - It then treats the subscription as "paid", for GOOD **and** DUNNING alike, only when none of its open invoices (filtered by `subscriptionId`) satisfies `isOverdue(inv, now)`. In that case it reconciles and doesn't cancel. That covers a customer who pays between the evaluation and this section while Stripe stays `past_due`.
        - Otherwise it takes the cancel path, after the existing `paymentProcessing` check.
        - When paid, it passes the **unfiltered** invoice list to `reconcileInLock` as the loader result. That section makes at most 4 Stripe calls (retrieve, invoices, subscription list, optional tracked retrieve), one more than the usual budget; acceptable for this rare path.
      - So Stripe stops billing a customer who was told the subscription ended.
  - **`nextLifecycleActions`** (`lifecycle.ts:323-335`): the dunning block's condition changes from `isDunning(f.subscriptionStatus)` to `isDunning(f.subscriptionStatus) || f.collectionMethod === 'send_invoice'`, still requiring `P !== null`.
    - `LifecycleFacts` gains an **optional** `collectionMethod?: string | null` (`toLifecycleFacts` maps it; absent means charge-automatically), so the existing facts literals in tests keep compiling.
    - So an invoiced customer with an overdue invoice gets the warning and suspension on the due-date clock even while Stripe says `active` (an older invoice behind a newer paid one), with **no Stripe setting needed**.
    - Nothing else in `lifecycle.ts` reads DUNNING for access: DUNNING and GOOD are both `full`.
  - **No "All invoices" setting.** v3.1 asked the founder for it. v3.3 drops it: invoiced customers no longer depend on Stripe's status resolution, and for charge-automatically customers an older failed invoice behind a newer paid one can't realistically occur (a failed upgrade invoice makes the subscription `past_due` at once, and the dunning clock runs out long before the next renewal).
- **Enterprise is never overwritten:** `reconcileInLock` deletes `patch.plan` and `patch.planInterval` when `row.plan === 'enterprise'`.
- **`reconcileInLock` returns `becameGood: boolean`:** `!isGood(row.subscriptionStatus) && isGood(updated.subscriptionStatus)`, **or** `row.pastDueSince !== null && updated.pastDueSince === null` with the subscription LIVE (an invoiced account recovers while Stripe says active), **or** `row.subscriptionEndedAt !== null && updated.subscriptionEndedAt === null` with the subscription LIVE (a revival). §6.5's callers mark the seat sync due on it.
- **Drift alert resolution:** `reconcileInLock` resolves `subscription-status-drift` for the tenant whenever it writes a tracked status (the mirror then agrees with Stripe).
- **Legacy key in the mirror:** a GOOD Standard read writes `plan = 'standard'`, so `starter`/`pro` rows heal on their next reconcile.

**Founder commands** (`src/lib/tenant/admin-commands.ts` planners and `scripts/tenant-admin.ts` cases). Each previews first, applies only with `--yes`, runs under the lock with the guard, and is audited.

**Stripe-mode guard** (commands that call Stripe: `ensure-customer`, `seat-sync`):
- Print the Stripe mode, read from the key prefix (`sk_live_` / `sk_test_` / `rk_…`), next to the control-plane banner.
- Refuse unless `--stripe-mode live|test` is given and matches the key.
- Record `livemode` in the audit detail.
- The script header lists the env these commands need: the control-plane URL, `ENCRYPTION_KEY` (for `seat-sync`) and `STRIPE_SECRET_KEY`.

| Command | Effect | Refusals |
|---|---|---|
| `set-plan <slug> enterprise` | `plan = 'enterprise'`, `plan_interval = null`; audit `plan-set` (`old→new`); resolve `seat-sync-unmanaged-price` for the tenant | tenant not active or suspended |
| `set-plan <slug> standard` | `plan = 'standard'`; the interval comes from the next reconcile | the tenant isn't `enterprise` |
| `ensure-customer <slug>` | `ensureStripeCustomer(tenantId)`; prints the `cus_…` id and the mode; audit `stripe-customer-ensured` | closed tenant; mode guard |
| `seat-sync <slug>` | without `--yes`: prints the planned calls (`dryRun`), writes nothing; with `--yes`: one `syncSeatQuantity` (reason `manual`), then prints the outcome | mode guard |

`show` prints `plan_interval`, `collection_method`, the `tenant_seat_billing` row and, when `ENCRYPTION_KEY` is set, the **live active-user count** from the tenant DB (as `printImportWindow` already reads it). The runbook uses this count as the quantity for hand-made subscriptions.

**An Enterprise workspace stays Enterprise** until `set-plan standard`, even if it later self-checks-out on Standard. The runbook (§12) says to run `set-plan standard` when an Enterprise contract ends.

### 6.3 Seat cap (`src/server/internal/seats.ts`)
- **`readPlanFresh(tenantId)`**, in its own module `src/server/internal/plan-source.ts` so test suites can mock it:
  - `SELECT plan FROM tenants WHERE id = $1` on `controlDb`. A missing row throws, never a silent default.
  - The registry cache can hold a stale `trial` for minutes after payment on another instance.
  - The plan is read **before** a tenant transaction opens, never inside one.
- **`getSeatUsage(executor?, plan?)`** → `{ limit: seatLimitFor(plan), currentActive, plan }`. It reads the plan fresh when none is passed. `getTenantOrThrow` is still used for the tenant id on the request path (Users page).
- **`assertSeatsAvailable(n, tx, plan)`:** the writers call `readPlanFresh` before their `db.transaction` and pass the plan in.
  - Order: after `requireAdminFresh` and input validation, and only when the call can take a seat. `createUserWithPassword` always; `bulkImportEmployees` always (its dry run reports the seat check too, as today); `updateUser` **only when `data.isActive === true`**.
  - So a rename or role change never depends on the control plane (invariant 2). When `currentActive + n > limit`:
  - `displayPlan(plan) === 'standard'` (so legacy `pro`/`starter` too): `UserFacingError(STANDARD_CAP_MESSAGE)`, exactly, for create, reactivate and import alike (Q7);
  - otherwise (trial): today's message, unchanged.

### 6.4 The quantity sync (`src/lib/billing/seat-sync.ts`, server-only)
**Principle (Q1): the Stripe quantity only rises during a term, and comes down to the real count in the last day before renewal.**
- Stripe's own quantity is the term's paid level, so the app keeps **no billing state of its own** that a lost write could corrupt.
- Rule 4 holds literally ("Removing users takes effect at the next renewal, with no mid-term credit").
- Re-adding a removed user in the same term costs nothing: the quantity never went down.
- Increases follow rule 3.

`syncSeatQuantity(tenantId, { runId, reason: 'due' | 'daily' | 'renewal' | 'manual', dryRun? }): Promise<SeatSyncOutcome>` is called by the seat-sync cron (§6.5) and by `tenant:admin seat-sync`.

**Lock.** `withSeatLock(tenantId, fn)` (new in `locked.ts`): one control-plane transaction on the dedicated pool with `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10s'`, then `pg_advisory_xact_lock(hashtext('seats:'||tenantId))`.
- It is **not** the `tenant:` lifecycle lock.
- Inside, the **only** writes to `tenant_seat_billing` are the final ones in step 7, after every Stripe call. No row lock is held across a Stripe call, so `markSeatSyncDue` is never blocked by a running sync.

**Stripe call options.** Every Stripe call in this module passes explicit options: `{ timeout: 10000, maxNetworkRetries: 1 }`, except the step 3 read, which uses `maxNetworkRetries: 0`.

**Alerts are written after the transaction.** Every alert this function raises or resolves (steps 3–7) is collected in memory and written after the `withSeatLock` transaction ends, on `withLockedPool`, followed by any emails. No `ops_alerts` row lock and no Resend call is held across a Stripe call or inside the locked section (`locked.ts:53-55`).
- If that post-commit alert write throws, it's logged and sent to Sentry. The outcome stays as it was (never `failed`: Stripe already applied the calls).
- Event-type facts that must not be lost, such as a term race, are also written as an **audit event inside the transaction** (`seat-sync-term-race`, detail from/to/periods/restore result). The audit trail is the durable record; the alert is the notification.

**Steps:**

1. **Read** the `tenants` row and the seat row (`tx`, plain selects). Keep `markSeq0 = seat?.mark_seq ?? 0` and `stored = seat?.stripe_quantity ?? null`. If the tenant isn't `active`, has no `stripe_subscription_id`, has `subscriptionEndedAt` set, or its access mode is `closed`, return `not-applicable`.
2. **Count:** on `getDbForUrl(decrypt(row.dbUrlEncrypted))`, a tenant transaction with `SET LOCAL statement_timeout = '5s'`, then `SELECT count(*) FROM users WHERE is_active = true`. Set `desired = max(1, count)`.
3. **Read Stripe:** `subscriptions.retrieve(subId, {}, { timeout: 10000, maxNetworkRetries: 0 })`.
   - **Missing subscription** (`resource_missing`): return `not-applicable` and raise alert `seat-sync-subscription-missing` (dedup sub id).
   - **Not syncable:** return `not-applicable`. Syncable means the row's `pastDueSince` is null (the account isn't overdue, Q10) **and** either:
     - the status is `active`; or
     - it's `past_due` on a send_invoice subscription (Stripe's `past_due` there doesn't mean late, §6.2).

     Users added then reach Stripe as usual, and held quantities drop before renewal.
     - If Stripe's status is not GOOD (`active`/`trialing`) while the row's `subscription_status` is GOOD, also raise alert `subscription-status-drift` (dedup sub id, detail both statuses).
     - A run that finds Stripe GOOD resolves it, and so does `reconcileInLock` (§6.2).
     - `trialing` is not synced (the app doesn't sell trials) and raises no drift.
   - **Schedule attached** (`subscription.schedule` set): `subscriptionSchedules.retrieve(scheduleId)` (one extra call, only in this case). The alert `seat-sync-schedule-attached` (dedup sub id) is raised only when the **next phase's** item quantity differs from `desired`, which would reset the quantity at renewal. It's emailed when inside the renewal window.
     - It resolves when a run finds no schedule, or a next phase that matches.
     - The sync continues either way.
     - The runbook's sanctioned schedule (step 6, made inside the window with the live count) therefore raises nothing.
   - **Items:** the sync manages a subscription only when it has **exactly one item, on a Standard price**.
     - No Standard item → `not-standard`. If `row.plan !== 'enterprise'`, raise `seat-sync-unmanaged-price` (dedup sub id), resolved by `set-plan enterprise` or by a later managed run.
     - More than one item (with or without a Standard one) → `not-standard` and `seat-sync-unexpected-items` (dedup sub id).
     - The snapshot's `interval` (§6.2) is likewise taken from the Standard item, not blindly from the first.
   - **Read the values:**
     - `current = item.quantity ?? 1`;
     - `interval` from the Standard item's price;
     - `periodStart = current_period_start` and `periodEnd = current_period_end` (epoch seconds);
     - `collection = collection_method`.
4. **Where in the term.** `now` is epoch seconds.
   - `window = periodEnd − 86400 <= now && now < periodEnd − 300`: the last day before renewal, ending 5 minutes early.
   - Outside the window, decreases wait.
   - After `periodEnd − 300`, and while Stripe hasn't renewed yet (`now >= periodEnd`), no decrease is sent, so a removal can never land just after a renewal.
5. **Plan the calls:** a pure function `planSeatUpdates(current, desired, window, interval)`, unit-tested over the full table in §7.2.
   - `desired > current` (at any time):
     - when `current < STANDARD_FLAT_TIER_USERS`: **call A**, `quantity: min(desired, 5)`, `'none'` (inside the flat tier the amount doesn't change, so no $0 invoice);
     - when `desired > max(current, 5)`: **call B**, `quantity: desired`, `'create_prorations'` for `month` (on the next invoice) or `'always_invoice'` for `year` (invoiced now). That's rule 3.
     - A runs before B.
   - `desired < current` and `window`: **call D**, `quantity: desired`, `'none'` (no credit; the renewal bills the real count).
   - `desired < current` and not `window`: no call (`held`). The quantity stays at the term's level.
   - `desired === current`: no call.
   - With `dryRun`, return the planned calls and **write nothing at all**: no seat row, no audit, no clear, and no step 3 alerts (they're skipped in dry runs).
6. **Execute each call:**
   ```ts
   subscriptions.update(subId,
     { items: [{ id: item.id, quantity }], proration_behavior, payment_behavior: 'allow_incomplete' },
     { idempotencyKey: `seat:${subId}:${periodStart}:${from}->${to}:${runId}`, timeout: 10000, maxNetworkRetries: 1 })
   ```
   - The `runId` makes each run's key unique.
   - **No double charge after a lost response:** if Stripe applied a call but the response or the run was lost, the next run reads the new quantity in step 3 and plans from it. There's nothing to reconcile.
   - **Term race** (only call D can do harm):
     - **Detect:** if call D's response has a `current_period_start` different from step 3's, Stripe renewed between the read and the write. The renewal billed `from`.
     - **Act:** send a **restore** call immediately: `quantity: from`, `'none'`, key `restore:${subId}:${newPeriodStart}:${runId}`. That puts back the quantity the customer just paid for, and the next window lowers it.
     - **Alert:** raise `seat-sync-term-race` (dedup sub id), with detail saying whether the restore succeeded.
     - A race on calls A or B is harmless: an increase landing in the new term is prorated from its start.
7. **Record** (last statements in `tx`, after every Stripe call), in every non-failed, non-dry-run outcome:
   - Upsert `stripe_subscription_id` and `stripe_quantity` (the final Stripe values; for `not-applicable` / `not-standard` both are left unchanged), `billable_count`, `checked_at = now`, `failures = 0`, `last_error = null`, `next_attempt_at = null`.
   - This upsert **never** touches `mark_seq` or `sync_due_at` (a new row starts with `mark_seq = 0`).
   - Then compare-and-clear on the sequence number:
     ```sql
     UPDATE tenant_seat_billing SET sync_due_at = NULL WHERE tenant_id = $1 AND mark_seq = $markSeq0
     ```
   - **Corrections for the digest (rule 2):** write the audit event `seat-quantity-corrected` (`tenant_audit_events`, detail `from→to (billable N, reason)`) when either:
     - `stored !== null`, the seat row's `stripe_subscription_id` equals this subscription, and Stripe's quantity at step 3 differs from `stored`: something outside this module changed it, or a previous response was lost (detail `"changed outside the sync"`). The first run on a new subscription records no correction; or
     - the run's `reason` is `daily` and it made call A or B (a missed increase).
   - Resolve `seat-sync-failing`.
8. **Send-invoice proration invoices** (send_invoice subscriptions only). This is a separate step **after** step 7's commit, in its **own `withSeatLock` section** (so a manual run and the cron can't both send), with its own failure handling. It never blocks the quantity sync.
   - `invoices.list({ subscription: subId, limit: 20 })`, newest first. For each invoice with `status ∈ {draft, open}`, `billing_reason === 'subscription_update'` and no `metadata.cadenzpoint_sent`:
     - `draft` → `invoices.finalizeInvoice(id, { auto_advance: false })`;
     - then `invoices.sendInvoice(id)`;
     - then `invoices.update(id, { metadata: { cadenzpoint_sent: <ISO now> } })`.
   - Send happens before the marker, so a crash between them re-sends once (a duplicate email at worst), never zero.
   - This is stateless: an invoice whose update response was lost is still found on the next run.
   - A failure raises `seat-sync-invoice-send-failed` (dedup invoice id). The alert resolves once the invoice is sent, paid or void.
   - **Retry:** on a failure, or when more unsent invoices remain (step 8 handles one per run), it sets `sync_due_at = COALESCE(sync_due_at, now())` and `next_attempt_at = now + 10 min`, so the next run comes back within about 10 minutes, not at the next daily check.
     - Once the invoice's `seat-sync-invoice-send-failed` alert has 3 occurrences, step 8 stops forcing early retries for it, and it's retried only on daily runs. The alert stays open for the founder (for example, a customer with no email).
     - At that third occurrence it is re-raised with `raiseAlertWithEmail` under the dedup key `${invoiceId}:stuck`, so the founder is emailed: the unsent invoice still drives the due-date clock.
   - Step 8 is skipped entirely with `dryRun`.
   - **When it runs:** for any LIVE send_invoice subscription of a tenant that isn't ended or closed, **whatever step 3 decided about syncing** (an overdue or `not-applicable` account still has its unsent invoices sent).
   - **Skip:** open invoices with `auto_advance: true`, which Stripe emails itself.
   - **Closing stuck alerts:** each step 8 run reads the invoice ids of the tenant's open `seat-sync-invoice-send-failed` alerts (both dedup keys, `id` and `id:stuck`) and retrieves each one. When the invoice is no longer open, or carries the marker, both alerts are resolved.
   - Every send-invoice subscription with an active status gets this step on each run that processes it, including `in-sync` runs.

**Outcomes:** `in-sync | held | updated | lowered | corrected | term-race | not-applicable | not-standard | dry-run | failed | busy`.
- **`failed`** (any error in steps 2–7): the transaction rolls back. Then, **in a separate upsert on `withLockedPool`** (`INSERT … ON CONFLICT (tenant_id) DO UPDATE`, inserting `failures = 1` when the row didn't exist; an aborted transaction can't record its own failure):
  - `failures = failures + 1`;
  - `last_error` (message plus `err.code`, no customer data);
  - `checked_at = now`;
  - `sync_due_at = COALESCE(sync_due_at, now())` (a failed daily or renewal run becomes due, so backoff applies);
  - `next_attempt_at = now + min(10 min × 2^(failures − 1), 6 h)`, but **capped at 10 minutes while inside the renewal window**. The window comes from the step 3 values, or from the mirror's `tenants.current_period_end` when step 3 wasn't reached.
  - At 3 consecutive failures, raise `seat-sync-failing` (dedup tenant) with `raiseAlert`.
  - **Inside the renewal window**, also raise `seat-sync-renewal-at-risk` (dedup `${subId}:${periodEnd}`) with `raiseAlertWithEmail` on the first in-window failure. It is a new alert per renewal, so the email fires even when `seat-sync-failing` was already open. A successful run resolves it.
- **`busy`:** the lock timed out. Nothing is written, and the next run retries.

### 6.5 Due marks and the cron
**Table `tenant_seat_billing`:**

| column | type |
|---|---|
| `tenant_id` | uuid PK, FK → `tenants.id` ON DELETE CASCADE |
| `sync_due_at` | timestamptz null (oldest unserved mark, for ordering) |
| `mark_seq` | bigint not null default 0 |
| `stripe_subscription_id` | varchar(100) null (the subscription `stripe_quantity` belongs to) |
| `stripe_quantity` | int null (last quantity read or written) |
| `billable_count` | int null |
| `checked_at` | timestamptz null |
| `next_attempt_at` | timestamptz null |
| `failures` | int not null default 0 |
| `last_error` | text null |
| `updated_at` | timestamptz not null default now() |

**`markSeatSyncDue(tenantId)`:** one `controlDb` transaction with `SET LOCAL lock_timeout = '1s'` and `SET LOCAL statement_timeout = '2s'` (Postgres cancels it, so no pooled connection is left waiting). Then:
```sql
INSERT INTO tenant_seat_billing (tenant_id, sync_due_at, mark_seq) VALUES ($1, now(), 1)
ON CONFLICT (tenant_id) DO UPDATE SET sync_due_at = COALESCE(tenant_seat_billing.sync_due_at, now()),
  mark_seq = tenant_seat_billing.mark_seq + 1, updated_at = now()
```
- Also wrapped in a 3-second `Promise.race` as a last guard. The raced promise gets its own `.catch` (log only), so the losing branch can't cause an unhandled rejection. The same applies to every `Promise.race` in this blueprint (§6.10).
- It **never throws** to its caller: errors and timeouts are logged and sent to Sentry with `Sentry.captureException`.
- **Test seam:** the statement runs through a small exported `seatMarkStore.upsert(tenantId)`, so tests inject failures and delays below the protection (S18).

**Callers** (after the tenant transaction commits; awaited before the action returns):

| Caller | When |
|---|---|
| `updateUser` | `changed.isActive !== old.isActive` |
| `createUserWithPassword` | always |
| `bulkImportEmployees` | `!dryRun && done.created > 0` |
| Stripe webhook, after the locked section, when `outcome` is non-null | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, or `becameGood` |
| Lifecycle runner (`runTenantLifecycle`), after its locked section | `becameGood` from its reconcile |
| Lifecycle runner `cancelInOwnSection`, after its section | `becameGood` from its reconcile |

**Cron `seat-sync`:**
- `vercel.json` gets `{"path": "/api/cron/seat-sync", "schedule": "*/10 * * * *"}`.
- The route `src/app/api/cron/seat-sync/route.ts` goes through `runCron` (heartbeat), with `maxDuration = 300`.
- The heartbeat registry gains `'seat-sync'`, schedule `*/10 * * * *`, stale after 1 h. `cron-ops.test.ts` is updated.

**Candidates.** `runId = randomUUID()`; each candidate list is one control-plane query, and every list requires `next_attempt_at IS NULL OR next_attempt_at <= now`:
1. **Due** (reason `due`): `sync_due_at IS NOT NULL`, ordered by `failures ASC, sync_due_at ASC`.
2. **Renewal** (reason `renewal`): tenants with `status = 'active'`, `subscription_ended_at IS NULL`, a syncable mirror (`past_due_since IS NULL` and either `subscription_status = 'active'` or `subscription_status = 'past_due'` with `collection_method = 'send_invoice'`), and `current_period_end` between `now + 5 min` and `now + 24 h`, whose seat row is missing or has `checked_at < current_period_end − 24 h`, ordered by `current_period_end ASC`.
   - This runs every tenant once inside its window, even with no user change, so a held quantity comes down before renewal.
   - It relies on the `tenants.current_period_end` mirror. If that's stale, the daily list still reaches the tenant, and step 4 decides from Stripe's own values.
3. **Daily** (reason `daily`): tenants with `status = 'active'`, `subscription_ended_at IS NULL`, `stripe_subscription_id IS NOT NULL` and a syncable mirror (as above), whose seat row is missing or has `checked_at < now − 24 h`, ordered by `checked_at ASC NULLS FIRST`.

**Per run:**
- Tenants run one at a time.
- **Step 8 handles at most one invoice per tenant per run.**
- **Worst case per tenant:** 5 s lock + 15 s count + 10 s read + 20 s schedule read + 2 updates × 20 s (A+B, or D+restore) + post-commit alerts with emails (≤10 s, `ALERT_TIMEOUT_MS`) + step 8 (5 s lock + list 20 s + finalize, send, mark 3 × 20 s) ≈ 190 s.
- **No new tenant starts once 100 s have passed** (100 + 190 < 300).
- At least one tenant runs per run.
- One tenant failing never stops the others.
- The summary carries counts per outcome and slugs for `corrected`, `term-race`, `failed` and `busy`.

**Incomplete runs:** a run that stops early raises the existing kind `cron-incomplete` with `dedupKey = 'seat-sync'` (as `tenant-sweep.ts:136` does for its crons), using `raiseAlert`. Digest only, **on purpose**: unlike the reminder crons, a stop here only delays a sync by 10 minutes, and an every-10-minutes cron would email on each flip. A complete run resolves it.

**Config check** at the start of each run: if either `STRIPE_PRICE_STANDARD_*` is empty while any tenant has `subscription_status = 'active'`, raise `stripe-prices-missing`; otherwise resolve it.

**Why 10 minutes (Q5):** changes made close together become one Stripe update, so an annual customer importing 30 users gets one invoice. That keeps the 20-invoices-per-day limit (§4.1.8) out of reach. Rule 3's "invoiced right away" means within about 10 minutes.

### 6.6 Founder digest
- `sendOpsDigest` gains the section "Seat quantities corrected (last 24 h)", one line per `seat-quantity-corrected` event: slug, from→to, the reason, the time. `hasNews` includes it.
- The new alert kinds show in the existing alert list:
  - `seat-sync-failing`, `seat-sync-unmanaged-price`, `seat-sync-unexpected-items`, `seat-sync-subscription-missing`, `seat-sync-term-race`, `seat-sync-invoice-send-failed`;
  - `subscription-status-drift`, `stripe-prices-missing`;
  - `checkout-payment-failed`, `payment-failed-subscription-active`, `stripe-event-unknown-customer`;
  - `seat-sync-schedule-attached`, `seat-sync-renewal-at-risk`;
  - `cron-incomplete` (dedup `seat-sync`).
- **How each new alert closes:**
  - **Resolved automatically by a later run that no longer finds the condition:** `seat-sync-failing`, `seat-sync-renewal-at-risk`, `seat-sync-unmanaged-price`, `seat-sync-unexpected-items`, `seat-sync-subscription-missing`, `seat-sync-schedule-attached`, `seat-sync-invoice-send-failed`, `subscription-status-drift`, `stripe-prices-missing`, `cron-incomplete`.
  - **Events the founder reviews and closes with `tenant:admin resolve-alert`:** `seat-sync-term-race`, `checkout-payment-failed`, `payment-failed-subscription-active`, `stripe-event-unknown-customer`.

### 6.7 Send-invoice subscriptions (rule 8)
- **Linking (round 1 HIGH):** a hand-made subscription must be on the workspace's own Stripe customer. The founder runs `tenant:admin ensure-customer <slug> --stripe-mode live --yes` (or `show`, if one exists) and creates the subscription on that `cus_…` in the Dashboard (§12 runbook). The webhook alerts on events for an unknown customer (§6.9).
- **Dunning anchor:** `P` is the earliest overdue open invoice's due date (§6.2). So the 15-day grace, the warning and the notice all count from the due date, even when the webhook is late or lost.
- **The Pay button opens the right invoice:** `payUrl` (§6.10) comes from `choosePayInvoice`. It's never simply `latest_invoice`, which can be a newer proration invoice that isn't due yet. The order:
  1. the earliest (by `created`) open invoice with a null due date;
  2. else the earliest open invoice with `due_date <= now`;
  3. else the earliest open invoice.
- **Overdue while Stripe still says active** (an older invoice behind a newer paid one): the app's own due-date clock (§6.2) still sends the invoiced `payment-failed`, warns and suspends. No Stripe setting is needed.
- **Paid, but another invoice is open and not yet due:** `pastDueSince` returns to null, and a non-payment suspension lifts (§6.2), whatever Stripe's status says.
- **Daily reconcile for invoiced subscriptions:** `shouldReconcile` returns true when `collectionMethod === 'send_invoice'` and the mirror is GOOD (new `ReconcileContext.collectionMethod`). A lost `past_due` webhook is then found by the next daily lifecycle run.
- **Notice wording (Q4):**
  - The `payment-failed` kind is unchanged. At render time, `notices.ts` picks `InvoiceOverdueEmail` (new template, Q4 text, no due date) when `row.collectionMethod === 'send_invoice'`.
  - **The stated suspension date**, for both variants, is `max(P + 15 days, now + SUSPENSION_NOTICE_DAYS)` formatted in the workspace time zone. A back-dated `P` can't produce a date already in the past.
- **Stripe's Dashboard setting** for invoices sent to customers (what to do after the due date) must be **leave past due**, like 9.5 (§12).

### 6.8 Checkout and portal (`src/server/actions/billing.ts`)
`startCheckout(interval: BillingInterval)`.
1. The existing guards come first: `requireAdminFresh`, `getTenantForBilling`, the closed and policy refusals.
   - **Only then** the interval is validated: any value other than `'month'`/`'year'` → `UserFacingError('Choose monthly or annual billing.')`.
   - Validating before the guard would tell an unauthenticated caller which arguments are valid (`guard-first-oracle.test.ts`).
2. `standardPriceIds()[interval]`; missing → `UserFacingError('That plan is not available yet.')`.
3. **Count:** `countActiveUsers(row)`, a new helper in `seats.ts` that uses `getDbForUrl(decrypt(row.dbUrlEncrypted))`, like `notices.ts:71-88`, so it works in `billing_only`. If `count > 100` → `UserFacingError(STANDARD_CAP_MESSAGE)`.
4. `ensureStripeCustomer` and the authoritative duplicate check, as today.
5. Create the session:
   ```ts
   checkout.sessions.create({ mode: 'subscription', customer, line_items: [{ price, quantity: max(1, count) }],
     payment_method_types: ['card', 'us_bank_account'],
     payment_method_options: { us_bank_account: { verification_method: 'automatic', financial_connections: { permissions: ['payment_method'] } } },
     allow_promotion_codes: true,
     subscription_data: { metadata: { slug, tenantId } },
     success_url, cancel_url, metadata: { slug } })
   ```
   - No `discounts`, no `adjustable_quantity`.
   - A quantity that's stale by payment time is corrected by the due mark set on completion.

**Portal (Q2):** `openBillingPortal` is unchanged. Phase 9.3 changes to payment method update, invoice history and cancel at the end of the billing period, with **plan switching and quantity changes off** (§12).

### 6.9 Webhook changes (`route.ts`)
- **Events:** add `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, both resolved like `checkout.session.completed` (by metadata slug).
  - `_succeeded`: the normal reconcile, then mark due.
  - `_failed`: the normal reconcile, then, in the same locked section:
    - `raiseAlert('checkout-payment-failed', dedup session id)`;
    - **only if** the session's subscription is **not** LIVE after the reconcile (the `incomplete` / `incomplete_expired` path, where the subscription never started): `enqueueNotice(tx, tenantId, 'bank-payment-failed', anchor = session.created)`. A LIVE subscription's failure is covered by `invoice.payment_failed`.
- **`invoice.payment_failed`:** after the reconcile, **only if no grace notice covers it** (the tenant's `pastDueSince` is null after the reconcile, whatever Stripe's status), **and** the invoice's subscription is LIVE, **and** the tenant isn't ended (`subscriptionEndedAt` null; an ended tenant gets the founder alert only, since its Billing page offers no payment). An `incomplete` / `incomplete_expired` one is covered by `checkout.session.async_payment_failed`, so there's one email per failure. That covers:
  - the ACH case where Stripe voids the invoice and leaves the subscription active;
  - (Q11) a failed card or bank payment on an invoiced subscription's invoice page before the due date, even if Stripe flips the subscription to `past_due`.

  Then, in the same locked section:
  - `enqueueNotice(tx, tenantId, 'bank-payment-failed', anchor = invoice.created)`;
  - `raiseAlert('payment-failed-subscription-active', dedup invoice id)`.
  - When `pastDueSince` is set, `payment-failed` from the transition is the email instead.
  - The triggers are exclusive (`pastDueSince` null vs set), so one failure sends one email.
- **Unknown customer:** for `SUBSCRIPTION_EVENTS` whose customer matches no tenant, `raiseAlert('stripe-event-unknown-customer', tenant null, dedup customer id, detail { event type })` before returning `ignored()`. Checkout events with an unknown slug keep returning `ignored()` (no customer link yet).
- **The `bank-payment-failed` notice (Q6):**
  - Add it to `NoticeKind` (`lifecycle.ts:144-154`).
  - In `isNoticeSuperseded` it is superseded only by `deleting`/`deleted` (it states a past fact).
  - It renders `BankPaymentFailedEmail` (new template, Q6 text: subject "Payment not received for {workspace}").
  - It is delivered like every notice (after the transaction, `deliverNotice`).
- **Seat marks:** per §6.5, after the locked section, only when `outcome` is non-null.
- PRODUCTION-DEPLOY 9.2's event list grows from eight to ten.

### 6.10 Billing page (`BillingClient.tsx`, `getTenantBillingInfo`)
**Data** (`TenantBillingInfo`, all server-computed; **no tenant-DB accessor that refuses `billing_only`**):
- `getTenantBillingInfo` reads the control-plane row (as today) and the `tenant_seat_billing` row. It then reads **the count and the time zone with `getDbForUrl(decrypt(row.dbUrlEncrypted))`**, through `countActiveUsers(row)` and a `readWorkspaceTimeZone(row)` that mirrors `notices.ts:84-85`.
  - Those two reads together are capped at **3 s** (`Promise.race`).
  - On error or timeout the page still renders, with `seats: null` and the time zone `America/New_York`, and the error is logged. Paying must never depend on it.
- **`payUrl` and open invoices:**
  - When the tenant has a tracked subscription that is DUNNING, `incomplete`, GOOD, or suspended for non-payment, one `invoices.list({ subscription: row.stripeSubscriptionId, status: 'open', limit: 100 }, { timeout: 5000 })` replaces today's `latest_invoice` read.
    - It's needed for GOOD too: the `bank-payment-failed` email sends admins here while the subscription is active, and an invoiced subscription can be overdue while Stripe says active.
    - The list includes `uncollectible` invoices as a fallback (second call, `status: 'uncollectible'`, only when no open invoice exists): their `hosted_invoice_url` still accepts payment.
  - `payUrl` is chosen by a pure helper `choosePayInvoice` in **`src/lib/billing/pay-url.ts`** (not in the `'use server'` actions file, which may only export async functions) (§6.7, U13):
    - first the **earliest by `created`** among open invoices with a null due date (on a charge-automatically subscription all are null; the earliest is the one driving the dunning; F37);
    - else the open invoice with the earliest `due_date` that is `<= now` (audit D13);
    - else the earliest open invoice by `created`.
  - `openInvoiceCount` is the number of open invoices.
  - A failure leaves `payUrl` null, and is logged.
- **Fields:**
  - `plan: PlanKey` (`displayPlan`), `interval`;
  - `access` (`getTenantAccess`), `lifecycleExempt`;
  - `subscriptionStatus`, `cancelAtPeriodEnd`;
  - preformatted date strings `trialEnd`, `renewsOn`, `endedOn`;
  - `trialDaysLeft` (server-computed, `ceil((trialEndsAt − now) / day)`);
  - `seats: { active, limit } | null`;
  - `billedQuantity`: the seat row's `stripe_quantity`, or null;
  - `billedQuantityApplies`: the seat row's `stripe_subscription_id` equals the tenant's (computed on the server);
  - `overdue` (`pastDueSince !== null`), `collectionMethod`, `ended` (`subscriptionEndedAt !== null`), `trialDateKnown` (`trialEndsAt !== null`);
  - `payUrl`, `openInvoiceCount`, `hasCustomer`;
  - `canSubscribe`: nothing LIVE or `incomplete` **and** access not `closed` **and** not policy-suspended;
  - `standardAvailable: { month, year }`, `suspensionReason`.
- Dates use `Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone })` on the server.

**Header:** "Billing" (order `headerOrder`); description "Your plan, users and payment details." Then three tiles in a row (stacked on mobile). Each tile has a small label above its big text: **`Plan`**, **`Users`**, **`Payment`**.

**Plan tile, first match wins:**
1. `plan = enterprise` → `Enterprise` / `Custom terms`.
2. `plan = standard` and the subscription ended (`subscriptionEndedAt` set) → `Standard` / *(no small text)*.
3. `plan = standard`, interval `month` → `Standard` / `Billed monthly`; `year` → `Billed annually`; null → no small text.
4. Trial with `trialEndsAt` null, or `lifecycleExempt` (demo, internal) → `Free trial` / no small text.
5. Trial not ended → `Free trial` / `Ends {trialEnd} · {n} days left` (`1 day left` when n = 1).
6. Trial ended → `Free trial` / `Ended {trialEnd}`.

**Users tile, first match wins:**
1. `seats` null → big text `—` / `Couldn't load the user count.`
2. Enterprise → `{n} active users` (`1 active user`) / `No user limit.`
3. Standard, subscription ended → `{n} active users` / no small text.
4. Standard, `billedQuantity > max(n, 5)` (held above the flat tier, Q1), the seat row's `stripe_subscription_id` equal to the tenant's, and `renewsOn` known:
   - `cancelAtPeriodEnd` → `{n} active users` / `Billed for {billedQuantity} users until {renewsOn}, when your subscription ends.`
   - otherwise → `{n} active users` / `Billed for {billedQuantity} users until {renewsOn}. Removed users leave your bill at renewal.`
   - With `renewsOn` null, this rule doesn't apply (rule 5 shows).
5. Standard → `{n} active users` / `You pay for each active user. The minimum covers 5. Up to 100 users.`
6. Trial → `{n} of 10 used` + progress bar (`aria-hidden`, the text says it) / `Active users count. Inactive users don't.`

**Payment tile, first match wins:**

| # | Condition | Big | Small | Action |
|---|---|---|---|---|
| 1 | suspended for non-payment | `Suspended` | `Pay the open invoice to restore access.` | **Pay the invoice** (`payUrl`). If `payUrl` is null: `Use Manage billing to pay.` |
| 2 | `pastDueSince` set (DUNNING, or an invoiced subscription with an overdue invoice while Stripe says active) | `Payment overdue` | `Pay the open invoice to avoid suspension.` | as row 1 |
| 2b | `past_due` / `unpaid` with `pastDueSince` null, `subscriptionEndedAt` null and `collectionMethod = 'send_invoice'` (an invoiced subscription that isn't overdue) | `Invoice open` | `Pay it by the due date on the invoice.` | **Pay the invoice** (`payUrl`), when present |
| 3 | `incomplete` | `Payment pending` | `Finish paying in Stripe, or wait for your bank payment to clear. If a bank payment failed, pay another way.` | **Finish paying** (`payUrl`), when present |
| 4 | `subscriptionEndedAt` set | `Canceled` | `Ended on {endedOn}. Choose a plan to start again.` (without the second sentence when `!canSubscribe`) | — |
| 5 | `active` / `trialing`, `cancelAtPeriodEnd` | `Active` | `Ends {renewsOn}` | **Pay the open invoice** (`payUrl`) when an open invoice exists |
| 6 | `active` / `trialing` | `Active` | `Renews {renewsOn}` | as row 5 |
| 7 | `paused` | `Paused` | `Contact support@cadenzpoint.com.` | — |
| 8 | anything else (no subscription, `incomplete_expired`, canceled never paid) and `lifecycleExempt` | `None yet` | *(no small text)* | — |
| 9 | as 8, not exempt, trial not ended or no trial date | `None yet` | `Choose a plan before your trial ends to keep editing.` | — |
| 10 | as 8, not exempt, trial ended | `None yet` | `Choose a plan to keep editing.` | — |

- Rows 1–3 add `You have {openInvoiceCount} open invoices. Manage billing lists them all.` when `openInvoiceCount > 1`.
- **Manage billing** (existing button) sits under the tiles when `hasCustomer`. When `!canSubscribe` and `hasCustomer`, the line beneath reads `Use Manage billing to update your payment method, see invoices or cancel.`
- **Plan cards**, when `canSubscribe`: a heading `Choose a plan` at `sectionOrder` (`BillingClient.tsx:35`), then cards titled `Standard, monthly`, `Standard, annual` and `Enterprise` at `sectionOrder + 1`.
  - **Standard, monthly:** `PRICE_COPY.standardMonthly.price` / `.detail` / `STANDARD_USERS_LINE`; button `Choose monthly`. When `!standardAvailable.month` it is disabled, with the visible line `Not available yet.`
  - **Standard, annual:** the same, with `Choose annual`.
  - **Enterprise:** `PRICE_COPY.enterprise.price` / `.detail`; a link-button `Contact us` → `ENTERPRISE_MAILTO`.
  - Below the cards: `You'll finish on Stripe's secure checkout page. Pay by card or US bank account, and enter a promotion code there if you have one.`
- Statuses are never shown raw. The `?status=success` / `cancelled` alerts and the one 5 s refresh stay.
- `BillingWall` keeps `headerOrder={2}`.

### 6.11 Landing Pricing section (`src/app/page.tsx`, `landing-copy.ts`)
- **Header:** `Features`, then **`Pricing`** (`#pricing`), from the `sm` breakpoint, matching the mockup order.
- **Section** `<section id="pricing" aria-labelledby="pricing-heading">`, after Features:
  - h2 `LANDING_PRICING_HEADING = 'Pricing'` (new in `landing-copy.ts`, Q7);
  - three cards, each title an h3: `Trial`, `Standard`, `Enterprise` (`LANDING_PRICING_CARD_TITLES` in `landing-copy.ts`).
    - **Trial:** `PRICE_COPY.trial.price` / `.detail`; button `Start free trial` (the existing CTA target).
    - **Standard:** the monthly price and detail, then the annual price and detail, then `STANDARD_USERS_LINE`.
    - **Enterprise:** the price as a link to `ENTERPRISE_MAILTO`, plus the detail.
- No "+ tax". The comment at `:50` is updated.

### 6.12 Users page seat line (Q8; `UsersClient.tsx`, `admin/users/page.tsx`)
- `seats` gains `plan`, passed as `displayPlan(plan)` (a legacy `pro`/`starter` row shows the Standard line).
- **Standard:** `{n} active · up to 100`.
- **Enterprise:** `{n} active`.
- **Trial:** unchanged (`… seats free`).
- The drawer line `Uses 1 of {free} free seats` shows on Trial only.
- `users-admin-page.test.tsx:70,134` are updated, and a Standard case is added.

## 7. State machines

### 7.1 Seat sync per tenant (`tenant_seat_billing`)
| State | Event | Next | Side effects |
|---|---|---|---|
| no row | user change committed | due | insert: `sync_due_at = now`, `mark_seq = 1` |
| no row | daily or renewal candidate | clean / failing | step 7 creates the row with `mark_seq = 0` |
| clean | user change | due | `mark_seq + 1`, `sync_due_at = now` |
| due | another change | due | `mark_seq + 1`; `sync_due_at` kept |
| due | run: in-sync / held / updated / lowered / not-applicable / not-standard | clean | step 7 record; compare-and-clear on `mark_seq` |
| due | a change marked during the run | due | `mark_seq` moved, so the clear doesn't match |
| due | run: dry-run | due | nothing written |
| due | run: term race | clean or due (as above) | restore call; alert |
| due | run: failed | due, backing off | `failures + 1`, `next_attempt_at` (capped at 10 min in the renewal window); alert at 3 |
| due | run: busy | due | none |
| clean | daily or renewal run fails | due, backing off | `sync_due_at = COALESCE(…, now)` |
| clean | 24 h pass, subscription active | daily candidate | — |
| clean | the renewal window opens (`current_period_end` within 24 h) | renewal candidate | — |
| clean | run finds Stripe ≠ `stripe_quantity`, or a daily increase | clean | audit `seat-quantity-corrected` → digest |
| failing | run succeeds | clean | `failures = 0`; resolve alert |
| any | tenant not `active` | — | not a daily/renewal candidate; a due mark gets `not-applicable` and clears; the row stays |

### 7.2 The quantity plan (`planSeatUpdates(current, desired, window, interval)`)
"prorate" means `create_prorations` for month, `always_invoice` for year.

| Case | (current, desired, window) | Calls |
|---|---|---|
| equal | (8, 8, any) | none |
| removal mid-term | (8, 6, no) | none (`held`) |
| removal in the window | (8, 6, yes) | D: `6, none` |
| removal below the flat tier, in the window | (4, 2, yes) | D: `2, none` |
| removal below the flat tier, mid-term | (4, 2, no) | none |
| re-add after a mid-term removal | Stripe 8, count back to 8 | none (the quantity never dropped: no charge) |
| increase inside the flat tier | (3, 5, any) | A: `5, none` |
| increase crossing the flat tier | (4, 7, any) | A: `5, none`; B: `7, prorate` |
| increase above the held level | (8, 10, any) (Stripe held at 8, count 10) | B: `10, prorate` |
| count rises but stays under the held level | Stripe 10 held, count 6 → 9, mid-term | none (seats already paid this term) |
| the same, in the window | (10, 9, yes) | D: `9, none` |
| re-add after the drop, still inside the window | (9, 10, yes) | B: `10, prorate` (prorated for the hours left in the term: cents) |
| after the window, before Stripe renews (`now ≥ periodEnd − 300`) | (10, 8, no) | none; the decrease waits for the next window (rule 4: billed for the next term, Q5 note) |

### 7.3 Lifecycle (changes only)
The transition table (`feature-plan-terms-compliance-fixes.md` §4.3) is unchanged except for:
- send_invoice subscriptions: `pastDueSince` recomputed from the invoices on every reconcile, unsuspension when nothing is overdue, and the dunning block keyed on `collectionMethod` (§6.2);
- the new fact fields;
- `plan` is never written while `row.plan === 'enterprise'`;
- the notice kind `bank-payment-failed` (§6.9);
- `shouldReconcile` daily for `send_invoice` (§6.7).

**Send-invoice walk-through:**

| Step | Stripe | App |
|---|---|---|
| founder creates it on the workspace's customer, quantity = active users | `active`, invoice open, due in 30 days | GOOD, full access; `plan standard` (Standard price); `collection_method send_invoice` |
| users added mid-term | proration invoice | §6.4 step 8 finalizes and **emails** it |
| a payment attempt fails before the due date | may turn `past_due` | `pastDueSince` stays null (nothing overdue): no grace; `bank-payment-failed` to admins (Q11); Payment tile "Invoice open"; seat sync continues |
| due date passes unpaid | `past_due` or still `active` | the next reconcile (webhook, or the daily one) sets `pastDueSince` = the earliest overdue due date; `payment-failed` in the invoiced variant; Pay button = that invoice |
| webhook lost | `past_due` | the next daily lifecycle run reconciles (send_invoice); `P` = that due date |
| due + 12 | — | `suspension-warning` |
| due + 15 (and at least 3 days after the warning) | — | suspended (non-payment), unless a payment is processing |
| the overdue invoice paid, another open but not yet due | `past_due` or `active` | `pastDueSince` null; old notices supersede; a non-payment suspension lifts |
| all paid | `active` | GOOD; dunning cleared; unsuspended |

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | `markSeatSyncDue` fails or times out after the user change commits | The change stands; logged and sent to Sentry. The daily check finds it within 24 h and records a correction. |
| F2 | Stripe applies an update but the response is lost (timeout, commit failure, kill) | The row stays due. The next run reads Stripe's real quantity and plans from it. The app stores no billing state, so nothing can drift. The digest notes "changed outside the sync". |
| F3 | Call A succeeds, call B fails | Stripe sits at 5. The next run sends only call B. |
| F4 | Overlapping runs, or the cron and `tenant:admin seat-sync` at once | `seats:` lock: the second waits up to 5 s, then reports `busy`. |
| F5 | Stripe `lock_timeout` (its own renewal is running) | `failed`, backs off (≤10 min inside the window), retried. |
| F6 | Account overdue (`pastDueSince` set), or subscription `unpaid` / `incomplete` / `paused`, or charge-automatically `past_due` | `not-applicable`, no write. When it recovers it's marked due. Users added during the grace are billed from recovery (Q10). An invoiced `past_due` with nothing overdue is still synced. |
| F7 | Annual increase invoice payment fails | The update stands and the subscription goes `past_due`. The app's dunning applies. The Pay button is the earliest overdue open invoice (§6.7). The upgrade invoice gets no Smart Retries. |
| F8 | ACH payment fails while the subscription is active (invoice voided) | `invoice.payment_failed` on a GOOD charge-automatically subscription: admins get `bank-payment-failed` (Terms §4.7), and the founder gets an alert to re-invoice the voided amount. |
| F9 | Checkout finishes with a stale quantity | Marked due on completion and corrected within 10 minutes. |
| F10 | Tenant DB unreachable or slow for the count | Connect ≤10 s, statement ≤5 s, then `failed` with backoff and an alert at 3. Stripe is never written with a guessed count. |
| F11 | A `STRIPE_PRICE_STANDARD_*` value is missing | Checkout refuses that interval. Sync reports `not-standard` plus `seat-sync-unmanaged-price`, and the cron raises `stripe-prices-missing`. |
| F12 | Webhook for a send-invoice `past_due` is lost | The daily lifecycle reconcile finds it; `P` = the due date. |
| F13 | Webhook for a charge-automatically `past_due` is lost | Existing gap. Now visible: `subscription-status-drift` from the seat sync's read. |
| F14 | Portal or Dashboard quantity change | Detected as Stripe ≠ `stripe_quantity` and written to the digest. A raise is held for the term. A cut below the count is raised back, and that raise is **prorated**: if the founder's cut gave no credit, the customer pays twice for those seats for the rest of the term. The runbook forbids hand edits. |
| F15 | Founder subscription on a custom price | Never updated. Alert only if the workspace isn't `enterprise`. The runbook sets the plan first. |
| F16 | Founder subscription on an unlinked customer | Every event raises `stripe-event-unknown-customer`. The runbook's `ensure-customer` prevents it. |
| F17 | `tenant:admin` run with the wrong Stripe mode | Refused unless `--stripe-mode` matches the key; the mode is shown and audited (§6.2). |
| F18 | Seat-cap race (users 100 and 101) | `lockUserRulesExclusive` serializes them; the second is refused. |
| F19 | Webhook for a deleting or deleted tenant | No facts written and no mark, as today. |
| F20 | Stale registry plan right after checkout | `readPlanFresh` (§6.3). |
| F21 | 3→4 users on annual | Call A with `none`; no $0 invoice. |
| F22 | Cron misses runs or a day | Daily and renewal candidates are picked up by the next run. |
| F23 | Failing tenants | Backoff plus `failures ASC` ordering; healthy tenants go first. |
| F24 | Stripe renews between the read and call D | Restore call to the billed quantity, plus an alert (§6.4 step 6). If the restore fails, the alert says so and the founder fixes it in Stripe. |
| F25 | The renewal window passes with every run failing (Stripe or DB outage for a day) | The renewal bills the held quantity. Immediate-email alert after 3 failures inside the window. The founder can credit the difference. |
| F26 | A user is removed in the last 5 minutes before renewal, or after Stripe's renewal is due | Billed for the next term (Q5). |
| F27 | Annual customer adds users in many separate 10-minute windows in one day | At most one invoice per window, and only above the held level. A 21st invoice in one day fails, backs off, and succeeds later. |
| F28 | Suspended for non-payment, admin opens Billing | No accessor that refuses `billing_only`. The count and time-zone read is capped at 3 s and degrades to `seats: null`. The Pay button renders whenever `payUrl` exists. |
| F29 | A send-invoice proration invoice isn't emailed by Stripe, or its response was lost | Step 8 finds every unsent `subscription_update` invoice by its missing marker, finalizes it and sends it. A failure is alerted and retried without blocking the quantity sync. |
| F31 | A subscription schedule is attached (a Dashboard "at period end" change) | Its next phase can reset the quantity at renewal. The runbook only creates one after the drop, with the active count. Otherwise `seat-sync-schedule-attached` is raised (immediate email inside the window). Test-mode check: quantity updates while a schedule is attached. |
| F32 | A renewal falls while the subscription is past due | The held quantity isn't dropped (sync only touches active subscriptions), so removed users are billed on that renewal (Q10 discloses it). |
| F33 | Invoice overdue while Stripe still says active | The app's due-date clock runs regardless: the invoiced `payment-failed`, the warning and the suspension (§6.2). Detection can lag up to 24 h after the due date: no Stripe event fires, and the daily lifecycle run reconciles invoiced subscriptions. In that window the seat sync may still update the subscription. |
| F34 | Stripe marks an invoiced subscription `past_due` before any invoice is due | `pastDueSince` stays null: no grace, no suspension. A failed attempt emails admins (Q11). Seat sync continues. Payment tile "Invoice open" (§6.2, S39). |
| F35 | The overdue invoice is paid while a newer one isn't due yet | `pastDueSince` returns to null and the suspension lifts, even if Stripe stays `past_due` (S42). `invoice.paid` triggers it at once. A founder **void** (no subscribed event) is picked up by the daily run, within 24 h. |
| F37 | The founder switches a charge-automatically subscription to invoicing while a charge is unpaid | The open charge invoice (no due date) still counts as overdue since `pastDueSince` (§6.2), so the dunning and any suspension continue. Runbook: switch only with no invoice open, or void and re-issue it as a send-invoice invoice. |
| F36 | An invoice is marked uncollectible | Invoiced dunning reads only `open` invoices, so it drops out of the clock. The founder's 9.5 setting keeps invoices open ("leave as-is"). The Pay button falls back to an uncollectible invoice's hosted URL. |
| F30 | An older overdue invoice is hidden behind a newer invoice | Invoiced: the due-date clock reads every open invoice. `payUrl` uses the earliest overdue open invoice. |

## 9. Platform limits
- **Vercel:**
  - `seat-sync` has `maxDuration` 300 s, and no new tenant starts after 100 s. The worst case per tenant is about 190 s (§6.5); the typical case is about 1 s.
  - `getTenantBillingInfo` adds one tenant-DB read, capped at 3 s, and, for any tenant with a tracked subscription, one `invoices.list` (5 s timeout), plus an `uncollectible` list only when no open invoice exists. The reads run in parallel (`Promise.all`), so the worst case is about 5 s, not 13 s.
- **Neon:**
  - The `seats:` lock uses one connection of the dedicated 3-connection pool at a time.
  - `markSeatSyncDue` uses the request pool, with lock and statement timeouts of 1 s and 2 s.
  - The tenant count uses `clientFor` (`connect_timeout: 10`) with a 5 s statement timeout.
- **Stripe:**
  - Quantity updates: at most 2 per subscription per run, so 24 an hour (limit 200).
  - Invoices: at most one per run, and only above the held level (limit 20 a day).
  - Global calls are sequential.
  - Lifecycle in-lock calls stay at 3 or fewer: the runner's lazy loader is the same read it already makes (§6.2).
- **Crons:** 5 in total, two of them every 10 minutes (`notice-delivery` and `seat-sync`) (Vercel Pro, already required).

## 10. Blast radius

### 10.1 Changed
| File | Change |
|---|---|
| `src/lib/billing/plans.ts` | New model (§6.1) |
| `src/lib/billing/plan-copy.ts` | **New**: client-safe strings |
| `src/lib/billing/seat-sync.ts` | **New**: `syncSeatQuantity`, the pure `planSeatUpdates`, `markSeatSyncDue`, `seatMarkStore` |
| `src/server/internal/plan-source.ts` | **New**: `readPlanFresh` (its own module, so suites can mock it) |
| `src/lib/billing/stripe-state.ts` | Snapshot fields; `OpenInvoiceState` gains `dueDate`, `hostedUrl`; `listOpenInvoicesForSubscription` |
| `src/lib/billing/subscription-transitions.ts` | Interval, cancel flag, collection method, the send_invoice `invoiceOverdueSince` rules |
| `src/lib/billing/reconcile.ts` | The lazy `loadOpenInvoices` option and `invoiceOverdueSince`; Enterprise protection; `becameGood`; drift resolve |
| `src/lib/tenant/lifecycle.ts` | `bank-payment-failed` kind and supersession; `LifecycleFacts.collectionMethod`; the dunning block condition; `shouldReconcile` for send_invoice |
| `src/lib/tenant/lifecycle-runner.ts` | Pass the lazy invoice loader to `reconcileInLock` and reuse its memoized result; `collectionMethod` to `shouldReconcile`; mark due on `becameGood`; `toCancel` invoiced rule, DUNNING-filter exclusion and de-dup; `cancelInOwnSection` invoice read first and the paid check for send_invoice |
| `src/lib/tenant/registry.ts` | `toLifecycleFacts` maps `collectionMethod` |
| `src/lib/tenant/notices.ts`, `src/lib/email/templates/invoice-overdue.tsx`, `bank-payment-failed.tsx` (**new**) | Variants, the new kind, the clamped stated date |
| `src/db/control-plane/schema.ts` + migration | Columns, table |
| `src/db/control-plane/locked.ts` | `withSeatLock` |
| `src/server/internal/seats.ts` | Fresh plan input, `countActiveUsers(row)`, limits, message |
| `src/server/actions/users.ts`, `import.ts` | Pre-read plan; `markSeatSyncDue` after commit |
| `src/server/actions/billing.ts` | Checkout by interval, ACH, promo codes, new billing info, `payUrl` rule |
| `src/app/api/stripe/webhook/route.ts` | Two events, notices, alerts, unknown customer, seat marks |
| `src/app/api/cron/seat-sync/route.ts` | **New** |
| `src/lib/cron/heartbeat.ts`, `vercel.json` | Fifth cron |
| `src/lib/tenant/ops-digest.ts` | Corrections section |
| `src/lib/tenant/admin-commands.ts`, `scripts/tenant-admin.ts` (+ header env list) | `set-plan`, `ensure-customer`, `seat-sync`, Stripe-mode guard, `show` fields |
| `src/app/(app)/settings/billing/BillingClient.tsx`, `page.tsx` | Redesign |
| `src/app/(app)/admin/users/UsersClient.tsx`, `page.tsx` | Seat line (Q8) |
| `src/app/page.tsx` (+ CSS module), `src/lib/marketing/landing-copy.ts` | Pricing |
| `.env.example`, `DEPLOY-DEMO.md` Part 10 | New price variables; the old ones removed |
| `PRODUCTION-DEPLOY.md` | Env table; 9.1, 9.2, 9.3, 9.5; the 9.x check line; 12.8 and 12.8b; new runbook (§12) |
| Tests in §3.8 | Updated |
| Suites in §3.8 that call the seat-taking actions | Each declares, **at the top level of the test file** (vitest hoists `vi.mock` to the file top, so a helper function can't wrap it), with the plan held in a `vi.hoisted` state object the suite already uses: `vi.mock('@/server/internal/plan-source', () => ({ readPlanFresh: async () => tenantState.plan }))`. It also mocks `@/lib/billing/seat-sync` with `markSeatSyncDue: vi.fn(async () => {})`. That one is optional, since `markSeatSyncDue` never throws, but it avoids Sentry noise and FK errors on fake tenant ids. Suites that mock the actions wholesale (`import-page`, `import-row-errors`, `users-row-actions`) need nothing. Billing suites (S-tests) use the real modules. |
| `src/__tests__/unit/action-result.test.ts` | New `assertSeatsAvailable(n, tx, plan)` signature |
| `unit/lifecycle.test.ts`, `integration/account-security.test.ts`, `mfa-signin.test.ts`, `tenant-admin.test.ts` (facts literals) | Unchanged (`collectionMethod` is optional); add send_invoice cases to `lifecycle.test.ts` |
| `src/lib/billing/pay-url.ts` | **New**: `choosePayInvoice` (pure) |
| `src/lib/cron/heartbeat.ts:7` comment, `scripts/smoke-tenancy.sh:80` (cron probe list), `PRODUCTION-DEPLOY.md:126` and 13.5 ("the four jobs") | Fifth cron |
| `src/__tests__/unit/server-action-guards.test.ts:125` | Allowlist reason text for `getTenantBillingInfo` |
| `integration/fakes/fake-stripe.ts` | The following additions: |

Additions to `integration/fakes/fake-stripe.ts`:
- `subscriptions.update`: items with `id`, `quantity`, `price.recurring.interval`; params and options capture; a response with `current_period_start`.
- `current_period_start`, `current_period_end`, `cancel_at_period_end`, `collection_method` on subscriptions.
- Invoices with `due_date`, `billing_reason`, `created`, `metadata`, `hosted_invoice_url`; a list by `subscription` and `status`.
- `finalizeInvoice`, `sendInvoice` (records sends), `update`.
- `checkout.sessions.create` params capture.
- A **failAfterApply** failure mode: apply, then throw.
- A **blocking hook**: a promise the test resolves.
- A **renewOnNextUpdate** switch: the update response shows a new period.

### 10.2 Checked, unchanged
- `provisionTenant` and the seeders (no subscription).
- `deleteTenant` (`reconcileInLock` with `allowDeleting`; the new fields are harmless).
- `BillingWall` (renders the new client).
- The Terms (§4.1–4.3 are already per-user; §4.8 is unaffected, since no credits are issued).
- `setUserApprover`.

## 11. Required tests (each must fail without the change it proves)
**Unit:**
- **U1** — `plan-copy`:
  - every §1 string equals §1 byte for byte (8 price strings, the mailto, the cap message);
  - `STANDARD_USERS_LINE` equals the §6.1 value (a Q7 string, not a §1 one);
  - `TRIAL_DAYS === 30`.
- **U2** — `planSeatUpdates`: every row of §7.2, for both intervals.
- **U3** — plan helpers:
  - `seatLimitFor`: trial 10, standard 100, enterprise null, legacy `pro`/`starter` 100, unknown 10;
  - `displayPlan` for each of those values.
- **U4** — dunning anchor:
  - send_invoice with `invoiceOverdueSince` set → `pastDueSince` = it, and `payment-failed` is enqueued; when it later moves → updated, and the old notice supersedes;
  - send_invoice with `invoiceOverdueSince` null while suspended for non-payment → `pastDueSince` null and unsuspended; while policy-suspended → stays suspended;
  - send_invoice, Stripe GOOD, overdue, suspended for non-payment, same anchor → stays suspended, `suspendedAt` unchanged, no new notice (no daily unsuspend and re-suspend);
  - send_invoice, anchor moves **later** while suspended → unsuspended, `pastDueSince` = the new date, `payment-failed` for it; anchor moves earlier → stays suspended;
  - send_invoice, ended and still overdue, Stripe GOOD → patch has no `subscriptionEndedAt`/`deletionScheduledFor` change (no revival); ended and nothing overdue → the generic GOOD revival;
  - `invoiceFacts: skipped` (deleteTenant) → no dunning or suspension field in the patch;
  - switched collection method: an open invoice with `due_date null` and `pastDueSince` set → `invoiceOverdueSince = pastDueSince`, stays suspended (M1 of pass 5);
  - `computeInvoiceOverdueSince` on an **ended** tenant (`pastDueSince` null, `endedAt` E) with a null-due-date invoice → E, which counts as old debt: no revival (M1 of pass 6). That the tenant stays in `toCancel` is asserted in S44 (integration), since `toCancel` is built inside `evaluateInLock`;
  - `isOverdue` for null and dated invoices against a cutoff;
  - ended at E, a new invoiced subscription with a debt due after E → revived (`subscriptionEndedAt` null) and the grace starts; debt due on or before E → status only;
  - suspended with an earlier `P2` → keeps `P1`;
  - same anchor → `payment-failed` pushed again (revives a superseded unsent row; `enqueueNotice` dedups otherwise);
  - charge_automatically → `now`;
  - an existing anchor is kept;
  - charge_automatically DUNNING → `now` on first sight, kept afterwards (unchanged);
  - `nextLifecycleActions`: send_invoice with `P` set and Stripe `active` → warning, then suspension on the due-date clock;
- **U5** — GOOD reconcile (also: GOOD send_invoice with an open invoice not yet due → `plan 'standard'` and `planInterval` written):
  - on the annual price → `plan 'standard'`, `planInterval 'year'`;
  - on an unknown price → neither is set;
  - `cancelAtPeriodEnd` and `collectionMethod` are always patched.
- **U6** — Billing UI (`billing-ui.test.tsx`):
  - every rule in the §6.10 lists and table, including the precedence cases (exempt, demo with no trial date, ended Standard, interval null, `payUrl` null, paused, incomplete with a link, several open invoices, "Billed for {q} users until {date}");
  - the labels;
  - no raw status;
  - cards hidden when `!canSubscribe`, including closed;
  - the Enterprise mailto;
  - "1 day left" and "1 active user";
  - heading levels for `headerOrder` 1 and 2;
  - "Not available yet.";
  - **BillingWall renders the pay button for a suspended `billingInfo`** (the S20 render half).
- **U7** — Landing:
  - Pricing contains every price, detail and users line, and the mailto;
  - h3 card titles;
  - no "tax";
  - header order: Features, then Pricing.
- **U8** — Static (source-scanner): `updateUser`, `createUserWithPassword` and `bulkImportEmployees` call `markSeatSyncDue` after their transaction; `setUserApprover` doesn't.
- **U9** — Emails:
  - `InvoiceOverdueEmail` and `BankPaymentFailedEmail` render the Q4 and Q6 text;
  - the stated suspension date clamps to `now + 3 days`.
- **U10** — `shouldReconcile`: true for a GOOD send_invoice mirror; false for a GOOD charge_automatically mirror inside its period (the second is a regression guard).
- **U11** — Users seat line:
  - Standard `7 active · up to 100` with no drawer line;
  - Enterprise;
  - Trial unchanged.
- **U12** — `isNoticeSuperseded`:
  - `'bank-payment-failed'` is false except for `deleting`/`deleted`;
  - `payment-failed` supersedes itself when the send_invoice `pastDueSince` moves (a **regression guard**: passes on today's code too).
- **U13** — `payUrl` choice (pure helper): the earliest-created null-due-date open invoice first (two null-due invoices → the older); then the earliest open invoice with `due_date <= now`; else the earliest open one; null when there are none.

**Integration** (fake Stripe and real Postgres; billing suites use the real `plan-source` and `seat-sync`):
- **S1** — Monthly, 8 users at Stripe 8:
  - create a user → due → cron → one update, 9, `create_prorations`; clean; `stripe_quantity 9`;
  - the very first run on that subscription (no seat row yet) writes **no** `seat-quantity-corrected`.
- **S2** — The same on annual → `always_invoice`.
- **S3** — Deactivate one mid-term → outcome `held`, no update (Stripe 8). Reactivate → no update (Q1).
- **S4** — Deactivate one, then a renewal run with `current_period_end` 12 h away → call D to 7, `none`. With 4 minutes left → no call.
- **S5** — 3→4 users on annual → one call A with `none`, never `always_invoice`.
- **S6** — Bulk import of 30 users:
  - from 8 users (Stripe 8) → exactly **one** update (B, 38);
  - from 2 users (Stripe 2) → A to 5 `none`, then B to 32.
- **S7** — A change marked during a run (blocking hook between the read and the update) → still due after the run (`mark_seq` moved); the next run serves it.
- **S8** — `failAfterApply` on call B (Stripe applies 8→10, the call throws):
  - `failed`, still due;
  - the next run is `in-sync` with no update call, and the audit event "changed outside the sync";
  - then deactivate 2 and reactivate 2 → no prorated call.
- **S9** — Term race: `renewOnNextUpdate` during call D → restore call to `from`, alert `seat-sync-term-race`.
- **S10a** — Send-invoice on the linked customer, invoice open and not yet due → GOOD.
- **S10b** — Past due, with an older invoice overdue 3 days and a newer proration invoice not yet due:
  - `pastDueSince` = the older due date;
  - the invoiced notice variant;
  - `getTenantBillingInfo().payUrl` = the older invoice's URL.
- **S10c** — At due + 15, after the warning → suspended.
- **S10d** — Paid → unsuspended.
- **S10e** — Lost webhook: the mirror says `active`, Stripe says `past_due`, no event → the lifecycle cron reconciles and anchors on the due date. Stripe `active` with an overdue open invoice (older invoice behind a newer paid one) → the same anchor, the invoiced notice, then suspension at due + 15. **A second lifecycle run after the suspension** → still suspended, the same `suspendedAt`, no new `suspended` notice row.
- **S45** — Ended tenants: a terminated invoiced tenant whose Stripe subscription is still `active` → the seat sync returns `not-applicable`, and the tenant isn't a daily or renewal candidate. The Payment tile shows "Canceled", not "Invoice open". `toCancel` has no duplicates.
- **S46** — Invoiced recovery while Stripe stays `active` (`pastDueSince` set → null) → `becameGood` true and the tenant is marked due.
- **S44** — Invoiced termination: Stripe `active`, invoice overdue, suspended → 30 days later terminated → the tracked subscription is in `toCancel` and is canceled (fake), its invoices voided. The next run stays ended, with no revival and no new notices.
- **S10f** — Annual send-invoice, users added → update, then `finalizeInvoice`, `sendInvoice` and the metadata marker.
  - With `sendInvoice` throwing → alert, quantity still recorded (not blocked); the next run sends it and the alert resolves.
  - An invoice whose update response was lost (`failAfterApply`) is still found and sent.
- **S11** — `past_due` → `not-applicable`, no update, `subscription-status-drift` raised (mirror active). Active via webhook → marked due, drift resolved.
- **S12** — Enterprise handling:
  - a custom-price subscription → `not-standard`, never updated, `seat-sync-unmanaged-price` unless the plan is enterprise;
  - `set-plan enterprise` → no cap at 101, and the alert resolves;
  - a webhook on GOOD keeps `plan 'enterprise'`;
  - `set-plan standard` is refused unless the plan is enterprise;
  - audit written.
- **S13** — Cap: user 101 on Standard via create, reactivate and import → the exact message; user 100 allowed; trial unchanged at 11.
- **S14** — The registry cache says trial while the row says standard → user 11 allowed.
- **S15** — Checkout:
  - the session has `us_bank_account`, `allow_promotion_codes: true`, quantity equal to the count, and the interval's price;
  - an invalid interval is refused;
  - more than 100 users → the cap message;
  - works when suspended for non-payment (the count comes through the row's URL). Fixture: the row is suspended and Stripe has nothing LIVE or `incomplete` (a terminated subscription), so the duplicate check passes;
  - "That plan is not available yet." when the interval's price env is empty;
  - the interval is validated after the guard: an unauthenticated call with a bad interval gets the auth refusal;
  - the duplicate check is unchanged.
- **S16** — Webhooks:
  - `invoice.payment_failed` on a GOOD charge-automatically subscription → `bank-payment-failed` enqueued (anchor `invoice.created`) plus an alert;
  - on GOOD send_invoice → also `bank-payment-failed` (Q11; see S38), keyed on `pastDueSince` null;
  - on past_due → only the existing `payment-failed`;
  - `checkout.session.async_payment_failed` with the subscription `incomplete` → `bank-payment-failed` (anchor `session.created`) plus an alert;
  - with the subscription GOOD → alert only (the invoice event sends the email, so there's one email);
  - unknown customer → `stripe-event-unknown-customer`;
  - `checkout.session.completed` and `customer.subscription.created` → marked due.
- **S17** — Daily check: Stripe edited to 3 with 7 active (stored 7) → corrected to 7; audit "changed outside the sync"; the digest line.
- **S18** — `seatMarkStore.upsert` made to throw, and separately to hang 5 s → `createUserWithPassword` still succeeds, within about 3 s for the hang.
- **S19** — Two concurrent syncs, the first held by the blocking hook for more than 5 s → the second is `busy`; one update in total.
- **S20** — Suspended for non-payment → `getTenantBillingInfo()` resolves with `payUrl`. With the tenant-DB read failing fast → `seats: null`.
- **S21** — 3 consecutive failures → `seat-sync-failing`, backoff of 10, 20, 40 min; success resolves it. Inside the renewal window → backoff capped at 10 min and an immediate-email alert.
- **S22** — Budget: 10 failing due rows, all eligible (`next_attempt_at <= now`), plus 1 healthy due row with `failures 0` → the healthy row is served first.
- **S23** — A due mark on a deleting tenant → `not-applicable`, cleared; a webhook for a deleting tenant marks nothing.
- **S24** — `ensure-customer` creates and links once; a second run prints the same id; audited with `livemode`. A mode mismatch is refused.
- **S25** — A run stopped by the budget → `cron-incomplete:seat-sync` via `raiseAlert`; a complete run resolves it.
- **S26** — The lifecycle runner's `becameGood` marks the tenant due.
- **S27** — `tenant:admin seat-sync` without `--yes` makes no Stripe write and no row write.
- **S28** — Renewal candidates: a tenant with no user change, Stripe 10 held, count 8, `current_period_end` 6 h away → picked by the next run, call D to 8.
- **S29** — Lazy loader: a charge_automatically reconcile never calls `loadOpenInvoices`; a send_invoice one calls it once, and the runner reuses the result (one invoice list in the lock).
- **S30** — Schedule attached with a next-phase quantity different from `desired` → `seat-sync-schedule-attached` raised, and the sync continues. Inside the window the alert is emailed. The fake gains `subscriptionSchedules.retrieve`.
- **S31** — Item rules: two items (Standard plus another) → `not-standard` with `seat-sync-unexpected-items`. Missing subscription → `seat-sync-subscription-missing`. A `trialing` subscription → `not-applicable`, no drift.
- **S32** — Config check: a price env emptied while an active subscription exists → `stripe-prices-missing`; restored → resolved.
- **S33** — Marks:
  - an `updateUser` rename makes no mark;
  - a bulk-import dry run makes no mark;
  - `checkout.session.async_payment_succeeded` marks;
  - `cancelInOwnSection`'s `becameGood` marks.
- **S34** — Renewal at risk: a failure inside the window opens `seat-sync-renewal-at-risk` with an email even when `seat-sync-failing` is already open. A step-2 failure inside the window (tenant DB down) still backs off at most 10 minutes (window from the mirror).
- **S35** — Step 8 retry: when `sendInvoice` throws, or two unsent invoices exist, the row is due again with `next_attempt_at` 10 minutes ahead. A concurrent manual run and cron run send once (lock).
- **S36** — Term race with a failed restore → the alert detail says the restore failed.
- **S37** — The S20 timeout branch: the tenant-DB read hangs → `getTenantBillingInfo` resolves within about 3 s with `seats: null`. The hang comes from a seam: `countActiveUsers` and `readWorkspaceTimeZone` go through an exported `billingTenantReads` object, which the test stubs with a never-resolving promise.
- **S39** — Send_invoice past due before the due date: the fake subscription is `past_due` with one open invoice due in 10 days →
  - no `pastDueSince`, no `payment-failed`, Payment tile "Invoice open", and the seat sync still syncs it;
  - `invoice.payment_failed` for that invoice → `bank-payment-failed` (Q11);
  - the lifecycle run after the due date → `pastDueSince` = that due date, the invoiced `payment-failed` is sent (within about 24 h of the due date: no Stripe event fires then, and the runner is daily).
- **S40** — Billing page for an invoiced subscription that is overdue while Stripe says `active` → Payment row 2 with the Pay button. Uncollectible-only → the Pay button uses the uncollectible invoice.
- **S41** — Schedule: next-phase quantity equals `desired` → no alert; differs → alert; schedule removed → resolved.
- **S38** — Q11: `invoice.payment_failed` on a GOOD send_invoice subscription → `bank-payment-failed` (anchor `invoice.created`). A second event for the same invoice → no second notice. With `pastDueSince` set → no `bank-payment-failed` (the `payment-failed` covers it). ACH checkout failure with the subscription `incomplete` → exactly one `bank-payment-failed` (from the session event); the `invoice.payment_failed` for its invoice adds none.
- **S42** — Invoiced: invoice A overdue (P = A's due date, suspended), then A is paid while B is open and not yet due, and Stripe stays `past_due` → `pastDueSince` null, unsuspended, no warning; the old notices are superseded. Variant: B is overdue by 1 day when A is paid → unsuspended, `pastDueSince` = B's due date, a new `payment-failed`; the warning at B + 12 and suspension at B + 15.
- **S43** — Alerts kept out of the seat transaction: a spy on `raiseAlert`/`raiseAlertWithEmail` records no call before the `withSeatLock` transaction ends. A throwing post-commit alert write leaves the outcome unchanged (not `failed`).

## 12. Founder steps (PRODUCTION-DEPLOY changes the dev writes)
- **9.1**
  - One Product, **CadenzPoint Standard**, with two **graduated** Prices exactly as `BUSINESS-DECISIONS.md` §1:
    - monthly: users 1–5 flat $50 at $0 per unit, users 6+ at $10;
    - yearly: users 1–5 flat $510 at $0 per unit, users 6+ at $102.
  - Put the IDs in `STRIPE_PRICE_STANDARD_MONTHLY` and `STRIPE_PRICE_STANDARD_ANNUAL`.
  - Coupon: 20% off, repeating, 24 months; "applies to" per Q9.
  - Promotion code `FOUNDING`, max 10 redemptions.
  - **Settings → Payment methods:** turn on **ACH Direct Debit**.
- **9.2** — The ten events: the eight, plus `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`. If the Dashboard offers it, set the endpoint API version to `2025-02-24.acacia`. It isn't required: the webhook never trusts payload state, and `invoiceSubscriptionOf` already reads both shapes.
- **9.3** — Customer portal: payment method update, invoice history, cancel at end of billing period. **Plan switching off. Quantity changes off.**
- **9.5**
  - Failed payments: leave the subscription past due (unchanged). Invoices sent to customers: leave past due.
  - Leave "subscription status resolution" at Stripe's default; the app doesn't depend on it (§6.2).
  - For failed payments and for invoices sent to customers, set the **invoice** outcome to **leave the invoice as-is (open)**, never "mark uncollectible".
- **Env table and the ✅ check line:** two price IDs.
- **New runbook, "Invoiced and Enterprise subscriptions"** (env: the control-plane URL, `ENCRYPTION_KEY`, and the `STRIPE_SECRET_KEY` of the intended mode):
  1. For Enterprise only, **first**: `npm run tenant:admin -- set-plan <slug> enterprise --yes`.
  2. `npm run tenant:admin -- ensure-customer <slug> --stripe-mode live --yes` (on staging: `--stripe-mode test`) → `cus_…`. In the Dashboard, set that customer's **email** to the person who pays invoices. Stripe can't send invoices without one.
  3. In the Dashboard, create the subscription **on that customer**:
     - the Standard price for per-user invoicing, with **quantity = the live active-user count** printed by `tenant:admin show <slug>` (needs `ENCRYPTION_KEY`); or a custom price for Enterprise;
     - collection method "Send invoice", net 30, for invoiced customers.
  4. `tenant:admin show <slug>` shows the subscription as GOOD within a minute.
  5. Don't edit the quantity of a Standard subscription by hand; the app manages it. A raise is billed until renewal. A cut below the active count is raised back with proration, which charges the customer twice if your cut gave no credit.
  6. Switching between monthly and annual on request (Q2): **only inside the last day before renewal.**
     - First run `tenant:admin seat-sync <slug> --stripe-mode live --yes` and check in `show` that the seat row's `stripe_quantity` equals the live active count.
     - Then, in the Dashboard, schedule the price change at the period end with that quantity.
     - After the renewal, release the schedule (Dashboard → subscription → schedule → Release) and confirm in `show` that the subscription has no schedule.
     - Scheduling earlier freezes an older quantity into the next term; the app then raises `seat-sync-schedule-attached`.
  7. When an Enterprise contract ends and the customer moves to self-serve Standard: `set-plan <slug> standard --yes`.
  8. To move a card or ACH customer to invoicing, switch the collection method only when no invoice is open. Otherwise void the open invoice and re-issue it as a "send invoice" one with a due date. An open card invoice keeps being chased from the original failure date. The **reverse** switch (invoicing to card) only once every invoice is paid or voided: a card subscription follows Stripe's status, which can drop an unpaid invoice's dunning.
  9. For a terminated workspace, cancel the old subscription in the Dashboard **before** creating a new one; otherwise the old GOOD subscription stays tracked and the tenant stays ended (only `duplicate-live-subscriptions` shows it).
- **12.8** — Have **at least 5 active users** first (below 5 an add is inside the flat tier: +1, no proration). Subscribe monthly with card 4242 (quantity = active users). Add a user; within 10 minutes the subscription shows +1 and a pending proration.
- **12.8b, new steps:**
  - **Annual:** add users above 5 → an immediate invoice. Deactivate and reactivate → no change and no invoice.
  - **Renewal window** (no test clock: it moves Stripe's time, not the app's):
    1. On a throwaway workspace, `ensure-customer --stripe-mode test --yes`. In the Dashboard, attach test card 4242 to that customer as its default payment method.
    2. In the Dashboard, create a Standard monthly subscription on that customer with a **billing cycle anchor about 12 hours ahead**, so `current_period_end` falls inside the real next 24 h. Quantity = the live count.
    3. Deactivate a user → within 10 minutes call D lowers the quantity with no proration. Then, after the real renewal, the renewal invoice bills the lower count.
    4. The existing 12.8b step 2's "or use Stripe's test clock" is replaced by the card `4000 0000 0000 0341` path only.
  - **ACH checkout:** choose the **Test Institution** in Financial Connections for instant verification. With manual entry, verify with the microdeposit amounts 32 and 45. Record the subscription status while the payment is processing. Use the failure account `000111111116` for the `bank-payment-failed` email.
  - **Promotion code:** `FOUNDING` at checkout.
  - **Send-invoice subscription,** made per the runbook with `days_until_due: 1`:
    - added users → the proration invoice is **emailed**;
    - left unpaid → within about a day of the due date, the invoiced email, and the Pay button opens the overdue invoice;
    - paid → `pastDueSince` clears and the Payment tile returns to Active.
  - **Record the §4 test-mode checks in §15:**
    - a $0 invoice in the flat tier;
    - a send-invoice proration invoice that is draft or open;
    - an overdue `auto_advance: false` proration invoice moves the subscription to `past_due`;
    - quantity updates on a `past_due` subscription;
    - the ACH status while processing;
    - Checkout with quantity > 1;
    - a quantity update while a subscription schedule is attached;
    - a long `withSeatLock` section (several Stripe calls) isn't cut by Neon's pooler (idle-in-transaction timeout);
    - whether Stripe itself emails a send_invoice `subscription_update` invoice (if it does, step 8's `auto_advance: true` skip prevents a second email; record the invoice's `auto_advance`);
    - a failed card on the hosted page of a not-yet-due send-invoice invoice: record the subscription status and **whether `invoice.payment_failed` fires** (Q11 depends on it; if it doesn't, the lead brings the product owner a follow-up before launch);
    - a schedule with `end_behavior: 'renew'` and no next phase: does it freeze the quantity at renewal? (If so, the schedule check treats it as a next phase with that quantity.)

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine, in this order:
   1. `npm run db:migrate:cp` (local control plane) and `npm run demo:local`;
   2. `TZ=America/New_York REQUIRE_CONTROL_PLANE_TESTS=1 npm run test:integration`;
   3. `npm run build`.
3. The lead writes `PER-USER-BILLING-BROWSER-CHECKS.md` after acceptance and runs it in the preview browser (`app-dev`):
   - the Billing page states, set through `tenant:admin` and SQL fixtures on a throwaway workspace;
   - the checkout redirect;
   - landing Pricing;
   - the Users seat line and the cap message;
   - the BillingWall pay button while suspended.
   - Steps that need a Stripe test key run at staging (§12).

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first, then stop for the lead's review.
- Stage files by name: the lead's uncommitted docs share the tree.
- Never call real Stripe from tests. The fake grows only the behaviours listed in §10.1.
- The strings in §6.1, §6.7, §6.9, §6.10, §6.11 and §6.12 are exact. Don't reword them.

## 15. Pre-mortem log
**Round 1** (two independent reviewers, 2026-11-15). Server half: 1 HIGH, 6 MEDIUM, 11 LOW. Rules/UI/tests half: 2 HIGH, 5 MEDIUM, 7 LOW. All fixed in v2:
- the paid level lost on failure paths;
- billing info unreachable in `billing_only`;
- no way to link founder-made subscriptions;
- `mark_seq`;
- send-invoice proration sending;
- send_invoice reconcile;
- backoff;
- the unmanaged-price alert;
- the budget;
- the Users page wording (Q8);
- complete tile lists;
- no self-serve plan switching (Q2);
- the ACH failure email (Q6);
- test rewrites;
- plus the LOW items.

**Round 2** (two fresh reviewers, on v2). Server half: 5 MEDIUM, 13 LOW. Rules/UI/tests half: 5 MEDIUM, 13 LOW. Fixed in v3:
- **Redesign of the quantity sync** (server M1, M2): v2 tracked a per-term "paid level" in the app, which lost writes, term races and early-return paths could corrupt. v3 keeps no billing state: the quantity only rises mid-term and comes down in the last day before renewal (Q1 reworded), with a restore call on a term race. This also removes the lost-record and new-term detection problems.
- **Send-invoice proration invoices** (server M3; rules M5): a stateless step 8 that finds unsent invoices by a metadata marker and never blocks the quantity sync.
- **Older overdue invoices masked by newer ones** (server M4; rules M1): earliest-overdue `payUrl` and `overdueSince`, the "all invoices" setting, the overdue-but-active alert, S10b.
- **Pool and row lock across Stripe calls** (server M5): writes come last, `markSeatSyncDue` gets lock and statement timeouts, explicit Stripe options.
- **Existing suites broken by the new seams** (rules M2): `plan-source` module, `mockBillingSeams`, suites listed, `action-result.test.ts`.
- **Stripe test/live mix-ups in `tenant:admin`** (rules M3): the `--stripe-mode` guard, with `livemode` audited.
- **S18 untestable as written** (rules M4): the `seatMarkStore` seam.
- **LOW items written in:**
  - the bank-payment-failed trigger narrowed to GOOD charge-automatically, with one email per failure and generic wording;
  - lifecycle in-lock call count (the runner passes invoices);
  - budget recomputed;
  - failed daily runs become due;
  - dry runs write nothing;
  - outcome and state-table completeness;
  - S21/S22 eligibility;
  - drift and unmanaged alerts resolve, with the runbook order;
  - customer email and quantity in the runbook;
  - the founder's Dashboard-edit warning;
  - the Enterprise sticky note (runbook plus `set-plan standard`);
  - the exempt Payment row;
  - labels and titles spelled out;
  - the 3 s cap on the billing count;
  - S20 split into unit and integration;
  - legacy keys mapped to 100;
  - corrections recorded whatever the reason;
  - microdeposits and Test Institution;
  - verification order;
  - missing tests (S26–S28, U12, U13);
  - an incomplete-payment link;
  - Q4 button note;
  - Q10 (users added during the grace).

**Confirmation pass 1** (two fresh reviewers, on v3). Server half: 2 MEDIUM, 10 LOW. Rules/UI/tests half: 4 MEDIUM, 20 LOW; one MEDIUM was the same as the server half's. It found no double-charge or stuck path in the v3 sync. Fixed in v3.1:
- **Overdue invoice on a still-active subscription emailed no one** (Terms §4.7): the new `invoice-overdue` notice (Q4 second text), with "All invoices" made a launch gate (§6.2, S29).
- **Runbook step 6 created a Stripe schedule that resets the quantity at renewal:** switch only inside the last day, after the sync; `seat-sync-schedule-attached` alert; test-mode check (§6.4, §12, S30, F31).
- **Staging renewal check relied on a test clock,** which moves Stripe's time but not the app's: replaced by a billing-cycle anchor about 12 h ahead (§12).
- **Failed payment on an invoiced subscription emailed no one:** Q11, with the trigger widened to any GOOD subscription (§6.9, S38).
- **`mockBillingSeams` was unworkable under vitest hoisting:** per-suite top-level `vi.mock` (§10.1).
- **LOW items written in:**
  - renewal-at-risk alert per renewal, and a mirror-based backoff cap;
  - Q10 now discloses renewals during the grace;
  - step 8 under its own lock, with a 10-minute retry;
  - drift resolves in `reconcileInLock`, and `trialing` raises no drift;
  - no correction on a subscription's first run (`stripe_subscription_id` on the seat row);
  - `overdueSince` skipped for ended and deleting tenants;
  - Q5 now says ~15 minutes;
  - `cron-incomplete` kind with dedup `seat-sync`;
  - dry runs skip alerts;
  - the exactly-one-item rule;
  - F14 consequence spelled out;
  - Q1 and invariant 7 exceptions;
  - Users tile cancel variant and null-date rule;
  - Payment row 3 wording;
  - exempt Plan tile;
  - `show` prints the live count;
  - runbook mode for staging;
  - 12.8 needs at least 5 users;
  - API version "if offered";
  - guard-first ordering for the interval and `readPlanFresh`;
  - `pay-url.ts` module;
  - `.catch` on raced promises;
  - blast-radius additions (heartbeat comment, `smoke-tenancy.sh`, PRODUCTION-DEPLOY :126 and 13.5);
  - U1 users line;
  - new tests S29–S38;
  - `displayPlan` on the Users page;
  - S15 fixture;
  - `cancelInOwnSection` mark.

**Confirmation pass 2** (one fresh reviewer, whole blueprint, on v3.1): 1 MEDIUM, 12 LOW. It found no double-charge or stuck path. Fixed in v3.2:
- **MEDIUM — an invoiced subscription marked `past_due` before any invoice was due would start the grace from today:** the `not-yet-due` anchor, with no grace and no email until the due date passes; a founder alert; the two staging checks, including whether `invoice.payment_failed` fires for hosted-page attempts (Q11) (§6.2, S39, F34).
- **LOW items written in:**
  - a 24 h margin on overdue-but-active, so there's no duplicate email at the due date;
  - Payment row 4b, with open invoices listed for GOOD subscriptions too, so the emails' "Go to Billing" has something to act on;
  - the schedule alert only when the next-phase quantity differs, plus the release step;
  - how each alert closes;
  - alerts written after the seat transaction;
  - the runner's lazy invoice loader;
  - the failure write is an upsert;
  - step 8 backoff after 3 attempts, and skipped in dry runs;
  - `planForSubscription`;
  - Users tile rule 4 above the flat tier, matching the subscription id;
  - `displayPlan` for the cap message;
  - the earliest-invoice anchor for `invoice-overdue`;
  - U9 second text;
  - §9 wording;
  - attaching a card in the renewal rehearsal;
  - the S37 seam.

**Confirmation pass 3** (one fresh reviewer, whole blueprint, on v3.2): 4 MEDIUM, 8 LOW. It found no double charge in the sync. The MEDIUMs:
- a failed early payment flipping an invoiced subscription to `past_due` emailed no one;
- the grace anchor was never recomputed after it was set (a paid-up customer could be suspended);
- a not-yet-due DUNNING subscription stopped the seat sync and the renewal drop;
- under "All invoices", uncollectible invoices kept a subscription past due with no Pay button.

Root cause: invoiced dunning followed Stripe's status, with patches on top. **Fixed in v3.3 by a simpler model** (§6.2):
- for send_invoice subscriptions, `pastDueSince` is the earliest open invoice past its due date, recomputed on every reconcile;
- the dunning block runs on it even while Stripe says active;
- the suspension lifts when nothing is overdue;
- Stripe's `past_due` alone starts nothing;
- the failed-payment email is keyed on "no grace notice covers it";
- the sync treats invoiced-and-not-overdue `past_due` as syncable;
- "All invoices", the `invoice-overdue` notice and two alerts are removed;
- 9.5 keeps invoices open, and the Pay button falls back to an uncollectible invoice.

LOWs written in:
- contradictions in §7.3 and §10.1 removed;
- post-commit alert failure doesn't change the outcome;
- term-race audit event;
- S39 timing;
- a renew-schedule check;
- budget recomputed (100 s cutoff);
- digest-only `cron-incomplete` stated as intended;
- tests S29 (lazy loader), S40, S42, S43.
- Not adopted: delivery-time supersession for `bank-payment-failed`. A payment that failed is still a fact worth stating even if paid later.

**Confirmation pass 4** (one fresh reviewer, on v3.3): 2 HIGH, 1 MEDIUM, 6 LOW, all from the new invoiced model. Fixed in v3.4:
- **HIGH — the precedence between the generic GOOD branch and the invoiced rule was undefined.** Either reading broke: a daily unsuspend/re-suspend loop, or new invoiced customers stuck on trial. Now explicit pseudo-code (§6.2): the send_invoice branch runs instead of the generic GOOD/DUNNING branches and returns; GOOD-only facts are still written; suspension changes only from the invoices.
- **HIGH — D9 termination didn't stick for an invoiced subscription Stripe reports active.** The ended-and-owing no-revival guard; the tracked subscription goes in `toCancel`; `cancelInOwnSection` doesn't treat an overdue invoiced subscription as paid (S44).
- **MEDIUM — the anchor moving later while suspended left the tenant suspended without a fresh grace.** Now it unsuspends and restarts from the newer due date (U4, S42 variant).
- **LOWs:**
  - one email per ACH checkout failure (the invoice trigger requires a LIVE subscription);
  - sync rules aligned (overdue blocks the sync; an invoiced not-overdue `past_due` syncs);
  - §9 aligned with §6.5;
  - `OpenInvoiceState.subscriptionId` already exists;
  - `collectionMethod` made optional in `LifecycleFacts` (test literals keep compiling);
  - the `deleteTenant` path writes no dunning fields (`skipped`).

**Confirmation pass 5** (one fresh reviewer, on v3.4): 1 MEDIUM, 10 LOW. It traced the v3.4 pseudo-code as code and found no HIGH. Fixed in v3.5:
- **MEDIUM — switching a charge-automatically subscription to invoicing while a charge was unpaid wiped the dunning.** Open invoices with no due date now count as overdue since `pastDueSince`; runbook step 8; U4 case; F37.
- **LOWs:**
  - the no-revival guard applies only to debt overdue on or before the end (a new subscription revives normally), and non-overdue invoiced DUNNING stays out of `toCancel`;
  - Payment row 2b limited to invoiced, not ended;
  - the seat sync and its candidates exclude ended tenants;
  - invoiced recovery marks due (`becameGood` widened);
  - `payment-failed` re-pushed each reconcile, as in the generic branch;
  - an earlier anchor keeps `P1` while suspended;
  - `toCancel` de-duplicated;
  - `cancelInOwnSection` passes the unfiltered list, with a stated budget of ≤4;
  - invoice facts only for GOOD/DUNNING, with `resource_missing` handling;
  - the 24 h detection lags written into F33/F35;
  - the `cancelInOwnSection` line range corrected;
  - tests S45, S46 and U4 cases.

**Confirmation pass 6** (one fresh reviewer, on v3.5): 1 MEDIUM, 7 LOW. It found the v3.5 precedence, unsuspend rules, notice pushes, `becameGood` and the `skipped` path all correct when traced. Fixed in v3.6:
- **MEDIUM — on an ended tenant, a null-due-date invoice was anchored at `now`, a "new debt", which revived a terminated tenant.** Now anchored at `pastDueSince ?? subscriptionEndedAt ?? now` (old debt on ended tenants), with one shared `isOverdue` predicate and a pure `computeInvoiceOverdueSince` used everywhere (U4).
- **LOWs:**
  - reverse switch (invoicing to card) in runbook step 8;
  - the pure helper makes U4 testable;
  - `cancelInOwnSection` reads invoices before the GOOD check, and applies the paid check to DUNNING too;
  - no `bank-payment-failed` email on ended tenants;
  - `choosePayInvoice` puts null-due-date invoices first;
  - the stuck invoice-send alert is emailed at its third occurrence;
  - blast radius adds `registry.ts` and the runner's `toCancel`/`cancelInOwnSection` changes.

**Confirmation pass 7** (one fresh reviewer, on v3.6): **no HIGH, no MEDIUM: CLEAN.** It traced the invoiced model as code through:
- terminate → failed cancel → later runs;
- both collection-method switches;
- resubscribing;
- paying during grace;
- founder voids;
- the `deleteTenant` restore.

Its 11 LOWs are written into v3.7, for the post-implementation audit to verify:
- `choosePayInvoice` order and tie-break, with §6.7 aligned;
- the missing `TenantBillingInfo` fields;
- `becameGood` on revival;
- closing the stuck-invoice alert;
- step 8 runs whatever step 3 decides;
- `auto_advance: true` invoices skipped, plus a test-mode check;
- the GOOD Pay action, with §9 aligned and parallel reads;
- null-due invoices count only once failed;
- regression-guard labels, with the `toCancel` assertion moved to S44;
- one cutoff (E) for both termination filters;
- runbook step 9 (cancel the old subscription before re-subscribing a terminated workspace).
