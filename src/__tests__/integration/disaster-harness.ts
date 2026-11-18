/**
 * The disaster suites' world (feature-plan-disaster-restore.md §11 "Without Neon or AWS"): a scratch control plane, one
 * scratch "original" tenant database, N throwaway tenants backed up for real by 3b's runBackup (real pg_dump 16, the
 * fake bucket, the raw AES keyring), a fake Neon API whose projects carry Neon-shaped hosts mapped (test-only host map)
 * to the local server, and the local Neon-proxy stand-in (28P01) for gone endpoints. Never the developer's control
 * plane, never acme/globex/initech, never a remote database.
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { encrypt } from '@/lib/encryption';
import { runBackup } from '../../../scripts/backup/backup';
import { runDisaster, type DisasterArgs, type DisasterDeps } from '../../../scripts/backup/disaster';
import { neonApi } from '../../../scripts/backup/lib/neon-api';
import { parseBackupLine, type BackupLine, type LogReader } from '../../../scripts/backup/lib/log-reader';
import type { DisasterEcs, EcsTaskInfo } from '../../../scripts/backup/lib/aws-clients';
import { controlPlaneId } from '../../../scripts/backup/lib/keys';
import { FakeBucket, testKeyring } from '../helpers/backup-fakes';
import { startFakeNeon, fakeHost, poolerOf, type FakeNeon } from '../helpers/fake-neon';
import { startFakePgProxy, type FakePgProxy } from '../helpers/fake-pg-proxy';
import { createScratchDb, dropScratchDb, SERVER_URL } from './backup-helpers';

export const PG_DUMP = process.env.BACKUP_PG_DUMP_BIN;
export const PG_RESTORE = process.env.BACKUP_PG_RESTORE_BIN;
if (process.env.REQUIRE_PG16_TOOLS === '1' && (!PG_DUMP || !PG_RESTORE)) throw new Error('REQUIRE_PG16_TOOLS=1 but BACKUP_PG_DUMP_BIN / BACKUP_PG_RESTORE_BIN are not set');
export const CAN_RUN = Boolean(SERVER_URL && PG_DUMP && PG_RESTORE);

export interface WorldTenant {
  id: string;
  slug: string;
  projectId: string;
  host: string;
  url: string;
}

export interface World {
  cp: { name: string; url: string };
  cpSql: postgres.Sql;
  original: { name: string; url: string };
  bucket: FakeBucket;
  neon: FakeNeon;
  proxy: FakePgProxy;
  lines: BackupLine[];
  tenants: WorldTenant[];
  cpId: string;
  restoreTestProjectId: string;
  controlPlaneProjectId: string;
  close(): Promise<void>;
}

/** A Neon-shaped URL for a local database: the fake host is mapped to the local server. */
function onFakeHost(localUrl: string, host: string): string {
  const u = new URL(localUrl);
  u.hostname = poolerOf(host);
  u.port = '';
  return u.toString();
}

/**
 * Builds the world; if any step fails part-way, everything already created is torn down before the error is rethrown
 * (fix round 1, FR4: mutated runs used to leak scratch databases).
 */
export async function createWorld(n: number, prefix: string): Promise<World> {
  const undo: Array<() => Promise<unknown>> = [];
  try {
    return await buildWorld(n, prefix, undo);
  } catch (e) {
    for (const u of undo.reverse()) await u().catch(() => {});
    throw e;
  }
}

async function buildWorld(n: number, prefix: string, undo: Array<() => Promise<unknown>>): Promise<World> {
  const cp = await createScratchDb('cp', { migrateControlPlane: true });
  undo.push(() => dropScratchDb(cp.name));
  const original = await createScratchDb('t', { tenantSchema: true });
  undo.push(() => dropScratchDb(original.name));
  const cpSql = postgres(cp.url, { max: 3, onnotice: () => {} });
  undo.push(() => cpSql.end({ timeout: 5 }));
  const proxy = await startFakePgProxy({ kind: 'auth-fail' });
  undo.push(() => proxy.close());
  const neon = await startFakeNeon({ serverUrl: SERVER_URL!, createDatabases: true, proxy: { host: proxy.host, port: proxy.port } });
  undo.push(() => neon.close());
  const tenants: WorldTenant[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const slug = `${prefix}-${i}`;
    await cpSql`INSERT INTO tenants (id, slug, name, status, db_url_encrypted) VALUES (${id}, ${slug}, ${'Test ' + slug}, 'active', ${encrypt(original.url)})`;
    tenants.push({ id, slug, projectId: '', host: '', url: '' });
  }
  // Real 3b backups of every tenant (each points at the same original database): two runs, the second newer, so every
  // tenant has an older backup to fall back to.
  const bucket = new FakeBucket();
  const logs: string[] = [];
  for (let run = 0; run < 2; run++) {
    const r = await runBackup({
      controlPlaneUrl: cp.url, store: bucket, keyring: testKeyring(), pgDumpBin: PG_DUMP!, pgDumpVersion: 'pg_dump (PostgreSQL) 16',
      runId: `test-${randomUUID().slice(0, 8)}`, log: (l) => logs.push(l),
    });
    if (r.exitCode !== 0) throw new Error(`the setup backup failed: ${logs.join('\n')}`);
    bucket.ageAll(2 * 60 * 60_000);
  }
  const lines = logs.map((l) => parseBackupLine(l)).filter((l): l is BackupLine => l !== null);
  // Now give each tenant its own original Neon project on its own Neon-shaped host.
  for (const t of tenants) {
    const host = fakeHost();
    const p = neon.addProject({ name: `cadenzpoint-${t.slug}`, host });
    t.projectId = p.id;
    t.host = host;
    t.url = onFakeHost(original.url, host);
    await cpSql`UPDATE tenants SET db_url_encrypted = ${encrypt(t.url)}, neon_project_id = ${p.id} WHERE id = ${t.id}`;
  }
  const rt = neon.addProject({ name: 'cadenzpoint-restore-test' });
  const cpp = neon.addProject({ name: 'cadenzpoint-control-plane' });
  return {
    cp, cpSql, original, bucket, neon, proxy, lines, tenants, cpId: controlPlaneId(cp.url),
    restoreTestProjectId: rt.id, controlPlaneProjectId: cpp.id,
    async close() {
      await cpSql.end({ timeout: 5 });
      await neon.close();
      await proxy.close();
      await dropScratchDb(original.name);
      await dropScratchDb(cp.name);
    },
  };
}

