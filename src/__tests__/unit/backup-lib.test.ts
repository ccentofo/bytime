import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

/**
 * feature-plan-database-backups.md §11 unit tests U1, U2, U4, U5 (environment and keys), U7, U8, U11, U12 for the pure
 * pieces under scripts/backup/lib. No AWS: the raw AES keyring runs the real Encryption SDK streams.
 */

import {
  baseKey, controlPlaneId, dumpKey, newRunId, probeKey, RT_NAME_RE, rtDatabaseName, rtNameCreatedAt, sidecarKeyFor, targetPrefix,
} from '../../../scripts/backup/lib/keys';
import { copyTableName, installCrashHandler, labelFor, sqlstateOf, summarizeError } from '../../../scripts/backup/lib/summarize-error';
import { parseNeonHost, regionOfUrl } from '../../../scripts/backup/lib/neon-host';
import { childConnection, childEnv, clientUrl, withDatabase } from '../../../scripts/backup/lib/pg-url';
import { checkToolVersion, defaultToolPath, FatalError, intEnv, requireEnv, requireHexKey } from '../../../scripts/backup/lib/env';
import { chooseTargets, targetCount, WEEK_MS, type EligibleWorkspace } from '../../../scripts/backup/lib/targets';
import { compareCounts, describeDiffs } from '../../../scripts/backup/lib/counts';
import { restoreServerRefusal, restoreUrlRefusal } from '../../../scripts/backup/lib/rt-guards';
import { runDumpPipeline } from '../../../scripts/backup/lib/dump-pipeline';
import { restoreObject } from '../../../scripts/backup/lib/restore-stream';
import { contextMatches, encryptBuffer, encryptionContext, kmsKeyringFactory, makeEncryptStream, decryptBuffer } from '../../../scripts/backup/lib/crypto';
import type { SpawnFn } from '../../../scripts/backup/lib/child';
import { FakeBucket, fakeDumpArgs, testKeyring } from '../helpers/backup-fakes';

const NOW = new Date('2026-11-16T06:17:05Z');

describe('U1: keys, run ids, rt_ names', () => {
  it('dump and sidecar keys carry <cp>, target, id, date, run id and a random suffix; baseKey strips either suffix', () => {
    const k = dumpKey({ cp: 'abcdef012345', target: 'tenant', id: 'u-1', now: NOW, runId: 'ecs-x', token: 'zz11yy22' });
    expect(k).toBe('v1/abcdef012345/tenant/u-1/2026/11/16/ecs-x-zz11yy22.dump.enc');
    expect(sidecarKeyFor(k)).toBe('v1/abcdef012345/tenant/u-1/2026/11/16/ecs-x-zz11yy22.manifest.json.enc');
    expect(baseKey(k)).toBe(baseKey(sidecarKeyFor(k)));
    expect(baseKey(k)).toBe('v1/abcdef012345/tenant/u-1/2026/11/16/ecs-x-zz11yy22');
    expect(() => baseKey('v1/x/other.txt')).toThrow();
    expect(targetPrefix('c', 'control-plane', 'control-plane')).toBe('v1/c/control-plane/control-plane/');
    expect(dumpKey({ cp: 'c', target: 'tenant', id: 'i', now: NOW, runId: 'r' })).toMatch(/\/r-[a-z0-9]{8}\.dump\.enc$/);
    expect(probeKey('ecs-1')).toBe('v1/probe/ecs-1');
  });

  it('<cp> is derived from the DIRECT host: pooled and direct URLs of one endpoint give the same id; another host differs', () => {
    const pooled = 'postgresql://u:p@ep-cool-1-pooler.c-2.us-east-1.aws.neon.tech/db?sslmode=require';
    const direct = 'postgresql://u:other@ep-cool-1.c-2.us-east-1.aws.neon.tech/other';
    expect(controlPlaneId(pooled)).toBe(controlPlaneId(direct));
    expect(controlPlaneId(pooled)).toMatch(/^[0-9a-f]{12}$/);
    expect(controlPlaneId(pooled)).toBe(createHash('sha256').update('ep-cool-1.c-2.us-east-1.aws.neon.tech').digest('hex').slice(0, 12));
    expect(controlPlaneId('postgresql://u:p@ep-other.us-east-1.aws.neon.tech/db')).not.toBe(controlPlaneId(pooled));
  });

  it('run id and rt_ name formats', () => {
    expect(newRunId(NOW, 'ab12cd')).toBe('ecs-20261116T061705Z-ab12cd');
    expect(newRunId(NOW)).toMatch(/^ecs-\d{8}T\d{6}Z-[a-z0-9]{6}$/);
    const name = rtDatabaseName(NOW, 'abcd1234');
    expect(name).toBe('rt_20261116061705_abcd1234');
    expect(RT_NAME_RE.test(name)).toBe(true);
    expect(rtNameCreatedAt(name)?.toISOString()).toBe('2026-11-16T06:17:05.000Z');
    expect(rtNameCreatedAt('rt_2026111608_abcd1234')).toBeNull();
  });
});

