import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Constant advisory-lock key shared by every migration path (rollout + provisioning), so a
// deploy's bulk rollout and a signup provisioning that same tenant can never run migrate()
// concurrently against the same database. Drizzle's migrator itself takes no lock.
const MIGRATION_LOCK_KEY = 728_402_113;

/**
 * Stored tenant/control-plane URLs use Neon's POOLED host (`ep-…-pooler.…`) because that's right for
 * the serverless app. But that pooler is PgBouncer in transaction mode, where a session-level
 * advisory lock is NOT held across statements — the migration lock below would silently stop
 * protecting anything. So migrations always connect to the DIRECT host (same name without
 * `-pooler`). Non-Neon URLs (local Postgres, CI) have no `-pooler` label and pass through unchanged.
 */
export function toDirectConnectionUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const [firstLabel, ...rest] = parsed.hostname.split('.');
  if (!firstLabel.endsWith('-pooler')) return url;
  parsed.hostname = [firstLabel.slice(0, -'-pooler'.length), ...rest].join('.');
  return parsed.toString();
}

/** Migrate one tenant DB to the latest schema under a session advisory lock, so a deploy
 *  rollout and a signup provisioning the same DB can never run migrate() concurrently. */
export async function migrateTenantDatabase(
  url: string,
  opts: { migrationsFolder?: string; connectTimeoutSec?: number } = {},
): Promise<void> {
  const sql = postgres(toDirectConnectionUrl(url), { max: 1, connect_timeout: opts.connectTimeoutSec ?? 30 });
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

type JournalEntry = { idx: number; when: number; tag: string };
type Journal = { entries: JournalEntry[] };

/**
 * Count migrations in `migrationsFolder` that have not been applied to `url` yet, without
 * applying anything. Compares the journal's entries against the high-water mark Drizzle's own
 * migrator tracks: the newest `created_at` (= journal entry `when`) in `drizzle.__drizzle_migrations`
 * (schema/table/columns confirmed against the installed drizzle-orm postgres-js dialect — it only
 * ever compares against the LATEST applied timestamp, not individual migration ids). A missing
 * tracking table (the DB has never been migrated) means everything is pending.
 */
export async function getPendingMigrationCount(
  url: string,
  migrationsFolder = './drizzle',
): Promise<number> {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;

  const sql = postgres(toDirectConnectionUrl(url), { max: 1, connect_timeout: 30 });
  try {
    let lastAppliedAt = 0;
    try {
      const rows = await sql<{ created_at: string | number | null }[]>`
        select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
      `;
      lastAppliedAt = rows[0]?.created_at ? Number(rows[0].created_at) : 0;
    } catch (err) {
      // 42P01 = relation (or its schema) does not exist — no migrations have ever run.
      if ((err as { code?: string })?.code !== '42P01') throw err;
    }
    return journal.entries.filter((entry) => entry.when > lastAppliedAt).length;
  } finally {
    await sql.end();
  }
}
