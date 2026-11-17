/**
 * The ordered-lock handshake between migrations and backups (feature-plan-database-backups.md §6.4 "Migrations and
 * backups never overlap", F22). Each side takes its own lock, then READS the other's through pg_locks (never by taking
 * it), and the waits are polling loops: neither ever blocks on the other's lock, so there is no deadlock, and they can't
 * both miss each other. Imported by scripts/migrate-all.ts (app deploys) and by the backup image.
 */
import { splitKey } from './locks';

// A postgres.js client (Sql or ReservedSql); typed loosely so both fit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LockSql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<readonly unknown[]>;

/** Whether any session holds the advisory lock `key` in the current database (pg_locks; the lock is not taken). */
export async function isAdvisoryLockHeld(sql: LockSql, key: number): Promise<boolean> {
  const { hi, lo } = splitKey(key);
  const rows = await sql`SELECT 1 AS held FROM pg_locks
    WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ${hi} AND objid = ${lo} AND objsubid = 1 AND granted
    LIMIT 1`;
  return rows.length > 0;
}

export interface WaitOptions {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  maxMs: number;
  pollMs?: number;
  onWait?: () => void;
}

/** Poll until `key` is free or `maxMs` has passed. */
export async function waitForLock(sql: LockSql, key: number, o: WaitOptions): Promise<{ free: boolean; waitedMs: number }> {
  const start = o.now();
  const poll = o.pollMs ?? 60_000;
  for (;;) {
    if (!(await isAdvisoryLockHeld(sql, key))) return { free: true, waitedMs: o.now() - start };
    const elapsed = o.now() - start;
    if (elapsed >= o.maxMs) return { free: false, waitedMs: elapsed };
    o.onWait?.();
    await o.sleep(Math.min(poll, Math.max(1, o.maxMs - elapsed)));
  }
}
