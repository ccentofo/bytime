import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { encrypt } from '@/lib/encryption';
import { createScratchDb, dropScratchDb, SERVER_URL } from './backup-helpers';
import { startFakePgProxy, type FakePgProxy } from '../helpers/fake-pg-proxy';
import { readDisasterFacts } from '../../../scripts/lib/disaster-records';

/**
 * feature-plan-disaster-restore.md §11 R7: the real `migrate-all` CLI with `--skip-lost` and `--check` against real
 * databases: a scratch control plane, a scratch tenant database (really migrated), and a "lost" tenant whose URL points at
 * the local Neon-proxy stand-in (28P01, as Neon answers for a deleted endpoint). Never the developer's control plane.
 */

const ROOT = path.resolve(__dirname, '../../..');
/** Async (never spawnSync): the Neon-proxy stand-in runs in this process and must keep answering while the CLI runs. */
const run = (cpUrl: string, args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn('node', ['--conditions=react-server', '--import', 'tsx', 'scripts/migrate-all.ts', ...args], {
    cwd: ROOT, env: { ...process.env, CONTROL_PLANE_DATABASE_URL: cpUrl, NEON_API_KEY: '' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

describe.skipIf(!SERVER_URL)('R7: migrate-all --skip-lost against real databases', () => {
  let cp: { name: string; url: string };
  let tenantDb: { name: string; url: string };
  let proxy: FakePgProxy;
  let sql: postgres.Sql;
  const LOST = '11111111-1111-4111-8111-111111111111';
  const LIVE = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    cp = await createScratchDb('cp', { migrateControlPlane: true });
    tenantDb = await createScratchDb('t');
    proxy = await startFakePgProxy({ kind: 'auth-fail' });
    sql = postgres(cp.url, { max: 1, onnotice: () => {} });
    const lostUrl = `postgres://neondb_owner:pw@127.0.0.1:${proxy.port}/tenant_test_dr_lost`;
    await sql`INSERT INTO tenants (id, slug, name, status, db_url_encrypted, neon_project_id) VALUES
      (${LOST}, 'test-dr-lost', 'Lost Co', 'active', ${encrypt(lostUrl)}, 'p-lost'),
      (${LIVE}, 'test-dr-live', 'Live Co', 'active', ${encrypt(tenantDb.url)}, 'p-live')`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await proxy?.close();
    if (tenantDb) await dropScratchDb(tenantDb.name);
    if (cp) await dropScratchDb(cp.name);
  });

  const actions = (kind: string) => sql<Array<{ tenantId: string; status: string; runId: string }>>`
    SELECT tenant_id::text AS "tenantId", status, run_id AS "runId" FROM disaster_actions WHERE kind = ${kind} ORDER BY at, id`;

  it('without a proof: the lost tenant fails the deploy (exit 1), as today', async () => {
    const r = await run(cp.url, []);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/test-dr-lost\s+\|\s+active\s+\|\s+FAILED/);
  }, 240_000);

  it('with a deletion-due "gone" proof and the flag: skipped by uuid (never the slug), the skip row written, exit 0; the live one migrated', async () => {
    await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, detail, at)
      VALUES ('gh-1-1', ${LOST}, 'proof', 'gone', 'p-lost', 'deletion-due', now() - interval '3 days')`;
    // A later transient refusal never supersedes the decisive proof.
    await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, at)
      VALUES ('gh-2-1', ${LOST}, 'proof', 'refused:proof-failed', 'p-lost', now() - interval '1 day')`;
    const r = await run(cp.url, ['--skip-lost']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Skipping workspaces the disaster button proved lost (--skip-lost).'); // the flag reached argv
    expect(r.stdout).toMatch(new RegExp(`${LOST}\\s+\\|\\s+active\\s+\\|\\s+skipped: skipped \\(proven lost, awaiting rebuild\\)`));
    expect(r.stdout + r.stderr).not.toContain('test-dr-lost');
    const skips = await actions('skip');
    expect(skips).toEqual([expect.objectContaining({ tenantId: LOST, status: 'skipped' })]);
    expect(skips[0].runId).toMatch(/^migrate-\d{8}T\d{6}Z$/);
  }, 240_000);

  it('--check --skip-lost: skipped, read-only (no new rows), exit 0', async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM disaster_actions`)[0].n;
    const r = await run(cp.url, ['--check', '--skip-lost']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(LOST);
    expect(r.stdout + r.stderr).not.toContain('test-dr-lost');
    expect((await sql`SELECT count(*)::int AS n FROM disaster_actions`)[0].n).toBe(before);
  }, 240_000);

  it('M10: a 3b `ok` backup that finished after the proof ends it (the facts reader\'s backup SQL, for real): not skipped, FAILED by slug', async () => {
    const LOST2 = '33333333-3333-4333-8333-333333333333';
    await sql`INSERT INTO tenants (id, slug, name, status, db_url_encrypted, neon_project_id) VALUES
      (${LOST2}, 'test-dr-lost2', 'Lost Two', 'active', ${encrypt(`postgres://neondb_owner:pw@127.0.0.1:${proxy.port}/tenant_x2`)}, 'p-lost2')`;
    try {
      await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, at) VALUES ('gh-9-1', ${LOST2}, 'proof', 'gone', 'p-lost2', now() - interval '2 days')`;
      await sql`INSERT INTO database_backups (tenant_id, target, run_id, status, target_deadline_ms, started_at, finished_at)
        VALUES (${LOST2}, 'tenant', 'test-m10', 'ok', 1800000, now() - interval '1 day', now() - interval '1 day')`;
      const r = await run(cp.url, ['--check', '--skip-lost']);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/test-dr-lost2\s+\|\s+active\s+\|\s+FAILED/);
      expect(r.stdout).toMatch(new RegExp(`${LOST}\\s+\\|\\s+active\\s+\\|\\s+skipped`)); // the other proof still holds
    } finally {
      await sql`UPDATE tenants SET status = 'deleted', db_url_encrypted = NULL WHERE id = ${LOST2}`;
    }
  }, 240_000);

  it('the lost tenant comes back: migrated under the lock (something pending), reachable-again and migrated rows written', async () => {
    // Point it at a real (empty) database: it now connects and has every migration pending, so the run takes the lock.
    const back = await createScratchDb('t');
    try {
      await sql`UPDATE tenants SET db_url_encrypted = ${encrypt(back.url)} WHERE id = ${LOST}`;
      const r = await run(cp.url, ['--skip-lost']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/test-dr-lost\s+\|\s+active\s+\|\s+migrated/);
      const proofs = await actions('proof');
      expect(proofs.at(-1)).toMatchObject({ tenantId: LOST, status: 'reachable-again' });
      expect((await actions('skip')).at(-1)).toMatchObject({ tenantId: LOST, status: 'migrated' });
      const f = (await readDisasterFacts(sql)).get(LOST)!;
      expect(f.proof?.status).toBe('reachable-again');
      // The next run: no live proof, nothing more to write.
      const again = await run(cp.url, []);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect((await actions('proof')).filter((p) => p.status === 'reachable-again')).toHaveLength(1);
    } finally {
      await sql`UPDATE tenants SET status = 'deleted', db_url_encrypted = NULL WHERE id = ${LOST}`;
      await dropScratchDb(back.name);
    }
  }, 300_000);

  it('a control plane without disaster_actions (the merge deploy) reads as "no proofs", no failure', async () => {
    const bare = await createScratchDb('cp');
    const s = postgres(bare.url, { max: 1, onnotice: () => {} });
    try {
      expect((await readDisasterFacts(s)).size).toBe(0);
    } finally {
      await s.end({ timeout: 5 });
      await dropScratchDb(bare.name);
    }
  });
});

