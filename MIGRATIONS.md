# Database Migrations Guide

CadenzPoint is **database-per-tenant**: a control-plane database (`drizzle/control-plane`) holds
tenant records, and every tenant has its own physical Postgres database running the app schema
(`drizzle/`). A schema-changing deploy must migrate the control plane **and every tenant database**
before the new code goes live — see [Production Deployment](#production-deployment) below.

## Development Workflow

### Making Schema Changes

1. **Edit the schema file:**
   ```
   src/db/schema.ts
   ```

2. **Generate a migration:**
   ```bash
   npm run db:generate
   ```
   This creates a new SQL file in `./drizzle/` containing only the incremental changes.

3. **Review the generated SQL:**
   Open the new file in `./drizzle/` and verify:
   - The SQL matches your intended changes
   - No unintended DROP or ALTER statements
   - Indexes and foreign keys are correct
   - It passes `npm run db:safety` (see [The expand/contract rule](#the-expandcontract-rule) — this
     runs in CI on every push, so check it locally before you push)

4. **Apply the migration locally:**
   ```bash
   npm run db:migrate
   ```

5. **Commit the migration files:**
   ```bash
   git add drizzle/
   git commit -m "db: add <description of change>"
   ```

### Quick Local Development

For rapid prototyping (NOT for changes going to production):

```bash
npm run db:push
```

This directly syncs the database without generating migration files. **Never use `push` for changes that will be deployed to staging/production.**

## The expand/contract rule

Migrations run **before** the new application code is live. That means, for the entire window
between "migration applied" and "new code deployed," **the currently-running (old) code must keep
working against the migrated schema.** A migration that breaks the old code breaks production for
every tenant for the whole deploy window — there is no way to "migrate and deploy" atomically across
one control-plane database plus N tenant databases.

Concretely, this means:

- **Never** ship, in one migration: `DROP TABLE`, `DROP COLUMN`, a column `RENAME`, an `ALTER COLUMN
  ... TYPE`, or `ALTER COLUMN ... SET NOT NULL` on a column that already has rows. `npm run db:safety`
  (wired into CI) blocks all of these for any migration added after this rule was introduced.
- **Do** ship destructive changes as two separate deploys:
  1. **Expand** — add the new column/table (nullable, or with a default), and update the code to
     *write* to both the old and new shape while still *reading* the old one. Deploy this first.
  2. **Backfill** — run a one-off script (or let the expand deploy's write path backfill naturally)
     to populate the new column for existing rows.
  3. **Contract** — once the expand deploy has been live for a while and the backfill is confirmed
     complete, ship a second deploy that switches the code to the new shape and, in a *later* third
     migration, drops the old column/table.
- A genuinely safe destructive statement (e.g. dropping a column that was added and never used in
  the same uncommitted change set) can opt out of the `db:safety` guard with a comment immediately
  above the statement: `-- migration-safety: allow <reason>`. The reason is printed in CI output —
  use it to explain *why* it's safe, not just to silence the check.

### Note: tenant migration 0014 (certified outputs)

`0014_certified_outputs` is additive (new tables, nullable/defaulted columns, triggers, backfills), so the old code
keeps working against it — but **deploy the new code immediately after running it**. In the window between the two,
the old migration importer can still write history without the new provenance (those rows are labelled "Legacy
import" by their `MIGRATION` reason code), and the old `submitPeriod` doesn't set `history_import_closed_at`. The new
import-window check also treats any app-sourced `submitted` period event as "closed", so a submission made by the old
code still closes the window once the new code is live.

### Note: tenant migration 0015 (dated labor-category rates)

`0015` only creates `labor_category_rates` (its FKs and the `lcat_rate_effective_unique_idx` unique index); there is no
backfill. With no rows, every rate equals today's starting rate, so deploying it changes no number.

- **Deploy the app right after migrating.** Older code ignores the new table, which is harmless until someone adds a
  dated change through the new UI.
- **Never roll the app back past dated rates once a dated change exists.** Older code prices every hour at the starting
  rate (`labor_categories.hourly_rate`), which silently re-prices history. Fix forward instead. This is the one
  exception to "code can be rolled back with Instant Rollback" below.

### Note: tenant migration 0016 (a charge code's labor category by date)

`0016` only creates `charge_code_labor_categories` (its FKs — the labor category with NO ACTION, never `SET NULL` — and
the `cc_lcat_effective_unique_idx` unique index); there is no backfill. With no rows, every charge code keeps its
category (`charge_codes.labor_category_id`, now the starting category), so deploying it changes no number.

- **Deploy the app right after migrating**, as for 0015.
- **The same no-rollback rule applies once a dated category change exists.** Older code prices every entry on a code
  with the code's starting category, which silently re-prices history. Fix forward instead.

### Note: tenant migration 0017 (timesheet notes)

`0017_timesheet_notes` only creates `timesheet_notes` (its FKs, the `timesheet_notes_cell_rev_unique_idx` unique index,
a lookup index, the one-code CHECK) and its append-only triggers (the 0012 function, row-level UPDATE/DELETE and
statement-level TRUNCATE). There is no backfill: notes were never saved before.

- **Additive: deploy it before the app.** Older code ignores the table.
- **Never roll the app back past it once notes exist.** Older code neither shows nor saves notes, so employees would
  see their notes disappear (the rows stay, append-only). Fix forward instead.

## Production Deployment

### Automated (CI/CD)

Both deploy workflows (`deploy-prod.yml`, `deploy-staging.yml`) run this before the Vercel deploy
step, so a failed or incomplete migration aborts the deploy instead of shipping new code against a
stale schema:

```bash
npm run db:migrate:all      # migrate control plane + every tenant
npm run db:migrate:check    # verify nothing is left pending; non-zero exit fails the deploy
```

`npm run db:deploy` (`scripts/migrate.ts`) still exists, but it only migrates a **single** database
named by `DATABASE_URL` — it predates multi-tenancy. Keep using it for the CI unit/integration test
database and any other single-DB local work; it is **not** the deploy-time migrator.

### Manual rollout runbook

Run from the repo root with `CONTROL_PLANE_DATABASE_URL` and `ENCRYPTION_KEY` set (the same
`ENCRYPTION_KEY` the running app uses — it decrypts tenant connection strings read from the control
plane). Locally, these can live in `.env.local`/`.env`. In CI/deploy they come from **GitHub
Environment** secrets — the `staging` and `production` Environments each hold their own
`CONTROL_PLANE_DATABASE_URL` and `ENCRYPTION_KEY` (the deploy jobs declare `environment:`). Never
store these as repo-level secrets: both workflows would then read the same values, and a staging
deploy would migrate production databases.

```bash
# 1. See what's pending, before touching anything.
npm run db:migrate:check

# 2. Apply. Migrates the control plane first, then every tenant in status
#    active/suspended/provisioning/deleting, with bounded concurrency and one
#    retry-after-5s per database on a connection error (Neon cold starts). A 'deleting'
#    tenant whose database is CONFIRMED gone (Neon 404 / no pg_database row) is reported
#    "skipped (database deleted)"; any other failure is FAILED.
npm run db:migrate:all

# 3. Confirm nothing is left pending.
npm run db:migrate:check

# 4. Deploy the new code.
```

**Re-running a single failed tenant.** `db:migrate:all` prints a summary table and exits non-zero if
any tenant failed, but every other tenant that succeeded stays migrated — it doesn't roll anything
back. To retry just the one that failed (after fixing whatever caused it — usually a transient
connection issue):

```bash
npm run db:migrate:all -- --tenant <slug>
```

**Concurrency.** Tenants migrate `--concurrency 3` at a time by default
(`npm run db:migrate:all -- --concurrency 5` to change it). Raise it for a large tenant count if your
Postgres provider can take the connection burst; lower it if you're hitting connection limits.

### Safety net: concurrent migration protection

Both the rollout script and tenant provisioning (`src/lib/tenant/provision.ts`, for brand-new
signups) migrate through the same `migrateTenantDatabase()` helper
(`src/lib/tenant/migrate-tenant.ts`), which wraps Drizzle's `migrate()` in a Postgres session
advisory lock. If a deploy rollout and a signup happen to provision/migrate the same tenant database
at the same moment, one simply waits for the other's lock instead of racing — Drizzle's own migrator
takes no lock on its own.

## Commands Reference

| Command | Purpose | When to Use |
|---|---|---|
| `npm run db:generate` | Generate migration SQL from schema changes | After editing `schema.ts` |
| `npm run db:migrate` | Apply pending migrations (drizzle-kit, local single DB) | After generating, local dev |
| `npm run db:push` | Directly sync schema (no migration file) | Local dev only, never production |
| `npm run db:studio` | Open Drizzle Studio GUI | Debugging, data inspection |
| `npm run db:check` | Verify schema ↔ migration sync (drizzle-kit) | CI checks, pre-deployment |
| `npm run db:safety` | Block non-backward-compatible SQL in new migrations | CI, before pushing a new migration |
| `npm run db:deploy` | Migrate the single DB named by `DATABASE_URL` | CI test DB, local single-DB work only |
| `npm run db:migrate:all` | Migrate the control plane + every tenant DB | Deploy pipeline (prod/staging) |
| `npm run db:migrate:check` | Report pending-migration counts for every DB, apply nothing | Deploy pipeline verification, rollout rehearsal |

## Important Rules

1. **Never edit generated migration files** — They are auto-generated and must match the schema snapshots
2. **Never delete migration files** — They represent the schema history
3. **Always review generated SQL** — Before committing, ensure no destructive operations (and run `npm run db:safety`)
4. **Commit `drizzle/` directory** — Including `drizzle/meta/` — this is the migration history
5. **Never use `push` in production** — Always use `generate` + `migrate`

## Rollback: fix forward only

There are no down-migrations, and a production database is never edited by hand to "undo" one.

1. Write a **new** migration that corrects the problem (revert the `schema.ts` change if that is the fix, then
   `npm run db:generate` / `npm run db:generate:cp`).
2. `npm run db:safety`, then deploy it through the normal pipeline.

Never re-run a broken migration, never edit one that has already been applied, and never rewind a tenant database to
undo one. Code can be rolled back with Vercel Instant Rollback (the expand/contract rule keeps older code working on the
newer schema — see PRODUCTION-DEPLOY.md Phase 14). Restoring lost data is in `RESTORE.md`.
