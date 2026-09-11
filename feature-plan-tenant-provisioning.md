# Blueprint: Automated Tenant Provisioning

> **This ticket contains TWO phases (A: provisioning engine, B: CLI + idempotency). Complete A before B.**
> **Tier 2.** **Depends on `feature-plan-control-plane.md` (#4) being merged** — it uses the registry (`src/lib/tenant/registry.ts`), `controlDb`, `getDbForUrl`, and the `tenants` table. Do not start until #4's isolation tests pass.

## 1. Architectural Overview

### The Problem

Today a new customer is created by a **manual, interactive shell script** (`scripts/provision-customer.sh`) that:
- prompts a human to create a Neon project and paste the connection string,
- runs `npx drizzle-kit push` (not migrations),
- creates an admin user **with a random generated password** (`scripts/provision-customer-db.ts`),
- writes a per-customer `.env.<slug>` and expects a separate Vercel/Docker deploy.

This cannot back a self-service signup: it needs a human, it uses `push` (no migration discipline), it issues a password (violates "users set their own credentials"), and it assumes one-deployment-per-customer — which the control plane has now replaced with one deployment serving many tenants.

### The Solution

A single programmatic function, **`provisionTenant()`**, callable from the signup server action (blueprint #6) and from a thin CLI for ops. It:
1. validates and reserves the slug,
2. creates a dedicated Neon database via the Neon API,
3. records the tenant in the control-plane registry (`status: 'provisioning'`, DB URL encrypted),
4. **runs Drizzle migrations** (`drizzle/*.sql`) against the new DB — never `push`,
5. creates **only an admin user** (with **NO password** — set via the invite flow in #6) + that admin's notification preferences. **Blank slate: NO indirect codes, NO contracts.**
6. flips the tenant to `status: 'active'`.

> **Blank-slate policy (product decision):** a new tenant starts with **zero charge codes and zero contracts** — no defaults, no assumptions. The admin populates everything via the UI or by importing data. The only seeded record is the admin user (so someone can log in). The pay period is **not** seeded either: `getPayPeriodConfig()` falls back to **semi-monthly** (`DEFAULT_PERIOD_CONFIG`), which is the accepted default; the admin can change it in settings.

It is **idempotent and resumable**: re-running for a partially-provisioned slug continues from where it failed, driven by the `status` column.

### Design Decisions

1. **No password at provisioning.** The admin `users` row is created with `passwordHash = null`. `src/auth.ts` already rejects login when `passwordHash` is falsy, so the account is dormant until the invite flow (#6) sets a password. This satisfies the rule that users set their own credentials.
2. **Migrations, not push.** Reuse the migrator pattern from `scripts/migrate.ts` (`migrate(db, { migrationsFolder: './drizzle' })`) against the freshly created DB. This guarantees every tenant DB matches committed migrations exactly.
3. **No seed data (blank slate).** Provisioning does NOT seed indirect codes, contracts, labor categories, or a pay-period row. Only the admin user is created. (This intentionally drops the old `provision-customer-db.ts` indirect-code seeding.)
4. **Neon API with a documented fallback.** Primary path: Neon REST API (`NEON_API_KEY`). Fallback for self-hosted Postgres clusters: a `createDatabase(sql)` path that runs `CREATE DATABASE`. The function takes a pluggable "database creator" so the engine is host-agnostic.
5. **Encryption at rest.** The tenant DB URL is stored encrypted via the registry helper (`createTenantRecord` already calls `encrypt`).
6. **Runs outside request context.** Provisioning has no tenant Host header, so it uses `controlDb` + `getDbForUrl(newDbUrl)` directly — never `getDb()`.

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/tenant/provision.ts         ← provisionTenant() engine (the core deliverable)
├── src/lib/tenant/neon.ts              ← Neon API client: createNeonDatabase() + fallback
├── scripts/provision-tenant.ts         ← Thin CLI wrapper calling provisionTenant()

Files to MODIFY:
├── package.json                        ← Add a "provision:tenant" script (optional convenience)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/control-plane/**             ← ❌ Use registry helpers; don't change the schema
├── src/lib/tenant/registry.ts          ← ❌ Use createTenantRecord/getTenantBySlug/invalidateTenant as-is
├── src/db/index.ts                     ← ❌ Use getDbForUrl as-is
├── src/db/schema.ts                    ← ❌ Tenant schema unchanged
├── scripts/provision-customer.sh       ← ❌ Leave the legacy script (or delete in a later cleanup; not here)
├── scripts/migrate.ts                  ← ❌ Reference its pattern; don't change it
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** scan `node_modules`.
> - Provisioning runs server-side, outside any request — use `controlDb` and `getDbForUrl()`, never `getDb()`.
> - The admin user is created with **no password**. Do not generate or set one.
> - Run **migrations** (`migrate()` over `./drizzle`), never `drizzle-kit push`.
> - Treat the Neon API shapes below as a starting point — **verify against current Neon API docs** before relying on exact field names; the connection-string field in particular varies.
> - **After Phase A: `npm run build`.**

---

## Phase A: Provisioning Engine

> **Blank slate:** there is no indirect-code (or any) seed list. Provisioning creates only the
> admin user. The old `scripts/provision-customer-db.ts` indirect-code seeding is intentionally
> not carried forward — do not extract or reuse it.

**A3.** Create `src/lib/tenant/neon.ts` — database creation:

```typescript
import 'server-only';

/**
 * Create a dedicated Postgres database for a tenant and return its connection string.
 * Primary implementation: Neon REST API. VERIFY the endpoint/fields against current Neon docs.
 */
export async function createNeonDatabase(slug: string): Promise<string> {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('NEON_API_KEY / NEON_PROJECT_ID not set — cannot create tenant database.');
  }

  // Neon model: one project can hold many databases (or many branches). Creating a
  // database within the shared project is the simplest unit of isolation. For stronger
  // isolation, create a separate Neon PROJECT per tenant instead (returns its own URI).
  // VERIFY exact request/response shape at https://api-docs.neon.tech before shipping.
  const res = await fetch(`https://console.neon.tech/api/v2/projects/${projectId}/databases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ database: { name: `tenant_${slug}`, owner_name: 'neondb_owner' } }),
  });
  if (!res.ok) {
    throw new Error(`Neon database creation failed: ${res.status} ${await res.text()}`);
  }

  // The connection URI is NOT returned by the create-database call on all Neon plans.
  // You typically construct it from the project's connection details (host, role,
  // password, dbname). VERIFY: fetch the project connection_uri / endpoint and
  // substitute the new database name. Return a full postgres:// URL with sslmode=require.
  // Implement this construction per the current Neon API and return the string.
  throw new Error('TODO: construct and return the tenant connection string per Neon API docs');
}
```

> **Important for the execution agent:** the Neon API's exact way to obtain a usable connection string changed across versions and plans. Do not guess. Read Neon's current API docs, implement the construction, and return a complete `postgres://…?sslmode=require` URL. If the deployment is **not** on Neon, implement an alternative creator (e.g. connect to an admin Postgres URL and `CREATE DATABASE tenant_<slug>`, then return that DB's URL) and have `provisionTenant` accept it via the `createDatabase` parameter in A4.

**A4.** Create `src/lib/tenant/provision.ts` — the engine:

```typescript
import 'server-only';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { getTenantBySlug, createTenantRecord, invalidateTenant } from '@/lib/tenant/registry';
import { decrypt } from '@/lib/encryption';
import { getDbForUrl } from '@/db';
import * as schema from '@/db/schema';
import { createNeonDatabase } from './neon';

const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'support']);

export function isValidSlug(slug: string): boolean {
  // DNS label: 1–63 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen.
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

export type ProvisionInput = {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  plan?: string;
  /** Override DB creation (tests / self-hosted). Defaults to Neon. */
  createDatabase?: (slug: string) => Promise<string>;
};

export type ProvisionResult = { slug: string; adminUserId: string };

/**
 * Provision a new tenant end-to-end. Idempotent and resumable: safe to re-run for a
 * slug stuck in 'provisioning'. Throws on hard failure, leaving status='provisioning'.
 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = input.slug.toLowerCase().trim();
  if (!isValidSlug(slug)) throw new Error(`Invalid workspace name: "${slug}".`);

  const existing = await getTenantBySlug(slug);
  if (existing && existing.status === 'active') {
    throw new Error(`Workspace "${slug}" already exists.`);
  }

  // 1. Create the database (only if we don't already have a record from a prior attempt).
  let dbUrl: string;
  if (existing) {
    dbUrl = existing.dbUrl; // resume — reuse the recorded (decrypted) URL
  } else {
    const create = input.createDatabase ?? createNeonDatabase;
    dbUrl = await create(slug);
    // 2. Register immediately (status 'provisioning') so a crash is resumable.
    await createTenantRecord({ slug, name: input.name, dbUrl, plan: input.plan });
    invalidateTenant(slug);
  }

  // 3. Run migrations against the tenant DB (NOT push). Use a dedicated single-conn client.
  const migrationClient = postgres(dbUrl, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: './drizzle' });
  } finally {
    await migrationClient.end();
  }

  // 4. Blank slate: create ONLY the admin user (no password) + prefs. No codes, no contracts.
  const db = getDbForUrl(dbUrl);

  const email = input.adminEmail.toLowerCase().trim();
  let [admin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!admin) {
    [admin] = await db.insert(schema.users).values({
      email,
      fullName: input.adminName.trim(),
      role: 'admin',
      isActive: true,
      // passwordHash intentionally omitted — set via the invite flow (signup blueprint).
    }).returning({ id: schema.users.id });
    await db.insert(schema.notificationPreferences).values({ userId: admin.id });
  }

  // 5. Activate.
  await controlDb.update(tenants).set({ status: 'active', updatedAt: new Date() }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);

  return { slug, adminUserId: admin.id };
}
```

> **Confirmed safe:** `src/db/schema.ts` declares `passwordHash: varchar('password_hash', { length: 255 })` with **no `.notNull()`** — it is nullable. And `auth.ts` rejects login when `!user.passwordHash`. So creating the admin with a null `passwordHash` is correct and the account stays dormant until the invite flow sets a password. No schema change needed.

### Phase A Verification

```bash
npm run build
```

| Check | Expected Result |
|---|---|
| `provisionTenant` with a test `createDatabase` returning a scratch DB URL | New DB migrated; registry row `active` |
| Re-run for the same slug mid-failure | Resumes; no duplicate admin; ends `active` |
| Admin user row | `passwordHash` is null; cannot log in yet |
| Charge codes / contracts | **Zero** — blank slate (admin adds them later) |
| Pay period | No `pay_period_config` row; app defaults to semi-monthly |
| Invalid slug (`WWW`, `a_b`, reserved) | Throws |

---

## Phase B: CLI Wrapper & Idempotency Hardening

**B1.** Create `scripts/provision-tenant.ts` (ops convenience — replaces the interactive shell flow):

```typescript
import 'dotenv/config';
import { provisionTenant } from '@/lib/tenant/provision';

const [slug, name, adminEmail, adminName] = process.argv.slice(2);
if (!slug || !name || !adminEmail || !adminName) {
  console.error('Usage: tsx scripts/provision-tenant.ts <slug> <name> <admin-email> <admin-name>');
  process.exit(1);
}

provisionTenant({ slug, name, adminEmail, adminName })
  .then((r) => {
    console.log(`✓ Provisioned tenant "${r.slug}" (admin user ${r.adminUserId}).`);
    console.log('  The admin must set their password via the invite link (signup/onboarding flow).');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Provisioning failed:', err);
    process.exit(1);
  });
```

> The `@/` alias may not resolve under `tsx` without tsconfig paths support. If it doesn't, either use relative imports in this script or ensure `tsx` honors `tsconfig.json` paths (the existing `scripts/*.ts` use `@/` — check how they run; match that). If existing scripts use relative imports, use relative here too.

**B2.** Add to `package.json` scripts (optional):

```json
    "provision:tenant": "tsx scripts/provision-tenant.ts",
```

**B3.** Idempotency review checklist (no new code unless a gap is found):
- Re-running with an `active` slug throws (guarded).
- Re-running with a `provisioning` slug reuses the recorded DB URL and re-applies migrations (migrations are idempotent — already-applied ones are skipped by the migrator) and seeds conditionally.
- A failure after DB creation but before activation leaves `status='provisioning'` and a recorded URL → next run resumes.

### Phase B Verification

| Check | Expected Result |
|---|---|
| `npm run provision:tenant acme "Acme Corp" admin@acme.com "Admin"` | Creates DB, migrates, seeds, activates |
| Kill mid-run after registry insert; re-run | Completes without duplication |
| Provision two tenants | Two isolated DBs; both `active`; registry has both |

---

## 4. Verification

### 4a. Build

```bash
npm run build
```

### 4b. End-to-end with the control plane

1. Provision `acme` and `beta` via the CLI (using real Neon creds or a test `createDatabase`).
2. Confirm each registry row is `active` with an **encrypted** `db_url_encrypted` (not plaintext).
3. `getTenantBySlug('acme')` returns a decrypted URL that connects.
4. Each tenant DB has exactly one passwordless admin and **no charge codes / contracts**.
5. Run the control-plane isolation test (#4 §4b) against the two provisioned DBs — must pass.

### 4c. Integration test — `src/__tests__/integration/provision.test.ts`

Provide a fake `createDatabase` that returns a disposable scratch DB URL (e.g. a second test database). Assert: migrations applied (a known table exists), admin user exists with null `passwordHash`, **zero `indirect_charge_codes` and zero `contracts`**, registry row `active`, and a second run is a no-op.

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `passwordHash` violates not-null | schema requires a password | See A4 verify note — make nullable or set via signup atomically |
| Neon connection string wrong | guessed API shape | Implement construction per current Neon docs; return full `postgres://…?sslmode=require` |
| Duplicate admin on re-run | unconditional insert | Guard with the existing `if (!admin)` check (already in A4) |
| Migrations not applied | used `push` or wrong folder | Use `migrate(..., { migrationsFolder: './drizzle' })` |
| `getDb()` called in provisioning | no request context | Use `getDbForUrl(dbUrl)` |
| `@/` import fails under tsx | path alias unsupported by runner | Match how existing `scripts/*.ts` import; use relative if needed |
| Tenant stuck `provisioning` | hard failure mid-run | Re-run the same slug — it resumes |
