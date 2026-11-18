import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

/**
 * feature-plan-database-backups.md §11 S13 (audit), S16 (probe rows from real runs), S18 (audit), S23 (the audit's
 * deadline). Scratch control plane (G2); fake store and AWS clients; `bytime_rt_test`'s server for the rt_ sweep.
 */
import { encrypt } from '@/lib/encryption';
import { RESTORE_TEST_LOCK_KEY } from '@/lib/tenant/backup-locks';
import { runAudit, type AuditDeps } from '../../../scripts/backup/audit';
import { runBackup } from '../../../scripts/backup/backup';
import { acquireLock } from '../../../scripts/backup/lib/locks';
import { withDatabase } from '../../../scripts/backup/lib/pg-url';
import { controlPlaneId } from '../../../scripts/backup/lib/keys';
import { deniedKeyClient, FakeBucket, fakeAuditClients, fakeDumpArgs, TEST_KEY_ARN, testKeyring } from '../helpers/backup-fakes';
import { adminUrl, createScratchDb, dropScratchDb, listRtDatabases, SERVER_URL } from './backup-helpers';

const DAY = 86_400_000;

describe.skipIf(!SERVER_URL)('audit', () => {
  let cp: { name: string; url: string };
  let t1: { name: string; url: string };
  let cpSql: postgres.Sql;
  let rtUrl: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE bytime_rt_test').catch((e) => { if (e.code !== '42P04') throw e; });
    await admin.end();
    rtUrl = withDatabase(SERVER_URL!, 'bytime_rt_test');
    cp = await createScratchDb('cp', { migrateControlPlane: true });
    t1 = await createScratchDb('t', { tenantSchema: true });
    cpSql = postgres(cp.url, { max: 2, onnotice: () => {} });
    await cpSql`INSERT INTO tenants (slug, name, status, db_url_encrypted) VALUES ('test-lc-a', 'A', 'active', ${encrypt(t1.url)})`;
  }, 60_000);
  afterAll(async () => {
    await cpSql?.end({ timeout: 5 });
    for (const d of [cp, t1]) if (d) await dropScratchDb(d.name);
  });
  beforeEach(async () => {
    await cpSql`DELETE FROM backup_audits`;
    await cpSql`DELETE FROM backup_permission_checks`;
  });

  function deps(o: Partial<AuditDeps> = {}) {
    const bucket = new FakeBucket();
    const f = fakeAuditClients();
    const lines: string[] = [];
    const d: AuditDeps = {
      controlPlaneUrl: cp.url, restoreTestUrl: rtUrl, reader: bucket, store: bucket, clients: f.clients, keyClient: deniedKeyClient(),
      keyArn: TEST_KEY_ARN, runId: `test-${randomUUID().slice(0, 8)}`, log: (l) => lines.push(l), hostGuardOverride: true, ...o,
    };
    return { d, bucket, f, lines };
  }
  const auditRow = async (runId: string) => (await cpSql`SELECT * FROM backup_audits WHERE run_id = ${runId}`)[0];

  it('S13: the row\'s fields', async () => {
    const { d, bucket, f } = deps();
    const now = Date.now();
    bucket.objects.set('v1/c/tenant/a/2026/10/01/r-old.dump.enc', { bytes: Buffer.alloc(100), lastModified: new Date(now - 30 * DAY) });
    bucket.objects.set('v1/c/tenant/a/2026/11/15/r-new.dump.enc', { bytes: Buffer.alloc(50), lastModified: new Date(now - DAY) });
    f.state.uploads = [{ key: 'v1/x', initiated: new Date(now - 5 * DAY) }, { key: 'v1/y', initiated: new Date(now - DAY) }];
    expect((await runAudit(d)).exitCode).toBe(0);
    const row = await auditRow(d.runId);
    expect(row).toMatchObject({
      oldest_key: 'v1/c/tenant/a/2026/10/01/r-old.dump.enc', objects_over_29_days: 1, total_objects: 2, total_bytes: '150',
      versioning_status: '', stale_uploads: 1, kms_key_state: 'Enabled', alert_email_confirmed: true, protection_drift: null,
      leftover_test_dbs: 0, stuck_test_dbs: 0, errors: null,
    });
    const [probe] = await cpSql`SELECT role, ok, detail FROM backup_permission_checks WHERE run_id = ${d.runId}`;
    expect(probe).toMatchObject({ role: 'audit', ok: true, detail: { head_newest_object: 'denied', kms_decrypt: 'skipped', delete_object: 'denied' } });
  });

  it('S13: one throwing check → `errors` set, its column null or `error`, and the row still inserted; an unconfirmed email', async () => {
    const { d, f } = deps();
    f.state.throwOn.add('versioning');
    f.state.throwOn.add('key-state');
    f.state.subscriptions = [{ arn: 'PendingConfirmation', protocol: 'email' }];
    expect((await runAudit(d)).exitCode).toBe(0);
    const row = await auditRow(d.runId);
    expect(row.versioning_status).toBeNull();
    expect(row.kms_key_state).toBe('error');
    expect(row.alert_email_confirmed).toBe(false);
    expect(row.errors).toBe('versioning label=s3-error; key-state label=s3-error');
  });

  it('S13: leftover rt_ databases older than 1 h with no session are dropped and counted; newer ones and ones with a session are left', async () => {
    const admin = postgres(rtUrl, { max: 1, onnotice: () => {} });
    const fresh = `rt_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_auditnew`;
    await admin.unsafe('CREATE DATABASE rt_20200101000000_auditold');
    await admin.unsafe('CREATE DATABASE rt_20200101000000_auditbsy');
    await admin.unsafe(`CREATE DATABASE "${fresh}"`);
    const busy = postgres(withDatabase(SERVER_URL!, 'rt_20200101000000_auditbsy'), { max: 1 });
    await busy`SELECT 1`;
    try {
      const { d } = deps();
      expect((await runAudit(d)).exitCode).toBe(0);
      const row = await auditRow(d.runId);
      expect(row.leftover_test_dbs).toBe(1);
      expect(row.stuck_test_dbs).toBe(1); // the busy one is older than 24 h and couldn't be dropped
      expect((await listRtDatabases()).sort()).toEqual([fresh, 'rt_20200101000000_auditbsy'].sort());
    } finally {
      await busy.end();
      for (const n of [fresh, 'rt_20200101000000_auditbsy', 'rt_20200101000000_auditold']) await admin.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('S13: with RESTORE_TEST_LOCK_KEY held by another connection → nothing dropped, leftover_test_dbs null', async () => {
    const admin = postgres(rtUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE rt_20200101000000_auditlck');
    const held = (await acquireLock(cp.url, RESTORE_TEST_LOCK_KEY))!;
    try {
      const { d } = deps();
      expect((await runAudit(d)).exitCode).toBe(0);
      const row = await auditRow(d.runId);
      expect(row.leftover_test_dbs).toBeNull();
      expect(row.stuck_test_dbs).toBeNull();
      expect(await listRtDatabases()).toContain('rt_20200101000000_auditlck');
    } finally {
      await held.release();
      await admin.unsafe('DROP DATABASE IF EXISTS rt_20200101000000_auditlck');
      await admin.end();
    }
  });

  it('S13: drift is recorded in protection_drift', async () => {
    const { d, f } = deps();
    f.state.logging = false;
    await runAudit(d);
    expect((await auditRow(d.runId)).protection_drift).toBe('trail:not-logging');
  });

  it('S16: a real backup run stores its data key; the next audit probes kms:Decrypt with it (denied → ok); one ALLOWED → ok false', async () => {
    const bucket = new FakeBucket();
    const backupRun = `test-${randomUUID().slice(0, 8)}`;
    const r = await runBackup({
      controlPlaneUrl: cp.url, cpId: controlPlaneId(cp.url), store: bucket, keyring: testKeyring(), keyClient: deniedKeyClient(), pgDumpBin: 'unused', pgDumpVersion: 'x',
      runId: backupRun, log: () => {}, hooks: { dumpCommand: () => ({ bin: process.execPath, args: fakeDumpArgs({}) }) },
    });
    expect(r.exitCode).toBe(0);
    const [b] = await cpSql<Array<{ ok: boolean; detail: Record<string, unknown> }>>`SELECT ok, detail FROM backup_permission_checks WHERE run_id = ${backupRun}`;
    expect(b.ok).toBe(true);
    expect(b.detail).toMatchObject({ head_own_object: 'denied', kms_decrypt: 'denied', kms_reencrypt: 'denied', put_without_if_none_match: 'denied', delete_object: 'denied' });
    expect(typeof b.detail.edk).toBe('string');
    expect(b.detail.edk_context).toMatchObject({ purpose: 'cadenzpoint-backup', kind: 'dump' });

    const key = deniedKeyClient();
    const { d } = deps({ keyClient: key });
    await runAudit(d);
    const [a] = await cpSql<Array<{ ok: boolean; detail: Record<string, unknown> }>>`SELECT ok, detail FROM backup_permission_checks WHERE run_id = ${d.runId}`;
    expect(a).toMatchObject({ ok: true, detail: { kms_decrypt: 'denied' } });
    expect(key.calls).toEqual(['decrypt']);

    const allow = deps({ keyClient: { decrypt: async () => {}, reEncrypt: async () => {} } });
    await runAudit(allow.d);
    const [c] = await cpSql<Array<{ ok: boolean; detail: Record<string, unknown> }>>`SELECT ok, detail FROM backup_permission_checks WHERE run_id = ${allow.d.runId}`;
    expect(c).toMatchObject({ ok: false, detail: { kms_decrypt: 'ALLOWED' } });
    await cpSql`DELETE FROM database_backups`;
  }, 30_000);

  it('S23: the audit stops at its (shortened) deadline and still inserts its row; exit 1', async () => {
    const { d, f } = deps({ deadlineMs: 200 });
    f.clients.key.state = () => new Promise<string>(() => {}); // a hung AWS call
    const r = await runAudit(d);
    expect(r.exitCode).toBe(1);
    const row = await auditRow(d.runId);
    expect(row.errors).toBe('deadline');
    expect(row.versioning_status).toBe('');
    expect(row.kms_key_state).toBeNull();
  });

  it('S18: backup tables missing → "run deploy-prod first"', async () => {
    const bare = await createScratchDb('cp');
    try {
      await expect(runAudit({ ...deps().d, controlPlaneUrl: bare.url })).rejects.toThrow('backup tables missing: run deploy-prod first');
    } finally {
      await dropScratchDb(bare.name);
    }
  });
});
