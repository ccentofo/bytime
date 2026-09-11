# Blueprint: Billing Polish — Suspended-Tenant Reactivation + Webhook/Version/Domain Fixes

> **Role: Senior engineer.** Phase A is the important one (a lapsed customer must be able to pay and
> recover without a support ticket) and touches auth — implement it carefully and verify with Stripe
> test mode. B/C/D are small, contained fixes.

## 1. Overview

After Blueprint 7, billing works, but a **suspended (unpaid) tenant is locked out of the very screen
that would let them pay.** The `(app)` layout renders the dead-end `TenantUnavailable` screen for
suspended tenants, `/admin/billing` is unreachable, and `openBillingPortal` calls `getTenantOrThrow`
which throws for suspended. Worse, **login itself fails for a suspended tenant** because the
credentials lookup goes through `getDb()` → `getTenantOrThrow()` (strict, rejects suspended). Net:
a failed payment becomes permanent churn. Phase A fixes this with an in-app **billing wall**: a
suspended tenant's admin can still sign in, sees a "subscription inactive — update billing" screen,
opens the Stripe portal, pays, and the existing webhook flips them back to `active`.

Phases B–D are the minor findings: don't reset the plan label on a transient payment failure; pin a
correct Stripe API version; and stop hardcoding the `bytime.app` domain on the confirm page.

### Security invariant (must hold)
A suspended tenant's users may **authenticate and reach billing only** — they must get **no app
data**. `getDb()` stays strict (throws for suspended); only the auth lookup and the billing path use
a suspended-tolerant resolver. Every non-billing `(app)` route still shows the wall.

---

## 2. File Topology

```
Files to MODIFY:
├── src/lib/tenant/context.ts          ← add getTenantForBilling() (allows active + suspended)
├── src/db/index.ts                    ← add getDbForAuth() (resolves tenant allowing suspended)
├── src/auth.ts                        ← login lookup uses the suspended-tolerant DB so suspended admins can sign in
├── src/app/(app)/layout.tsx           ← suspended → render BillingWall (not the dead-end screen)
├── src/app/(app)/BillingWall.tsx      ← (CREATE) "subscription inactive" wall with Manage Billing button
├── src/server/actions/billing.ts      ← openBillingPortal uses getTenantForBilling (allow suspended)
├── src/app/api/stripe/webhook/route.ts← Phase B: preserve current plan on invoice.payment_failed
├── src/lib/billing/stripe.ts          ← Phase C: confirm/adjust apiVersion
├── src/app/signup/verify/route.ts     ← Phase D: derive workspace host from APP_ROOT_DOMAIN

Files NOT TOUCHED (guardrail):
├── src/lib/tenant/registry.ts         ← getTenantBySlug already returns suspended tenants; use as-is
├── src/db/control-plane/**            ← billing reads via controlDb already
```

---

## 3. Phase A — Suspended-tenant reactivation (the billing wall)

> Read the Next.js 16 / Auth.js v5 docs in `node_modules` before editing auth. Run `npm run build`
> after the phase and verify the full lifecycle with Stripe test mode.

**A1. Suspended-tolerant resolvers.**
- In `src/lib/tenant/context.ts`, add `getTenantForBilling()`: like `getTenantOrThrow` but it
  **allows `active` AND `suspended`** (still rejects none/unknown/`deleting`). This is the resolver
  the billing path uses.
- In `src/db/index.ts`, add `getDbForAuth()`: resolve the current request's tenant slug, look it up
  via `getTenantBySlug` (which already returns suspended tenants), and return `getDbForUrl(tenant.dbUrl)`
  — i.e. a tenant DB client that works even when suspended. Do **not** change `getDb()` (it stays
  strict). Only auth and billing use the tolerant variants.

**A2. Let suspended admins sign in.** In `src/auth.ts`, the credentials `authorize()` looks up the
user via `getUserByEmail`, which uses strict `getDb()` → fails for suspended. Change the login lookup
to use `getDbForAuth()` (query the user directly, or add a `getUserByEmail`-style helper that accepts
a db). The JWT session-version block already resolves via `getTenantBySlug` + `getDbForUrl`, so it
already tolerates suspended — leave it. Net effect: a suspended tenant's admin can authenticate;
they still get no app data because every data path uses strict `getDb()`.

**A3. Billing wall in the `(app)` layout.** `src/app/(app)/layout.tsx` currently does
`getTenantState()` and renders `TenantUnavailable` for any non-active state. Change ONLY the
`suspended` branch: render a new `<BillingWall>` instead of the dead-end. Keep `none`/`unknown`/
`deleting`/`mismatch` on `TenantUnavailable`. The wall should render for any authenticated user on a
suspended tenant; the "Manage billing" action is admin-only (the server action enforces it).

