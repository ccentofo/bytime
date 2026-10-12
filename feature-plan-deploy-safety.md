# Blueprint: Deploy Safety — Multi-Tenant Migration Rollout + Server-Action Integration Tests

> **Role for the executing developer: Senior platform/backend engineer.** This is the gate before
> any real deployment. Two problems, both silent until they hurt a customer:
> (A) deploys never migrate tenant databases, and (B) the app's core server-side logic has never
> been exercised by a test. Fix both, then prove it.

## 1. Findings (diagnosed — fix, don't re-investigate)

**A1 — Deploys migrate the wrong database.** `.github/workflows/deploy-prod.yml` (and staging) run
`npm run db:deploy` → `scripts/migrate.ts`, which migrates the single DB in `PROD_DATABASE_URL`. That
predates multi-tenancy. With **database-per-tenant**, the next schema-changing deploy would never
reach the control plane (`drizzle/control-plane`) or any tenant DB (`drizzle/`), while the new code
expects the new schema → **every customer breaks on that deploy.** New tenants are fine only because
`src/lib/tenant/provision.ts` migrates at creation.

**A2 — No protection against concurrent migrations.** `provision.ts` calls Drizzle's `migrate()`
directly. A deploy-time rollout and a signup provisioning the same tenant could run `migrate()`
simultaneously. Drizzle's migrator takes no lock.

**A3 — Nothing enforces backward-compatible migrations.** Migrations run *before* the new code is
live, so the currently-deployed code must keep working against the migrated schema. A `DROP`,
`RENAME`, type change, or `SET NOT NULL` on a populated column would break production mid-deploy.

**B1 — No integration test calls a server action.** Every file in `src/__tests__/integration/`
inserts rows directly with `db.insert(...)`. That proves DB constraints, not the app logic. The
riskiest code in the product — `saveTimesheetBatch` (append-only revisions, late-entry/reason-code
and period-lock guards, `chargeCodeId` keying + denormalized `clinId`), `assignChargeCodeToUser`
(auto-syncs `user_assignments`, which drives supervisor approval scope), and
`getSupervisedEmployeeIds` — has **zero** end-to-end coverage.

**B2 — Test cleanup is stale.** `cleanupTestData()` in `src/__tests__/integration/helpers.ts` doesn't
know about `user_charge_codes`, `charge_codes`, or `cost_classes` (`cost_classes.name` is UNIQUE, so
leftovers collide across tests).

**B3 — CI skips integration tests on working branches.** The `integration-tests` job in
`.github/workflows/ci.yml` only runs on `main` or pull requests. All recent work landed on
`wip/cadenzpoint-rebuild`, so the integration suite has not run in CI for any multi-tenant,
billing, or charge-code work.

## 2. File Topology

```
CREATE:
├── src/lib/tenant/migrate-tenant.ts            ← single, lock-protected tenant-migration helper (no 'server-only')
├── scripts/migrate-all.ts                       ← control plane + every tenant; --check / --concurrency
├── scripts/check-migration-safety.ts           ← CI guard against non-backward-compatible SQL in NEW migrations
├── src/__tests__/integration/charge-code-actions.test.ts   ← real server-action tests (§4 B)
└── src/__tests__/integration/migrate-tenant.test.ts        ← helper idempotency + lock test

MODIFY:
├── src/lib/tenant/provision.ts                  ← use migrateTenantDatabase() instead of raw migrate()
├── src/__tests__/integration/helpers.ts         ← cleanup new tables; add charge-code factories
├── package.json                                 ← db:migrate:all, db:migrate:check, db:safety scripts
├── .github/workflows/deploy-prod.yml            ← migrate-all (control plane + tenants) before deploy
├── .github/workflows/deploy-staging.yml         ← same
├── .github/workflows/ci.yml                     ← integration tests on every push; add migration-safety step
└── MIGRATIONS.md                                ← document the expand/contract rule + rollout runbook

DO NOT MODIFY:
├── src/server/actions/** behavior — tests must exercise current logic, not change it. If a test
│   reveals a real bug, STOP and report it with the failing test; don't "fix" logic to make tests pass.
├── existing migration files in drizzle/ and drizzle/control-plane/ (never edit applied migrations)
└── scripts/migrate.ts / db:deploy — keep for single-DB use (CI test DB, local)
```

