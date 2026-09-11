# Blueprint: Self-Service Signup & Onboarding

> **This ticket contains THREE phases (A: signup + email verify, B: verify → provision → set-password invite, C: first-run onboarding). Strictly ordered.**
> **Tier 2.** **Depends on `feature-plan-control-plane.md` (#4) and `feature-plan-tenant-provisioning.md` (#5).** Uses `provisionTenant`, the registry, `getDbForUrl`, and the existing password-reset machinery.

## 1. Architectural Overview

### The Problem

There is no way for a prospect to become a customer without an operator running a CLI. To sell self-service, a visitor must be able to: choose a workspace name, prove control of their email, get a tenant auto-provisioned, set their own password, and land in the product — with no human in the loop.

### The Solution (one email, no DB-spam)

1. **Signup** collects company name + admin email, derives a workspace `slug`, checks availability, rate-limits, and stores a **pending signup** in the control plane. **No tenant database is created yet** — this prevents an abuse vector where spam signups each create an expensive Neon DB.
2. A **verification email** is sent to the admin. Clicking it proves email control.
3. On verify, the system **provisions the tenant** (`provisionTenant`), mints a **set-password token** in the new tenant DB (reusing the existing `passwordResetTokens` machinery), and redirects the now-verified admin to the tenant's existing `/reset-password` page to set their own password.
4. After setting a password, the admin logs in on their subdomain and is routed into the **existing setup wizard** (`src/app/(app)/admin/setup`).

### Critical safety property

**The product never sets the user's password for them.** The admin sets it themselves via the set-password (reset) page. The account is created with a null `passwordHash` during provisioning (#5) and is dormant until the admin completes the invite.

### Design Decisions

1. **Signup pages live on the apex/marketing host**, not a tenant subdomain (there is no tenant yet). The signup server action therefore uses control-plane tables + `provisionTenant` directly — never `getDb()` (which requires a tenant context).
2. **Email verification before provisioning.** A `signups` control-plane table holds a hashed verify token. Provisioning is triggered only by a valid token click.
3. **Reuse, don't rebuild, the set-password flow.** After provisioning, mint a token in the tenant DB's `passwordResetTokens` table and reuse the existing `/reset-password` page + `resetPassword()` action (which sets `passwordHash`, bumps `sessionVersion`, single-use). The only difference is a longer expiry suited to onboarding.
4. **The set-password link points at the tenant subdomain** (`https://<slug>.<root>/reset-password?...`) so the existing `resetPassword()` action resolves the correct tenant DB via `getDb()`.
5. **Idempotent verification.** A consumed signup token can't re-provision; if the tenant already exists and is active, the verify route routes the user to login instead.

---

## 2. File Topology

```
Files to CREATE:
├── src/db/control-plane/schema.ts          ← (MODIFY) add `signups` table
├── src/app/signup/page.tsx                 ← Public signup form (apex host)
├── src/app/signup/SignupForm.tsx           ← Client form component (Mantine)
├── src/app/signup/check/route.ts           ← (optional) slug availability check endpoint
├── src/server/actions/signup.ts            ← startSignup() server action (validate + email verify)
├── src/app/signup/verify/route.ts          ← GET verify → provision → mint token → redirect
├── src/lib/tenant/invite.ts               ← issueSetPasswordToken(dbUrl, email, hours)
├── src/lib/email/send-signup.ts            ← sendSignupVerifyEmail() (or extend send.ts)

Files to MODIFY:
├── src/db/control-plane/schema.ts          ← add signups table (see Phase A)
├── src/app/page.tsx                         ← add a "Start free / Sign up" CTA → /signup
├── src/app/(app)/timesheet/...layout or admin entry ← first-login routing to /admin/setup (Phase C)
├── next.config.ts                           ← (only if CSP blocks the new page assets; usually no change)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/server/actions/password-reset.ts     ← ❌ Reuse resetPassword()/verifyResetToken() as-is
├── src/app/reset-password/**                ← ❌ Reuse the existing set-password page
├── src/lib/tenant/provision.ts              ← ❌ Use provisionTenant() as-is
├── src/lib/tenant/registry.ts               ← ❌ Use getTenantBySlug/isValidSlug helpers as-is
├── src/db/schema.ts                         ← ❌ Tenant schema unchanged
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** scan `node_modules` (but DO read the Next 16 docs for route handlers/redirects if unsure).
> - Signup runs on the apex host → use control-plane DB + `provisionTenant` + `getDbForUrl`, never `getDb()`.
> - **Never set the admin's password programmatically.** Mint a token; the admin sets it themselves.
> - Mantine only for UI (no other component libs), matching the existing `LoginForm`/`reset-password` pages.
> - Rate-limit signup to prevent abuse (reuse `src/lib/rate-limit.ts`).
> - **After each phase: `npm run build`.**

---

## Phase A: Signup Form + Email Verification

**A1.** Add a `signups` table to `src/db/control-plane/schema.ts` (append to the existing file):

```typescript
export const signups = pgTable('signups', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 200 }).notNull(),
  slug: varchar('slug', { length: 63 }).notNull(),
  verifyTokenHash: varchar('verify_token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Generate + apply the control-plane migration:

```bash
npm run db:generate:cp && npm run db:migrate:cp
```

**A2.** Create `src/server/actions/signup.ts`:

```typescript
'use server';

import crypto from 'crypto';
import dayjs from 'dayjs';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { getTenantBySlug } from '@/lib/tenant/registry';
import { isValidSlug } from '@/lib/tenant/provision';
import { sendSignupVerifyEmail } from '@/lib/email/send-signup';

const VERIFY_EXPIRY_HOURS = 24;

/** Derive a DNS-safe slug from a company name. */
export function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export async function checkSlugAvailable(slug: string): Promise<{ available: boolean; reason?: string }> {
  if (!isValidSlug(slug)) return { available: false, reason: 'invalid' };
  const existing = await getTenantBySlug(slug);
  return existing ? { available: false, reason: 'taken' } : { available: true };
}

export async function startSignup(input: {
  companyName: string;
  email: string;
  slug?: string;
}): Promise<{ success: boolean; error?: string }> {
  const email = input.email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Please enter a valid email address.' };
  }
  const slug = (input.slug?.trim() || slugify(input.companyName));
  const avail = await checkSlugAvailable(slug);
  if (!avail.available) {
    return { success: false, error: avail.reason === 'taken'
      ? 'That workspace name is taken. Try another.'
      : 'That workspace name is not allowed. Use letters, numbers, and hyphens.' };
  }

  // Mint a verification token.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const verifyTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await controlDb.insert(signups).values({
    email, companyName: input.companyName.trim(), slug,
    verifyTokenHash, expiresAt: dayjs().add(VERIFY_EXPIRY_HOURS, 'hour').toDate(),
  });

  const apexUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const verifyUrl = `${apexUrl}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;
  sendSignupVerifyEmail({ email, companyName: input.companyName.trim(), verifyUrl }); // fire-and-forget

  return { success: true };
}
```

> **Rate limiting:** wrap `startSignup` usage with `src/lib/rate-limit.ts` keyed by IP (the form posts via a route handler or you read IP in the action). If reading IP in a server action is awkward, add a thin `/api/signup` route handler that rate-limits then calls `startSignup`. Cap to e.g. 5/hour/IP.

**A3.** Create `src/lib/email/send-signup.ts` — `sendSignupVerifyEmail({ email, companyName, verifyUrl })`. Mirror the structure of `sendPasswordResetEmail` in `src/lib/email/send.ts` (Resend + React Email). Copy: "Confirm your email to create your ByTime workspace." Include the `verifyUrl` button and a 24-hour expiry note.

**A4.** Create `src/app/signup/page.tsx` + `src/app/signup/SignupForm.tsx` — a Mantine form (company name, work email, optional workspace slug with live availability via `checkSlugAvailable`/`/signup/check`). On submit, call `startSignup`. On success, show "Check your email to confirm and finish setup." Match the visual style of `src/app/login` and `src/app/reset-password`.

**A5.** Add a CTA to `src/app/page.tsx` (landing) linking to `/signup`.

### Phase A Verification

| Check | Expected Result |
|---|---|
| Submit valid signup | Row in `signups`; verify email sent; success message |
| Taken/invalid slug | Inline error; no row |
| Live availability check | Reflects taken/available |
| > rate limit | Blocked |
| No tenant DB created yet | Confirmed (provisioning happens at verify) |

---

## Phase B: Verify → Provision → Set-Password Invite

**B1.** Create `src/lib/tenant/invite.ts`:

```typescript
import 'server-only';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { getDbForUrl } from '@/db';
import { passwordResetTokens } from '@/db/schema';

