/**
 * Temporary restore-test databases (feature-plan-database-backups.md §6.6 step 6, §6.7 steps 3 and 6, invariant 9).
 * Only names matching `^rt_[0-9]{14}_[a-z0-9]{8}$` are ever created or dropped; the name carries its UTC creation time.
 * A drop closes this code's own sessions first, then runs a plain DROP DATABASE, then WITH (FORCE) only if a session is
 * still open (§4.8.1: FORCE is undocumented on Neon; proven at §12 step 9).
 */
import type postgres from 'postgres';
import { RT_NAME_RE, rtNameCreatedAt } from './keys';
import { HOUR } from './util';

type Sql = postgres.Sql;

function assertRtName(name: string): void {
  if (!RT_NAME_RE.test(name)) throw new Error('refusing a database name that is not a restore-test name');
}

export async function createRtDatabase(admin: Sql, name: string): Promise<void> {
  assertRtName(name);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
}

async function sessionCount(admin: Sql, name: string): Promise<number> {
  const [row] = await admin<{ n: string }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = ${name}`;
  return Number(row.n);
}

/** Drop one rt_ database. Returns true when it is gone. */
export async function dropRtDatabase(admin: Sql, name: string): Promise<boolean> {
  assertRtName(name);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== '55006') throw e; // 55006: being accessed by other users
    if ((await sessionCount(admin, name)) === 0) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      return true;
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    return true;
  }
}

export interface SweepResult {
  dropped: number;
  stuck: number;
}

/**
 * Drop every rt_ database older than `minAgeMs` (1 h) with no session. Count those older than 24 h that couldn't be
 * dropped (a lingering session or a failed drop) as stuck. The caller holds RESTORE_TEST_LOCK_KEY.
 */
export async function sweepRtDatabases(admin: Sql, now: Date, o: { minAgeMs?: number; stuckAgeMs?: number; log?: (l: string) => void } = {}): Promise<SweepResult> {
  const minAge = o.minAgeMs ?? HOUR;
  const stuckAge = o.stuckAgeMs ?? 24 * HOUR;
  const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname ~ '^rt_[0-9]{14}_[a-z0-9]{8}$'`;
  const out: SweepResult = { dropped: 0, stuck: 0 };
  for (const { datname } of rows) {
    const created = rtNameCreatedAt(datname);
    if (!created) continue;
    const age = now.getTime() - created.getTime();
    if (age <= minAge) continue;
    let gone = false;
    if ((await sessionCount(admin, datname)) === 0) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`);
        gone = true;
        out.dropped++;
      } catch {
        o.log?.(`could not drop a leftover test database (${datname})`);
      }
    }
    if (!gone && age > stuckAge) out.stuck++;
  }
  return out;
}
