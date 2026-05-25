# Blueprint: Database Migration Strategy — Production-Safe Schema Evolution

## 1. Architectural Overview

### The Problem

The project currently uses `drizzle-kit push` for all schema changes. This command directly modifies the database to match the schema file — **without generating migration files or maintaining a migration history**.

**Why `push` is dangerous in production:**

1. **No migration history** — There's no record of what schema changes were applied, when, or in what order
2. **Destructive operations without warning** — `push` can DROP columns, DROP tables, or ALTER columns with data loss if the schema file changes in certain ways
3. **No rollback capability** — If a schema change breaks the application, there's no way to revert to the previous state
4. **No code review for schema changes** — Without migration SQL files, schema changes can't be reviewed in pull requests
5. **Multi-environment drift** — Without versioned migrations, dev/staging/production databases can drift out of sync

### The Solution: Drizzle Migrations

Drizzle Kit provides a proper migration workflow:

```
Developer changes src/db/schema.ts
  → Runs: npm run db:generate
  → Drizzle Kit generates a SQL migration file in ./drizzle/
  → Developer reviews the SQL
  → Migration file is committed to git
  → On deployment: npm run db:migrate
  → Drizzle Kit applies pending migrations in order
  → Migration is recorded in a __drizzle_migrations table
```

### Design Decisions

1. **Generate + Migrate workflow** — Use `drizzle-kit generate` to create SQL migration files, then `drizzle-kit migrate` to apply them. Never use `push` in production.
2. **Keep `push` for development** — `push` remains available via `npm run db:push` for rapid local development. But `generate`/`migrate` should be used for any changes destined for staging/production.
3. **Migration files in git** — All generated SQL files in `./drizzle/` are committed to version control. They serve as a reviewable, auditable history of schema changes.
4. **No custom migration runner** — Use Drizzle Kit's built-in migration runner. No need for a separate tool.
5. **Baseline migration** — Generate a baseline migration from the current schema state so existing databases can be bootstrapped.

### DCAA Relevance

While database migrations aren't a direct DCAA requirement, the **integrity and auditability of the data store** is implicit in all DCAA compliance. If a schema migration drops the `change_reason_code` column or truncates `timesheet_entries`, the entire audit trail is destroyed. Proper migrations with review and rollback capability protect against this.

---

## 2. File Topology

```
Files to CREATE:
├── drizzle/                                          ← Migration output directory (auto-generated)
│   ├── meta/                                         ← Drizzle Kit metadata (auto-generated)
│   └── 0000_initial_schema.sql                       ← Baseline migration (auto-generated)
│
├── scripts/
│   └── migrate.ts                                    ← Programmatic migration runner for deployment

Files to MODIFY:
├── drizzle.config.ts                                 ← Already correctly configured (verify)
├── package.json                                      ← Add migration scripts
├── src/db/index.ts                                   ← Add migration runner for programmatic use
├── .gitignore                                        ← Ensure drizzle/ is NOT ignored

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                  ← ❌ DO NOT MODIFY (schema is the source of truth)
├── src/auth.ts                                       ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/components/**                                 ← ❌ DO NOT MODIFY
├── src/server/actions/**                              ← ❌ DO NOT MODIFY
├── src/app/**                                        ← ❌ DO NOT MODIFY
├── src/lib/**                                        ← ❌ DO NOT MODIFY
├── src/types/**                                      ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify `src/db/schema.ts` — the schema file is the source of truth and is NOT being changed in this blueprint.
> - **DO NOT** modify any application code files listed in the "DO NOT MODIFY" section.
> - This blueprint is about **infrastructure and workflow** — not application features.
> - Follow the step order exactly.
> - **After completing each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Verify & Update Configuration (A1–A3)

#### A1. Verify `drizzle.config.ts` is correctly configured

The current file should already look like this:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime',
  },
});
```

**Verify:**
- `schema` points to `./src/db/schema.ts` ✅
- `out` points to `./drizzle` ✅ (this is where migration files will be generated)
- `dialect` is `'postgresql'` ✅

If the file matches, **no changes needed**. If `out` is missing or different, update it.

#### A2. Verify `.gitignore` does NOT exclude the `drizzle/` directory

Check `.gitignore` for any lines that would exclude the migration output directory. The `drizzle/` directory should be **committed to git** — it contains the migration SQL files that serve as the schema change history.

If `.gitignore` contains `drizzle/` or `drizzle/*`, remove that line.