## 3. Part A — Multi-Tenant Migration Rollout

> **⚠️ GUARDRAILS (Part A)**
> - **Never log a decrypted connection string.** Log tenant slugs only; redact URLs in errors.
> - Scripts run under `tsx`, outside Next.js — do **not** import modules that import `'server-only'`
>   (e.g. `src/db/index.ts`, `src/lib/tenant/context.ts`). Use raw `postgres` + `drizzle` and
>   `decrypt` from `src/lib/encryption.ts` (tsx-safe; `seed-demo.ts` already does this).
> - Read `ENCRYPTION_KEY` / `CONTROL_PLANE_DATABASE_URL` from env (`dotenv` with `.env.local`, `.env`
>   for local runs, mirroring `scripts/seed-demo.ts`). Fail fast with a clear message if missing.
> - Exit non-zero if **any** tenant fails, so CI blocks the deploy.

**A.1 — `src/lib/tenant/migrate-tenant.ts`** (no `'server-only'`, importable by scripts and `provision.ts`):
```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Constant advisory-lock key shared by every migration path (rollout + provisioning).
const MIGRATION_LOCK_KEY = 728_402_113;

/** Migrate one tenant DB to the latest schema under a session advisory lock, so a deploy
 *  rollout and a signup provisioning the same DB can never run migrate() concurrently. */
export async function migrateTenantDatabase(
  url: string,
  opts: { migrationsFolder?: string; connectTimeoutSec?: number } = {},
): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: opts.connectTimeoutSec ?? 30 });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: opts.migrationsFolder ?? './drizzle' });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
}
```
Also export a read-only helper for `--check`, e.g. `getPendingMigrationCount(url, folder)`: compare
the entries in `<folder>/meta/_journal.json` against rows in Drizzle's tracking table
(`drizzle.__drizzle_migrations`; treat a missing table as "all pending"). Confirm the tracking
table's schema/name against the installed `drizzle-orm` migrator source before relying on it.

**A.2 — Use it in provisioning.** In `src/lib/tenant/provision.ts`, replace the direct
`migrate(drizzle(migrationClient), …)` call with `await migrateTenantDatabase(dbUrl)`. Keep
everything else (status transitions, resumability) identical.

**A.3 — `scripts/migrate-all.ts`.** Behavior:
1. Migrate the **control plane** first: `migrateTenantDatabase(CONTROL_PLANE_DATABASE_URL,
   { migrationsFolder: './drizzle/control-plane' })`.
2. Read tenants from the control plane (raw drizzle on `tenants`), **status in
   `('active','suspended','provisioning')`** — suspended tenants must stay current so reactivation
   works; skip `'deleting'`.
3. For each tenant: `decrypt(dbUrlEncrypted)` → `migrateTenantDatabase(url)`. Run with a concurrency
   limit (`--concurrency`, default 3). On a connection error, retry once after 5 s (Neon cold starts).
4. Print a summary table — `slug | status | result (migrated / up-to-date / FAILED: <redacted msg>)
   | duration` — and exit `1` if any tenant failed.
5. `--check`: apply nothing; print pending-migration counts for the control plane and every
   tenant. Exit `0` if all current, `2` if any pending, `1` on errors.
6. `--tenant <slug>`: limit to one tenant (for targeted re-runs after a failure).

**A.4 — npm scripts** (`package.json`):
```json
"db:migrate:all": "tsx scripts/migrate-all.ts",
"db:migrate:check": "tsx scripts/migrate-all.ts --check",
"db:safety": "tsx scripts/check-migration-safety.ts"
```

