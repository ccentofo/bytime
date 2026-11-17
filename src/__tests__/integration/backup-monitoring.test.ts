import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, gte, inArray, isNull, like } from 'drizzle-orm';

/**
 * feature-plan-database-backups.md §11 S9: syncBackupAlerts(now, filter) with BACKUPS_EXPECTED=1 raises every §6.9
 * finding and resolves it; `0` syncs nothing and resolves. Uses the app's control plane (G2 allows S9/U9/U10), with
 * `test-lc-*` tenants and `test-s9-` run ids only, and cleans up after itself.
 *
 * FR11 (documented, not scoped): GLOBAL backup alerts have no tenant to filter by, so the sync here resolves every open
 * global backup alert, and the cleanup deletes global backup alerts first seen after this file started. This suite runs
 * only against a developer or CI control plane, which never holds real backup alerts (production's live in Neon and
 * are never reachable from tests: no test reads a remote database).
 */
import { controlDb } from '@/db/control-plane';
import { backupAudits, backupPermissionChecks, databaseBackups, opsAlerts, restoreTestResults, restoreTestRuns } from '@/db/control-plane/schema';
import { backupDigest, FINDING_KINDS, syncBackupAlerts } from '@/lib/tenant/backup-status';
import { cleanupLifecycleTenants, cpReady, makeTenant, setTenant, type TenantRow } from './lifecycle-helpers';

const H = 3600_000;
const D = 24 * H;
const PREFIX = 'test-s9-';

