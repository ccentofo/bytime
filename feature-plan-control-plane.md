# Blueprint: Multi-Tenant Control Plane — Tenant Registry & Runtime DB Routing

> **This ticket contains FOUR phases (A → B → C → D). They are strictly ordered — each depends on the previous.**
> **Tier 2 — FOUNDATIONAL.** Blueprints #5 (provisioning), #6 (signup), and #7 (billing) all depend on this. Do NOT start them until this merges and the isolation tests pass.
> **Prerequisite:** Tier 1 blueprints (#1–#3) should be merged first.

> **⚠️ READ THE NEXT.JS DOCS FIRST.** Per `AGENTS.md`, this is Next.js 16 with breaking changes from prior versions. Before writing any code, read the relevant guides in `node_modules/next/dist/docs/` for: **`headers()` (now async)**, **middleware request-header injection / `NextResponse.next({ request: { headers } })`**, **route segment `runtime` config**, and **`unstable_cache`/caching**. Do not rely on training-data memory of older Next APIs.

## 1. Architectural Overview & DCAA Impact

### The Problem

ByTime is **database-per-tenant** (the correct isolation model for DCAA audit separation), but it is wired for **one tenant per deployment**:

- `src/db/index.ts` builds a single `postgres` client from `process.env.DATABASE_URL` at module load and exports it as a singleton `db`.
- That singleton is imported as `import { db } from '@/db'` in **42 files** (~165 call sites), including `src/auth.ts`.
- There is no tenant registry, no subdomain routing, no way for one running app to serve more than one customer DB.

For **self-service SaaS**, a single deployment must serve many tenants, each on its own subdomain (`acme.bytime.app`), each backed by its own Postgres database — with **zero possibility of cross-tenant data access**.

### The Solution

Add a **control plane**:
1. A separate **registry database** (`CONTROL_PLANE_DATABASE_URL`) with a `tenants` table mapping `slug → encrypted tenant DATABASE_URL` + status/plan/billing fields.
2. **Subdomain resolution in middleware**, which injects an `x-tenant-slug` request header.
3. A **per-request, tenant-resolved DB accessor** (`getDb()`) replacing the singleton, returning a **cached pooled client per tenant DB**.
4. **Tenant context carried in the Auth.js JWT** so auth queries hit the right tenant DB.

The per-tenant DB isolation means there is **no `tenantId` column** anywhere in the tenant schema — isolation is physical (separate databases), which is the strongest guarantee and ideal for DCAA.

### DCAA / security impact

| Concern | How this design addresses it |
|---|---|
| Cross-tenant data leakage | Physically impossible — each tenant is a separate database; a query can only ever touch the connection bound to the resolved tenant |
| Audit isolation | Each customer's append-only trail lives in its own DB; export/retention/legal-hold are per-tenant |
| Secrets at rest | Tenant DB URLs stored encrypted (AES-256-GCM via existing `src/lib/encryption.ts`) in the registry |
| Fail-closed routing | An unresolved/unknown/suspended tenant is rejected before any DB access |

### Design Decisions

1. **`getDb()` is async.** Next 16's `headers()` is async, so tenant resolution is async. The 42 importers migrate from `db.select(...)` to `(await getDb()).select(...)`. Every importer is already an async function (server action / route handler / RSC), so awaiting is safe.
2. **Per-tenant connection cache.** A module-level `Map<string, DrizzleClient>` keyed by the (decrypted) tenant DB URL. Each entry is a `postgres` pool (same options as today: `max: 10, prepare: false`). Cache survives across requests in the same server instance; serverless instances each build their own (fine).
3. **Registry lookups are cached briefly** (in-memory TTL, e.g. 60s) to avoid a control-plane round-trip on every request. Status changes (suspend) take effect within the TTL.
4. **Tenant identity is in the JWT.** At login, the resolved tenant `slug` is written to the token and session. This avoids a registry lookup in the edge-runtime auth path and ties a session to exactly one tenant.
5. **Fail-closed.** Unknown subdomain, missing header, or `suspended` tenant → the request is rejected (redirect to a marketing/"unknown workspace" page or 404), never silently falling back to a default DB.
6. **The apex/marketing host and reserved subdomains** (`www`, `app`, `api`, `admin`, none) are NOT tenants. Middleware must treat them specially (allow public marketing routes; never resolve a tenant DB for them).

---

## 2. File Topology

```
Files to CREATE:
├── src/db/control-plane/schema.ts      ← Drizzle schema for the registry `tenants` table
├── src/db/control-plane/index.ts       ← Registry DB client (separate connection)
├── src/lib/tenant/registry.ts          ← getTenantBySlug() with TTL cache; create/update helpers
├── src/lib/tenant/context.ts           ← getTenantSlug()/getTenantOrThrow() reading request headers
├── drizzle.control-plane.config.ts     ← Drizzle Kit config pointing at the control-plane DB + schema
├── drizzle/control-plane/              ← Generated registry migrations (via db:generate:cp)

Files to MODIFY:
├── src/db/index.ts                     ← Replace singleton with getDb() (per-tenant cached pool)
├── src/middleware.ts                   ← Subdomain → x-tenant-slug header; gate non-tenant hosts
├── src/auth.ts                         ← Resolve tenant DB; carry tenantSlug in JWT + session
├── package.json                        ← Add db:generate:cp / db:migrate:cp scripts
├── <42 files importing `db`>           ← Mechanical: import { getDb }; `db.` → `(await getDb()).`

Files NOT TOUCHED (guardrail — DO NOT MODIFY logic):
├── src/db/schema.ts                    ← ❌ Tenant schema is unchanged (NO tenantId columns)
├── src/lib/encryption.ts              ← ❌ Reuse encrypt()/decrypt() as-is
├── src/lib/session.ts                 ← ❌ Reads from auth(); unaffected
```

> **Scope warning:** Phase C touches ~42 files mechanically. This is the bulk of the work and must be done carefully and uniformly. Use the exact procedure in Phase C. Do NOT change query logic in those files — only the accessor.

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - Read the Next.js 16 docs in `node_modules/next/dist/docs/` for `headers()`, middleware, and runtime — but do NOT grep/scan the rest of `node_modules`.
> - **Physical isolation is the product.** Never add a fallback to a "default" DB. Never add a `tenantId` filter as a substitute — the DB boundary IS the isolation.
> - Reuse `encrypt`/`decrypt` from `src/lib/encryption.ts` for tenant DB URLs.
> - Keep the `postgres` client options identical to today (`max: 10, prepare: false`).
> - **After each phase: `npm run build`.** Phase C is not "done" until `grep -rn "import { db }" src` returns ZERO results.

---

## Phase A: Control-Plane Registry

**A1.** Create `src/db/control-plane/schema.ts`:

```typescript
import { pgTable, uuid, varchar, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'provisioning', // DB being created/migrated/seeded
  'active',       // live and billable
  'suspended',    // access blocked (unpaid / admin action)
  'deleting',     // offboarding in progress
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(), // subdomain label
  name: varchar('name', { length: 200 }).notNull(),
  // Encrypted (AES-256-GCM via src/lib/encryption.ts) tenant Postgres connection string.
  dbUrlEncrypted: text('db_url_encrypted').notNull(),
  status: tenantStatusEnum('status').notNull().default('provisioning'),
  plan: varchar('plan', { length: 40 }).notNull().default('trial'),
  // Billing fields (populated by the billing blueprint; nullable for now).
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 100 }),
  subscriptionStatus: varchar('subscription_status', { length: 40 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**A2.** Create `src/db/control-plane/index.ts`:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env.CONTROL_PLANE_DATABASE_URL;
if (!url) {
  throw new Error('CONTROL_PLANE_DATABASE_URL is not set. See .env.example.');
}

// Small pool — the registry is read-light and cached in front of.
const client = postgres(url, { max: 5, prepare: false });
export const controlDb = drizzle(client, { schema });
export { schema as controlSchema };
```

**A3.** Create `drizzle.control-plane.config.ts`. Match the existing `drizzle.config.ts` exactly — it uses `defineConfig` from `drizzle-kit` (confirmed). Only `schema`, `out`, and the env var differ:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/control-plane/schema.ts',
  out: './drizzle/control-plane',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.CONTROL_PLANE_DATABASE_URL ?? '',
  },
});
```

**A4.** Add scripts to `package.json` (in `"scripts"`):

```json
    "db:generate:cp": "drizzle-kit generate --config=drizzle.control-plane.config.ts",
    "db:migrate:cp": "drizzle-kit migrate --config=drizzle.control-plane.config.ts",
