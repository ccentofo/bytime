import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-database-backups.md §11 U3 (backupFindings: every §6.9 row raised and cleared, plus the named cases),
 * U9 (the digest's Backups section), U10 (the route step: a throw raises backup-check-failed; monitoring off resolves).
 */

const h = vi.hoisted(() => ({
  raised: [] as Array<{ tenantId: string | null; kind: string; dedupKey?: string }>,
  resolved: [] as Array<{ tenantId: string | null; kind: string }>,
  prefixResolved: [] as string[][],
  lockedThrows: false,
  failNextLocked: 0,
  sends: [] as Array<{ html: string; subject: string }>,
  digest: { lines: [] as string[], news: false },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane/locked', () => ({
  withLockedPool: async (fn: (db: unknown) => unknown) => {
    if (h.lockedThrows) throw new Error('connect ECONNREFUSED');
    if (h.failNextLocked > 0) { h.failNextLocked--; throw new Error('db down'); }
    const empty = (): unknown => new Proxy(() => {}, { get: (_t, k) => (k === 'then' ? (r: (v: unknown[]) => void) => r([]) : () => empty()) });
    return fn({ select: () => empty(), selectDistinctOn: () => empty(), update: () => empty(), insert: () => empty() });
  },
}));
vi.mock('@/lib/tenant/lifecycle-store', () => ({
  raiseAlert: async (_db: unknown, a: { tenantId: string | null; kind: string; dedupKey?: string }) => { h.raised.push(a); return { opened: true }; },
  resolveAlert: async (_db: unknown, a: { tenantId: string | null; kind: string }) => { h.resolved.push(a); },
  resolveAlertsByKindPrefix: async (_db: unknown, prefixes: string[]) => { h.prefixResolved.push(prefixes); },
}));

import {
  backupDigest, backupFindings, backupsExpected, runBackupMonitoring, syncBackupAlerts, FINDING_KINDS,
  type BackupFacts, type BackupRowFact, type RestoreRunFact,
} from '@/lib/tenant/backup-status';

const NOW = new Date('2026-11-16T13:00:00Z');
const H = 3600_000;
const D = 24 * H;
const W = 7 * D;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function row(o: Partial<BackupRowFact> = {}): BackupRowFact {
  return { tenantId: null, runId: 'ecs-1', status: 'ok', region: 'us-east-1', targetDeadlineMs: 30 * 60_000, error: null, startedAt: ago(6 * H + 5 * 60_000), finishedAt: ago(6 * H), ...o };
}
function run(o: Partial<RestoreRunFact> = {}): RestoreRunFact {
  return { id: 'r1', status: 'pass', planned: 2, sweptTestDbs: 0, deadlineMs: 6 * H, targetDeadlineMs: 2 * H, detail: null, startedAt: ago(2 * D), finishedAt: ago(2 * D - H), resultCount: 2, stoppedOrNotReached: false, ...o };
}

/** A healthy state: everything recent, every check clean. */
function healthy(): BackupFacts {
  const t = 't-1';
  return {
    tenants: [{ id: t, slug: 'acme-test', status: 'active', hasUrl: true, createdAt: ago(60 * D) }],
    latestRow: new Map([[null, row()], [t, row({ tenantId: t })]]),
    latestOk: new Map([[null, row()], [t, row({ tenantId: t })]]),
    latestWithRegion: new Map([[null, row()], [t, row({ tenantId: t })]]),
    firstOk: new Map([[null, ago(30 * D)], [t, ago(30 * D)]]),
    latestCpRunSpan: { startedAt: ago(7 * H), finishedAt: ago(6 * H) },
    latestAudit: { runAt: ago(2 * H), objectsOver29Days: 0, versioningStatus: '', staleUploads: 0, kmsKeyState: 'Enabled', alertEmailConfirmed: true, protectionDrift: null, leftoverTestDbs: 0, stuckTestDbs: 0, errors: null },
    firstAuditAt: ago(30 * D),
    restoreRuns: [run()],
    lastPass: new Map([[t, ago(2 * D)]]),
    latestResult: new Map([[t, { durationMs: 10 * 60_000, targetDeadlineMs: 2 * H }]]),
    permission: new Map(['backup', 'audit', 'restore-test'].map((r) => [r, { latestOk: true, latestAt: ago(H), latestDetail: {}, firstAt: ago(30 * D) }])),
  };
}
const kinds = (f: BackupFacts) => backupFindings(f, NOW).map((x) => x.kind).sort();

describe('U3: backupFindings', () => {
  it('a healthy state raises nothing', () => {
    expect(backupFindings(healthy(), NOW)).toEqual([]);
  });

  const raisers: Array<[string, (f: BackupFacts) => void, string]> = [
    ['missed backup run (no control-plane ok in 26 h)', (f) => { f.latestOk.set(null, row({ finishedAt: ago(27 * H) })); }, 'backup-missed-run'],
    ['stale workspace', (f) => { f.latestOk.set('t-1', row({ tenantId: 't-1', finishedAt: ago(37 * H) })); }, 'backup-stale'],
    ['failed backup (workspace)', (f) => { f.latestRow.set('t-1', row({ tenantId: 't-1', status: 'failed', error: 'dump exit=1' })); }, 'backup-failed'],
    ['slow backup run', (f) => { f.latestCpRunSpan = { startedAt: ago(10 * H), finishedAt: ago(5 * H) }; }, 'backup-run-slow'],
    ['audit missed (12 h)', (f) => { f.latestAudit!.runAt = ago(13 * H); }, 'backup-audit-missed'],
    ['old backups', (f) => { f.latestAudit!.objectsOver29Days = 2; }, 'backup-old-objects'],
    ['bucket drift: versioning', (f) => { f.latestAudit!.versioningStatus = 'Suspended'; }, 'backup-bucket-drift'],
    ['bucket drift: stale uploads', (f) => { f.latestAudit!.staleUploads = 1; }, 'backup-bucket-drift'],
    ['key not enabled', (f) => { f.latestAudit!.kmsKeyState = 'PendingDeletion'; }, 'backup-key-state'],
    ['alert email unconfirmed', (f) => { f.latestAudit!.alertEmailConfirmed = false; }, 'backup-alert-email'],
    ['protection drift', (f) => { f.latestAudit!.protectionDrift = 'bucket-policy:DenyDeletes'; }, 'backup-protection-drift'],
    ['audit check failed', (f) => { f.latestAudit!.errors = 'versioning label=s3-error'; }, 'backup-audit-error'],
    ['restore test missed (no completed run in 8 days)', (f) => { f.restoreRuns = [run({ startedAt: ago(9 * D), finishedAt: ago(9 * D) })]; }, 'restore-test-missed'],
    ['restore test failed (latest completed run fail)', (f) => { f.restoreRuns = [run({ status: 'fail', detail: 'acme-test: FAIL:pg_restore', resultCount: 2 })]; }, 'restore-test-failed'],
    ['restore test failed (a guard failure is the latest finished row)', (f) => { f.restoreRuns = [run({ id: 'g', status: 'fail', planned: null, detail: 'guard: pooled host', startedAt: ago(H), finishedAt: ago(H), resultCount: 0 }), run()]; }, 'restore-test-failed'],
    ['restore test failed (latest run running for over 12 h)', (f) => { f.restoreRuns = [run({ id: 'x', status: 'running', planned: 2, startedAt: ago(13 * H), finishedAt: null, resultCount: 0 }), run()]; }, 'restore-test-failed'],
    ['slow restore test', (f) => { f.restoreRuns = [run({ startedAt: ago(2 * D), finishedAt: ago(2 * D - 5 * H) })]; }, 'restore-test-slow'],
    ['slow target (backup half)', (f) => { f.latestOk.set('t-1', row({ tenantId: 't-1', startedAt: ago(7 * H), finishedAt: ago(7 * H - 16 * 60_000) })); }, 'backup-target-slow'],
    ['slow target (restore half)', (f) => { f.latestResult.set('t-1', { durationMs: 61 * 60_000, targetDeadlineMs: 2 * H }); }, 'backup-target-slow'],
    ['test databases left behind (audit)', (f) => { f.latestAudit!.leftoverTestDbs = 1; }, 'restore-test-leftover'],
    ['stuck test databases (audit)', (f) => { f.latestAudit!.stuckTestDbs = 1; }, 'restore-test-leftover'],
    ['a run in 7 days swept databases', (f) => { f.restoreRuns = [run({ sweptTestDbs: 1 })]; }, 'restore-test-leftover'],
    ['a run in 7 days closed abandoned', (f) => { f.restoreRuns = [run(), run({ id: 'ab', status: 'fail', detail: 'abandoned', planned: 2, resultCount: 0, startedAt: ago(3 * D), finishedAt: ago(2 * D) })]; }, 'restore-test-leftover'],
    ['permission drift (latest row not ok)', (f) => { f.permission.set('backup', { latestOk: false, latestAt: ago(H), latestDetail: { delete_object: 'ALLOWED' }, firstAt: ago(30 * D) }); }, 'backup-permission-drift'],
    ['permission drift (no row in 8 days)', (f) => { f.permission.set('audit', { latestOk: true, latestAt: ago(9 * D), latestDetail: {}, firstAt: ago(30 * D) }); }, 'backup-permission-drift'],
    ['database region (non-us-east-1 row)', (f) => { f.latestWithRegion.set('t-1', row({ tenantId: 't-1', region: 'us-east-2' })); }, 'backup-region'],
    ['coverage (no PASS in 13 weeks; first ok over 13 weeks ago)', (f) => { f.firstOk.set('t-1', ago(14 * W)); f.lastPass.set('t-1', ago(13 * W + D)); }, 'restore-test-coverage'],
  ];
  it.each(raisers)('%s → raised; cleared when healthy again', (_n, mutate, kind) => {
    const f = healthy();
    mutate(f);
    expect(kinds(f)).toContain(kind);
    expect(kinds(healthy())).not.toContain(kind);
  });

  it('every finding kind has a raising case', () => {
    expect(new Set(raisers.map((r) => r[2]))).toEqual(new Set(FINDING_KINDS));
  });

  it('control-plane findings are global with dedup `control-plane`; per-role permission dedup', () => {
    const f = healthy();
    f.latestRow.set(null, row({ status: 'failed', error: 'dump exit=1' }));
    f.latestWithRegion.set(null, row({ region: 'unknown' }));
    f.permission.set('restore-test', { latestOk: false, latestAt: ago(H), latestDetail: {}, firstAt: ago(30 * D) });
    const out = backupFindings(f, NOW);
    expect(out.find((x) => x.kind === 'backup-failed')).toMatchObject({ tenantId: null, dedupKey: 'control-plane' });
    expect(out.find((x) => x.kind === 'backup-region')).toMatchObject({ tenantId: null, dedupKey: 'control-plane' });
    expect(out.find((x) => x.kind === 'backup-permission-drift')).toMatchObject({ tenantId: null, dedupKey: 'restore-test' });
  });

  it('anchors: nothing before the first control-plane ok; a new workspace; a null-URL provisioning one; one leaving active', () => {
    const f = healthy();
    f.firstOk.delete(null);
    f.latestOk.delete(null);
    f.latestOk.delete('t-1');
    expect(kinds(f)).not.toContain('backup-missed-run');
    expect(kinds(f)).not.toContain('backup-stale');
    const g = healthy();
    g.tenants.push({ id: 'new', slug: 'brand-new', status: 'active', hasUrl: true, createdAt: ago(10 * H) });
    g.tenants.push({ id: 'prov', slug: 'prov', status: 'provisioning', hasUrl: false, createdAt: ago(5 * D) });
    expect(kinds(g)).toEqual([]);
    const gone = healthy();
    gone.tenants[0].status = 'deleting';
    gone.latestRow.set('t-1', row({ tenantId: 't-1', status: 'failed' }));
    gone.latestOk.set('t-1', row({ tenantId: 't-1', finishedAt: ago(5 * D) }));
    expect(kinds(gone)).toEqual([]);
  });

  it('the restore-test anchor: no `restore-test-missed` in the first 8 days', () => {
    const f = healthy();
    f.firstOk.set(null, ago(7 * D));
    f.restoreRuns = [];
    expect(kinds(f)).not.toContain('restore-test-missed');
    f.firstOk.set(null, ago(9 * D));
    expect(kinds(f)).toContain('restore-test-missed');
  });

  it('seven daily deadline-cut runs → `restore-test-missed` (a cut run is not completed)', () => {
    const f = healthy();
    f.restoreRuns = Array.from({ length: 8 }, (_, i) => run({ id: `c${i}`, status: 'fail', planned: 3, resultCount: 3, stoppedOrNotReached: true, startedAt: ago((i + 1) * D), finishedAt: ago((i + 1) * D - H) }));
    expect(kinds(f)).toContain('restore-test-missed');
    expect(kinds(f)).not.toContain('restore-test-failed'); // the catch-up retries: not a completed failure
  });

  it('the latest-run rule (S17): an old `running` row followed by a newer `pass` → no alert', () => {
    const f = healthy();
    f.restoreRuns = [run(), run({ id: 'old', status: 'running', planned: 2, resultCount: 1, startedAt: ago(5 * D), finishedAt: null })];
    expect(kinds(f)).toEqual([]);
  });

  it('FR2: the permission-drift detail names the role and the probes not refused, never the stored data key', () => {
    const f = healthy();
    f.permission.set('backup', { latestOk: false, latestAt: ago(H), latestDetail: { head_own_object: 'denied', delete_object: 'ALLOWED', kms_decrypt: 'error:InternalError', kms_reencrypt: 'skipped', edk: 'AQIDAHh…secret', edk_context: { cp: 'abc', id: 'tenant-uuid', key: 'v1/abc/tenant/x' } }, firstAt: ago(30 * D) });
    const finding = backupFindings(f, NOW).find((x) => x.kind === 'backup-permission-drift')!;
    expect(finding.detail).toEqual({ role: 'backup', probes: { delete_object: 'ALLOWED', kms_decrypt: 'error:InternalError' } });
    expect(JSON.stringify(finding.detail)).not.toMatch(/edk|secret|tenant-uuid|v1\//);
  });

  it('FR3: an abandoned run is never completed, even with every planned result', () => {
    const f = healthy();
    f.restoreRuns = [run({ id: 'ab', status: 'fail', detail: 'abandoned', planned: 2, resultCount: 2, startedAt: ago(2 * D), finishedAt: ago(D) })];
    expect(kinds(f)).toContain('restore-test-missed');
    expect(kinds(f)).not.toContain('restore-test-failed');
  });

  it('FR10: a fail run with fewer results than planned (none stopped) is not completed', () => {
    const f = healthy();
    f.restoreRuns = [run({ id: 'short', status: 'fail', planned: 3, resultCount: 2, stoppedOrNotReached: false, detail: 'x: FAIL:pg_restore', startedAt: ago(2 * D), finishedAt: ago(D) })];
    expect(kinds(f)).toContain('restore-test-missed');
    expect(kinds(f)).not.toContain('restore-test-failed');
  });

  it('FR10: the anchors (stale at first control-plane ok + 36 h; audit-missed needs a first audit)', () => {
    const f = healthy();
    f.firstOk.set(null, ago(35 * H));
    f.latestOk.set(null, row({ finishedAt: ago(35 * H) }));
    f.latestOk.delete('t-1');
    expect(kinds(f)).not.toContain('backup-stale');
    f.firstOk.set(null, ago(37 * H));
    expect(kinds(f)).toContain('backup-stale');
    const g = healthy();
    g.firstAuditAt = null;
    g.latestAudit = null;
    expect(kinds(g)).not.toContain('backup-audit-missed');
  });

  it('FR10: just under each threshold → nothing (26 h, 36 h, 12 h audit, 8 days, 12 h running)', () => {
    const M = 60_000;
    const a = healthy(); a.latestOk.set(null, row({ finishedAt: ago(26 * H - M) }));
    expect(kinds(a)).not.toContain('backup-missed-run');
    const b = healthy(); b.latestOk.set('t-1', row({ tenantId: 't-1', finishedAt: ago(36 * H - M) }));
    expect(kinds(b)).not.toContain('backup-stale');
    const c = healthy(); c.latestAudit!.runAt = ago(12 * H - M);
    expect(kinds(c)).not.toContain('backup-audit-missed');
    const d = healthy(); d.restoreRuns = [run({ startedAt: ago(8 * D), finishedAt: ago(8 * D - M) })];
    expect(kinds(d)).not.toContain('restore-test-missed');
    const e = healthy(); e.restoreRuns = [run({ id: 'r2', status: 'running', planned: 2, resultCount: 0, startedAt: ago(12 * H - M), finishedAt: null }), run()];
    expect(kinds(e)).not.toContain('restore-test-failed');
  });

  it('FR10: coverage needs an eligible workspace (an ok backup in the last 36 h)', () => {
    const f = healthy();
    f.firstOk.set('t-1', ago(14 * W));
    f.lastPass.delete('t-1');
    f.latestOk.set('t-1', row({ tenantId: 't-1', finishedAt: ago(37 * H) }));
    expect(kinds(f)).not.toContain('restore-test-coverage');
    f.latestOk.set('t-1', row({ tenantId: 't-1', finishedAt: ago(35 * H) }));
    expect(kinds(f)).toContain('restore-test-coverage');
  });

  it('lock-held rows are ignored by the failed rule', () => {
    const f = healthy();
    f.restoreRuns = [run({ id: 'l', status: 'fail', planned: null, detail: 'lock held', startedAt: ago(H), finishedAt: ago(H), resultCount: 0 }), run()];
    expect(kinds(f)).toEqual([]);
    // A stuck run (running for 13 h) still alerts when a later lock-held row (locked out by it) is the newest row.
    const g = healthy();
    g.restoreRuns = [
      run({ id: 'l2', status: 'fail', planned: null, detail: 'lock held', startedAt: ago(H), finishedAt: ago(H), resultCount: 0 }),
      run({ id: 'stuck', status: 'running', planned: 2, resultCount: 0, startedAt: ago(13 * H), finishedAt: null }),
      run(),
    ];
    expect(kinds(g)).toContain('restore-test-failed');
  });

  it('coverage exactly at 13 weeks; the slow thresholds at 70% / half; alert email null is not an alert', () => {
    const f = healthy();
    f.firstOk.set('t-1', ago(13 * W + D));
    f.lastPass.set('t-1', ago(13 * W - H));
    expect(kinds(f)).not.toContain('restore-test-coverage');
    f.lastPass.delete('t-1');
    expect(kinds(f)).toContain('restore-test-coverage');
    const s = healthy();
    s.latestCpRunSpan = { startedAt: ago(251 * 60_000 + 6 * H), finishedAt: ago(6 * H) }; // just under 70% of 6 h (252 min)
    expect(kinds(s)).not.toContain('backup-run-slow');
    s.latestOk.set('t-1', row({ tenantId: 't-1', startedAt: ago(7 * H), finishedAt: ago(7 * H - 15 * 60_000) }));
    expect(kinds(s)).not.toContain('backup-target-slow');
    const e = healthy();
    e.latestAudit!.alertEmailConfirmed = null;
    expect(kinds(e)).not.toContain('backup-alert-email');
  });

  it('`backup-target-slow` restore half ignores results older than 14 days (they are not in the facts)', () => {
    const f = healthy();
    f.latestResult.delete('t-1');
    expect(kinds(f)).not.toContain('backup-target-slow');
  });
});

describe('U10: the route step and monitoring modes', () => {
  beforeEach(() => { h.raised = []; h.resolved = []; h.prefixResolved = []; h.lockedThrows = false; });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a throwing sync raises the global backup-check-failed and returns, never throwing (so the digest still runs)', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    h.failNextLocked = 1; // the facts read fails; the alert write succeeds
    expect(await runBackupMonitoring(NOW)).toEqual({ error: true });
    expect(h.raised).toEqual([{ tenantId: null, kind: 'backup-check-failed' }]);
    h.failNextLocked = 2; // even the alert write fails: still no throw
    await expect(runBackupMonitoring(NOW)).resolves.toEqual({ error: true });
  });

  it('BACKUPS_EXPECTED=0 → nothing synced, every backup alert kind resolved (incl. backup-check-failed)', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '0');
    expect(await syncBackupAlerts(NOW)).toEqual({ synced: false, findings: 0 });
    expect(h.prefixResolved).toEqual([['backup-', 'restore-test-']]);
    expect(h.raised).toEqual([]);
  });

  it('BACKUPS_EXPECTED=1 → the sync runs and resolves backup-check-failed', async () => {
    vi.stubEnv('BACKUPS_EXPECTED', '1');
    expect((await syncBackupAlerts(NOW)).synced).toBe(true);
    expect(h.resolved).toContainEqual({ tenantId: null, kind: 'backup-check-failed' });
  });

  it('modes: 1 on, 0 off, anything else in production not-configured, local silent', () => {
    expect(backupsExpected({ BACKUPS_EXPECTED: '1' })).toBe('on');
    expect(backupsExpected({ BACKUPS_EXPECTED: '0', NODE_ENV: 'production' })).toBe('off');
    expect(backupsExpected({ BACKUPS_EXPECTED: 'yes', NODE_ENV: 'production' })).toBe('not-configured');
    expect(backupsExpected({ NODE_ENV: 'production' })).toBe('not-configured');
    expect(backupsExpected({ NODE_ENV: 'development' })).toBe('silent');
  });
});

