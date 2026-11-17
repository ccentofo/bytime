import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * feature-plan-database-backups.md §11 S10, S11, S15, S17 (closing), S18 (restore-test), S19: the restore test end to end
 * with real pg_dump / pg_restore 16, the fake store, the raw AES keyring, scratch control plane and tenants (G2), and the
 * empty `bytime_rt_test` database as the restore-test project (host guard overridden in-process only).
 */

import { encrypt } from '@/lib/encryption';
import { RESTORE_TEST_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { runBackup } from '../../../scripts/backup/backup';
import { runRestoreTest, type RestoreTestDeps } from '../../../scripts/backup/restore-test';
import { acquireLock } from '../../../scripts/backup/lib/locks';
import { baseKey, controlPlaneId, sidecarKeyFor, targetPrefix } from '../../../scripts/backup/lib/keys';
import { decryptBuffer, encryptBuffer, encryptionContext } from '../../../scripts/backup/lib/crypto';
import { withDatabase } from '../../../scripts/backup/lib/pg-url';
import { FakeBucket, testKeyring } from '../helpers/backup-fakes';
import { adminUrl, createScratchDb, dropScratchDb, listRtDatabases, SERVER_URL } from './backup-helpers';

const PG_DUMP = process.env.BACKUP_PG_DUMP_BIN;
const PG_RESTORE = process.env.BACKUP_PG_RESTORE_BIN;
if (process.env.REQUIRE_PG16_TOOLS === '1' && (!PG_DUMP || !PG_RESTORE)) throw new Error('REQUIRE_PG16_TOOLS=1 but BACKUP_PG_DUMP_BIN / BACKUP_PG_RESTORE_BIN are not set');
const MIN = 60_000;

describe.skipIf(!SERVER_URL || !PG_DUMP || !PG_RESTORE)('restore test', () => {
  let cp: { name: string; url: string };
  let t1: { name: string; url: string };
  let t2: { name: string; url: string };
  let cpSql: postgres.Sql;
  let rtUrl: string;
  let bucket: FakeBucket;
  let cpId: string;
  const ids = { a: '', b: '' };
  const snapshot = new Map<string, { bytes: Buffer; lastModified: Date }>();

  beforeAll(async () => {
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE bytime_rt_test').catch((e) => { if (e.code !== '42P04') throw e; });
    await admin.end();
    rtUrl = withDatabase(SERVER_URL!, 'bytime_rt_test');
    cp = await createScratchDb('cp', { migrateControlPlane: true });
    t1 = await createScratchDb('t', { tenantSchema: true });
    t2 = await createScratchDb('t', { tenantSchema: true });
    cpSql = postgres(cp.url, { max: 2, onnotice: () => {} });
    cpId = controlPlaneId(cp.url);
    const rows = await cpSql<{ id: string; slug: string }[]>`INSERT INTO tenants (slug, name, status, db_url_encrypted) VALUES
      ('test-lc-a', 'A', 'active', ${encrypt(t1.url)}), ('test-lc-b', 'B', 'active', ${encrypt(t2.url)}) RETURNING id::text AS id, slug`;
    ids.a = rows.find((r) => r.slug === 'test-lc-a')!.id;
    ids.b = rows.find((r) => r.slug === 'test-lc-b')!.id;
    bucket = new FakeBucket();
    const r = await runBackup({
      controlPlaneUrl: cp.url, store: bucket, keyring: testKeyring(), pgDumpBin: PG_DUMP!, pgDumpVersion: 'pg_dump (PostgreSQL) 16',
      runId: `test-${randomUUID().slice(0, 8)}`, log: () => {},
    });
    expect(r.exitCode).toBe(0);
    bucket.ageAll(31 * MIN);
    for (const [k, v] of bucket.objects) snapshot.set(k, { bytes: Buffer.from(v.bytes), lastModified: v.lastModified });
  }, 120_000);

  afterAll(async () => {
    await cpSql?.end({ timeout: 5 });
    for (const d of [cp, t1, t2]) if (d) await dropScratchDb(d.name);
  });

  beforeEach(async () => {
    // Every test starts from the same bucket and backup rows; earlier runs' rows are removed.
    bucket.objects = new Map([...snapshot].map(([k, v]) => [k, { bytes: Buffer.from(v.bytes), lastModified: v.lastModified }]));
    bucket.failGet = () => false;
    await cpSql`DELETE FROM restore_test_runs`;
    await cpSql`DELETE FROM backup_permission_checks`;
    await cpSql`DELETE FROM database_backups WHERE run_id LIKE 'test-extra-%'`;
  });

  const keyOf = (tenantId: string) => [...snapshot.keys()].find((k) => k.startsWith(targetPrefix(cpId, 'tenant', tenantId)) && k.endsWith('.dump.enc'))!;
  const pick = (...tenantIds: string[]) => (e: Array<{ tenantId: string; slug: string; dueAt: Date }>) =>
    tenantIds.map((id) => e.find((x) => x.tenantId === id) ?? { tenantId: id, slug: `test-lc-${id.slice(0, 4)}`, dueAt: new Date() });

  function deps(o: Partial<RestoreTestDeps> = {}): RestoreTestDeps & { lines: string[] } {
    const lines: string[] = [];
    return {
      controlPlaneUrl: cp.url, restoreTestUrl: rtUrl, reader: bucket, store: bucket, keyring: testKeyring(), pgRestoreBin: PG_RESTORE!,
      runId: `test-${randomUUID().slice(0, 8)}`, log: (l) => lines.push(l), hostGuardOverride: true, lockRetryMs: 50, lockRetryMaxMs: 200,
      selectTargets: () => [], ...o, lines,
    };
  }
  const runRows = () => cpSql<Array<{ status: string; planned: number | null; detail: string | null; finished_at: Date | null; swept_test_dbs: number }>>`SELECT status, planned, detail, finished_at, swept_test_dbs FROM restore_test_runs ORDER BY started_at`;
  const resultRows = (runId: string) => cpSql<Array<{ target: string; tenant_id: string | null; result: string; detail: string | null; backup_id: string | null; s3_key: string | null }>>`SELECT target, tenant_id::text, result, detail, backup_id::text, s3_key FROM restore_test_results WHERE run_id = ${runId} ORDER BY tested_at`;

  it('S10: the control plane and both tenants PASS; no rt_ left; run and result rows; at most RESTORE_TEST_CONCURRENCY databases at once', async () => {
    let live = 0;
    let maxLive = 0;
    const d = deps({ concurrency: 2, selectTargets: pick(ids.a, ids.b) });
    d.hooks = {
      onCreated: () => { live++; maxLive = Math.max(maxLive, live); },
      dropDb: async (n) => { const admin = postgres(rtUrl, { max: 1, onnotice: () => {} }); try { await admin.unsafe(`DROP DATABASE IF EXISTS "${n}"`); } finally { await admin.end(); live--; } return true; },
    };
    const r = await runRestoreTest(d);
    expect(r.exitCode).toBe(0);
    const results = await resultRows(d.runId);
    expect(results.map((x) => [x.target, x.result])).toEqual(expect.arrayContaining([['control-plane', 'PASS'], ['tenant', 'PASS'], ['tenant', 'PASS']]));
    expect(results.length).toBe(3);
    expect(results.every((x) => x.backup_id && x.s3_key)).toBe(true);
    const [run] = await runRows();
    expect(run).toMatchObject({ status: 'pass', planned: 3, detail: null });
    expect(run.finished_at).not.toBeNull();
    expect(maxLive).toBeLessThanOrEqual(2);
    expect(maxLive).toBeGreaterThanOrEqual(1);
    expect(await listRtDatabases()).toEqual([]);
    const [probe] = await cpSql`SELECT role, ok FROM backup_permission_checks WHERE run_id = ${d.runId}`;
    expect(probe).toMatchObject({ role: 'restore-test', ok: true });
  }, 120_000);

  describe('S11: failures, each with no rt_ left behind', () => {
    it('a tampered ciphertext frame → FAIL:decrypt', async () => {
      const k = keyOf(ids.a);
      const o = bucket.objects.get(k)!;
      const bad = Buffer.from(o.bytes);
      bad[Math.floor(bad.length / 2)] ^= 0xff;
      bucket.objects.set(k, { ...o, bytes: bad });
      const d = deps({ selectTargets: pick(ids.a) });
      expect((await runRestoreTest(d)).exitCode).toBe(1);
      expect((await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)!.result).toBe('FAIL:decrypt');
      expect(await listRtDatabases()).toEqual([]);
    }, 60_000);

    it('a valid object whose row has a different sha256 → FAIL:sha256', async () => {
      const k = keyOf(ids.a);
      const [orig] = await cpSql<{ sha256: string }[]>`SELECT sha256 FROM database_backups WHERE s3_key = ${k}`;
      await cpSql`UPDATE database_backups SET sha256 = ${'0'.repeat(64)} WHERE s3_key = ${k}`;
      try {
        const d = deps({ selectTargets: pick(ids.a) });
        expect((await runRestoreTest(d)).exitCode).toBe(1);
        expect((await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)!.result).toBe('FAIL:sha256');
        expect(await listRtDatabases()).toEqual([]);
      } finally {
        await cpSql`UPDATE database_backups SET sha256 = ${orig.sha256} WHERE s3_key = ${k}`;
      }
    }, 60_000);

    it('another tenant\'s object copied under this tenant\'s prefix, with a matching ok row and the right SHA-256 → FAIL:context', async () => {
      const src = keyOf(ids.b);
      const forged = keyOf(ids.a).replace(/-[a-z0-9]{8}\.dump\.enc$/, '-forged00.dump.enc');
      const newer = new Date(Date.now() - 31 * MIN + 1000);
      bucket.objects.set(forged, { bytes: bucket.objects.get(src)!.bytes, lastModified: newer });
      bucket.objects.set(sidecarKeyFor(forged), { bytes: bucket.objects.get(sidecarKeyFor(src))!.bytes, lastModified: newer });
      await cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, s3_key, sha256, row_counts, target_deadline_ms, started_at, finished_at)
        SELECT ${ids.a}, 'tenant', 'test-extra-forged', 'ok', ${forged}, sha256, row_counts, 1, now(), now() FROM database_backups WHERE s3_key = ${src}`;
      const d = deps({ selectTargets: pick(ids.a) });
      expect((await runRestoreTest(d)).exitCode).toBe(1);
      const row = (await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)!;
      expect(row.result).toBe('FAIL:context');
      expect(row.s3_key).toBe(forged);
      expect(await listRtDatabases()).toEqual([]);
    }, 60_000);

    it('row_counts altered in the row only → FAIL:sidecar (the sidecar is checked first); in the row AND the sidecar → MISMATCH with the difference', async () => {
      const k = keyOf(ids.a);
      const [orig] = await cpSql<{ row_counts: Record<string, number> }[]>`SELECT row_counts FROM database_backups WHERE s3_key = ${k}`;
      const altered = { ...orig.row_counts, 'public.users': 999 };
      await cpSql`UPDATE database_backups SET row_counts = ${cpSql.json(altered)} WHERE s3_key = ${k}`;
      try {
        const d1 = deps({ selectTargets: pick(ids.a) });
        await runRestoreTest(d1);
        expect((await resultRows(d1.runId)).find((x) => x.tenant_id === ids.a)!.result).toBe('FAIL:sidecar');
        // Now make the sidecar agree (re-encrypted with the same context), so only the restored counts differ.
        const ctx = encryptionContext({ cp: cpId, kind: 'manifest', target: 'tenant', id: ids.a, key: baseKey(k) });
        const manifest = JSON.parse((await decryptBuffer(testKeyring(), bucket.objects.get(sidecarKeyFor(k))!.bytes, ctx)).toString());
        const { ciphertext } = await encryptBuffer(testKeyring(), ctx, Buffer.from(JSON.stringify({ ...manifest, rowCounts: altered })));
        bucket.objects.set(sidecarKeyFor(k), { ...bucket.objects.get(sidecarKeyFor(k))!, bytes: ciphertext });
        const d2 = deps({ selectTargets: pick(ids.a) });
        expect((await runRestoreTest(d2)).exitCode).toBe(1);
        const row = (await resultRows(d2.runId)).find((x) => x.tenant_id === ids.a)!;
        expect(row.result).toBe('MISMATCH');
        expect(row.detail).toBe('public.users: backup 999, restored 25');
        expect(await listRtDatabases()).toEqual([]);
      } finally {
        await cpSql`UPDATE database_backups SET row_counts = ${cpSql.json(orig.row_counts)} WHERE s3_key = ${k}`;
      }
    }, 60_000);

    it('a forced pg_restore failure → FAIL:pg_restore, and detail holds only the summary', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cpbk-'));
      const fake = path.join(dir, 'pg_restore');
      writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'pg_restore: error: COPY failed for table "users": ERROR:  invalid input syntax for type uuid: "AB123"\' >&2\necho \'CONTEXT:  COPY users, line 3: "pat@acme.com"\' >&2\nexit 1\n');
      chmodSync(fake, 0o755);
      const d = deps({ selectTargets: pick(ids.a), pgRestoreBin: fake });
      expect((await runRestoreTest(d)).exitCode).toBe(1);
      const row = (await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)!;
      expect(row.result).toBe('FAIL:pg_restore');
      expect(row.detail).toBe('pg_restore exit=1 table=users label=other');
      expect(await listRtDatabases()).toEqual([]);
    }, 60_000);

    it('no row for any candidate → FAIL:no-row', async () => {
      const [{ id: other }] = await cpSql<{ id: string }[]>`INSERT INTO tenants (slug, name, status, db_url_encrypted)
        VALUES (${`test-lc-norow-${randomUUID().slice(0, 6)}`}, 'NR', 'active', ${encrypt(t1.url)}) RETURNING id::text AS id`;
      const src = keyOf(ids.a);
      const k = src.replace(`/tenant/${ids.a}/`, `/tenant/${other}/`);
      bucket.objects.set(k, snapshot.get(src)!);
      bucket.objects.set(sidecarKeyFor(k), snapshot.get(sidecarKeyFor(src))!);
      const d = deps({ selectTargets: () => [{ tenantId: other, slug: 'test-lc-norow', dueAt: new Date() }] });
      await runRestoreTest(d);
      const rows = await cpSql<Array<{ result: string }>>`SELECT result FROM restore_test_results WHERE run_id = ${d.runId} AND target = 'tenant'`;
      expect(rows.map((x) => x.result)).toEqual(['FAIL:no-row']);
      expect(await listRtDatabases()).toEqual([]);
    }, 60_000);

    it('a newer object without a row plus an older one with an ok row → the older is restored (PASS, note in detail)', async () => {
      const src = keyOf(ids.a);
      const newer = src.replace(/-[a-z0-9]{8}\.dump\.enc$/, '-newer000.dump.enc');
      const when = new Date(Date.now() - 31 * MIN + 1000);
      bucket.objects.set(newer, { bytes: snapshot.get(src)!.bytes, lastModified: when });
      bucket.objects.set(sidecarKeyFor(newer), { bytes: snapshot.get(sidecarKeyFor(src))!.bytes, lastModified: when });
      const d = deps({ selectTargets: pick(ids.a) });
      expect((await runRestoreTest(d)).exitCode).toBe(0);
      const row = (await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)!;
      expect(row).toMatchObject({ result: 'PASS', s3_key: src, detail: '1 newer object(s) skipped: no ok row' });
    }, 60_000);

    it('an object under 30 minutes old is ignored (even with an ok row)', async () => {
      const src = keyOf(ids.a);
      const fresh = src.replace(/-[a-z0-9]{8}\.dump\.enc$/, '-fresh000.dump.enc');
      bucket.objects.set(fresh, { bytes: snapshot.get(src)!.bytes, lastModified: new Date() });
      bucket.objects.set(sidecarKeyFor(fresh), { bytes: snapshot.get(sidecarKeyFor(src))!.bytes, lastModified: new Date() });
      await cpSql`INSERT INTO database_backups (tenant_id, target, run_id, status, s3_key, sha256, row_counts, target_deadline_ms, started_at, finished_at)
        SELECT ${ids.a}, 'tenant', 'test-extra-fresh', 'ok', ${fresh}, sha256, row_counts, 1, now(), now() FROM database_backups WHERE s3_key = ${src}`;
      const d = deps({ selectTargets: pick(ids.a) });
      expect((await runRestoreTest(d)).exitCode).toBe(0);
      expect((await resultRows(d.runId)).find((x) => x.tenant_id === ids.a)).toMatchObject({ result: 'PASS', s3_key: src, detail: null });
    }, 60_000);
  });

  it('S15: a stop signal during a restore test → the rt_ database dropped, the result FAIL:stopped, the run closed fail', async () => {
    const stop = new AbortController();
    const d = deps({ selectTargets: pick(ids.a), concurrency: 1, stopSignal: stop.signal });
    d.hooks = { onCreated: () => stop.abort() };
    expect((await runRestoreTest(d)).exitCode).toBe(1);
    const results = await resultRows(d.runId);
    expect(results.map((x) => x.result)).toEqual(['FAIL:stopped', 'FAIL:stopped']);
    expect((await runRows())[0]).toMatchObject({ status: 'fail' });
    expect(await listRtDatabases()).toEqual([]);
  }, 60_000);

  it('a result row that can\'t be recorded fails the run but doesn\'t stop the other workers (their databases are dropped)', async () => {
    const ghost = randomUUID(); // not in tenants: its result insert violates the foreign key
    const d = deps({ concurrency: 2, selectTargets: () => [{ tenantId: ghost, slug: 'test-lc-ghost', dueAt: new Date() }] });
    expect((await runRestoreTest(d)).exitCode).toBe(1);
    expect(d.lines.some((l) => l.startsWith('test-lc-ghost: the result row could not be recorded'))).toBe(true);
    expect((await resultRows(d.runId)).map((x) => x.result)).toEqual(['PASS']); // the control plane finished normally
    expect((await runRows())[0]).toMatchObject({ status: 'fail' });
    expect(await listRtDatabases()).toEqual([]);
  }, 60_000);

  it('S17: an earlier `running` run row is closed fail / abandoned by the next run', async () => {
    await cpSql`INSERT INTO restore_test_runs (run_id, started_at, status, deadline_ms, target_deadline_ms) VALUES ('test-old', now() - interval '2 days', 'running', 1, 1)`;
    const d = deps();
    expect((await runRestoreTest(d)).exitCode).toBe(0);
    const rows = await runRows();
    expect(rows[0]).toMatchObject({ status: 'fail', detail: 'abandoned' });
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ status: 'pass' });
  }, 60_000);

  it('S18: backup tables missing → "run deploy-prod first"', async () => {
    const bare = await createScratchDb('cp');
    try {
      await expect(runRestoreTest({ ...deps(), controlPlaneUrl: bare.url })).rejects.toThrow('backup tables missing: run deploy-prod first');
    } finally {
      await dropScratchDb(bare.name);
    }
  });

  describe('S19: the remaining transitions', () => {
    const insertRun = async (o: { status: string; planned: number | null; results?: string[]; detail?: string }) => {
      const [r] = await cpSql<{ id: string }[]>`INSERT INTO restore_test_runs (run_id, started_at, finished_at, status, planned, deadline_ms, target_deadline_ms, detail)
        VALUES ('test-prior', now() - interval '1 minute', now(), ${o.status}, ${o.planned}, 1, 1, ${o.detail ?? null}) RETURNING id::text AS id`;
      for (const res of o.results ?? []) {
        await cpSql`INSERT INTO restore_test_results (test_run_id, run_id, target, result, duration_ms, tested_at) VALUES (${r.id}, 'test-prior', 'control-plane', ${res}, 1, now())`;
      }
    };

    it('--if-missed re-runs after a stopped, deadline-cut, locked-out or guard-failed run, and exits after a completed pass or fail', async () => {
      const cases: Array<[string, Parameters<typeof insertRun>[0], boolean]> = [
        ['stopped', { status: 'fail', planned: 1, results: ['FAIL:stopped'] }, true],
        ['deadline cut', { status: 'fail', planned: 2, results: ['PASS', 'FAIL:not-reached'] }, true],
        ['locked out', { status: 'fail', planned: null, detail: 'lock held' }, true],
        ['guard failed', { status: 'fail', planned: null, detail: 'guard: pooled host' }, true],
        ['completed pass', { status: 'pass', planned: 1, results: ['PASS'] }, false],
        ['completed fail', { status: 'fail', planned: 1, results: ['FAIL:pg_restore'] }, false],
        ['fail with fewer results than planned (FR10)', { status: 'fail', planned: 2, results: ['FAIL:pg_restore'] }, true],
        ['abandoned after every result (FR3)', { status: 'fail', planned: 1, results: ['PASS'], detail: 'abandoned' }, true],
      ];
      for (const [name, prior, reruns] of cases) {
        await cpSql`DELETE FROM restore_test_runs`;
        await insertRun(prior);
        const d = deps({ ifMissed: true });
        expect((await runRestoreTest(d)).exitCode, name).toBe(0);
        expect(d.lines.includes('catch-up: no completed restore test since Monday 00:00 UTC; running one'), name).toBe(reruns);
        expect(d.lines.includes('catch-up: a completed restore test ran since Monday 00:00 UTC; nothing to do'), name).toBe(!reruns);
      }
    }, 120_000);

    it('FAIL:list, FAIL:create-db, FAIL:download, FAIL:sidecar', async () => {
      const [{ id: noObjects }] = await cpSql<{ id: string }[]>`INSERT INTO tenants (slug, name, status, db_url_encrypted)
        VALUES (${`test-lc-none-${randomUUID().slice(0, 6)}`}, 'None', 'active', ${encrypt(t1.url)}) RETURNING id::text AS id`;
      const d1 = deps({ selectTargets: () => [{ tenantId: noObjects, slug: 'test-lc-none', dueAt: new Date() }] });
      await runRestoreTest(d1);
      expect((await cpSql`SELECT result FROM restore_test_results WHERE run_id = ${d1.runId} AND target = 'tenant'`)[0].result).toBe('FAIL:list');

      const d2 = deps({ selectTargets: pick(ids.a) });
      d2.hooks = { createDb: async () => { throw Object.assign(new Error('permission denied to create database'), { name: 'PostgresError', code: '42501' }); } };
      await runRestoreTest(d2);
      expect((await resultRows(d2.runId)).map((x) => x.result)).toEqual(['FAIL:create-db', 'FAIL:create-db']);

      bucket.failGet = (k) => k === keyOf(ids.a);
      const d3 = deps({ selectTargets: pick(ids.a) });
      await runRestoreTest(d3);
      expect((await resultRows(d3.runId)).find((x) => x.tenant_id === ids.a)!.result).toBe('FAIL:download');
      bucket.failGet = () => false;

      const k = keyOf(ids.a);
      bucket.objects.set(sidecarKeyFor(k), { ...bucket.objects.get(sidecarKeyFor(k))!, bytes: Buffer.from('not encrypted') });
      const d4 = deps({ selectTargets: pick(ids.a) });
      await runRestoreTest(d4);
      expect((await resultRows(d4.runId)).find((x) => x.tenant_id === ids.a)!.result).toBe('FAIL:sidecar');
      expect(await listRtDatabases()).toEqual([]);
    }, 120_000);

    it('FAIL:deadline and FAIL:not-reached (shortened deadlines)', async () => {
      const d1 = deps({ selectTargets: pick(ids.a), concurrency: 1, targetDeadlineMs: 1 });
      await runRestoreTest(d1);
      expect((await resultRows(d1.runId)).map((x) => x.result)).toEqual(['FAIL:deadline', 'FAIL:deadline']);
      const d2 = deps({ selectTargets: pick(ids.a, ids.b), concurrency: 1, runDeadlineMs: 1 });
      await runRestoreTest(d2);
      const results = (await resultRows(d2.runId)).map((x) => x.result);
      expect(results.length).toBe(3);
      expect(results.slice(1)).toEqual(['FAIL:not-reached', 'FAIL:not-reached']);
      expect(await listRtDatabases()).toEqual([]);
    }, 60_000);

    it('a guard failure → a fail row with finished_at and the reason; exit 1', async () => {
      const d = deps({ restoreTestUrl: t1.url });
      expect((await runRestoreTest(d)).exitCode).toBe(1);
      const [run] = await runRows();
      expect(run).toMatchObject({ status: 'fail', planned: null, detail: 'guard: database holds user tables' });
      expect(run.finished_at).not.toBeNull();
    });

    it('a failed drop is logged (the next audit or test drops it)', async () => {
      const made: string[] = [];
      const d = deps({ selectTargets: () => [] });
      d.hooks = { onCreated: (n) => made.push(n), dropDb: async () => { throw new Error('drop failed'); } };
      await runRestoreTest(d);
      expect(d.lines.some((l) => l.includes('control-plane: the test database could not be dropped'))).toBe(true);
      const admin = postgres(rtUrl, { max: 1, onnotice: () => {} });
      for (const n of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${n}"`);
      await admin.end();
    }, 60_000);

    it('the step-3 sweep drops rt_ databases older than 1 h with no session, and leaves newer ones', async () => {
      const admin = postgres(rtUrl, { max: 1, onnotice: () => {} });
      await admin.unsafe('CREATE DATABASE rt_20200101000000_oldsweep');
      const fresh = `rt_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_newsweep`;
      await admin.unsafe(`CREATE DATABASE "${fresh}"`);
      try {
        const d = deps();
        await runRestoreTest(d);
        const [run] = await runRows();
        expect(run.swept_test_dbs).toBe(1);
        expect(await listRtDatabases()).toEqual([fresh]);
      } finally {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${fresh}"`);
        await admin.unsafe('DROP DATABASE IF EXISTS rt_20200101000000_oldsweep');
        await admin.end();
      }
    }, 60_000);

    it('the lock is retried, then a `lock held` fail row; exit 1', async () => {
      const held = (await acquireLock(cp.url, RESTORE_TEST_LOCK_KEY))!;
      try {
        const d = deps();
        expect((await runRestoreTest(d)).exitCode).toBe(1);
        const [run] = await runRows();
        expect(run).toMatchObject({ status: 'fail', detail: 'lock held', planned: null });
        expect(run.finished_at).not.toBeNull();
      } finally {
        await held.release();
      }
    });
  });
});
