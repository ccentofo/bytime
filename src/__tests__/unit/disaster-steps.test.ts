import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateEvidence, classifyRestoreFailure, networkProven, rebuildName, Aborted, type StepEnv } from '../../../scripts/backup/disaster-steps';
import { StageError, summarizeError } from '../../../scripts/backup/lib/summarize-error';
import { NeonApiError } from '../../../scripts/backup/lib/neon-api';
import { monotonicAt } from '../../../scripts/backup/lib/disaster-sql';
import type { EvidenceFacts } from '../../../scripts/backup/lib/disaster-sql';

/**
 * feature-plan-disaster-restore.md §11 D4 (the switch SQL), D1's override evidence rules (pure), D3's failure classes,
 * and D8's network-first rule, without a database.
 */

const ROOT = path.resolve(__dirname, '../../..');
const steps = readFileSync(path.join(ROOT, 'scripts/backup/disaster-steps.ts'), 'utf8');
const sqlMod = readFileSync(path.join(ROOT, 'scripts/backup/lib/disaster-sql.ts'), 'utf8');
const locked = readFileSync(path.join(ROOT, 'src/db/control-plane/locked.ts'), 'utf8');

describe('D4: the switch SQL', () => {
  const sw = steps.slice(steps.indexOf('export async function switchWorkspace'), steps.indexOf('// ---- cleanup'));
  it('takes the app\'s tenant lock with the same expression as locked.ts:63, after a 5 s lock_timeout', () => {
    expect(locked).toContain("pg_advisory_xact_lock(hashtext(${'tenant:' + tenantId}))");
    expect(sw).toContain("pg_advisory_xact_lock(hashtext(${'tenant:' + s.t.id}))");
    expect(sw.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(sw.indexOf('pg_advisory_xact_lock'));
    // Cleanup's re-read takes the very same lock.
    expect(sqlMod).toContain("pg_advisory_xact_lock(hashtext(${'tenant:' + tenantId}))");
  });
  it('the UPDATE: byte equality on the URL and project id read at the start, live status, no passed deletion date, a lifecycle_version bump, updated_at', () => {
    const upd = sw.slice(sw.indexOf('UPDATE tenants'), sw.indexOf('RETURNING id'));
    expect(upd).toContain('db_url_encrypted = ${s.oldUrlEncrypted}');
    expect(upd).toContain('neon_project_id = ${s.oldProjectId}');
    expect(upd).toContain("status IN ('provisioning', 'active', 'suspended')");
    expect(upd).toContain('(deletion_scheduled_for IS NULL OR deletion_scheduled_for > now())');
    expect(upd).toContain('lifecycle_version = lifecycle_version + 1');
    expect(upd).toContain('updated_at = now()');
    expect(sw).toContain('if (rows.length === 0) throw new ChangedMeanwhile()');
  });
  it('SWITCHING is logged inside the transaction (before COMMIT), LINKED after it', () => {
    expect(sw.indexOf('env.log(`SWITCHING ${line}`)')).toBeLessThan(sw.indexOf('await env.deps.hooks?.beforeCommit'));
    expect(sw.indexOf('env.log(`LINKED ${line}`)')).toBeGreaterThan(sw.indexOf('await env.deps.hooks?.afterCommit'));
  });
  it('alerts are raised with ON CONFLICT on ops_alerts_open_unique (as raiseAlert does)', () => {
    expect(sqlMod).toContain('ON CONFLICT (scope, kind, dedup_key) WHERE resolved_at IS NULL');
  });
});

const NOW = new Date('2026-11-17T12:00:00Z');
const h = (n: number) => new Date(NOW.getTime() - n * 3600_000);
const facts = (o: Partial<EvidenceFacts>): EvidenceFacts => ({ rebuiltAt: null, reachableAt: null, lastOkAt: null, reachableAgainAt: null, observations: [], failedBackups: [], ...o });
const connect = summarizeError('connect', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

describe('D1: the override evidence rules (pure)', () => {
  it('an earlier observation 4–48 h ago counts; fresher than 4 h or older than 48 h does not', () => {
    expect(evaluateEvidence(facts({ observations: [{ at: h(5) }] }), NOW)).toMatchObject({ found: true, kind: 'observation' });
    expect(evaluateEvidence(facts({ observations: [{ at: h(3) }] }), NOW).found).toBe(false);
    expect(evaluateEvidence(facts({ observations: [{ at: h(49) }] }), NOW).found).toBe(false);
  });
  it('an observation stops counting after a 3b ok, a reachable-again, a rebuild (linked) or a refused:reachable press', () => {
    for (const o of [{ lastOkAt: h(2) }, { reachableAgainAt: h(2) }, { rebuiltAt: h(2) }, { reachableAt: h(2) }]) {
      expect(evaluateEvidence(facts({ observations: [{ at: h(5) }], ...o }), NOW).found).toBe(false);
    }
  });
  it('3b: connect-stage connection-refused/timeout rows from two runs ≥ 4 h apart, no ok since the oldest', () => {
    const rows = [{ runId: 'a', at: h(14), error: connect }, { runId: 'b', at: h(2), error: 'connect label=timeout' }];
    expect(evaluateEvidence(facts({ failedBackups: rows }), NOW)).toMatchObject({ found: true, kind: 'backups' });
    expect(evaluateEvidence(facts({ failedBackups: rows, lastOkAt: h(10) }), NOW).found).toBe(false);
    expect(evaluateEvidence(facts({ failedBackups: [rows[0], { ...rows[1], runId: 'a' }] }), NOW).found).toBe(false); // one run
    expect(evaluateEvidence(facts({ failedBackups: [rows[0], { ...rows[1], at: h(11) }] }), NOW).found).toBe(false); // 3 h apart
    expect(evaluateEvidence(facts({ failedBackups: [{ ...rows[0], error: 'upload label=connection-refused' }, rows[1]] }), NOW).found).toBe(false);
    expect(evaluateEvidence(facts({ failedBackups: [{ ...rows[0], error: 'connect label=auth-failed' }, rows[1]] }), NOW).found).toBe(false); // an auth error is not unreachable
    expect(evaluateEvidence(facts({ failedBackups: rows, rebuiltAt: h(8) }), NOW).found).toBe(false); // the older failure predates the rebuild
  });
});

describe('D3: the failure classes', () => {
  it('integrity: context, SHA, sidecar, counts, a decryption failure; infrastructure: s3/kms/connection/timeout labels, Neon 5xx/423/429/network, a stop; anything else: other', () => {
    expect(classifyRestoreFailure(new StageError('context')).kind).toBe('integrity');
    expect(classifyRestoreFailure(new StageError('sha256')).kind).toBe('integrity');
    expect(classifyRestoreFailure(new StageError('sidecar', new Error('x'))).kind).toBe('integrity');
    expect(classifyRestoreFailure(new StageError('counts', new Error('x'))).kind).toBe('integrity');
    expect(classifyRestoreFailure(new StageError('decrypt', new Error('unable to decrypt: tag mismatch'))).kind).toBe('integrity');
    expect(classifyRestoreFailure(new StageError('decrypt', Object.assign(new Error('KMS key unavailable'), { name: 'KMSInvalidStateException' }))).kind).toBe('infra');
    expect(classifyRestoreFailure(new StageError('download', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).kind).toBe('infra');
    expect(classifyRestoreFailure(new StageError('pg_restore', { exitCode: 1 }, 'pg_restore: error: connection to server failed: timeout expired')).kind).toBe('infra');
    for (const s of [500, 503, 423, 429, 0]) expect(classifyRestoreFailure(new NeonApiError('create-project', s, null)).kind, String(s)).toBe('infra');
    expect(classifyRestoreFailure(new NeonApiError('create-project', 422, 'PROJECTS_LIMIT_EXCEEDED')).kind).toBe('create');
    expect(classifyRestoreFailure(new Aborted('stopped')).kind).toBe('infra');
    expect(classifyRestoreFailure(new StageError('pg_restore', { exitCode: 1 }, 'pg_restore: error: some odd thing')).kind).toBe('other');
  });
  it('rebuilt project names stay within 40 characters and are unique per try', () => {
    const a = rebuildName('abcdef12-3456-4789-8abc-def012345678', NOW, 1);
    expect(a).toBe('cadenzpoint-r-abcdef12-20261117120000-1');
    expect(a.length).toBeLessThanOrEqual(40);
    expect(rebuildName('abcdef12-3456-4789-8abc-def012345678', NOW, 2)).not.toBe(a);
  });
  it('action times are strictly increasing within a second (no ties on "the newest row")', () => {
    const t = new Date('2030-01-01T00:00:00.000Z');
    const a = monotonicAt(t);
    const b = monotonicAt(t);
    expect(b.getTime()).toBeGreaterThan(a.getTime());
  });
});

describe('D8: network first', () => {
  const env = (results: Record<string, 'ok' | 'auth'>, tenants: Array<{ id: string; url: string }>) => ({
    cp: Object.assign(async () => [], { unsafe: async () => tenants.map((t) => ({ id: t.id, slug: 's', status: 'active', dbUrlEncrypted: t.url, neonProjectId: 'p', deletionScheduledFor: null })) }),
    deps: { controlPlaneUrl: 'postgres://cp' },
    connect: async (url: string) => ({ cls: results[url] ?? 'auth', code: null }),
  }) as unknown as StepEnv;

  it('no other database connects (every workspace and the control plane fail) → not proven; the control plane alone suffices', async () => {
    const { encrypt } = await import('@/lib/encryption');
    process.env.ENCRYPTION_KEY ??= '0'.repeat(63) + '1';
    const tenants = [{ id: 'a', url: encrypt('postgres://a') }, { id: 'b', url: encrypt('postgres://b') }];
    expect(await networkProven(env({}, tenants), 'x')).toBe(false);
    expect(await networkProven(env({ 'postgres://cp': 'ok' }, tenants), 'x')).toBe(true);
    expect(await networkProven(env({ 'postgres://b': 'ok' }, tenants), 'x')).toBe(true);
    expect(await networkProven(env({ 'postgres://a': 'ok' }, tenants), 'a')).toBe(false); // never the workspace itself
  });
});