**A4. `BillingWall` component** (`src/app/(app)/BillingWall.tsx`, Mantine, themed like
`TenantUnavailable`): a clear "Your subscription is inactive — update your billing to restore access"
message, and for admins a **"Manage billing"** button that calls `openBillingPortal()` and
`window.location = url`. For non-admins, show "ask your administrator to update billing." Use the
existing session role (passed from the layout) to decide.

**A5. Portal action tolerates suspended.** In `src/server/actions/billing.ts`, change
`openBillingPortal` to resolve the tenant via `getTenantForBilling()` instead of `getTenantOrThrow()`
so it works while suspended. Keep `requireAdmin()` first. (It already reads the Stripe customer from
`controlDb`, which is fine for suspended.) `startCheckout` and `getTenantBillingInfo` may also switch
to `getTenantForBilling()` so the billing page is fully usable while suspended.

### Phase A verification (Stripe test mode + `stripe listen`)
- Suspend a tenant (trigger `invoice.payment_failed` or set `status='suspended'` in the registry).
- The admin can still **log in** on that tenant's subdomain.
- Every app route shows the **billing wall** (no app data leaks).
- Admin clicks **Manage billing** → Stripe portal opens → completes payment → webhook sets the tenant
  back to `active` → full app access returns (within the registry cache TTL).
- A non-admin on a suspended tenant sees the wall **without** a working portal button.
- A truly unknown/`deleting` workspace still shows `TenantUnavailable` (unchanged).

---

## 4. Phase B — Preserve plan on transient payment failure

In `src/app/api/stripe/webhook/route.ts`, the `invoice.payment_failed` case currently passes
`plan: 'trial'`, which downgrades the tenant's plan label (and seat limit) on a hiccup. Change it to
**preserve the current plan**: read the tenant row first (via `findTenantByStripeCustomer`) and pass
its existing `plan`, or have `applySubscriptionState` skip updating `plan` when it isn't provided.
Keep `access: 'suspended'` and `subscriptionStatus: 'past_due'`. The next
`customer.subscription.updated` event will set the authoritative plan anyway.

**Verify:** a Pro tenant that fails payment becomes suspended but its `plan` stays `pro` (so on
reactivation its seat limit is correct).

---

## 5. Phase C — Confirm the Stripe API version

In `src/lib/billing/stripe.ts`, the `apiVersion` is pinned to `'2025-04-30'`. Confirm it matches the
installed SDK and adjust if needed:
```bash
node -e "console.log(require('stripe').LATEST_API_VERSION)"
```
Set `apiVersion` to that value (cast `as any` is fine to avoid the literal-type mismatch). If you
prefer, omit `apiVersion` entirely so the SDK uses its built-in pinned default — either is acceptable;
just make it intentional and correct.

**Verify:** `npm run build` passes; a Stripe test-mode call (checkout session create) succeeds.

---

## 6. Phase D — Derive the confirm-page domain from env

In `src/app/signup/verify/route.ts`, the GET confirm page hardcodes
`${row.slug}.bytime.app`. Replace it with the host derived from `APP_ROOT_DOMAIN` (and the scheme/port
from `NEXT_PUBLIC_APP_URL`) — the route already has a `tenantBase(slug)` helper; reuse it (strip the
scheme for display, or just show `${slug}.${APP_ROOT_DOMAIN}`). This removes the hardcoded brand and
is correct under the pending product rename.

**Verify:** the confirm page shows the correct workspace host in dev (`<slug>.localhost`) and would
show the real domain in prod.

---

## 7. Verification (all phases)

```bash
npm run build        # zero errors (the lazy Stripe client must not throw at build)
npm run test         # unit green
npm run lint         # clean
```
Then the Stripe test-mode lifecycle, end to end on a `*.localhost` tenant (see
`LOCAL-MULTITENANT-TESTING.md`): trial → subscribe → active → fail payment → **suspended but admin can
log in and reach the billing wall** → pay via portal → reactivated. Confirm no app data is reachable
while suspended, and no card form exists anywhere in-app.

### Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Suspended admin still can't log in | auth still using strict `getDb()` | login lookup must use `getDbForAuth()` |
| Suspended tenant can read app data | a data path used `getDbForBilling`/tolerant resolver | only auth + billing use tolerant resolvers; `getDb()` stays strict |
| Portal button throws "suspended" | `openBillingPortal` still uses `getTenantOrThrow` | switch to `getTenantForBilling()` |
| Reactivation doesn't restore access immediately | registry cache TTL | expected (≤60s); `applySubscriptionState` already calls `invalidateTenant` |
| Build still fails on Stripe | a module constructs Stripe at import | client is lazy (proxy) — don't construct at module top |
| Plan shows "trial" after a payment blip | webhook reset plan | Phase B — preserve current plan on `payment_failed` |
```
