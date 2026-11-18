import type postgres from 'postgres';

/**
 * DROP DATABASE … WITH (FORCE) for test scratch databases. On PostgreSQL 16 a non-superuser can't terminate an autovacuum
 * worker (superuser-owned), so FORCE fails with 42501 "permission denied to terminate process" while autovacuum works on a
 * freshly restored or migrated database. Wait on the real state (no autovacuum worker on that database), then retry;
 * bounded at 60 s. Any other error is thrown at once. (3c-2: a full integration run hit this in two suites' teardown.)
 */
export async function dropDatabaseForce(admin: postgres.Sql, name: string, maxWaitMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== '42501' || Date.now() > deadline) throw e;
    }
    // Poll until the autovacuum worker on this database is gone (or the deadline passes).
    while (Date.now() <= deadline) {
      const [r] = await admin<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${name} AND backend_type = 'autovacuum worker'`;
      if (r.n === 0) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  }
}