```

**A5.** Generate the registry migration and apply it to your control-plane DB:

```bash
npm run db:generate:cp
# then, with CONTROL_PLANE_DATABASE_URL set:
npm run db:migrate:cp
```

**A6.** Create `src/lib/tenant/registry.ts` — cached lookup + helpers:

```typescript
import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt, encrypt } from '@/lib/encryption';

export type TenantRecord = {
  id: string;
  slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'deleting';
  plan: string;
  dbUrl: string; // decrypted
};

type CacheEntry = { value: TenantRecord | null; expires: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Look up a tenant by slug, decrypting its DB URL. Cached for TTL_MS. Returns null if unknown. */
export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expires > now) return hit.value;

  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const value: TenantRecord | null = row
    ? {
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        plan: row.plan,
        dbUrl: decrypt(row.dbUrlEncrypted),
      }
    : null;

  cache.set(slug, { value, expires: now + TTL_MS });
  return value;
}

/** Invalidate a slug's cache entry (call after status/plan changes). */
export function invalidateTenant(slug: string): void {
  cache.delete(slug);
}

/** Insert a new tenant record (used by the provisioning blueprint). DB URL is encrypted at rest. */
export async function createTenantRecord(input: {
  slug: string; name: string; dbUrl: string; plan?: string;
}): Promise<void> {
  await controlDb.insert(tenants).values({
    slug: input.slug,
    name: input.name,
    dbUrlEncrypted: encrypt(input.dbUrl),
    plan: input.plan ?? 'trial',
    status: 'provisioning',
  });
}
```

### Phase A Verification

| Check | Expected Result |
|---|---|
| `npm run build` | Zero errors |
| Registry migration applied | `tenants` table exists in control-plane DB |
| Manually insert a tenant + `getTenantBySlug` | Returns record with **decrypted** dbUrl |
| Unknown slug | Returns `null` (cached) |

---

## Phase B: Subdomain Resolution in Middleware

**B1.** Replace `src/middleware.ts`. The current file is `export { auth as middleware }`. The new middleware must (1) resolve the tenant from the Host subdomain, (2) inject `x-tenant-slug`, (3) handle non-tenant hosts (apex/marketing, reserved subdomains), then (4) chain Auth.js for protected routes.

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';

const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? 'localhost';
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'static', 'assets']);

/** Extract the tenant subdomain label from a Host header, or null for apex/reserved. */
function tenantFromHost(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0]; // strip port
  if (hostname === ROOT_DOMAIN || hostname === `www.${ROOT_DOMAIN}`) return null;
  if (!hostname.endsWith(`.${ROOT_DOMAIN}`)) return null; // not a tenant host
  const label = hostname.slice(0, -1 * (`.${ROOT_DOMAIN}`).length);
  if (!label || RESERVED.has(label) || label.includes('.')) return null;
  return label;
}

export async function middleware(req: NextRequest) {
  const slug = tenantFromHost(req.headers.get('host'));

  // Inject the resolved tenant slug (or empty) as a request header for downstream getDb().
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-tenant-slug', slug ?? '');

  // Public marketing / apex host: allow through without a tenant.
  if (!slug) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Tenant host: continue with the header set. Auth.js gating still applies to
  // protected routes (see matcher). We re-create the response so the header propagates.
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    // Run on app routes so the tenant header is present; exclude static assets.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
```