const INVITE_EXPIRY_HOURS = 72; // onboarding window, longer than the 1h reset default

/** Mint a single-use set-password token in a specific tenant DB. Returns the raw token. */
export async function issueSetPasswordToken(dbUrl: string, email: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = getDbForUrl(dbUrl);
  await db.insert(passwordResetTokens).values({
    email: email.toLowerCase().trim(),
    tokenHash,
    expiresAt: dayjs().add(INVITE_EXPIRY_HOURS, 'hour').toDate(),
  });
  return rawToken;
}
```

> The existing `resetPassword()` (`src/server/actions/password-reset.ts:114`) consumes exactly this token shape (matches on `email` + `tokenHash` + `usedAt IS NULL` + expiry) and sets the password + bumps `sessionVersion`. Reuse it unchanged.

**B2.** Create `src/app/signup/verify/route.ts` (GET handler):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { and, eq, isNull } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { provisionTenant } from '@/lib/tenant/provision';
import { issueSetPasswordToken } from '@/lib/tenant/invite';
import { getTenantBySlug } from '@/lib/tenant/registry';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const email = (req.nextUrl.searchParams.get('email') ?? '').toLowerCase().trim();
  const apex = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const fail = (msg: string) => NextResponse.redirect(`${apex}/signup?error=${encodeURIComponent(msg)}`);

  if (!token || !email) return fail('Invalid link.');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const [row] = await controlDb.select().from(signups).where(
    and(eq(signups.email, email), eq(signups.verifyTokenHash, tokenHash), isNull(signups.consumedAt)),
  ).limit(1);
  if (!row) return fail('This link is invalid or already used.');
  if (dayjs().isAfter(dayjs(row.expiresAt))) return fail('This link has expired. Please sign up again.');

  // If already provisioned, just send them to login.
  const rootDomain = process.env.APP_ROOT_DOMAIN ?? 'localhost';
  const tenantBase = `https://${row.slug}.${rootDomain}`;
  const already = await getTenantBySlug(row.slug);
  if (already && already.status === 'active') {
    await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));
    return NextResponse.redirect(`${tenantBase}/login`);
  }

  // Provision the tenant (idempotent/resumable).
  const { } = await provisionTenant({
    slug: row.slug, name: row.companyName, adminEmail: email, adminName: email.split('@')[0],
  });

  // Mark signup consumed.
  await controlDb.update(signups).set({ consumedAt: new Date() }).where(eq(signups.id, row.id));

  // Mint a set-password token in the new tenant DB and redirect there.
  const tenant = await getTenantBySlug(row.slug);
  if (!tenant) return fail('Provisioning failed. Please contact support.');
  const setToken = await issueSetPasswordToken(tenant.dbUrl, email);
  const url = `${tenantBase}/reset-password?token=${setToken}&email=${encodeURIComponent(email)}&welcome=1`;
  return NextResponse.redirect(url);
}
```

> **adminName:** signup collects only company + email in Phase A; we use the email local-part as a placeholder name. The setup wizard (Phase C) lets the admin correct their display name. If you prefer, add a "Your name" field to the signup form and thread it through `signups` → here.
>
> **Local dev note:** redirects to `https://<slug>.<root>` won't resolve on plain `localhost`. For dev, use `http://<slug>.localhost:3000`. Compute the scheme/host from `NEXT_PUBLIC_APP_URL` rather than hardcoding `https`.