describe.skipIf(!cpReady)('S9: the backup alert sync', () => {
  const start = new Date();
  const extraScope = { id: '' };
  let a: TenantRow;
  let b: TenantRow;
  const now = () => new Date();
  const ago = (ms: number) => new Date(Date.now() - ms);

  const cleanRows = async () => {
    await controlDb.delete(restoreTestRuns).where(like(restoreTestRuns.runId, `${PREFIX}%`));
    await controlDb.delete(databaseBackups).where(like(databaseBackups.runId, `${PREFIX}%`));
    await controlDb.delete(backupAudits).where(like(backupAudits.runId, `${PREFIX}%`));
    await controlDb.delete(backupPermissionChecks).where(like(backupPermissionChecks.runId, `${PREFIX}%`));
    await controlDb.delete(opsAlerts).where(and(eq(opsAlerts.scope, 'global'), inArray(opsAlerts.kind, [...FINDING_KINDS, 'backup-check-failed']), gte(opsAlerts.firstSeenAt, start)));
  };
  beforeAll(async () => {
    await cleanupLifecycleTenants();
    await cleanRows();
    a = await makeTenant({ slug: `test-lc-s9a-${Date.now() % 100000}`, status: 'active' });
    b = await makeTenant({ slug: `test-lc-s9b-${Date.now() % 100000}`, status: 'active' });
    await setTenant(a.id, { createdAt: ago(60 * D) });
    await setTenant(b.id, { createdAt: ago(200 * D) });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanRows();
    await cleanupLifecycleTenants();
  });

  const backup = (o: Partial<typeof databaseBackups.$inferInsert>) => controlDb.insert(databaseBackups).values({
    target: o.tenantId ? 'tenant' : 'control-plane', runId: `${PREFIX}r`, status: 'ok', region: 'us-east-1', targetDeadlineMs: 30 * 60_000,
    startedAt: ago(H + 60_000), finishedAt: ago(H), ...o,
  });
  const filter = () => ({ tenantIds: [a.id, b.id], runIdPrefix: PREFIX });
  const openKinds = async () => (await controlDb.select({ kind: opsAlerts.kind, scope: opsAlerts.scope, dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
    .where(and(isNull(opsAlerts.resolvedAt), inArray(opsAlerts.kind, [...FINDING_KINDS]), gte(opsAlerts.lastSeenAt, start))))
    .filter((x) => x.scope === 'global' || x.scope === a.id || x.scope === b.id || x.scope === extraScope.id);

  it('raises every finding from a bad state', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    // Control plane: first ok 40 days ago; latest ok 30 h ago from a 5-hour run; the newest row failed, in us-east-2.
    await backup({ runId: `${PREFIX}first`, startedAt: ago(40 * D + H), finishedAt: ago(40 * D) });
    await backup({ runId: `${PREFIX}slow`, tenantId: a.id, startedAt: ago(41 * H), finishedAt: ago(40 * H) });
    await backup({ runId: `${PREFIX}slow`, startedAt: ago(31 * H), finishedAt: ago(30 * H) });
    await backup({ runId: `${PREFIX}slow`, tenantId: a.id, status: 'failed', error: 'dump exit=1 label=other', startedAt: ago(30 * H), finishedAt: ago(30 * H - 1000), region: null });
    await backup({ runId: `${PREFIX}late`, status: 'failed', error: 'connect label=timeout', region: 'us-east-2', startedAt: ago(2 * H), finishedAt: ago(2 * H - 1000) });
    // B: a recent but slow ok backup (20 min of a 30 min deadline), first ok 100 days ago, never passed a restore test.
    await backup({ runId: `${PREFIX}first`, tenantId: b.id, startedAt: ago(100 * D + H), finishedAt: ago(100 * D) });
    await backup({ runId: `${PREFIX}b`, tenantId: b.id, startedAt: ago(2 * H + 20 * 60_000), finishedAt: ago(2 * H) });
    // The audit: 13 h old and unhappy everywhere.
    await controlDb.insert(backupAudits).values({ runId: `${PREFIX}audit`, runAt: ago(13 * H), objectsOver29Days: 1, totalObjects: 10, totalBytes: 100, versioningStatus: 'Enabled',
      staleUploads: 0, kmsKeyState: 'Disabled', alertEmailConfirmed: false, protectionDrift: 'bucket-policy:DenyDeletes', leftoverTestDbs: 1, stuckTestDbs: 0, errors: 'versioning label=s3-error' });
    // Restore tests: a slow completed pass 10 days ago; then a guard failure.
    const [old] = await controlDb.insert(restoreTestRuns).values({ runId: `${PREFIX}rt-old`, startedAt: ago(10 * D), finishedAt: ago(10 * D - 5 * H), status: 'pass', planned: 1, deadlineMs: 6 * H, targetDeadlineMs: 2 * H }).returning();
    await controlDb.insert(restoreTestResults).values({ testRunId: old.id, runId: `${PREFIX}rt-old`, target: 'control-plane', result: 'PASS', durationMs: 1000, testedAt: ago(10 * D - 5 * H) });
    await controlDb.insert(restoreTestRuns).values({ runId: `${PREFIX}rt-guard`, startedAt: ago(H), finishedAt: ago(H), status: 'fail', deadlineMs: 6 * H, targetDeadlineMs: 2 * H, detail: 'guard: pooled host' });
    await controlDb.insert(backupPermissionChecks).values({ runId: `${PREFIX}p`, role: 'backup', checkedAt: ago(H), ok: false, detail: { delete_object: 'ALLOWED' } });

    const r = await syncBackupAlerts(now(), filter());
    expect(r.synced).toBe(true);
    const open = await openKinds();
    expect(new Set(open.map((x) => x.kind))).toEqual(new Set(FINDING_KINDS));
    expect(open.find((x) => x.kind === 'backup-failed' && x.scope === 'global')?.dedupKey).toBe('control-plane');
    expect(open.find((x) => x.kind === 'backup-stale')?.scope).toBe(a.id);
    expect(open.find((x) => x.kind === 'restore-test-coverage')?.scope).toBe(b.id);
    expect(open.find((x) => x.kind === 'backup-permission-drift')?.dedupKey).toBe('backup');
    // A second sync bumps, never duplicates.
    await syncBackupAlerts(now(), filter());
    expect((await openKinds()).length).toBe(open.length);
  });

  it('resolves every finding once the state is healthy', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    await backup({ runId: `${PREFIX}good`, tenantId: a.id, startedAt: ago(30 * 60_000 + 60_000), finishedAt: ago(30 * 60_000) });
    await backup({ runId: `${PREFIX}good`, tenantId: b.id, startedAt: ago(29 * 60_000 + 60_000), finishedAt: ago(29 * 60_000) });
    await backup({ runId: `${PREFIX}good`, startedAt: ago(28 * 60_000 + 60_000), finishedAt: ago(28 * 60_000) });
    await controlDb.insert(backupAudits).values({ runId: `${PREFIX}audit2`, runAt: ago(60_000), objectsOver29Days: 0, totalObjects: 10, totalBytes: 100, versioningStatus: '',
      staleUploads: 0, kmsKeyState: 'Enabled', alertEmailConfirmed: true, protectionDrift: null, leftoverTestDbs: 0, stuckTestDbs: 0, errors: null });
    const [run] = await controlDb.insert(restoreTestRuns).values({ runId: `${PREFIX}rt-good`, startedAt: ago(20 * 60_000), finishedAt: ago(10 * 60_000), status: 'pass', planned: 2, deadlineMs: 6 * H, targetDeadlineMs: 2 * H }).returning();
    await controlDb.insert(restoreTestResults).values([
      { testRunId: run.id, runId: `${PREFIX}rt-good`, target: 'control-plane', result: 'PASS', durationMs: 1000, testedAt: ago(10 * 60_000) },
      { testRunId: run.id, runId: `${PREFIX}rt-good`, target: 'tenant', tenantId: b.id, result: 'PASS', durationMs: 1000, testedAt: ago(10 * 60_000) },
    ]);
    await controlDb.insert(backupPermissionChecks).values({ runId: `${PREFIX}p2`, role: 'backup', checkedAt: ago(60_000), ok: true, detail: {} });
    // The 10-day-old guard failure and the leftover counts are older than the new rows; the leftover rule looks back 7 days.
    await controlDb.delete(restoreTestRuns).where(eq(restoreTestRuns.runId, `${PREFIX}rt-guard`));

    await syncBackupAlerts(now(), filter());
    expect(await openKinds()).toEqual([]);
    const digest = await backupDigest(now(), { BACKUPS_EXPECTED: '1' });
    expect(digest.news).toBe(false);
    expect(digest.lines[1]).toMatch(/^Last restore test \d{4}-\d{2}-\d{2}: pass, control plane \+ 1 workspaces\.$/);
  });

  it('BACKUPS_EXPECTED=0 → nothing synced, and open backup alerts are resolved', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    await backup({ runId: `${PREFIX}bad2`, tenantId: a.id, status: 'failed', error: 'x', startedAt: ago(1000), finishedAt: now() });
    await syncBackupAlerts(now(), filter());
    expect((await openKinds()).map((x) => x.kind)).toContain('backup-failed');
    vi.stubEnv('BACKUPS_EXPECTED', '0');
    expect(await syncBackupAlerts(now(), filter())).toEqual({ synced: false, findings: 0 });
    expect(await openKinds()).toEqual([]);
  });

  describe('FR10: the facts read through the database', () => {
    let c: TenantRow;
    beforeAll(async () => {
      c = await makeTenant({ slug: `test-lc-s9c-${Date.now() % 100000}`, status: 'active' });
      extraScope.id = c.id;
      await setTenant(c.id, { createdAt: ago(60 * D) });
    });

    const restoreAt = async (testedAgo: number, durationMs: number) => {
      const [run] = await controlDb.insert(restoreTestRuns).values({ runId: `${PREFIX}win-${testedAgo}`, startedAt: ago(testedAgo + H), finishedAt: ago(testedAgo), status: 'pass', planned: 2, deadlineMs: 6 * H, targetDeadlineMs: 2 * H }).returning();
      await controlDb.insert(restoreTestResults).values([
        { testRunId: run.id, runId: run.runId, target: 'control-plane', result: 'PASS', durationMs: 1000, testedAt: ago(testedAgo) },
        { testRunId: run.id, runId: run.runId, target: 'tenant', tenantId: c.id, result: 'PASS', durationMs, testedAt: ago(testedAgo) },
      ]);
      return run.id;
    };

    it('the restore half of backup-target-slow looks back 14 days only', async () => {
      vi.stubEnv('BACKUPS_EXPECTED', '1');
      await backup({ runId: `${PREFIX}c-ok`, tenantId: c.id, startedAt: ago(H + 60_000), finishedAt: ago(H) });
      const old = await restoreAt(15 * D, 61 * 60_000);
      await syncBackupAlerts(now(), { tenantIds: [c.id], runIdPrefix: PREFIX });
      expect((await openKinds()).filter((x) => x.scope === c.id).map((x) => x.kind)).not.toContain('backup-target-slow');
      await controlDb.delete(restoreTestRuns).where(eq(restoreTestRuns.id, old));
      await restoreAt(13 * D, 61 * 60_000);
      await syncBackupAlerts(now(), { tenantIds: [c.id], runIdPrefix: PREFIX });
      expect((await openKinds()).filter((x) => x.scope === c.id).map((x) => x.kind)).toContain('backup-target-slow');
    });

    it('alerts of a workspace that is no longer live are resolved ("workspace no longer live")', async () => {
      vi.stubEnv('BACKUPS_EXPECTED', '1');
      expect((await openKinds()).some((x) => x.scope === c.id)).toBe(true);
      await setTenant(c.id, { status: 'deleting' });
      await syncBackupAlerts(now(), { tenantIds: [c.id], runIdPrefix: PREFIX });
      expect((await openKinds()).some((x) => x.scope === c.id)).toBe(false);
      const [resolved] = await controlDb.select({ note: opsAlerts.resolutionNote }).from(opsAlerts).where(and(eq(opsAlerts.scope, c.id), eq(opsAlerts.kind, 'backup-target-slow')));
      expect(resolved.note).toBe('workspace no longer live');
      await setTenant(c.id, { status: 'active' });
    });

    it('the digest: 26 h freshness, and the "last restore test" line from completed runs only', async () => {
      vi.stubEnv('BACKUPS_EXPECTED', '1');
      // Only this file's rows can make the lines deterministic: the digest reads everything, so assert relative facts.
      await backup({ runId: `${PREFIX}c-fresh`, tenantId: c.id, startedAt: ago(27 * H + 60_000), finishedAt: ago(27 * H) });
      await controlDb.delete(databaseBackups).where(and(eq(databaseBackups.tenantId, c.id), eq(databaseBackups.runId, `${PREFIX}c-ok`)));
      const before = (await backupDigest(now(), { BACKUPS_EXPECTED: '1' })).lines[0];
      await backup({ runId: `${PREFIX}c-fresh2`, tenantId: c.id, startedAt: ago(25 * H + 60_000), finishedAt: ago(25 * H) });
      const after = (await backupDigest(now(), { BACKUPS_EXPECTED: '1' })).lines[0];
      const fresh = (l: string) => Number(/^(\d+) of/.exec(l)![1]);
      expect(fresh(after)).toBe(fresh(before) + 1);
      // A newer running run and a newer guard failure don't replace the last completed run in the line.
      await controlDb.insert(restoreTestRuns).values([
        { runId: `${PREFIX}rt-running`, startedAt: ago(10 * 60_000), status: 'running', planned: 3, deadlineMs: 6 * H, targetDeadlineMs: 2 * H },
        { runId: `${PREFIX}rt-guard2`, startedAt: ago(5 * 60_000), finishedAt: ago(5 * 60_000), status: 'fail', deadlineMs: 6 * H, targetDeadlineMs: 2 * H, detail: 'guard: pooled host' },
      ]);
      const line = (await backupDigest(now(), { BACKUPS_EXPECTED: '1' })).lines[1];
      expect(line).toMatch(/: pass, control plane \+ 1 workspaces\.$/);
    });
  });
});