> **Auth.js integration nuance:** the original middleware delegated entirely to `auth`. Auth.js v5 supports wrapping: you can call `auth` as a function inside middleware, or keep route protection in the protected layouts/server actions (which already call `requireSession`/`requireAdmin`). For this milestone, **route protection remains enforced server-side** (existing `requireAdmin()`/`requireSession()` in server actions + page-level checks). The middleware's primary new job is tenant-header injection. If you want middleware-level auth redirects preserved, consult the Next 16 + Auth.js v5 docs in `node_modules` for the `auth((req) => …)` wrapper pattern and compose it with the header injection. Do not break existing protection.

**B2.** Create `src/lib/tenant/context.ts`:

```typescript
import 'server-only';
import { headers } from 'next/headers';
import { getTenantBySlug, type TenantRecord } from './registry';

/** Read the tenant slug injected by middleware. Returns '' for apex/non-tenant requests. */
export async function getTenantSlug(): Promise<string> {
  const h = await headers();
  return h.get('x-tenant-slug') ?? '';
}

/** Resolve the active tenant or throw (fail-closed). Rejects unknown/suspended tenants. */
export async function getTenantOrThrow(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  if (tenant.status === 'suspended') throw new Error('This workspace is suspended.');
  if (tenant.status === 'deleting') throw new Error('This workspace is being removed.');
  return tenant;
}
```