**Note:** The `drizzle/meta/` directory contains Drizzle Kit's internal metadata (snapshot JSONs). This should ALSO be committed — it's needed for Drizzle Kit to generate correct incremental migrations.

#### A3. Update `package.json` — Add/verify migration scripts

The existing scripts should already include:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:push": "drizzle-kit push",
"db:studio": "drizzle-kit studio"
```

If these are already present, **no changes needed**.

Add one new convenience script for checking migration status:

Find the `"scripts"` section and add after `"db:studio"`:

```json
"db:check": "drizzle-kit check"
```

The `check` command validates that the schema file and migration files are in sync.

---

### Phase B: Generate Baseline Migration (B1–B2)

#### B1. Generate the initial migration

This creates a SQL migration file representing the ENTIRE current schema. Run:

```bash
npx drizzle-kit generate
```

This will create files in `./drizzle/`:
- `0000_<name>.sql` — The SQL DDL for all tables, enums, indexes
- `meta/0000_snapshot.json` — Schema snapshot for incremental diff

**Important:** The generated migration file will contain CREATE TABLE statements for ALL tables currently defined in `src/db/schema.ts`. Review it to ensure it matches the expected schema.

#### B2. Review the generated migration

Open the generated SQL file (e.g., `./drizzle/0000_initial_schema.sql`) and verify:

1. All tables are present: `users`, `contracts`, `clins`, `slins`, `user_assignments`, `labor_categories`, `user_labor_categories`, `timesheet_entries`, `timesheet_periods`, `notification_preferences`
2. All enums are present: `user_role`, `record_status`, `period_status`
3. All indexes and foreign keys are correct
4. No DROP statements (this is a fresh baseline — there should only be CREATE statements)

**Do NOT run `db:migrate` yet.** The existing database already has these tables from `push`. See Phase C for handling existing databases.

---

### Phase C: Handle Existing Databases (C1)

#### C1. Mark the baseline migration as already applied

For existing databases (dev, staging) that were set up via `push`, the tables already exist. Running the baseline migration would fail with "table already exists" errors.

The solution is to mark the baseline migration as "already applied" without actually running it. Drizzle Kit tracks applied migrations in a `__drizzle_migrations` table.

**Option A — For existing databases (dev/staging):**

Create the Drizzle migrations tracking table and insert the baseline migration record manually:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "
CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
);
"
```

Then run `drizzle-kit migrate` with a special flag or manually insert the migration hash. The simplest approach for existing databases:

```bash
# Run migrate — if the database already has all tables, Drizzle Kit should handle this gracefully
# by detecting that the migration's DDL has already been applied
npx drizzle-kit migrate
```

If Drizzle Kit's migrate command fails because tables already exist, use `push` one final time to sync the migration state:

```bash
npx drizzle-kit push
```

Then generate and migrate will work correctly for all future changes.

**Option B — For brand-new databases (fresh installs):**

Simply run:

```bash
npx drizzle-kit migrate
```

This applies the baseline migration, creating all tables from scratch.

---

### Phase D: Create Programmatic Migration Runner (D1)

#### D1. Create `scripts/migrate.ts` — For CI/CD deployment automation

This script can be called during deployment to run pending migrations programmatically:

```typescript
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  console.log('Running database migrations...');

  // Use max 1 connection for migrations
  const migrationClient = postgres(connectionString, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }

  await migrationClient.end();
  process.exit(0);
}

runMigrations();
```

**Add a script to `package.json`:**

Find the `"scripts"` section and add:

```json
"db:deploy": "tsx scripts/migrate.ts"
```

**Install `tsx` as a dev dependency** (for running TypeScript scripts):

```bash
npm install -D tsx dotenv
```

**Note:** `tsx` is a TypeScript script runner. `dotenv` loads `.env.local` for the `DATABASE_URL`. In production CI/CD, the environment variable is typically set by the deployment platform.

---

### Phase E: Update Developer Documentation (E1)

#### E1. Create `MIGRATIONS.md` — Developer guide for schema changes

Create a new file at the project root:

```markdown
# Database Migrations Guide

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

## Production Deployment

### Automated (CI/CD)

Add this step to your deployment pipeline BEFORE starting the application:

```bash
npm run db:deploy
```

This runs all pending migrations in order.

### Manual

```bash
DATABASE_URL=postgresql://user:pass@host:5432/dbname npx drizzle-kit migrate
```

## Commands Reference

| Command | Purpose | When to Use |
|---|---|---|
| `npm run db:generate` | Generate migration SQL from schema changes | After editing `schema.ts` |
| `npm run db:migrate` | Apply pending migrations | After generating, or on deployment |
| `npm run db:push` | Directly sync schema (no migration file) | Local dev only, never production |
| `npm run db:studio` | Open Drizzle Studio GUI | Debugging, data inspection |
| `npm run db:check` | Verify schema ↔ migration sync | CI checks, pre-deployment |
| `npm run db:deploy` | Programmatic migration (for CI/CD) | Deployment automation |

## Important Rules

1. **Never edit generated migration files** — They are auto-generated and must match the schema snapshots
2. **Never delete migration files** — They represent the schema history
3. **Always review generated SQL** — Before committing, ensure no destructive operations
4. **Commit `drizzle/` directory** — Including `drizzle/meta/` — this is the migration history
5. **Never use `push` in production** — Always use `generate` + `migrate`

## Rollback

Drizzle Kit does not have a built-in rollback command. To rollback:

1. Revert the `schema.ts` change in git
2. Generate a new migration (which will be the "undo" of the previous change)
3. Apply the new migration

For emergency rollbacks, manually execute the reverse SQL against the database.
```

---

### Phase F: Add CI/CD Migration Check (F1)

#### F1. Add a schema sync check script

This is optional but recommended. Add a check to your CI pipeline that verifies migrations are up to date with the schema.

Add to `package.json` scripts:

```json
"db:check-sync": "drizzle-kit check"
```

In CI (e.g., GitHub Actions), add:

```yaml
- name: Check migration sync
  run: npm run db:check-sync
```

This fails the build if someone changed `schema.ts` without generating a corresponding migration.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**. The migration infrastructure changes don't affect the build — they're tooling-only.

### 4b. Migration Workflow Checks

| Check | Expected Result |
|---|---|
| **`npm run db:generate`** | Creates migration SQL files in `./drizzle/` |
| **`npm run db:migrate`** | Applies pending migrations to the database |
| **Generated SQL matches schema** | All tables, columns, indexes, FKs present |
| **No duplicate tables** | Baseline migration doesn't conflict with existing tables |
| **`npm run db:check`** | Returns success (schema and migrations in sync) |
| **`npm run db:studio`** | Still works — opens Drizzle Studio |
| **Application still works** | All pages load; timesheet, admin, auth all function |

### 4c. Future Schema Change Test

Simulate a schema change to verify the generate/migrate workflow end-to-end:

1. Add a temporary test column to `schema.ts` (e.g., `testField: varchar('test_field', { length: 10 })` on `users`)
2. Run `npm run db:generate` — should produce a new migration file with `ALTER TABLE users ADD COLUMN test_field`
3. Run `npm run db:migrate` — should apply the migration
4. Verify the column exists in the database
5. Remove the test column from `schema.ts`
6. Run `npm run db:generate` — should produce a migration with `ALTER TABLE users DROP COLUMN test_field`
7. Run `npm run db:migrate` — should apply the rollback
8. **Delete both test migration files** and the corresponding snapshots

### 4d. File Checklist

After completing all phases, verify these files exist:

| File | Purpose |
|---|---|
| `drizzle.config.ts` | Drizzle Kit configuration (unchanged) |
| `drizzle/0000_*.sql` | Baseline migration SQL |
| `drizzle/meta/0000_snapshot.json` | Baseline schema snapshot |
| `drizzle/meta/_journal.json` | Migration journal (tracks order) |
| `scripts/migrate.ts` | Programmatic migration runner |
| `MIGRATIONS.md` | Developer documentation |

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `relation "users" already exists` | Running baseline migration on existing database | Mark baseline as applied (see Phase C) |
| `drizzle-kit: command not found` | Not installed | Already in devDependencies — run `npm install` |
| `tsx: command not found` | Not installed | Run `npm install -D tsx` |
| `DATABASE_URL is not set` | Missing env var | Set in `.env.local` or deployment environment |
| Migration files not in git | `.gitignore` excludes `drizzle/` | Remove `drizzle/` from `.gitignore` |
| `db:check` fails after schema change | Migration not generated | Run `npm run db:generate` first |
| `Cannot find module 'dotenv/config'` | dotenv not installed | Run `npm install -D dotenv` |
| Generated migration is empty | Schema hasn't changed since last generate | Expected behavior — no migration needed |
| Wrong migration order | Manual file renaming | Never rename migration files — they're ordered by timestamp |
