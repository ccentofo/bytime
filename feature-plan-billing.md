# Blueprint: Subscription Billing — Stripe Checkout, Webhooks & Access Gating

> **This ticket contains THREE phases (A: Stripe + checkout/portal, B: webhook + access gating, C: plan limits + CSP). Strictly ordered.**
> **Tier 2 — last of the milestone.** **Depends on `feature-plan-control-plane.md` (#4)** (uses the `tenants` registry + its `stripeCustomerId`/`stripeSubscriptionId`/`subscriptionStatus` columns + `getTenantOrThrow` gating) and benefits from **#6 (signup)** for the trial→subscribe flow.

## 1. Architectural Overview

### The Problem

There is **no billing of any kind** — no Stripe, no subscription records, no payment, no access gating by payment status. The product cannot collect revenue, so it cannot be sold self-service.

### The Solution

Billing lives in the **control plane**, one subscription per tenant:
1. The `tenants` registry row already carries `stripeCustomerId`, `stripeSubscriptionId`, `subscriptionStatus`, and `plan` (added in #4).
2. New tenants start on a **trial** (`plan='trial'`, `status='active'`) so signup works without a card.
3. An admin **Billing** page in the tenant app starts **Stripe Checkout** (hosted) to subscribe, and opens the **Stripe Customer Portal** to change/cancel.
4. A signature-verified **webhook** keeps the tenant row in sync with the Stripe subscription lifecycle and flips the tenant's `status` between `active` and `suspended`.
5. **Access gating** reuses the control plane's existing fail-closed check: `getTenantOrThrow()` already rejects `suspended` tenants — the webhook just sets that status.
6. **Plan limits** (e.g., seats) are enforced cheaply at user-creation time.

### Safety property

**All card data is entered on Stripe-hosted pages** (Checkout + Customer Portal). The app never renders a card form, never touches PAN/CVV, and stores only Stripe IDs and status. This keeps the app out of PCI scope and complies with the rule that the product never collects financial credentials directly.

### Design Decisions

1. **Subscription is per-tenant, tracked in the registry.** No billing tables in the tenant DB.
2. **Webhook is the source of truth.** The app reacts to Stripe events; it does not infer subscription state from client redirects.
3. **Gate via tenant `status`.** `subscriptionStatus` (Stripe's value: `active`/`trialing`/`past_due`/`canceled`/…) is stored for display; the binary access decision is the registry `status` (`active` vs `suspended`), which the webhook sets. This keeps the hot-path gate (`getTenantOrThrow`) a single field check.
4. **Trial grace.** New tenants are `active` during trial. A trial-ended / unpaid signal suspends them; a successful payment reactivates.
5. **Webhook runs on the apex host** (Stripe calls a fixed URL) → it uses `controlDb` directly, never `getDb()`.

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/billing/stripe.ts            ← Stripe SDK client (server-only)
├── src/lib/billing/plans.ts             ← Plan catalog: price IDs + limits (seats, etc.)
├── src/lib/billing/tenant-billing.ts    ← Registry billing helpers (get/update by stripe ids)
├── src/server/actions/billing.ts        ← startCheckout(), openBillingPortal() (tenant context)
├── src/app/api/stripe/webhook/route.ts  ← Signature-verified webhook handler (apex)
├── src/app/(app)/admin/billing/page.tsx ← Admin billing page (status + Subscribe/Manage buttons)
├── src/app/(app)/admin/billing/BillingClient.tsx ← Mantine client component

Files to MODIFY:
├── src/server/actions/users.ts          ← Enforce seat limit in createUser / createUserWithPassword
├── next.config.ts                        ← Extend CSP for Stripe (js/api/hooks.stripe.com)
├── package.json                          ← add "stripe" dependency
├── .env.example                          ← (already lists STRIPE_* from #2) confirm present

Files NOT TOUCHED (guardrail — DO NOT MODIFY logic):
├── src/lib/tenant/context.ts            ← ❌ getTenantOrThrow already gates `suspended`
├── src/db/control-plane/schema.ts       ← ❌ stripe columns already exist (from #4)
├── src/db/schema.ts                      ← ❌ no tenant-side billing tables
```

> **Dependency:** add `stripe` to `package.json` dependencies and `npm install`. Pin a current major version and read its README for the API version string to pass to the client.

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **Never render a card form.** Use Stripe Checkout + Customer Portal (hosted) only.
> - The webhook **must verify the Stripe signature** with `STRIPE_WEBHOOK_SECRET` against the **raw** request body. Do not parse JSON before verifying.
> - The webhook runs on apex → use `controlDb`, never `getDb()`. Checkout/portal actions run in tenant context → resolve the tenant via `getTenantOrThrow()`.
> - After updating a tenant's registry row, call `invalidateTenant(slug)` so the gate sees the change within the cache TTL.
> - **After each phase: `npm run build`.**

---

## Phase A: Stripe Client, Plans, Checkout & Portal

**A1.** Create `src/lib/billing/stripe.ts`:

```typescript
import 'server-only';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is not set. See .env.example.');

// Pin the apiVersion to the value Stripe's installed SDK expects (check the SDK README).
export const stripe = new Stripe(key, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
```

> **Verify** the `apiVersion` against the installed `stripe` package — using a mismatched string is a common footgun. Use the SDK's `LatestApiVersion` if available.

**A2.** Create `src/lib/billing/plans.ts` — the catalog (price IDs come from your Stripe dashboard, injected via env or hardcoded test IDs for now):

```typescript
export type PlanKey = 'trial' | 'starter' | 'pro' | 'enterprise';

export const PLANS: Record<PlanKey, { label: string; priceId: string | null; seatLimit: number | null }> = {
  trial:      { label: 'Trial',      priceId: null,                                  seatLimit: 10 },
  starter:    { label: 'Starter',    priceId: process.env.STRIPE_PRICE_STARTER ?? '', seatLimit: 25 },
  pro:        { label: 'Pro',        priceId: process.env.STRIPE_PRICE_PRO ?? '',     seatLimit: 100 },
  enterprise: { label: 'Enterprise', priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? '', seatLimit: null }, // unlimited
};

/** Map a Stripe price ID back to a plan key (for webhook → plan sync). */
export function planForPriceId(priceId: string | null | undefined): PlanKey {
  if (!priceId) return 'trial';
  const entry = (Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][])
    .find(([, p]) => p.priceId && p.priceId === priceId);
  return entry?.[0] ?? 'trial';
}
```

> Add `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` to `.env.example`. Seat limits are illustrative — set real numbers with the business.

**A3.** Create `src/lib/billing/tenant-billing.ts` — registry helpers:

```typescript
import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { invalidateTenant } from '@/lib/tenant/registry';

export async function setTenantStripeCustomer(slug: string, stripeCustomerId: string): Promise<void> {
  await controlDb.update(tenants).set({ stripeCustomerId, updatedAt: new Date() }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);
}

export async function findTenantByStripeCustomer(stripeCustomerId: string) {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.stripeCustomerId, stripeCustomerId)).limit(1);
  return row ?? null;
}

export async function applySubscriptionState(input: {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string;   // Stripe status
  plan: string;
  access: 'active' | 'suspended';
}): Promise<void> {
  const row = await findTenantByStripeCustomer(input.stripeCustomerId);
  if (!row) return; // unknown customer — ignore
  await controlDb.update(tenants).set({
    stripeSubscriptionId: input.stripeSubscriptionId,
    subscriptionStatus: input.subscriptionStatus,
    plan: input.plan,
    status: input.access,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);
}
```

**A4.** Create `src/server/actions/billing.ts` (runs in tenant context):

```typescript
'use server';

import { requireAdmin } from '@/lib/session';
import { getTenantOrThrow } from '@/lib/tenant/context';
import { stripe } from '@/lib/billing/stripe';
import { PLANS, type PlanKey } from '@/lib/billing/plans';
import { setTenantStripeCustomer } from '@/lib/billing/tenant-billing';

function tenantBaseUrl(slug: string): string {
  const root = process.env.APP_ROOT_DOMAIN ?? 'localhost';
  const scheme = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('http://') ? 'http' : 'https';
  const port = root === 'localhost' ? ':3000' : '';
  return `${scheme}://${slug}.${root}${port}`;
}

export async function startCheckout(plan: PlanKey): Promise<{ url: string }> {
  await requireAdmin();
  const tenant = await getTenantOrThrow();
  const priceId = PLANS[plan].priceId;
  if (!priceId) throw new Error('That plan is not purchasable.');

  // Reuse or create the Stripe customer for this tenant.
  let customerId = (await getTenantOrThrow()).status ? undefined : undefined; // placeholder; read from row below
  // Read the raw registry row for the existing customer id:
  const { controlDb } = await import('@/db/control-plane');
  const { tenants } = await import('@/db/control-plane/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, tenant.slug)).limit(1);
  customerId = row?.stripeCustomerId ?? undefined;

  if (!customerId) {
    const customer = await stripe.customers.create({ name: tenant.name, metadata: { slug: tenant.slug } });
    customerId = customer.id;
    await setTenantStripeCustomer(tenant.slug, customerId);
  }

  const base = tenantBaseUrl(tenant.slug);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/admin/billing?status=success`,
    cancel_url: `${base}/admin/billing?status=cancelled`,
    metadata: { slug: tenant.slug },
  });
  if (!session.url) throw new Error('Could not start checkout.');
  return { url: session.url };
}

export async function openBillingPortal(): Promise<{ url: string }> {
  await requireAdmin();
  const tenant = await getTenantOrThrow();
  const { controlDb } = await import('@/db/control-plane');
  const { tenants } = await import('@/db/control-plane/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, tenant.slug)).limit(1);
  if (!row?.stripeCustomerId) throw new Error('No billing account yet — subscribe first.');

  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: `${tenantBaseUrl(tenant.slug)}/admin/billing`,
  });
  return { url: portal.url };
}
```

> Clean up the placeholder `customerId` lines when implementing — the intent is: read the tenant's registry row, reuse `stripeCustomerId` if present, else create a Stripe customer and persist it. Keep `requireAdmin()` first (server-side RBAC, matching the app's pattern).

**A5.** Create the admin billing page `src/app/(app)/admin/billing/page.tsx` + `BillingClient.tsx`:
- Server component reads the tenant's `plan` / `subscriptionStatus` (from the registry via a small read) and passes to the client.
- Client (Mantine) shows current plan + status, a plan picker calling `startCheckout(plan)` then `window.location = url`, and a "Manage billing" button calling `openBillingPortal()`.
- Page must be admin-gated (the page-level pattern + `requireAdmin()` in the actions already enforce this).

### Phase A Verification (Stripe test mode)

| Check | Expected Result |
|---|---|
| Admin opens /admin/billing | Shows current plan (trial) + Subscribe buttons |
| Click Subscribe | Redirects to Stripe Checkout (hosted) |
| Complete test payment | Returns to /admin/billing?status=success |
| `stripeCustomerId` persisted | Set on the tenant registry row |
| Manage billing (after subscribe) | Opens Stripe Customer Portal |
| Non-admin | Cannot reach the actions (requireAdmin throws) |

---

## Phase B: Webhook & Access Gating

**B1.** Create `src/app/api/stripe/webhook/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/billing/stripe';
import { applySubscriptionState } from '@/lib/billing/tenant-billing';
import { planForPriceId } from '@/lib/billing/plans';
import type Stripe from 'stripe';

// Stripe requires the RAW body for signature verification.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  const sig = req.headers.get('stripe-signature') ?? '';
  const raw = await req.text(); // raw body — do NOT req.json() before verifying

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const accessFor = (status: string): 'active' | 'suspended' =>
    (status === 'active' || status === 'trialing') ? 'active' : 'suspended';

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price?.id ?? null;
      await applySubscriptionState({
        stripeCustomerId: sub.customer as string,
        stripeSubscriptionId: sub.id,
        subscriptionStatus: sub.status,
        plan: planForPriceId(priceId),
        access: event.type === 'customer.subscription.deleted' ? 'suspended' : accessFor(sub.status),
      });
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      await applySubscriptionState({
        stripeCustomerId: inv.customer as string,
        stripeSubscriptionId: (inv as any).subscription ?? null,
        subscriptionStatus: 'past_due',
        plan: 'trial', // unchanged plan label not critical here; keep current if you prefer
        access: 'suspended',
      });
      break;
    }
    default:
      break; // ignore others
  }

  return NextResponse.json({ received: true });
}
```

> **Raw-body requirement:** confirm in the Next 16 docs that `await req.text()` yields the unparsed body in a Route Handler (it does). Do not add body parsing middleware. The `invoice.payment_failed` plan field is illustrative — if you want to preserve the existing plan label, read the tenant row first and pass its current `plan`.

**B2.** Configure the webhook endpoint in Stripe (test mode) pointing at `https://<apex>/api/stripe/webhook`, subscribed to `customer.subscription.*` and `invoice.payment_failed`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.

**B3.** Access gating — **no new code needed**. `getTenantOrThrow()` (from #4) already throws when `status === 'suspended'`. Confirm:
- A suspended tenant cannot use the app (every server action/page resolving the tenant fails closed).
- Provide a friendly "workspace suspended — update billing" page rather than a raw error: catch the suspended case at the `(app)` layout and render a billing-prompt screen with a link to the portal. (Minimal: a try/catch around tenant resolution in the layout.)

### Phase B Verification (Stripe CLI: `stripe listen --forward-to`)

| Check | Expected Result |
|---|---|
| `customer.subscription.created` (active) | Tenant `status='active'`, `plan` synced, `subscriptionStatus='active'` |
| `invoice.payment_failed` | Tenant `status='suspended'`, `subscriptionStatus='past_due'` |
| `customer.subscription.deleted` | Tenant `status='suspended'` |
| Tampered signature | 400, no DB change |
| Suspended tenant browses app | Blocked; sees billing-prompt screen |
| Re-subscribe (active again) | Reactivated within cache TTL (`invalidateTenant` called) |

---

## Phase C: Plan Limits & CSP

**C1.** Enforce the seat limit in `src/server/actions/users.ts`. Both `createUser` (`users.ts:21`) and `createUserWithPassword` (`users.ts:109`) create users. Add a shared check at the top of each (after `requireAdmin()` if present — note the server-rbac blueprint adds `requireAdmin()` to these):

```typescript
import { getTenantOrThrow } from '@/lib/tenant/context';
import { PLANS, type PlanKey } from '@/lib/billing/plans';
import { count, eq } from 'drizzle-orm';

async function assertSeatAvailable(): Promise<void> {
  const db = await getDb();                  // tenant DB (per control-plane migration)
  const tenant = await getTenantOrThrow();
  const limit = PLANS[(tenant.plan as PlanKey)]?.seatLimit ?? PLANS.trial.seatLimit;
  if (limit == null) return;                 // unlimited (enterprise)
  const [{ value }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.isActive, true));
  if (Number(value) >= limit) {
    throw new Error(`Your ${PLANS[tenant.plan as PlanKey]?.label ?? 'current'} plan allows ${limit} active users. Upgrade in Billing to add more.`);
  }
}
```

Call `await assertSeatAvailable();` near the top of `createUser` and `createUserWithPassword` (after auth/validation, before insert).

> **Verify before writing:** match `users.ts`'s existing imports (it already imports `users`, `db`/`getDb`, drizzle ops). Use the file's actual `getDb()` accessor (post-#4) and add `count` to the drizzle import if missing. Count only `isActive` users so deactivated accounts don't consume seats.

**C2.** Extend CSP in `next.config.ts` for Stripe. In the `csp` array from the config-hardening blueprint (#2), add Stripe hosts:
- `script-src` … add `https://js.stripe.com`
- `connect-src` … add `https://api.stripe.com`
- add a `frame-src 'self' https://js.stripe.com https://hooks.stripe.com` directive

> Checkout and the Portal are full-page redirects (hosted by Stripe), so they aren't constrained by our CSP. `frame-src`/`script-src` matter only if you later embed Stripe.js Elements. Add them now to avoid surprises.

### Phase C Verification

| Check | Expected Result |
|---|---|
| Create users up to the plan limit | Succeed |
| Create one over the limit | Throws upgrade prompt |
| Deactivate a user, then create | Succeeds (freed a seat) |
| Enterprise (null limit) | No cap |
| CSP after Stripe additions | App + any Stripe.js usage works; no console CSP errors |

---

## 4. Verification

### 4a. Build & deps

```bash
npm install        # stripe added
npm run build
```

### 4b. Full billing lifecycle (Stripe test mode + `stripe listen`)

1. New tenant on trial → `/admin/billing` shows Trial.
2. Subscribe to Starter → Checkout → webhook sets `active`/`starter`.
3. Add users up to Starter's seat limit; the next is blocked.
4. Trigger `invoice.payment_failed` via Stripe CLI → tenant `suspended` → app shows billing-prompt.
5. Pay via Customer Portal → `active` again → app restored.
6. Cancel in Portal → `customer.subscription.deleted` → `suspended`.

### 4c. Security checks

| Check | Expected |
|---|---|
| No card form anywhere in the app | Correct — Stripe-hosted only |
| Webhook without valid signature | 400, ignored |
| Billing actions require admin | `requireAdmin()` enforced |
| Tenant cannot affect another tenant's billing | Customer↔tenant mapping is 1:1 via `stripeCustomerId` |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Webhook 400 "invalid signature" | parsed JSON before verifying / wrong secret | Use raw `await req.text()`; correct `STRIPE_WEBHOOK_SECRET` |
| Subscription state not updating tenant | `stripeCustomerId` not stored at checkout | Persist it in `startCheckout` before redirect |
| Suspended tenant still has access | cache not invalidated | `applySubscriptionState` calls `invalidateTenant` (TTL ≤60s) |
| Seat check throws on apex | `getTenantOrThrow` with no tenant | User creation only happens inside a tenant; ensure callers are tenant-scoped |
| `apiVersion` type error | mismatched Stripe SDK version string | Use the SDK's `LatestApiVersion` |
| CSP blocks Stripe.js | hosts not allowed | Add `js.stripe.com`/`api.stripe.com`/`hooks.stripe.com` per C2 |
| Webhook not received | endpoint not registered / not public | Register in Stripe dashboard; use `stripe listen` locally |