### Phase B Verification

| Check | Expected Result |
|---|---|
| Request to `acme.localhost:3000` | `x-tenant-slug: acme` reaches server context |
| Request to `localhost:3000` (apex) | `x-tenant-slug: ''`; marketing routes load |
| Request to `www.<root>` / `app.<root>` | Treated as non-tenant (reserved) |
| `getTenantOrThrow()` on a suspended tenant | Throws "suspended" |

> Local subdomain testing: `acme.localhost` resolves to 127.0.0.1 in modern browsers/curl. For others, add hosts entries or use `--resolve` with curl.

---

## Phase C: Replace the `db` Singleton with `getDb()`

**C1.** Replace `src/db/index.ts`:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getTenantOrThrow } from '@/lib/tenant/context';

type TenantDb = ReturnType<typeof drizzle<typeof schema>>;

// One pooled client per distinct tenant DB URL, reused across requests in this instance.
const pools = new Map<string, TenantDb>();

function clientFor(connectionString: string): TenantDb {
  const existing = pools.get(connectionString);
  if (existing) return existing;
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const instance = drizzle(client, { schema });
  pools.set(connectionString, instance);
  return instance;
}

/**
 * Resolve the Drizzle client for the CURRENT request's tenant.
 * Fail-closed: throws if no/unknown/suspended tenant.
 */
export async function getDb(): Promise<TenantDb> {
  const tenant = await getTenantOrThrow();
  return clientFor(tenant.dbUrl);
}

/**
 * Resolve a Drizzle client for an explicit connection string.
 * Used by auth (tenant resolved from JWT) and by provisioning/seed paths
 * that operate outside the request tenant context.
 */
export function getDbForUrl(connectionString: string): TenantDb {
  return clientFor(connectionString);
}
```

> **Note:** `getDb()` no longer reads `DATABASE_URL`. The single-tenant `DATABASE_URL` is now only used by scripts (seed/migrate) and tests. That is intended.

**C2.** Mechanical migration of all 42 importers. For EACH file that contains `import { db } from '@/db';`:

1. Change the import to `import { getDb } from '@/db';`
2. At the top of each function that uses `db`, add `const db = await getDb();` as the first line **inside** the function body (these are all already `async`).
3. Leave every `db.select(...)`, `db.insert(...)`, `db.update(...)`, `db.execute(...)`, `db.transaction(...)` call **unchanged** — the local `const db` shadows the old import, so the call sites need no edits.

Example transformation:

```typescript
// BEFORE
import { db } from '@/db';
export async function getUsers() {
  return db.select().from(users);
}

