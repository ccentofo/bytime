import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';

/**
 * feature-plan-database-backups.md §11 S1–S8, S12, S14, S18 (backup), S21/S23 (the backup side of the ordered locks).
 * Real Postgres on scratch databases (G2); the fake store; the raw AES keyring; fake pg_dump commands except S6, which
 * uses real pg_dump 16 (BACKUP_PG_DUMP_BIN; REQUIRE_PG16_TOOLS=1 makes a missing tool fail instead of skip).
 */

import { KeyringNode } from '@aws-crypto/client-node';
import { encrypt } from '@/lib/encryption';
import { BACKUP_LOCK_KEY, MIGRATE_RUN_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { runBackup, type BackupDeps, type TargetRef } from '../../../scripts/backup/backup';
import { acquireLock } from '../../../scripts/backup/lib/locks';
import { baseKey, controlPlaneId, sidecarKeyFor } from '../../../scripts/backup/lib/keys';
import { decryptBuffer, encryptionContext, type KeyringFactory } from '../../../scripts/backup/lib/crypto';
import { restoreObject } from '../../../scripts/backup/lib/restore-stream';
import { countTables } from '../../../scripts/backup/lib/counts';
import { childConnection, childEnv, withDatabase } from '../../../scripts/backup/lib/pg-url';
import { realSpawn } from '../../../scripts/backup/lib/child';
import { FakeBucket, fakeDumpArgs, kmsDenied, testKeyring } from '../helpers/backup-fakes';
import { createScratchDb, dropScratchDb, lockHolderPid, SERVER_URL, sleep, terminate, trackUncaught, waitUntil } from './backup-helpers';

const PG_DUMP = process.env.BACKUP_PG_DUMP_BIN;
const PG_RESTORE = process.env.BACKUP_PG_RESTORE_BIN;
const REQUIRE_TOOLS = process.env.REQUIRE_PG16_TOOLS === '1';
if (REQUIRE_TOOLS && (!PG_DUMP || !PG_RESTORE)) throw new Error('REQUIRE_PG16_TOOLS=1 but BACKUP_PG_DUMP_BIN / BACKUP_PG_RESTORE_BIN are not set');
const FAST_LOCK = { heartbeatMs: 100, heartbeatTimeoutMs: 400 };

describe.skipIf(!SERVER_URL)('backup command', () => {
  let cp: { name: string; url: string };
  let t1: { name: string; url: string };
  let t2: { name: string; url: string };
  let cpSql: postgres.Sql;
  const ids = { a: '', b: '', del: '' };

  beforeAll(async () => {
    cp = await createScratchDb('cp', { migrateControlPlane: true });
    t1 = await createScratchDb('t', { tenantSchema: true });
    t2 = await createScratchDb('t', { tenantSchema: true });
    cpSql = postgres(cp.url, { max: 2, onnotice: () => {} });
  }, 60_000);
  afterAll(async () => {
    await cpSql?.end({ timeout: 5 });
    for (const d of [cp, t1, t2]) if (d) await dropScratchDb(d.name);
  });

  beforeEach(async () => {
    await cpSql`DELETE FROM backup_permission_checks`;
    await cpSql`DELETE FROM database_backups`;
    await cpSql`DELETE FROM tenants`;
    const rows = await cpSql<{ id: string; slug: string }[]>`INSERT INTO tenants (slug, name, status, db_url_encrypted) VALUES
      ('test-lc-a', 'A', 'active', ${encrypt(t1.url)}),
      ('test-lc-b', 'B', 'suspended', ${encrypt(t2.url)}),
      ('test-lc-del', 'Del', 'deleting', ${encrypt(t1.url)}),
      ('test-lc-prov', 'P', 'provisioning', NULL)
      RETURNING id::text AS id, slug`;
    ids.a = rows.find((r) => r.slug === 'test-lc-a')!.id;
    ids.b = rows.find((r) => r.slug === 'test-lc-b')!.id;
    ids.del = rows.find((r) => r.slug === 'test-lc-del')!.id;
  });

  function deps(o: Partial<BackupDeps> & { dump?: (t: TargetRef) => string[] } = {}): BackupDeps & { lines: string[]; bucket: FakeBucket } {
    const lines: string[] = [];
    const bucket = (o.store as FakeBucket | undefined) ?? new FakeBucket();
    const { dump, ...rest } = o;
    return {
      controlPlaneUrl: cp.url,
      store: bucket,
      keyring: testKeyring(),
      pgDumpBin: PG_DUMP ?? 'pg_dump',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.test',
      runId: `test-${randomUUID().slice(0, 8)}`,
      log: (l) => lines.push(l),
      lockTiming: FAST_LOCK,
      connectRetryDelayMs: 50,
      migrationPollMs: 50,
      hooks: { dumpCommand: (t) => ({ bin: process.execPath, args: dump ? dump(t) : fakeDumpArgs({ bytes: 150_000 }) }) },
      ...rest,
      lines,
      bucket,
    };
  }

  const rowsOf = (runId: string) => cpSql<Array<{ tenant_id: string | null; target: string; status: string; s3_key: string | null; sha256: string | null; bytes: string | null; row_counts: Record<string, number> | null; error: string | null; region: string | null; target_deadline_ms: number }>>`
    SELECT tenant_id::text, target, status, s3_key, sha256, bytes::text, row_counts, error, region, target_deadline_ms FROM database_backups WHERE run_id = ${runId} ORDER BY finished_at`;

  it('S1: tenants and the control plane: ok rows, sidecars, SHA-256 of the stored bytes, numeric counts, BACKUP lines; deleting skipped; control plane last with this run\'s tenant rows', async () => {
    const d = deps();
    const r = await runBackup(d);
    expect(r.exitCode).toBe(0);
    const rows = await rowsOf(d.runId);
    expect(rows.map((x) => [x.target, x.tenant_id, x.status])).toEqual([
      ['tenant', expect.any(String), 'ok'], ['tenant', expect.any(String), 'ok'], ['control-plane', null, 'ok'],
    ]);
    expect(new Set(rows.slice(0, 2).map((x) => x.tenant_id))).toEqual(new Set([ids.a, ids.b]));
    expect(rows.some((x) => x.tenant_id === ids.del)).toBe(false);
    const cpId = controlPlaneId(cp.url);
    for (const row of rows) {
      const stored = d.bucket.objects.get(row.s3_key!)!.bytes;
      expect(row.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(Number(row.bytes)).toBe(stored.length);
      expect(row.region).toBe('unknown'); // localhost is not a Neon host
      expect(row.target_deadline_ms).toBe(30 * 60_000);
      const id = row.tenant_id ?? 'control-plane';
      expect(row.s3_key!.startsWith(`v1/${cpId}/${row.target}/${id}/`)).toBe(true);
      const sidecar = d.bucket.objects.get(sidecarKeyFor(row.s3_key!))!.bytes;
      const manifest = JSON.parse((await decryptBuffer(d.keyring, sidecar, encryptionContext({ cp: cpId, kind: 'manifest', target: row.target as 'tenant', id, key: baseKey(row.s3_key!) }))).toString());
      expect(manifest).toMatchObject({ v: 1, sha256: row.sha256, bytes: Number(row.bytes), rowCounts: row.row_counts, runId: d.runId, key: row.s3_key });
      expect(d.lines).toContain(`BACKUP ${cpId} ${row.target} ${id} ${manifest.slug} ${d.runId} ${row.s3_key} ${row.sha256} ${row.bytes}`);
    }
    expect(rows[0].row_counts).toEqual({ 'audit.events': 7, 'public.timesheet_entries': 400, 'public.users': 25 });
    expect(typeof rows[0].row_counts!['public.users']).toBe('number');
    // The control plane's snapshot holds this run's two tenant rows.
    expect(rows[2].row_counts!['public.database_backups']).toBe(2);
    expect(d.lines.join('\n')).not.toMatch(/localhost|postgres(ql)?:\/\/|bytime_dev/);
  });

  it('S1b: every slot filled with hung tenants: the control plane still runs at the (shortened) T + 75, and the summary names the slugs', async () => {
    const d = deps({ concurrency: 2, controlPlaneBarrierMs: 300, targetDeadlineMs: 1_200, dump: (t) => (t.target === 'tenant' ? fakeDumpArgs({ hang: true }) : fakeDumpArgs({})) });
    const r = await runBackup(d);
    expect(r.exitCode).toBe(1);
    expect(d.lines).toContain('control plane started before test-lc-a, test-lc-b finished');
    const rows = await rowsOf(d.runId);
    expect(rows.find((x) => x.target === 'control-plane')?.status).toBe('ok');
    expect(rows.filter((x) => x.target === 'tenant').every((x) => x.status === 'failed' && x.error === 'deadline')).toBe(true);
  }, 20_000);

  it('S2: pg_dump exits 1 mid-stream → failed; the store never saw end-of-stream', async () => {
    const d = deps({ options: { only: 'test-lc-a' }, dump: () => fakeDumpArgs({ failAfterBytes: 100_000, code: 1 }) });
    expect((await runBackup(d)).exitCode).toBe(1);
    const rows = await rowsOf(d.runId);
    expect(rows.length).toBe(2); // first round + the retry round
    expect(rows.every((x) => x.status === 'failed' && x.s3_key === null)).toBe(true);
    expect(rows[0].error).toMatch(/^dump exit=1/);
    expect(rows[0].error).not.toContain('secret@x.com');
    expect(d.bucket.completedStreams).toEqual([]);
    expect(d.bucket.objects.size).toBe(0);
  });

  it('S2b: a hanging pg_dump is killed at the (shortened) deadline → failed `deadline`', async () => {
    const d = deps({ options: { only: 'test-lc-a' }, targetDeadlineMs: 500, dump: () => fakeDumpArgs({ hang: true }) });
    expect((await runBackup(d)).exitCode).toBe(1);
    const rows = await rowsOf(d.runId);
    expect(rows.map((x) => x.error)).toEqual(['deadline', 'deadline']);
    expect(d.bucket.completedStreams).toEqual([]);
  });

  // 3b-fix (DISASTER-RESTORE-AUDIT.md F-3b): a target deadline or a stop that fires while dumpOnce is still on its
  // version query rejected `pipelineDone` with no handler: an unhandled rejection, which the image's crash handler turns
  // into FATAL and exit 1 for the whole run. The target must simply fail, and nothing may reject unhandled.
  for (const [name, mode] of [['a target deadline', 'deadline'], ['a stop (SIGTERM)', 'stopped']] as const) {
    it(`S2c: ${name} during the version query → that target failed \`${mode}\`, no unhandled rejection`, async () => {
      const pending: Array<(e: Error) => void> = [];
      // The tenant's connection hangs on its first query until the client is ended; every other connection is real.
      const connectTarget = ((url: string, opts: postgres.Options<Record<string, postgres.PostgresType>>) => {
        if (!url.includes(`/${t1.name}`)) return postgres(url, opts);
        const fake = (() => new Promise((_resolve, reject) => { pending.push(reject); })) as unknown as postgres.Sql;
        Object.assign(fake, { end: async () => { for (const r of pending.splice(0)) r(Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' })); } });
        return fake;
      }) as unknown as BackupDeps['connectTarget'];
      const stop = new AbortController();
      const d = deps({ options: { only: 'test-lc-a' }, connectTarget, stopSignal: mode === 'stopped' ? stop.signal : undefined, targetDeadlineMs: mode === 'deadline' ? 300 : 60_000 });
      const uncaught = trackUncaught();
      try {
        if (mode === 'stopped') setTimeout(() => stop.abort('stopped'), 300);
        expect((await runBackup(d)).exitCode).toBe(1);
        await sleep(100); // unhandledRejection fires after the microtask queue drains
        const rows = await rowsOf(d.runId);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.every((x) => x.status === 'failed' && x.error === mode)).toBe(true);
        expect(uncaught.count()).toBe(0);
      } finally {
        uncaught.stop();
      }
    });
  }

  it('S3: the keyring fails (KMS denied) → every target failed; exit 1', async () => {
    class DeniedKeyring extends KeyringNode {
      async _onEncrypt(): Promise<never> { throw kmsDenied(); }
      async _onDecrypt(): Promise<never> { throw kmsDenied(); }
    }
    const denied: KeyringFactory = { encrypt: () => new DeniedKeyring(), decrypt: () => new DeniedKeyring() };
    const d = deps({ keyring: denied });
    expect((await runBackup(d)).exitCode).toBe(1);
    const rows = await rowsOf(d.runId);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((x) => x.status === 'failed')).toBe(true);
    expect(rows.find((x) => x.target === 'control-plane')!.error).toContain('label=access-denied');
    expect(d.bucket.objects.size).toBe(0);
  });

  it('S4: the store rejects 412 → failed, then the retry round with a new key → ok', async () => {
    const d = deps({ options: { only: 'test-lc-a' } });
    d.bucket.reject412 = 1;
    expect((await runBackup(d)).exitCode).toBe(0);
    const rows = await rowsOf(d.runId);
    expect(rows.map((x) => x.status)).toEqual(['failed', 'ok']);
    expect(rows[0].error).toContain('label=s3-error');
    expect(d.bucket.completedStreams.length).toBe(2);
    expect(new Set(d.bucket.completedStreams).size).toBe(2); // a new key
  });

  it('S5: the row insert fails after upload → the `row-failed` line; exit 1', async () => {
    const insertRow = vi.fn(async (sql: postgres.Sql, row: Parameters<NonNullable<NonNullable<BackupDeps['hooks']>['insertRow']>>[1]) => {
      if (row.status === 'ok') throw Object.assign(new Error('connection terminated'), { name: 'PostgresError', code: '57P01' });
      const { insertBackupRow } = await import('../../../scripts/backup/lib/sql');
      return insertBackupRow(sql, row);
    });
    const d = deps({ options: { only: 'test-lc-a' } });
    d.hooks = { ...d.hooks, insertRow };
    expect((await runBackup(d)).exitCode).toBe(1);
    const backupLine = d.lines.find((l) => l.startsWith('BACKUP '))!;
    expect(d.lines).toContain(`${backupLine} row-failed`);
    expect(d.bucket.objects.size).toBe(2); // the dump and the sidecar exist; the restore test can't use them (no row)
  });

  it.skipIf(!PG_DUMP || !PG_RESTORE)('S6: real pg_dump 16 with rows committed between the counts and the spawn → the restored counts equal the snapshot', async () => {
    const before = postgres(t1.url, { max: 1 });
    const live = Number((await before`SELECT count(*) AS n FROM timesheet_entries`)[0].n);
    const d = deps({
      options: { only: 'test-lc-a' },
      hooks: {
        afterCounts: async () => {
          await before`INSERT INTO timesheet_entries (user_id, hours, note) SELECT 1, 1, 'after' FROM generate_series(1, 50)`;
          await before`INSERT INTO users (email) VALUES ('late@test.invalid')`;
        },
      },
    });
    try {
      expect((await runBackup(d)).exitCode).toBe(0);
      const [row] = await rowsOf(d.runId);
      expect(row.row_counts!['public.timesheet_entries']).toBe(live);
      const scratch = await createScratchDb('t');
      try {
        const child = childConnection(withDatabase(SERVER_URL!, scratch.name));
        await restoreObject({
          reader: d.bucket, key: row.s3_key!, factory: d.keyring, spawn: realSpawn, bin: PG_RESTORE!,
          args: ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${child.url}`], env: childEnv(child.password),
          expectedContext: encryptionContext({ cp: controlPlaneId(cp.url), kind: 'dump', target: 'tenant', id: ids.a, key: baseKey(row.s3_key!) }),
          expectedSha256: row.sha256!, signal: new AbortController().signal,
        });
        const rs = postgres(scratch.url, { max: 1 });
        const restored = await countTables(rs);
        await rs.end();
        expect(restored).toEqual(row.row_counts);
        expect(restored['public.timesheet_entries']).toBe(live); // fails without --snapshot: the 50 rows would be there
      } finally {
        await dropScratchDb(scratch.name);
      }
    } finally {
      await before`DELETE FROM timesheet_entries WHERE note = 'after'`;
      await before`DELETE FROM users WHERE email = 'late@test.invalid'`;
      await before.end();
    }
  }, 60_000);

  it('S7: a connection error then ok; two errors → failed; a count-query error before the pipeline → failed with no hang', async () => {
    let calls = 0;
    const flaky = (failures: number) => (url: string, o: postgres.Options<Record<string, postgres.PostgresType>>) => {
      calls++;
      if (calls <= failures) return postgres(url.replace(/:\d+\//, ':1/'), { ...o, connect_timeout: 2 });
      return postgres(url, o);
    };
    calls = 0;
    const d1 = deps({ options: { only: 'test-lc-a' }, connectTarget: flaky(1) });
    expect((await runBackup(d1)).exitCode).toBe(0);
    expect(d1.lines.some((l) => l.includes('test-lc-a: connection error; retrying'))).toBe(true);
    calls = 0;
    const d2 = deps({ options: { only: 'test-lc-a' }, connectTarget: flaky(10) });
    expect((await runBackup(d2)).exitCode).toBe(1);
    expect((await rowsOf(d2.runId))[0].error).toMatch(/^connect .*label=connection-refused/);
    const d3 = deps({ options: { only: 'test-lc-a' }, hooks: { beforeCounts: async () => { throw Object.assign(new Error('canceling statement due to lock timeout'), { name: 'PostgresError', code: '55P03' }); } } });
    expect((await runBackup(d3)).exitCode).toBe(1);
    expect((await rowsOf(d3.runId))[0].error).toBe('snapshot sqlstate=55P03 label=lock-timeout');
  }, 30_000);

  it('S8: the advisory lock: a second run exits 0 with no rows', async () => {
    const held = (await acquireLock(cp.url, BACKUP_LOCK_KEY))!;
    try {
      const d = deps();
      expect((await runBackup(d)).exitCode).toBe(0);
      expect(d.lines).toContain('another backup run is active; exiting');
      expect((await rowsOf(d.runId)).length).toBe(0);
    } finally {
      await held.release();
    }
  });

  it('S12: a wrong ENCRYPTION_KEY → tenants failed, the control plane ok', async () => {
    const d = deps({ decryptUrl: () => { throw new Error('Unsupported state or unable to authenticate data'); } });
    expect((await runBackup(d)).exitCode).toBe(1);
    const rows = await rowsOf(d.runId);
    expect(rows.filter((x) => x.target === 'tenant').every((x) => x.status === 'failed' && x.error?.startsWith('decrypt-url'))).toBe(true);
    expect(rows.find((x) => x.target === 'control-plane')?.status).toBe('ok');
  });

  it('S14: --if-missing-today: no work when today is complete; only failed tenants and tenants with no row today; a full run without a control-plane ok', async () => {
    // A full run first (today complete).
    expect((await runBackup(deps())).exitCode).toBe(0);
    const done = deps({ options: { ifMissingToday: true } });
    expect((await runBackup(done)).exitCode).toBe(0);
    expect(done.lines).toContain('catch-up: today is complete; nothing to do');
    expect((await rowsOf(done.runId)).length).toBe(0);
    // test-lc-b failed today (newest row failed) and a new tenant has no row today.
    await cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, target_deadline_ms, error, started_at, finished_at)
      VALUES (${ids.b}, 'tenant', 'test-manual', 'failed', 1, 'dump exit=1', now(), now())`;
    await cpSql`INSERT INTO tenants (slug, name, status, db_url_encrypted) VALUES ('test-lc-new', 'N', 'active', ${encrypt(t2.url)})`;
    const some = deps({ options: { ifMissingToday: true } });
    expect((await runBackup(some)).exitCode).toBe(0);
    const rows = await rowsOf(some.runId);
    expect(rows.map((x) => x.target)).toEqual(['tenant', 'tenant']);
    expect(rows.some((x) => x.tenant_id === ids.a)).toBe(false);
    // No control-plane ok today → a full run.
    await cpSql`DELETE FROM database_backups WHERE target = 'control-plane'`;
    const full = deps({ options: { ifMissingToday: true } });
    expect((await runBackup(full)).exitCode).toBe(0);
    expect(full.lines).toContain('catch-up: no control-plane backup today; running a full backup');
    expect((await rowsOf(full.runId)).some((x) => x.target === 'control-plane')).toBe(true);
  }, 30_000);

  it('FR5: a status re-read that throws fails only that target (`status-read`); the others continue', async () => {
    const { tenantStatus } = await import('../../../scripts/backup/lib/sql');
    const d = deps();
    d.hooks = { ...d.hooks, readStatus: async (sql, id) => { if (id === ids.b) throw Object.assign(new Error('connection terminated'), { name: 'PostgresError', code: '57P01' }); return tenantStatus(sql, id); } };
    expect((await runBackup(d)).exitCode).toBe(1);
    const rows = await rowsOf(d.runId);
    const b = rows.filter((x) => x.tenant_id === ids.b);
    expect(b.map((x) => x.error)).toEqual(['status-read sqlstate=57P01 label=connection-refused', 'status-read sqlstate=57P01 label=connection-refused']);
    expect(rows.find((x) => x.tenant_id === ids.a)?.status).toBe('ok');
    expect(rows.find((x) => x.target === 'control-plane')?.status).toBe('ok');
  });

  it('FR10: the status is re-read per target: a workspace set to `deleting` during the run is skipped', async () => {
    const d = deps({ concurrency: 1 });
    d.hooks = { ...d.hooks, afterCounts: async (t) => { if (t.tenantId === ids.a) await cpSql`UPDATE tenants SET status = 'deleting' WHERE id = ${ids.b}`; } };
    expect((await runBackup(d)).exitCode).toBe(0);
    const rows = await rowsOf(d.runId);
    expect(rows.some((x) => x.tenant_id === ids.b)).toBe(false);
    expect(d.lines).toContain('test-lc-b: skipped (deleting)');
  });

  it('S18: backup tables missing → exits with "run deploy-prod first"', async () => {
    const bare = await createScratchDb('cp');
    try {
      await expect(runBackup({ ...deps(), controlPlaneUrl: bare.url })).rejects.toThrow('backup tables missing: run deploy-prod first');
    } finally {
      await dropScratchDb(bare.name);
    }
  });

  describe('S21 / S23: the backup side of the ordered locks', () => {
    it('lock loss with no migration: the run re-takes the lock and finishes ok, with no uncaught exception', async () => {
      const t = trackUncaught();
      try {
        const d = deps({ options: { only: 'test-lc-a' }, dump: () => fakeDumpArgs({ slowMs: 1_500 }) });
        const run = runBackup(d);
        await waitUntil(async () => (await lockHolderPid(cp.url, BACKUP_LOCK_KEY)) !== null && d.lines.length === 0 && d.bucket.objects.size === 0, 5_000);
        await sleep(300);
        await terminate(cp.url, (await lockHolderPid(cp.url, BACKUP_LOCK_KEY))!);
        const r = await run;
        expect(d.lines).toContain('backup run lock lost; re-taking it');
        expect(r.exitCode).toBe(0);
        expect(t.count()).toBe(0);
        expect(await lockHolderPid(cp.url, BACKUP_LOCK_KEY)).toBeNull(); // released at the end
      } finally {
        t.stop();
      }
    }, 20_000);

    it('re-take with a migration started in the gap → the in-flight target is aborted `lock-lost`', async () => {
      const t = trackUncaught();
      let migration: Awaited<ReturnType<typeof acquireLock>> = null;
      try {
        const d = deps({ options: { only: 'test-lc-a' }, lockTiming: { heartbeatMs: 400, heartbeatTimeoutMs: 400 }, dump: () => fakeDumpArgs({ slowMs: 3_000 }) });
        const run = runBackup(d);
        await waitUntil(async () => (await lockHolderPid(cp.url, BACKUP_LOCK_KEY)) !== null, 5_000);
        await sleep(300);
        await terminate(cp.url, (await lockHolderPid(cp.url, BACKUP_LOCK_KEY))!);
        migration = await acquireLock(cp.url, MIGRATE_RUN_LOCK_KEY);
        const r = await run;
        expect(r.exitCode).toBe(1);
        expect(d.lines).toContain('a migration started while the lock was lost; aborting in-flight dumps');
        const rows = await rowsOf(d.runId);
        expect(rows[0]).toMatchObject({ status: 'failed', error: 'lock-lost' });
        expect(t.count()).toBe(0);
      } finally {
        await migration?.release();
        t.stop();
      }
    }, 20_000);

    it('the lock can\'t be re-taken → no new targets; in-flight aborted; the rest recorded `lock-lost`', async () => {
      const t = trackUncaught();
      try {
        // The first two lock-factory connections (the run lock, the pg_locks probe) work; every re-take attempt fails.
        let n = 0;
        const lockConnect = ((url: string, o: postgres.Options<Record<string, postgres.PostgresType>>) => {
          n++;
          if (n > 2) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
          return postgres(url, o);
        }) as never;
        const d = deps({ concurrency: 1, lockConnect, dump: () => fakeDumpArgs({ slowMs: 8_000 }) });
        const run = runBackup(d);
        await waitUntil(async () => (await lockHolderPid(cp.url, BACKUP_LOCK_KEY)) !== null, 5_000);
        await sleep(300);
        await terminate(cp.url, (await lockHolderPid(cp.url, BACKUP_LOCK_KEY))!);
        const r = await run;
        expect(r.exitCode).toBe(1);
        expect(d.lines).toContain('the backup run lock could not be re-taken; starting no new targets');
        const rows = await rowsOf(d.runId);
        expect(rows.length).toBe(3); // the in-flight tenant, the next tenant, the control plane
        expect(rows.every((x) => x.status === 'failed' && x.error === 'lock-lost')).toBe(true);
        expect(t.count()).toBe(0);
      } finally {
        t.stop();
      }
    }, 30_000);

    it('with MIGRATE_RUN_LOCK_KEY held, a backup waits and then proceeds, recording the wait', async () => {
      const migration = (await acquireLock(cp.url, MIGRATE_RUN_LOCK_KEY))!;
      const d = deps({ options: { only: 'test-lc-a' } });
      setTimeout(() => void migration.release(), 400);
      expect((await runBackup(d)).exitCode).toBe(0);
      expect(d.lines).toContain('test-lc-a: a migration is running; deferring');
      expect(d.lines.some((l) => /^test-lc-a: waited \d+s for a migration to finish$/.test(l))).toBe(true);
    });

    it('S23: a target not reached because a migration ran until the run deadline → failed `migration-running`', async () => {
      const migration = (await acquireLock(cp.url, MIGRATE_RUN_LOCK_KEY))!;
      try {
        const d = deps({ runDeadlineMs: 500 });
        expect((await runBackup(d)).exitCode).toBe(1);
        const rows = await rowsOf(d.runId);
        expect(rows.length).toBe(3);
        expect(rows.every((x) => x.status === 'failed' && x.error === 'migration-running')).toBe(true);
      } finally {
        await migration.release();
      }
    });
  });
});