**A.5 — Deploy workflows.** In `deploy-prod.yml` and `deploy-staging.yml`, replace the
`npm run db:deploy` step with:
```yaml
- name: Migrate control plane + all tenants
  run: npm run db:migrate:all
  env:
    CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
    ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
- name: Verify every database is current
  run: npm run db:migrate:check
  env:
    CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
    ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
```
Keep this **before** the Vercel deploy steps so a failed migration aborts the deploy. Remove the
obsolete `DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}` from the migrate step (and from the Build
step if the build doesn't need it — verify with a local `npm run build` without `DATABASE_URL`).

**A.6 — `scripts/check-migration-safety.ts`** (CI guard for A3). Scan only **new** migration SQL
files — journal entries with `idx` greater than the current latest (`0009` for tenants; latest for
control plane) — and fail if a statement matches a non-backward-compatible pattern:
`DROP TABLE`, `DROP COLUMN`, `RENAME`, `ALTER COLUMN … TYPE`, `ALTER COLUMN … SET NOT NULL`,
`DROP TYPE`. Allow an explicit opt-out per statement with a preceding SQL comment
`-- migration-safety: allow <reason>`, printed in the output so reviewers see it. Hardcode the
baseline index in the script with a comment explaining why existing migrations are exempt.

**A.7 — `MIGRATIONS.md`.** Add: (1) **expand/contract rule** — every migration must work with the
currently deployed code; destructive changes ship in two deploys (add + backfill + switch code →
later deploy removes the old column); (2) the **rollout runbook**: `db:migrate:check` →
`db:migrate:all` → `db:migrate:check` → deploy; how to re-run a single failed tenant with `--tenant`.

## 4. Part B — Server-Action Integration Tests

> **⚠️ GUARDRAILS (Part B)**
> - Tests call the **real** server actions. Only the I/O edges are stubbed: tenant DB resolution,
>   session, and outbound email.
> - Mock `@/db` **per test file** using `importOriginal`, overriding only `getDb` and keeping the real
>   `getDbForUrl` (other suites such as `tenant-data-isolation.test.ts` depend on it). Do not put
>   these mocks in the shared `setup-db.ts`.
> - Integration tests truncate their DB. Point `TEST_DATABASE_URL` only at `bytime_test` (never a
>   demo/tenant DB).

**B.1 — Test harness pattern** (top of `charge-code-actions.test.ts`):
```ts
import { vi } from 'vitest';
import { getTestDb } from './helpers';

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
}));

const sessionState = vi.hoisted(() => ({ user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/lib/session', () => ({
  getSessionUser: async () => sessionState.user,
  requireSession: async () => { if (!sessionState.user) throw new Error('Unauthorized'); return sessionState.user; },
  requireAdmin: async () => { if (sessionState.user?.role !== 'admin') throw new Error('Forbidden'); return sessionState.user; },
}));

vi.mock('@/lib/email/send', () => new Proxy({}, { get: () => async () => undefined })); // no outbound email
```
Verify the exact `SessionUser` shape against `src/lib/session.ts` and adjust. Import the server
actions **after** the mocks (vitest hoists `vi.mock`, so normal top-level imports are fine).

**B.2 — Helpers** (`helpers.ts`):
- `cleanupTestData()`: delete `userChargeCodes` and `chargeCodes` right after `timesheetEntries`/
  `timesheetPeriods`, and `costClasses` after `chargeCodes` (respect FK order).
- Add `createTestChargeCode(clinId, overrides?)` and `createTestCostClass(name?)` (unique default names).

**B.3 — Date handling (important).** `saveTimesheetBatch` treats any first save on a *past* date as a
late entry that **requires a reason code**, and rejects future dates. With no `pay_period_config` row
the default is semi-monthly. So: for "plain" saves use **today** (compute `periodStart` with
`getPeriodStartForDate(today)` from `src/lib/date-utils.ts` and `dayIndex = today − periodStart`);
for late/edit cases pass `changeReasonCode: 'CORRECTION'` (a valid value in `src/lib/reason-codes.ts`).

**B.4 — Required test cases** (`charge-code-actions.test.ts`), each with a clear name:
1. **Denormalization:** a direct save with `chargeCodeId` writes a row with that `charge_code_id`
   **and** the code's `clin_id`/`slin_id`.
2. **Append-only:** saving the same cell again (with a reason code) inserts revision 2 and leaves
   revision 1 untouched; no row is ever updated or deleted.
3. **Edit requires a reason:** the second save without `changeReasonCode` throws.
4. **Onsite/telework independence:** two charge codes on the same CLIN, same day, different hours →
   two independent rows/revision chains; `getTimesheetEntries` returns the right hours per code.
5. **RBAC:** saving to a charge code the user isn't assigned to throws "Unauthorized"; after
   `unassignChargeCodeFromUser`, saving to it throws.
6. **Assignment sync:** `assignChargeCodeToUser` creates an active `user_assignments` row for the
   code's CLIN; calling it again is idempotent; it re-activates a previously deactivated assignment.
7. **Supervisor scope:** supervisor assigned to the CLIN; employee given a code under it →
   `getSupervisedEmployeeIds(supervisor.id, 'supervisor')` includes the employee.
8. **Period lock:** with a `submitted` period row for that user/period, any save throws.
9. **Future date:** saving a future day throws.
10. **Indirect path unchanged:** an indirect save stores `indirect_code_id` with `charge_code_id` null.
11. **Revision map keying:** `getRevisionMap` keys direct cells by `chargeCodeId`.
12. **Code lifecycle:** `autobridgeChargeCodesFromClins` creates one code per active CLIN and is
    idempotent on re-run; `deactivateChargeCode` soft-deletes (row remains, `is_active=false`) and the
    code disappears from `getChargeCodesForUser`.

**B.5 — `migrate-tenant.test.ts`:** run `migrateTenantDatabase(TEST_DATABASE_URL)` twice → both
succeed (idempotent); run two calls concurrently with `Promise.all` → both succeed (lock serializes
them). Skip if `TEST_DATABASE_URL` is unset.

**B.6 — CI** (`ci.yml`):
- Change the `integration-tests` job condition so it runs on **every push** (and PRs), not just `main`.
- Add a step in the lint/build job: `npm run db:safety`.

## 5. Verification

### 5a. Static + unit
```bash
npx tsc --noEmit && npm run lint && npm run test     # 0 type errors, 0 lint errors, no NEW warnings
npm run db:safety                                    # passes (no new migrations yet)
```

### 5b. Integration (local)
```bash
TEST_DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime_test \
TEST_DATABASE_URL_2=postgresql://bytime:bytime_dev@localhost:5432/bytime_test2 \
npm run test:integration
```
All existing suites still pass; all 12 charge-code cases and the migrate-tenant cases pass.

### 5c. Rollout rehearsal (local demo: control plane + acme/globex/initech)
```bash
npm run db:migrate:check     # reports per-DB pending counts (expect 0 after demo:local)
npm run db:migrate:all       # all OK, exit 0, summary table, no URLs printed
npm run db:migrate:all       # second run: all "up-to-date" (idempotent)
npm run db:migrate:all -- --tenant acme   # single-tenant run works
```
Then prove failure handling: temporarily register a tenant with an unreachable DB URL (via
`npm run seed:tenant` against a bogus host, or a control-plane row), run `db:migrate:all`, confirm that
tenant shows FAILED with a **redacted** message, the others still migrate, and the exit code is `1`.
Remove the bogus row afterward.

### 5d. Safety-guard proof
Create a throwaway migration containing `ALTER TABLE users DROP COLUMN full_name;`, run
`npm run db:safety` → **fails**; add `-- migration-safety: allow test` above it → passes and prints the
reason. Delete the throwaway file (and any journal entry) before committing.

### 5e. Common errors
| Symptom | Cause | Fix |
|---|---|---|
| `server-only` import error in a script | script imports `src/db/index.ts` or tenant context | use raw `postgres`/`drizzle` + `decrypt` |
| Every tenant "decrypt failed" | `ENCRYPTION_KEY` differs from the key that encrypted the URLs | use the same key as the app/seed |
| Other integration suites break after adding mocks | `@/db` mocked globally / `getDbForUrl` replaced | mock per file with `importOriginal`, override only `getDb` |
| Save tests throw "reason code required" | first save on a past date = late entry | use today, or pass `changeReasonCode` |
| `cost_classes` unique violation between tests | cleanup misses the table | B.2 cleanup order |
| `--check` always shows everything pending | wrong tracking-table name/schema | confirm against the installed drizzle migrator |

## 6. Definition of Done
A deploy migrates the control plane and **every** tenant database (lock-protected, idempotent,
redacted logs, non-zero exit on any failure) before new code goes live; new migrations are checked
for backward compatibility in CI; and the core server-side logic (charge-code saves, append-only
revisions, DCAA guards, assignment sync, supervisor scope) is covered by integration tests that run
on every push.