// AFTER
import { getDb } from '@/db';
export async function getUsers() {
  const db = await getDb();
  return db.select().from(users);
}
```

> This pattern minimizes diff and risk: the only per-function change is one line. For files where `db` is used in multiple functions, add `const db = await getDb();` to EACH function that references it. For any **module-top-level** `db` usage (rare), refactor that usage into a function — top-level `getDb()` cannot work (no request context at import time).

**C3.** Find every importer to migrate:

```bash
grep -rln "from '@/db'" src | grep -v "src/db/"
# and the exact import statements:
grep -rn "import { db } from '@/db'" src
```

Work through the list until **both** of these return zero:

```bash
grep -rn "import { db } from '@/db'" src        # must be empty
grep -rn "\bdb\b" src | grep -v "getDb\|getDbForUrl\|const db = await getDb\|control-plane\|controlDb\|getTestDb"  # audit remaining bare db usages
```

> **Special cases to handle, not skip:**
> - `src/auth.ts` — handled in Phase D (do not apply the generic C2 transform there; it needs tenant-from-JWT, not tenant-from-headers).
> - `src/app/api/health/route.ts` — health check runs without a tenant. Change it to NOT call `getDb()`; instead verify the control-plane DB connectivity (`controlDb.execute(sql\`SELECT 1\`)`), or accept a `?tenant=` param for per-tenant health. Simplest: health-check the control plane.
> - `src/app/api/cron/**` — crons run without a browser Host. See the note below.
> - Scripts in `scripts/**` and tests — they import their own clients (`provision-customer-db.ts`, `getTestDb`), NOT `@/db`. Leave them; they are out of scope here.

> **Cron + multi-tenant (important follow-up):** the cron routes currently use the request-less `db` singleton. With per-tenant routing they have no single DB. For THIS blueprint, make the cron routes iterate tenants: load all `active` tenants from the registry, and for each, `getDbForUrl(tenant.dbUrl)` and run the existing logic. Wrap the existing per-DB body in a `for (const tenant of activeTenants)` loop. If that is too large to include here, gate the cron routes to return 501 with a clear "multi-tenant cron pending" message and track the fan-out as a fast-follow — but do NOT leave them calling a non-existent singleton.

### Phase C Verification

```bash
npm run build
grep -rn "import { db } from '@/db'" src   # MUST be empty
```

| Check | Expected Result |
|---|---|
| Build | Zero errors, zero remaining singleton imports |
| Server action on a tenant host | Queries that tenant's DB |
| Two tenants, same query | Return disjoint data (see isolation test in §4) |
| Apex host hitting a tenant-only action | Fails closed ("No tenant in request context") |

---

## Phase D: Thread Tenant Through Auth.js

The auth flow can't use `getDb()` (header-based) reliably in the edge/JWT path, and a session must be bound to exactly one tenant. Carry the tenant `slug` in the JWT and resolve the tenant DB explicitly.

**D1.** Tenant-aware user lookup at login. In `src/auth.ts`, the `authorize()` callback calls `getUserByEmail(email)`. That helper now uses `getDb()` (header-based), which works during the login POST because the request is on the tenant subdomain. Confirm `getUserByEmail` was migrated in Phase C and that login requests carry the tenant header (they do — middleware runs on `/login` and the Auth.js POST).

**D2.** Persist the tenant slug in the token. In the `jwt` callback, on initial sign-in (`if (user)` block, around `src/auth.ts:66`), add tenant capture. Insert after `token.totpEnabled = ...`:

```typescript
        // Bind this session to the tenant it logged into.
        try {
          const { getTenantSlug } = await import('@/lib/tenant/context');
          token.tenantSlug = await getTenantSlug();
        } catch {
          token.tenantSlug = '';
        }
```

**D3.** Use the token's tenant for the session-version revalidation query. In the `if (token.id && !user)` block (around `src/auth.ts:92`), the existing code queries `db` (the old singleton). Replace those queries to use the tenant DB resolved from `token.tenantSlug`:

Find:

```typescript
import { db } from '@/db';
```

Replace with:

```typescript
import { getDbForUrl } from '@/db';
import { getTenantBySlug } from '@/lib/tenant/registry';
```

Then, inside the revalidation block, before the `db.select(...)` calls, resolve the tenant DB:

```typescript
          const slug = (token.tenantSlug as string) ?? '';
          const tenant = slug ? await getTenantBySlug(slug) : null;
          if (!tenant) return token; // can't validate without a tenant — fail-open like the DB-down case
          const db = getDbForUrl(tenant.dbUrl);
```

Apply the same `const db = getDbForUrl(...)` resolution to the **initial sign-in** `sessionVersion` fetch (around `src/auth.ts:74`) using the slug just captured in D2. Keep the existing 3-second timeout + fail-open semantics exactly.