describe('U9: the digest Backups lines', () => {
  it('the 0 line counts as news on the production domain only; not-configured is news; local is silent', async () => {
    expect(await backupDigest(NOW, { BACKUPS_EXPECTED: '0', APP_ROOT_DOMAIN: 'cadenzpoint.com' })).toEqual({ lines: ['Backup monitoring is off on this deployment (BACKUPS_EXPECTED=0).'], news: true });
    expect((await backupDigest(NOW, { BACKUPS_EXPECTED: '0', APP_ROOT_DOMAIN: 'staging.cadenzpoint.com' })).news).toBe(false);
    expect(await backupDigest(NOW, { NODE_ENV: 'production' })).toEqual({ lines: ['Backup monitoring is not configured (BACKUPS_EXPECTED).'], news: true });
    expect(await backupDigest(NOW, { NODE_ENV: 'development' })).toEqual({ lines: [], news: false });
  });

  it('on, with an empty control plane: both summary lines and the disaster line (3c §6.8), not news', async () => {
    expect(await backupDigest(NOW, { BACKUPS_EXPECTED: '1' })).toEqual({
      lines: ['0 of 0 workspaces backed up in the last 26 h. Newest control-plane backup: none.', 'No restore test has completed yet.', 'Disaster runs in the last 7 days: none.'],
      news: false,
    });
  });

  it('"could not be read" counts as news', async () => {
    h.lockedThrows = true;
    try {
      expect(await backupDigest(NOW, { BACKUPS_EXPECTED: '1' })).toEqual({ lines: ['Backup status could not be read.'], news: true });
    } finally {
      h.lockedThrows = false;
    }
  });
});