// ---- feature-plan-control-plane-disaster.md §11 T16 -------------------------------------------------------------------
describe.skipIf(!SERVER_URL)('T16 (3c-2): the reconcile\'s new proofs are skippable; a newer linked row supersedes them', () => {
  let cp: { name: string; url: string };
  let proxy: FakePgProxy;
  let sql: postgres.Sql;
  const ids = {
    windowDeleted: '33333333-3333-4333-8333-333333333331',
    recoverableDeleted: '33333333-3333-4333-8333-333333333332',
    chainUnconfirmed: '33333333-3333-4333-8333-333333333333',
    superseded: '33333333-3333-4333-8333-333333333334',
  };

  beforeAll(async () => {
    cp = await createScratchDb('cp', { migrateControlPlane: true });
    proxy = await startFakePgProxy({ kind: 'auth-fail' });
    sql = postgres(cp.url, { max: 1, onnotice: () => {} });
    for (const [k, id] of Object.entries(ids)) {
      const url = `postgres://neondb_owner:pw@127.0.0.1:${proxy.port}/tenant_t16_${k.toLowerCase()}`;
      await sql`INSERT INTO tenants (id, slug, name, status, db_url_encrypted, neon_project_id) VALUES (${id}, ${`t16-${k.toLowerCase()}`}, 'T16', 'active', ${encrypt(url)}, ${`p-${k}`})`;
    }
    const proof = (id: string, status: string) => sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, old_project_id, detail, at)
      VALUES ('test-rc-1', ${id}, 'proof', ${status}, 'p', 'reconcile', now() - interval '2 hours')`;
    await proof(ids.windowDeleted, 'window-deleted');
    await proof(ids.recoverableDeleted, 'recoverable-deleted');
    await proof(ids.chainUnconfirmed, 'chain-unconfirmed');
    await proof(ids.superseded, 'chain-unconfirmed');
    await sql`INSERT INTO disaster_actions (run_id, tenant_id, kind, status, new_project_id, at) VALUES ('gh-5-1', ${ids.superseded}, 'rebuild', 'linked', 'p-new', now() - interval '1 hour')`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await proxy?.close();
    if (cp) await dropScratchDb(cp.name);
  });

  it('window-deleted, recoverable-deleted and chain-unconfirmed → skipped; chain-unconfirmed with a newer linked row → FAILED', async () => {
    const r = await run(cp.url, ['--skip-lost']);
    for (const id of [ids.windowDeleted, ids.recoverableDeleted, ids.chainUnconfirmed]) {
      expect(r.stdout, id).toMatch(new RegExp(`${id}\\s+\\|\\s+active\\s+\\|\\s+skipped: skipped \\(proven lost, awaiting rebuild\\)`));
    }
    expect(r.stdout).toMatch(/t16-superseded\s+\|\s+active\s+\|\s+FAILED/);
    expect(r.status).toBe(1);
  }, 240_000);
});