**B3.** The set-password page is the existing `src/app/reset-password/page.tsx`. It already calls `verifyResetToken`/`resetPassword`, which run on the tenant subdomain and resolve the tenant DB via `getDb()`. Optionally honor a `welcome=1` query param to show "Welcome — set your password to finish creating <workspace>." This is a copy-only tweak; do not change the token logic.

### Phase B Verification

| Check | Expected Result |
|---|---|
| Click valid verify link | Tenant provisioned; redirected to `<slug>` set-password page |
| Set password there | `resetPassword` sets hash + bumps sessionVersion; admin can now log in |
| Click the verify link twice | Second click: signup consumed → routed to login (no double-provision) |
| Expired verify link | Friendly error back on `/signup` |
| Provisioning mid-failure then re-click | Resumes (provisionTenant idempotent) |

---

## Phase C: First-Run Onboarding

**C1.** Route a freshly-onboarded admin into the existing setup wizard. After first login on the tenant subdomain, if the workspace has no contracts/users beyond the admin (i.e., setup not started), redirect to `/admin/setup`.

- Determine "needs setup" cheaply: e.g., zero `contracts` rows, or a `setupCompletedAt` flag. Prefer reading existing state (count contracts/users) over adding schema. Inspect `src/app/(app)/admin/setup/SetupWizardClient.tsx` and `page.tsx` to see if a completion signal already exists; reuse it.
- Implement the redirect in the app entry for authenticated users (the `(app)` layout or the timesheet landing) for `role === 'admin'` when setup is incomplete. Keep it minimal and non-looping (don't redirect while already on `/admin/setup`).

**C2.** Ensure the post-set-password experience flows: set password → land on `<slug>/login` → log in → (admin, no setup) → `/admin/setup`. Verify the existing wizard covers creating the first contract/CLIN, inviting employees, and pay-period config (it already exists — do not rebuild it).

### Phase C Verification

| Check | Expected Result |
|---|---|
| First admin login, empty workspace | Redirected to `/admin/setup` |
| After completing setup | Normal app; no forced redirect |
| Non-admin user | Never forced into setup |
| Already on `/admin/setup` | No redirect loop |

---

## 4. Verification

### 4a. Build

```bash
npm run build
npm run db:check        # tenant schema unchanged
# control-plane migration applied for `signups`
```

### 4b. Full self-service happy path (staging, real email)

1. Visit apex `/signup`, enter "Acme Corp" + admin email → success message.
2. Receive verify email → click → tenant `acme` provisioned → redirected to `acme.<root>/reset-password`.
3. Set a password → redirected to `acme.<root>/login`.
4. Log in → routed to `/admin/setup` → complete the wizard.
5. Log time, submit, (as a second seeded supervisor) approve → confirm DCAA flow works in the brand-new tenant.
6. Confirm via the control plane: `acme` registry row `active`; isolation test still green.

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Signup action throws "No tenant in request context" | used `getDb()` on apex | Signup must use `controlDb` + `provisionTenant` + `getDbForUrl` |
| Set-password link 404 / wrong tenant | link not on the tenant subdomain | Build `https://<slug>.<root>/reset-password…` from `APP_ROOT_DOMAIN` |
| Token "invalid or expired" immediately | invite token written to wrong DB | `issueSetPasswordToken` must use `getDbForUrl(tenant.dbUrl)` |
| Double provisioning | verify link reused | Mark `signups.consumedAt`; guard on existing active tenant |
| DB-spam from bots | provisioning before email proof | Provision only at verify; rate-limit `/signup` |
| Redirect loop into setup | redirect fires on `/admin/setup` itself | Exclude the setup path from the redirect check |
| Local dev redirect to https://acme.localhost fails | hardcoded scheme | Derive scheme/host from `NEXT_PUBLIC_APP_URL`; use `http://acme.localhost:3000` in dev |