describe('U2: summarizeError keeps no customer value, host or user name', () => {
  const SAMPLES: Array<{ err: unknown; stderr?: string; label: string; table?: string; forbidden: string[] }> = [
    { err: { exitCode: 1 }, stderr: 'pg_restore: error: COPY failed for table "users": ERROR:  invalid input syntax for type uuid: "AB123"\nCONTEXT:  COPY users, line 3: "x@acme.com\tAB123"', label: 'other', table: 'users', forbidden: ['AB123', 'acme.com', 'x@'] },
    { err: Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { name: 'PostgresError', code: '23505', detail: 'Key (email)=(pat@acme.com) already exists.' }), label: 'other', forbidden: ['pat@acme.com', 'users_email_key'] },
    { err: Object.assign(new Error('invalid input syntax for type integer: "AB123"'), { name: 'PostgresError', code: '22P02' }), label: 'other', forbidden: ['AB123'] },
    { err: Object.assign(new Error('new row for relation "users" violates check constraint'), { name: 'PostgresError', code: '23514', detail: 'Failing row contains (1, secret-value).' }), label: 'other', forbidden: ['secret-value'] },
    { err: { exitCode: 1 }, stderr: 'pg_dump: error: connection to server at "ep-cool-1.us-east-1.aws.neon.tech" (3.3.3.3), port 5432 failed: Connection refused', label: 'connection-refused', forbidden: ['ep-cool-1', 'neon.tech', '3.3.3.3'] },
    { err: { exitCode: 1 }, stderr: 'pg_dump: error: connection to server at "ep-x.neon.tech" failed: FATAL:  password authentication failed for user "founder_admin"', label: 'auth-failed', forbidden: ['founder_admin', 'ep-x'] },
  ];

  it.each(SAMPLES.map((s, i) => [i, s] as const))('sample %i', (_i, s) => {
    const out = summarizeError('dump', s.err, s.stderr);
    for (const f of s.forbidden) expect(out).not.toContain(f);
    expect(out).toContain(`label=${s.label}`);
    if (s.table) expect(out).toContain(`table=${s.table}`);
    expect(out.startsWith('dump')).toBe(true);
  });

  it('SQLSTATE only from a PostgresError code: never parsed from text ("AB123"), never from a Node code ("EPIPE")', () => {
    expect(sqlstateOf(Object.assign(new Error('x'), { name: 'PostgresError', code: '57P01' }))).toBe('57P01');
    expect(sqlstateOf(Object.assign(new Error('syntax "AB123"'), { name: 'Error' }))).toBeNull();
    expect(sqlstateOf(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBeNull();
    expect(summarizeError('restore', undefined, 'ERROR: invalid input "AB123"')).not.toContain('sqlstate');
    expect(summarizeError('count', Object.assign(new Error('terminating connection'), { name: 'PostgresError', code: '57P01' }))).toBe('count sqlstate=57P01 label=connection-refused');
  });

  it('exit code, signal, labels and the COPY table', () => {
    expect(summarizeError('dump', { exitCode: null, signal: 'SIGKILL' })).toBe('dump signal=SIGKILL label=killed');
    expect(labelFor(Object.assign(new Error('User is not authorized to perform kms:Decrypt'), { name: 'AccessDeniedException' }))).toBe('access-denied');
    expect(labelFor(Object.assign(new Error('x'), { name: 'KMSInvalidStateException' }))).toBe('kms-error');
    expect(labelFor(Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } }))).toBe('s3-error');
    expect(labelFor(new Error('ENOSPC: no space left on device'))).toBe('disk');
    expect(labelFor(new Error('canceling statement due to lock timeout'))).toBe('lock-timeout');
    expect(labelFor(new Error('write CONNECT_TIMEOUT ep-x:5432'))).toBe('timeout');
    expect(copyTableName(undefined, 'Command was: COPY public.timesheet_entries (id) TO stdout;')).toBe('public.timesheet_entries');
    expect(copyTableName(undefined, 'COPY failed for table "x"')).toBeNull();
    expect(summarizeError('deadline')).toBe('deadline');
  });

  it('the crash handler logs only the summary and exits 1', () => {
    const lines: string[] = [];
    const exit = vi.fn();
    const off = installCrashHandler((l) => lines.push(l), exit);
    try {
      process.emit('uncaughtException', Object.assign(new Error('boom at ep-secret.neon.tech'), { name: 'PostgresError', code: '08006', detail: 'Key (email)=(a@b.c)' }));
    } finally {
      off();
    }
    expect(lines).toEqual(['FATAL crash sqlstate=08006 label=connection-refused']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('the password split and the minimal child environment', () => {
    const c = childConnection('postgresql://founder:p%40ss%2Fw0rd@ep-x.us-east-1.aws.neon.tech/db?sslmode=require&channel_binding=require');
    expect(c.password).toBe('p@ss/w0rd');
    expect(c.url).not.toContain('p%40ss');
    expect(c.url).toContain('sslmode=require');
    expect(c.url).toContain('channel_binding=require');
    expect(c.url).toContain('keepalives=1');
    expect(c.url).toContain('connect_timeout=30');
    const env = childEnv('pw', { PATH: '/bin', HOME: '/h', LANG: 'C', ENCRYPTION_KEY: 'k', CONTROL_PLANE_DATABASE_URL: 'u', AWS_SECRET_ACCESS_KEY: 's' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', PGPASSWORD: 'pw' });
  });
});

describe('U5: environment checks', () => {
  it('missing or empty values are fatal; the key must be 64 hex', () => {
    expect(() => requireEnv({}, 'BACKUP_BUCKET')).toThrow(FatalError);
    expect(() => requireEnv({ BACKUP_BUCKET: '  ' }, 'BACKUP_BUCKET')).toThrow('BACKUP_BUCKET is not set');
    expect(requireEnv({ BACKUP_BUCKET: 'b' }, 'BACKUP_BUCKET')).toBe('b');
    expect(() => requireHexKey({ ENCRYPTION_KEY: 'replace-with-openssl-rand-hex-32' })).toThrow('64 hex');
    expect(requireHexKey({ ENCRYPTION_KEY: 'a'.repeat(64) })).toBe('a'.repeat(64));
    expect(() => intEnv({ BACKUP_CONCURRENCY: '0' }, 'BACKUP_CONCURRENCY', 3)).toThrow();
    expect(intEnv({}, 'BACKUP_CONCURRENCY', 3)).toBe(3);
  });

  it('pg_dump / pg_restore must be 16.x; --self-check falls back to the image paths when *_BIN is unset', async () => {
    await expect(checkToolVersion('x', 'pg_dump', async () => 'pg_dump (PostgreSQL) 16.14')).resolves.toContain('16.14');
    await expect(checkToolVersion('x', 'pg_dump', async () => 'pg_dump (PostgreSQL) 17.2')).rejects.toThrow('version 16');
    await expect(checkToolVersion('x', 'pg_restore', async () => 'pg_dump (PostgreSQL) 16.1')).rejects.toThrow('version 16');
    await expect(checkToolVersion('x', 'pg_restore', async () => { throw new Error('ENOENT'); })).rejects.toThrow('could not be run');
    expect(defaultToolPath({}, 'pg_dump')).toBe('/usr/lib/postgresql/16/bin/pg_dump');
    expect(defaultToolPath({}, 'pg_restore')).toBe('/usr/lib/postgresql/16/bin/pg_restore');
    expect(defaultToolPath({ BACKUP_PG_DUMP_BIN: '/opt/pg_dump' }, 'pg_dump')).toBe('/opt/pg_dump');
  });

  it('a KMS alias is refused where a key ARN is required (an alias would fail every strict decrypt)', () => {
    expect(() => kmsKeyringFactory('arn:aws:kms:us-east-1:111122223333:alias/cadenzpoint-backup')).toThrow('key ARN');
    expect(() => kmsKeyringFactory('arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab')).not.toThrow();
  });

  it('postgres.js URLs are reduced to sslmode; withDatabase swaps only the database', () => {
    expect(clientUrl('postgresql://u:p@h/db?sslmode=require&channel_binding=require&keepalives=1')).toBe('postgresql://u:p@h/db?sslmode=require');
    expect(withDatabase('postgresql://u:p@h:5432/db?sslmode=require', 'rt_1')).toBe('postgresql://u:p@h:5432/rt_1?sslmode=require');
  });
});

describe('U7: restore-test target choice', () => {
  const ws = (n: number, dueWeeksAgo: (i: number) => number, now = NOW): EligibleWorkspace[] =>
    Array.from({ length: n }, (_, i) => ({ tenantId: `t${i}`, slug: `s${i}`, dueAt: new Date(now.getTime() - dueWeeksAgo(i) * WEEK_MS) }));

  it('N at E = 0, 1, 12, 13, 25', () => {
    expect(targetCount(0, 0)).toBe(0);
    expect(targetCount(1, 0)).toBe(1);
    expect(targetCount(12, 0)).toBe(1);
    expect(targetCount(13, 0)).toBe(2);
    expect(targetCount(25, 0)).toBe(3);
    expect(targetCount(25, 5)).toBe(5);
    expect(chooseTargets([], NOW)).toEqual([]);
  });

  it('targets come back in due-date order; ties random', () => {
    const list = ws(30, (i) => (i * 7) % 10);
    const chosen = chooseTargets(list, NOW, () => 0.5);
    expect(chosen.map((c) => c.dueAt.getTime())).toEqual([...chosen.map((c) => c.dueAt.getTime())].sort((a, b) => a - b));
    expect(chosen.length).toBe(3);
    const ties = ws(24, () => 2);
    const a = chooseTargets(ties, NOW, (() => { let x = 0; return () => (x = (x * 9301 + 49297) % 233280) / 233280; })());
    const b = chooseTargets(ties, NOW, (() => { let x = 7; return () => (x = (x * 9301 + 49297) % 233280) / 233280; })());
    expect(a.map((c) => c.slug)).not.toEqual(b.map((c) => c.slug));
  });

  /** A 26-week simulation: weekly runs (Monday), optional lost Mondays (caught up Tuesday), a deadline cut, failing ws. */
  function simulate(o: { initial: number; newPerWeek?: number; failing?: Set<string>; lostMondays?: Set<number>; cutWeeks?: Map<number, number> }) {
    const start = new Date('2026-01-05T08:17:00Z'); // a Monday
    const firstOk = new Map<string, Date>();
    const lastPass = new Map<string, Date>();
    const gaps: Array<{ slug: string; weeks: number }> = [];
    const nUsed: number[] = [];
    let seq = 0;
    for (let i = 0; i < o.initial; i++) firstOk.set(`w${seq++}`, new Date(start.getTime() - 20 * WEEK_MS));
    let rand = 1;
    const random = () => (rand = (rand * 16807) % 2147483647) / 2147483647;
    for (let week = 0; week < 26; week++) {
      for (let i = 0; i < (o.newPerWeek ?? 0); i++) firstOk.set(`w${seq++}`, new Date(start.getTime() + week * WEEK_MS - 2 * 24 * 3600_000));
      const runAt = new Date(start.getTime() + week * WEEK_MS + (o.lostMondays?.has(week) ? 24 * 3600_000 : 0));
      const eligible = [...firstOk.entries()].map(([slug, ok]) => ({ tenantId: slug, slug, dueAt: lastPass.get(slug) ?? ok }));
      let chosen = chooseTargets(eligible, runAt, random);
      nUsed.push(chosen.length);
      const cut = o.cutWeeks?.get(week);
      if (cut !== undefined) chosen = chosen.slice(0, cut);
      for (const c of chosen) {
        if (o.failing?.has(c.slug)) continue;
        const prev = lastPass.get(c.slug);
        if (prev) gaps.push({ slug: c.slug, weeks: (runAt.getTime() - prev.getTime()) / WEEK_MS });
        lastPass.set(c.slug, runAt);
      }
    }
    return { gaps, nUsed, lastPass, end: new Date(start.getTime() + 26 * WEEK_MS), firstOk };
  }

  it('E = 10 with one new workspace a week: no passing workspace waits more than 13 weeks between PASSes', () => {
    const r = simulate({ initial: 10, newPerWeek: 1 });
    expect(Math.max(...r.gaps.map((g) => g.weeks))).toBeLessThanOrEqual(13);
  });

  it('one permanently failing workspace: N grows by one once it is 11 weeks overdue, and nobody else starves', () => {
    // E = 10: ceil(10/12) = 1 slot, which the failing workspace (oldest due date) takes every week. Once others reach
    // 11 weeks overdue they count towards N, so N grows past 1 and every passing workspace still makes the 13 weeks.
    const r = simulate({ initial: 10, failing: new Set(['w0']) });
    expect(r.nUsed[0]).toBe(10); // all 10 start 20 weeks overdue
    expect(Math.max(...r.gaps.map((g) => g.weeks))).toBeLessThanOrEqual(13);
    expect(r.nUsed.slice(1).some((n) => n >= 2)).toBe(true);
    for (const slug of [...r.firstOk.keys()].filter((s) => s !== 'w0')) {
      expect((r.end.getTime() - r.lastPass.get(slug)!.getTime()) / WEEK_MS, slug).toBeLessThanOrEqual(13);
    }
  });

  it('one lost Monday recovered by the Tuesday catch-up', () => {
    const r = simulate({ initial: 30, lostMondays: new Set([3, 9, 15]) });
    expect(Math.max(...r.gaps.map((g) => g.weeks))).toBeLessThanOrEqual(13);
  });

  it('a run cut by the deadline drops the newest-due targets, and the 13-week rule still holds', () => {
    const list = ws(40, (i) => i % 13);
    const chosen = chooseTargets(list, NOW, () => 0.1);
    const cut = chosen.slice(0, 1);
    expect(cut[0].dueAt.getTime()).toBe(Math.min(...chosen.map((c) => c.dueAt.getTime())));
    const r = simulate({ initial: 36, cutWeeks: new Map([[2, 1], [7, 1], [12, 0]]) });
    expect(Math.max(...r.gaps.map((g) => g.weeks))).toBeLessThanOrEqual(13);
  });
});

describe('U8: count comparison', () => {
  it('missing, extra and differing tables; key order ignored; string versus number counts', () => {
    expect(compareCounts({ 'public.a': 1, 'public.b': 2 }, { 'public.b': '2', 'public.a': 1 }).equal).toBe(true);
    const r = compareCounts({ 'public.a': 1, 'public.b': 2 }, { 'public.a': 3, 'public.c': 0 });
    expect(r.equal).toBe(false);
    expect(r.diffs).toEqual([
      { table: 'public.a', expected: 1, actual: 3 },
      { table: 'public.b', expected: 2, actual: null },
      { table: 'public.c', expected: null, actual: 0 },
    ]);
    expect(describeDiffs(r.diffs)).toBe('public.a: backup 1, restored 3; public.b: backup 2, restored absent; public.c: backup absent, restored 0');
  });
});

describe('U11: restore-test URL guards and the Neon host parser', () => {
  const CP = 'postgresql://owner:pw@ep-cp-1-pooler.us-east-1.aws.neon.tech/control?sslmode=require';

  it('parseNeonHost: pooler, cell label and region', () => {
    expect(parseNeonHost('ep-cool-1.us-east-1.aws.neon.tech')).toEqual({ pooled: false, region: 'us-east-1' });
    expect(parseNeonHost('ep-cool-1-pooler.c-2.us-east-1.aws.neon.tech')).toEqual({ pooled: true, region: 'us-east-1' });
    expect(parseNeonHost('ep-cool-1.c-2.us-east-2.aws.neon.tech')).toEqual({ pooled: false, region: 'us-east-2' });
    expect(parseNeonHost('localhost')).toBeNull();
    expect(regionOfUrl('postgresql://u:p@localhost:5432/x')).toBe('unknown');
    expect(regionOfUrl('postgresql://u:p@ep-a.c-3.us-east-1.aws.neon.tech/x')).toBe('us-east-1');
  });

  it('same host refused (also pooled vs direct); us-east-2 refused; c-2.us-east-1 accepted; c-2.us-east-2 refused; -pooler refused', () => {
    expect(restoreUrlRefusal(CP, 'postgresql://owner:pw@ep-cp-1.us-east-1.aws.neon.tech/rt')).toBe('same host as the control plane');
    expect(restoreUrlRefusal(CP, 'postgresql://u:p@ep-rt.us-east-2.aws.neon.tech/rt')).toBe('not a Neon us-east-1 host');
    expect(restoreUrlRefusal(CP, 'postgresql://u:p@ep-rt.c-2.us-east-1.aws.neon.tech/rt?sslmode=require&channel_binding=require')).toBeNull();
    expect(restoreUrlRefusal(CP, 'postgresql://u:p@ep-rt.c-2.us-east-2.aws.neon.tech/rt')).toBe('not a Neon us-east-1 host');
    expect(restoreUrlRefusal(CP, 'postgresql://u:p@ep-rt-pooler.us-east-1.aws.neon.tech/rt')).toBe('pooled host');
    expect(restoreUrlRefusal(CP, 'postgresql://u:p@ep-rt-pooler.us-east-1.aws.neon.tech/rt', { hostGuardOverride: true })).toBe('pooled host');
    expect(restoreUrlRefusal('postgresql://u:p@localhost/cp', 'postgresql://u:p@localhost/rt', { hostGuardOverride: true })).toBeNull();
    expect(restoreUrlRefusal('postgresql://u:p@localhost/cp', 'postgresql://u:p@localhost/rt')).toBe('same host as the control plane');
  });

  it('a Postgres 18 server and a database with user tables are refused', async () => {
    const fake = (n: number, tables: number) => ({
      unsafe: async (q: string) => (q.includes('server_version_num') ? [{ n }] : Array.from({ length: tables }, () => ({ table_schema: 'public', table_name: 't' }))),
    });
    expect(await restoreServerRefusal(fake(180001, 0))).toBe('server version is not 16');
    expect(await restoreServerRefusal(fake(160014, 2))).toBe('database holds user tables');
    expect(await restoreServerRefusal(fake(160014, 0))).toBeNull();
  });

  it('the rt_ drop pattern refuses postgres, template1, a short name and tenant-like names', () => {
    for (const n of ['postgres', 'template1', 'rt_2026111608_abcd1234', 'tenant_acme', 'rt_20261116081700_ABCD1234', 'xrt_20261116081700_abcd1234']) {
      expect(RT_NAME_RE.test(n), n).toBe(false);
    }
  });
});

describe('U4: the dump end gate', () => {
  const ctx = encryptionContext({ cp: 'c', kind: 'dump', target: 'tenant', id: 't', key: 'v1/c/tenant/t/k' });
  const spawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, args, opts);
  const run = (bucket: FakeBucket, args: string[], signal = new AbortController().signal) => runDumpPipeline({
    spawn, bin: process.execPath, args, env: { PATH: process.env.PATH ?? '' }, makeEncrypt: () => makeEncryptStream(testKeyring(), ctx),
    store: bucket, key: 'k1', signal,
  });

  it('success: the body ends after pg_dump (0,null) and the encrypt end; SHA-256 and bytes are of the stored ciphertext', async () => {
    const bucket = new FakeBucket();
    const r = await run(bucket, fakeDumpArgs({ bytes: 300_000 }));
    const stored = bucket.objects.get('k1')!.bytes;
    expect(r.bytes).toBe(stored.length);
    expect(r.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(bucket.completedStreams).toEqual(['k1']);
  });

  it('pg_dump exits 1 mid-stream → rejected; the body never reaches end-of-stream; no object', async () => {
    const bucket = new FakeBucket();
    await expect(run(bucket, fakeDumpArgs({ failAfterBytes: 100_000, code: 1 }))).rejects.toMatchObject({ summary: expect.stringMatching(/^dump exit=1/) });
    expect(bucket.completedStreams).toEqual([]);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.abortedStreams).toEqual(['k1']);
  });

  it('an encrypt-stream failure (keyring throws) → rejected before the body ends', async () => {
    const bucket = new FakeBucket();
    const bad = { encrypt: () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); }, decrypt: () => { throw new Error('x'); } };
    await expect(runDumpPipeline({
      spawn, bin: process.execPath, args: fakeDumpArgs({ bytes: 5000 }), env: {}, makeEncrypt: () => makeEncryptStream(bad as never, ctx),
      store: bucket, key: 'k2', signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(bucket.objects.size).toBe(0);
  });

  it('an abort (deadline) kills a hanging pg_dump and destroys the body', async () => {
    const bucket = new FakeBucket();
    const ac = new AbortController();
    setTimeout(() => ac.abort('deadline'), 300);
    await expect(run(bucket, fakeDumpArgs({ hang: true }), ac.signal)).rejects.toMatchObject({ summary: 'deadline' });
    expect(bucket.completedStreams).toEqual([]);
  });

  it('a body under 1024 bytes is not ok', async () => {
    const bucket = new FakeBucket();
    // An empty dump still yields a header + a final frame (~200 bytes) under the minimum.
    await expect(run(bucket, fakeDumpArgs({ bytes: 0 }))).rejects.toMatchObject({ summary: 'too-small' });
  });
});

describe('U12: the header check gates pg_restore', () => {
  it('a mismatched context destroys the stream and pg_restore is never spawned', async () => {
    const bucket = new FakeBucket();
    const realCtx = encryptionContext({ cp: 'c', kind: 'dump', target: 'tenant', id: 'other-tenant', key: 'v1/c/tenant/other-tenant/k' });
    const { ciphertext } = await encryptBuffer(testKeyring(), realCtx, Buffer.alloc(5000, 3));
    bucket.objects.set('obj', { bytes: ciphertext, lastModified: new Date() });
    const calls: string[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => { calls.push(cmd); return nodeSpawn(cmd, args, opts); };
    const expected = { ...realCtx, id: 'this-tenant', key: 'v1/c/tenant/this-tenant/k' };
    await expect(restoreObject({
      reader: bucket, key: 'obj', expectedContext: expected, expectedSha256: createHash('sha256').update(ciphertext).digest('hex'),
      factory: testKeyring(), spawn, bin: process.execPath, args: ['-e', 'process.stdin.resume()'], env: {}, signal: new AbortController().signal,
    })).rejects.toMatchObject({ summary: 'context' });
    expect(calls).toEqual([]);
  });

  it('a matching context spawns the restorer after the header and passes the plaintext through', async () => {
    const bucket = new FakeBucket();
    const ctx = encryptionContext({ cp: 'c', kind: 'dump', target: 'tenant', id: 't', key: 'v1/c/tenant/t/k' });
    const plain = Buffer.alloc(200_000, 9);
    const { ciphertext } = await encryptBuffer(testKeyring(), ctx, plain);
    bucket.objects.set('obj', { bytes: ciphertext, lastModified: new Date() });
    const calls: string[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => { calls.push(cmd); return nodeSpawn(cmd, args, opts); };
    const script = `let n=0;process.stdin.on('data',c=>{for(const b of c) if(b!==9) process.exit(3); n+=c.length});process.stdin.on('end',()=>process.exit(n===${plain.length}?0:4))`;
    await restoreObject({
      reader: bucket, key: 'obj', expectedContext: ctx, expectedSha256: createHash('sha256').update(ciphertext).digest('hex'),
      factory: testKeyring(), spawn, bin: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH ?? '' }, signal: new AbortController().signal,
    });
    expect(calls).toEqual([process.execPath]);
  });

  it('the KMS keyring (strict, key ARN; a fake in-process KMS client, no AWS) decrypts its FIRST message and passes the context to KMS', async () => {
    const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
    const { buildClient, CommitmentPolicy, KmsKeyringNode } = await import('@aws-crypto/client-node');
    const ARN = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
    const master = randomBytes(32);
    const aad = (c: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(c).sort()));
    const seen: Array<Record<string, string>> = [];
    const kms = {
      generateDataKey: async ({ NumberOfBytes, EncryptionContext }: { NumberOfBytes: number; EncryptionContext: Record<string, string> }) => {
        seen.push(EncryptionContext);
        const pt = randomBytes(NumberOfBytes); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', master, iv); c.setAAD(aad(EncryptionContext));
        const ct = Buffer.concat([c.update(pt), c.final()]);
        return { KeyId: ARN, Plaintext: pt, CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]) };
      },
      encrypt: async () => { throw new Error('unused'); },
      decrypt: async ({ CiphertextBlob, EncryptionContext }: { CiphertextBlob: Uint8Array; EncryptionContext: Record<string, string> }) => {
        const b = Buffer.from(CiphertextBlob); const d = createDecipheriv('aes-256-gcm', master, b.subarray(0, 12)); d.setAAD(aad(EncryptionContext)); d.setAuthTag(b.subarray(12, 28));
        return { KeyId: ARN, Plaintext: Buffer.concat([d.update(b.subarray(28)), d.final()]) };
      },
    };
    const clientProvider = () => kms as never;
    const factory = { encrypt: () => new KmsKeyringNode({ generatorKeyId: ARN, clientProvider }), decrypt: () => new KmsKeyringNode({ keyIds: [ARN], clientProvider }) };
    const ctx = encryptionContext({ cp: 'c', kind: 'dump', target: 'tenant', id: 't', key: 'k' });
    const { ciphertext } = await encryptBuffer(factory, ctx, Buffer.alloc(1500, 4));
    expect((await decryptBuffer(factory, ciphertext, ctx)).length).toBe(1500);
    expect(seen[0]).toEqual(ctx);
    expect(buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)).toBeTruthy();
  });

  it('the sidecar decrypt requires the exact context', async () => {
    const ctx = encryptionContext({ cp: 'c', kind: 'manifest', target: 'tenant', id: 't', key: 'k' });
    const { ciphertext } = await encryptBuffer(testKeyring(), ctx, Buffer.from('{"v":1}'));
    expect((await decryptBuffer(testKeyring(), ciphertext, ctx)).toString()).toBe('{"v":1}');
    await expect(decryptBuffer(testKeyring(), ciphertext, { ...ctx, id: 'u' })).rejects.toThrow('context');
    expect(contextMatches({ a: '1' }, { a: '1', b: '2' })).toBe(false);
  });
});
