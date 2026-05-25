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