/** Short enough for tests, long enough not to drop a lock under a loaded runner (timing fix: was 200 ms / 1 s). */
export const FAST_LOCK = { heartbeatMs: 500, heartbeatTimeoutMs: 10_000 };

export function fakeEcs(o: { startedBy?: string; others?: EcsTaskInfo[] } = {}): DisasterEcs {
  const self: EcsTaskInfo = { taskArn: 'arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/self', startedBy: o.startedBy ?? 'gh-1-1', createdAt: new Date('2026-11-17T12:00:00Z') };
  return { self: async () => self, running: async () => [self, ...(o.others ?? [])] };
}

export function fakeLogReader(lines: BackupLine[], fail = false): LogReader {
  return { async backupLines(cp, id) { if (fail) throw new Error('logs down'); return lines.filter((l) => l.cp === cp && l.id === id); } };
}

export interface RunCapture {
  logs: string[];
  emails: Array<{ subject: string; message: string }>;
}

export function deps(w: World, cap: RunCapture, over: Partial<DisasterDeps> = {}): DisasterDeps {
  return {
    controlPlaneUrl: w.cp.url,
    neon: neonApi({ apiKey: w.neon.apiKey, orgId: w.neon.orgId, baseUrl: w.neon.url, sleep: async () => {}, operationPollMs: 1 }),
    ecs: fakeEcs(),
    logReader: fakeLogReader(w.lines),
    reader: w.bucket,
    keyring: testKeyring(),
    publish: async (subject, message) => { cap.emails.push({ subject, message }); },
    pgRestoreBin: PG_RESTORE!,
    regionId: 'aws-us-east-1',
    restoreTestProjectId: w.restoreTestProjectId,
    controlPlaneProjectId: w.controlPlaneProjectId,
    log: (l) => cap.logs.push(l),
    hostMap: w.neon.hostMap,
    lockTiming: FAST_LOCK,
    lockWaitMs: 10_000,
    lockRetryMs: 100,
    timing: { recoverablePolls: 2, recoverablePollMs: 5, overrideGapMs: 5, lockRetryMs: 20, cleanupRetryMs: 20 },
    hardExit: () => { throw new Error('hard exit must not fire in tests'); },
    ...over,
  };
}

export async function press(w: World, args: Partial<DisasterArgs> & Pick<DisasterArgs, 'targets'>, over: Partial<DisasterDeps> = {}) {
  const cap: RunCapture = { logs: [], emails: [] };
  const a: DisasterArgs = { mode: 'workspace', override: 'none', runId: `gh-${randomUUID().slice(0, 6)}-1`, ...args };
  const r = await runDisaster(a, deps(w, cap, over));
  return { ...r, ...cap, args: a };
}

/** Make a tenant's original project gone: removed from Neon entirely (past recovery), its host now the 28P01 proxy. */
export function makeGone(w: World, t: WorldTenant): void {
  w.neon.purge(t.projectId);
}

export async function tenantRow(w: World, id: string) {
  const [r] = await w.cpSql<Array<{ dbUrlEncrypted: string | null; neonProjectId: string | null; lifecycleVersion: number; updatedAt: Date }>>`
    SELECT db_url_encrypted AS "dbUrlEncrypted", neon_project_id AS "neonProjectId", lifecycle_version AS "lifecycleVersion", updated_at AS "updatedAt" FROM tenants WHERE id = ${id}`;
  return r;
}

export async function actions(w: World, tenantId: string) {
  return w.cpSql<Array<{ kind: string; status: string; newProjectId: string | null; projectName: string | null; detail: string | null; oldProjectId: string | null }>>`
    SELECT kind, status, new_project_id AS "newProjectId", project_name AS "projectName", detail, old_project_id AS "oldProjectId" FROM disaster_actions WHERE tenant_id = ${tenantId} ORDER BY at, id`;
}