**D4.** Expose the tenant on the session. In the `session` callback (around `src/auth.ts:155`), add:

```typescript
        (session.user as any).tenantSlug = token.tenantSlug as string;
```

> Optionally add `tenantSlug` to the `SessionUser` type in `src/lib/session.ts` if any caller needs it. Keep changes minimal.

**D5.** Cross-tenant session safety. Because a token is bound to one `tenantSlug`, a session cookie minted on `acme.<root>` must not authorize requests on `beta.<root>`. Cookies are already scoped per-subdomain by default (no shared parent-domain cookie), so this holds — **verify** the Auth.js cookie config does not set a parent-domain cookie (`domain: .<root>`). If it does, remove that so cookies stay per-subdomain. Add a defense-in-depth check: in the `jwt`/`session` path, if `token.tenantSlug` is non-empty and differs from the request's `x-tenant-slug`, invalidate. (Document this as a hardening step; the cookie scoping is the primary control.)

### Phase D Verification

| Check | Expected Result |
|---|---|
| Login on `acme.<root>` | Session works; `tenantSlug='acme'` in token/session |
| Session-version revalidation | Hits acme's DB (not a singleton) |
| Reuse acme cookie on `beta.<root>` | Not authorized (cookie scoped per-subdomain) |
| Deactivate user (sessionVersion bump) in acme DB | acme session invalidates within 60s |

---

## 4. Verification

### 4a. Build & lint

```bash
npm run build
npm run lint
grep -rn "import { db } from '@/db'" src   # empty
```

### 4b. Isolation test (the most important check) — `src/__tests__/integration/tenant-isolation.test.ts`

Stand up **two** tenant databases and one control-plane DB. Insert distinct users/contracts into each tenant DB directly. Then assert that resolving `getDbForUrl(tenantA.dbUrl)` only ever returns tenant A's rows and never tenant B's. Because there is no `tenantId` column, the only isolation is the connection — the test proves the routing binds the correct connection.

Pseudostructure:

```typescript
// Seed control plane with tenant A (slug 'acme') and B (slug 'beta'), each pointing
// at its own test DATABASE_URL. Seed acme DB with user 'a@acme', beta DB with 'b@beta'.
// Assert getDbForUrl(acme.dbUrl) sees a@acme and NOT b@beta, and vice versa.
```

| Isolation assertion | Expected |
|---|---|
| Query tenant A client for B's user | Not found |
| Query tenant B client for A's user | Not found |
| Same email existing in both | Each client returns its own row only |

### 4c. Regression

| Check | Expected Result |
|---|---|
| Login → timesheet → submit → approve, on one tenant | Full flow works against that tenant DB |
| Admin CRUD on a tenant | Works |
| Reports (PDF/CSV/XLSX) on a tenant | Works (route handlers migrated to `getDb()`) |
| Health check | Reports control-plane connectivity |
| Apex marketing routes | Load without a tenant |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| "No tenant in request context" on every page | middleware matcher not running / header not injected | Verify matcher; verify `NextResponse.next({ request: { headers } })` is the Next 16 idiom (check docs) |
| `headers() should be awaited` | Next 16 made `headers()` async | `await headers()` everywhere (already in `context.ts`) |
| Build fails: top-level `getDb()` | a file called `getDb()` at module scope | Move into a function — there's no request context at import |
| Remaining `import { db }` | a file missed in Phase C | The grep gate must be empty before merge |
| Login can't find user | `getUserByEmail` not tenant-resolved or login host lacks subdomain | Ensure login happens on the tenant subdomain; `getUserByEmail` uses `getDb()` |
| Cross-tenant data visible | a `getDbForUrl` called with the wrong URL, or a leftover singleton | Re-run isolation test; audit for any non-`getDb` db usage |
| Connection pool exhaustion with many tenants | each tenant holds `max:10` | Acceptable for MVP scale; for many tenants tune `max` down or add idle eviction (note as follow-up) |
| Cron route crashes | still referencing old singleton | Implement the per-tenant loop (Phase C special cases) or gate to 501 with a tracked follow-up |
