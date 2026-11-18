import 'server-only';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, min, max, or, sql, type SQL } from 'drizzle-orm';
import {
  backupAudits, backupPermissionChecks, databaseBackups, opsAlerts, restoreTestResults, restoreTestRuns, tenants,
} from '@/db/control-plane/schema';
import { withLockedPool, type ControlTx } from '@/db/control-plane/locked';
import { raiseAlert, resolveAlert, resolveAlertsByKindPrefix } from './lifecycle-store';

/**
 * Backup monitoring (feature-plan-database-backups.md §6.9; state table §7.4 = the findings table below). The backup
 * image writes its results to the control plane; the daily lifecycle cron (13:00 UTC) reads them here, raises and
 * resolves alerts, and the digest prints a Backups section.
 *
 * `BACKUPS_EXPECTED` (Vercel env): `1` → the sync runs; `0` → off (the digest says so; on the production domain that line
 * counts as news); anything else in production → "not configured" (news); local development → silent. When the sync
 * doesn't run, every backup alert kind is resolved so nothing lingers.
 *
 * Alert details carry slugs, stages, counts and times only: the digest prints `detail` (ops-digest.ts).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
export const RUN_DEADLINE_MS = 6 * HOUR; // the backup run deadline (scripts/backup/backup.ts DEFAULTS)
export const BACKUP_ALERT_PREFIXES = ['backup-', 'restore-test-'];
export const BACKUP_CHECK_FAILED = 'backup-check-failed';
export const PRODUCTION_ROOT_DOMAIN = 'cadenzpoint.com';
const LIVE = new Set(['provisioning', 'active', 'suspended']);
const ROLES = ['backup', 'audit', 'restore-test'] as const;

export const FINDING_KINDS = [
  'backup-missed-run', 'backup-stale', 'backup-failed', 'backup-run-slow', 'backup-audit-missed', 'backup-old-objects',
  'backup-bucket-drift', 'backup-key-state', 'backup-alert-email', 'backup-protection-drift', 'backup-audit-error',
  'restore-test-missed', 'restore-test-failed', 'restore-test-slow', 'backup-target-slow', 'restore-test-leftover',
  'backup-permission-drift', 'backup-region', 'restore-test-coverage',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  tenantId: string | null;
  dedupKey: string;
  detail: Record<string, unknown>;
}

export interface BackupRowFact {
  tenantId: string | null;
  runId: string;
  status: string;
  region: string | null;
  targetDeadlineMs: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface RestoreRunFact {
  id: string;
  status: string;
  planned: number | null;
  sweptTestDbs: number;
  deadlineMs: number;
  targetDeadlineMs: number;
  detail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  resultCount: number;
  stoppedOrNotReached: boolean;
}

export interface BackupFacts {
  tenants: Array<{ id: string; slug: string; status: string; hasUrl: boolean; createdAt: Date }>;
  /** Newest row per target (tenant id, or null for the control plane). */
  latestRow: Map<string | null, BackupRowFact>;
  latestOk: Map<string | null, BackupRowFact>;
  latestWithRegion: Map<string | null, BackupRowFact>;
  firstOk: Map<string | null, Date>;
  /** First and last instants of the latest run that backed up the control plane (ok). */
  latestCpRunSpan: { startedAt: Date; finishedAt: Date } | null;
  latestAudit: {
    runAt: Date; objectsOver29Days: number | null; versioningStatus: string | null; staleUploads: number | null; kmsKeyState: string | null;
    alertEmailConfirmed: boolean | null; protectionDrift: string | null; leftoverTestDbs: number | null; stuckTestDbs: number | null; errors: string | null;
  } | null;
  firstAuditAt: Date | null;
  /** Restore-test runs started in the last 30 days, plus the latest run of all, newest first. */
  restoreRuns: RestoreRunFact[];
  lastPass: Map<string, Date>;
  /** Each workspace's latest restore result in the last 14 days, with its run's per-target deadline. */
  latestResult: Map<string, { durationMs: number; targetDeadlineMs: number }>;
  permission: Map<string, { latestOk: boolean; latestAt: Date; latestDetail: unknown; firstAt: Date }>;
}

/** A run that "completed" (§6.7): planned set, and pass, or fail with every planned result and none stopped/not reached. */
export function isCompleted(r: RestoreRunFact): boolean {
  if (r.planned === null || r.finishedAt === null || r.detail === 'abandoned') return false;
  if (r.status === 'pass') return true;
  return r.status === 'fail' && r.resultCount === r.planned && !r.stoppedOrNotReached;
}
const isLockHeld = (r: RestoreRunFact) => r.detail === 'lock held';
const isGuardFailure = (r: RestoreRunFact) => r.planned === null && r.status === 'fail' && (r.detail ?? '').startsWith('guard:');

/**
 * The probes that weren't refused, for an alert detail: probe name → result only. Never the stored `edk` / `edk_context`
 * (the digest prints details; §6.9: slugs, stages, counts and times only).
 */
export function failedProbes(detail: unknown): Record<string, string> {
  if (!detail || typeof detail !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (k.startsWith('edk')) continue;
    if (v === 'denied' || v === 'skipped') continue;
    out[k] = typeof v === 'string' && /^(ALLOWED|error:[A-Za-z0-9_.-]{1,60})$/.test(v) ? v : 'unexpected';
  }
  return out;
}

/** The pure findings (§6.9's table), checked at the cron's `now`. */
export function backupFindings(f: BackupFacts, now: Date): Finding[] {
  const out: Finding[] = [];
  const t = now.getTime();
  const add = (kind: FindingKind, tenantId: string | null, detail: Record<string, unknown> = {}, dedupKey = '') => out.push({ kind, tenantId, dedupKey, detail });
  const live = f.tenants.filter((x) => LIVE.has(x.status));
  const cpFirstOk = f.firstOk.get(null) ?? null;
  const cpLatestOk = f.latestOk.get(null) ?? null;

  // missed run (anchored to the first control-plane ok)
  if (cpFirstOk && (!cpLatestOk || t - cpLatestOk.finishedAt.getTime() > 26 * HOUR)) {
    add('backup-missed-run', null, { newestControlPlaneOk: cpLatestOk?.finishedAt.toISOString() ?? null });
  }
  // stale workspaces (anchored to the first control-plane ok + 36 h)
  if (cpFirstOk && t >= cpFirstOk.getTime() + 36 * HOUR) {
    for (const w of live) {
      if (!w.hasUrl || t - w.createdAt.getTime() <= 36 * HOUR) continue;
      const ok = f.latestOk.get(w.id);
      if (!ok || t - ok.finishedAt.getTime() > 36 * HOUR) add('backup-stale', w.id, { slug: w.slug, newestOk: ok?.finishedAt.toISOString() ?? null });
    }
  }
  // failed: the target's newest row is failed
  for (const w of live) {
    const r = f.latestRow.get(w.id);
    if (r?.status === 'failed') add('backup-failed', w.id, { slug: w.slug, error: r.error, at: r.finishedAt.toISOString() });
  }
  const cpRow = f.latestRow.get(null);
  if (cpRow?.status === 'failed') add('backup-failed', null, { slug: 'control-plane', error: cpRow.error, at: cpRow.finishedAt.toISOString() }, 'control-plane');
  // slow run
  if (f.latestCpRunSpan) {
    const span = f.latestCpRunSpan.finishedAt.getTime() - f.latestCpRunSpan.startedAt.getTime();
    if (span > 0.7 * RUN_DEADLINE_MS) add('backup-run-slow', null, { minutes: Math.round(span / 60_000), limitMinutes: RUN_DEADLINE_MS / 60_000 });
  }
  // audit findings
  if (f.firstAuditAt && (!f.latestAudit || t - f.latestAudit.runAt.getTime() > 12 * HOUR)) {
    add('backup-audit-missed', null, { latestAudit: f.latestAudit?.runAt.toISOString() ?? null });
  }
  const a = f.latestAudit;
  if (a) {
    if ((a.objectsOver29Days ?? 0) > 0) add('backup-old-objects', null, { objects: a.objectsOver29Days });
    if ((a.versioningStatus !== null && a.versioningStatus !== '') || (a.staleUploads ?? 0) > 0) {
      add('backup-bucket-drift', null, { versioning: a.versioningStatus, staleUploads: a.staleUploads });
    }
    if (a.kmsKeyState !== 'Enabled') add('backup-key-state', null, { state: a.kmsKeyState });
    if (a.alertEmailConfirmed === false) add('backup-alert-email', null, {});
    if (a.protectionDrift !== null) add('backup-protection-drift', null, { missing: a.protectionDrift });
    if (a.errors !== null) add('backup-audit-error', null, { errors: a.errors });
  }
  // restore tests
  const runs = f.restoreRuns;
  const completed = runs.filter(isCompleted).sort((x, y) => y.finishedAt!.getTime() - x.finishedAt!.getTime());
  const latestCompleted = completed[0] ?? null;
  if (cpFirstOk && t >= cpFirstOk.getTime() + 8 * DAY && !(latestCompleted && t - latestCompleted.finishedAt!.getTime() <= 8 * DAY)) {
    add('restore-test-missed', null, { latestCompleted: latestCompleted?.finishedAt?.toISOString() ?? null });
  }
  const finished = runs.filter((r) => r.finishedAt && !isLockHeld(r)).sort((x, y) => y.finishedAt!.getTime() - x.finishedAt!.getTime());
  const latestStarted = runs.filter((r) => !isLockHeld(r)).sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime())[0] ?? null;
  const failedReasons: string[] = [];
  if (latestCompleted?.status === 'fail') failedReasons.push(latestCompleted.detail ?? 'failed');
  if (finished[0] && isGuardFailure(finished[0])) failedReasons.push(finished[0].detail!);
  if (latestStarted?.status === 'running' && t - latestStarted.startedAt.getTime() > 12 * HOUR) failedReasons.push('a run has been running for over 12 h');
  if (failedReasons.length) add('restore-test-failed', null, { failed: failedReasons.join('; ') });
  if (latestCompleted) {
    const took = latestCompleted.finishedAt!.getTime() - latestCompleted.startedAt.getTime();
    if (took > 0.7 * latestCompleted.deadlineMs) add('restore-test-slow', null, { minutes: Math.round(took / 60_000), limitMinutes: Math.round(latestCompleted.deadlineMs / 60_000) });
  }
  // slow targets
  for (const w of live) {
    const ok = f.latestOk.get(w.id);
    const backupSlow = ok && ok.finishedAt.getTime() - ok.startedAt.getTime() > ok.targetDeadlineMs / 2;
    const res = f.latestResult.get(w.id);
    const restoreSlow = res && res.durationMs > res.targetDeadlineMs / 2;
    if (backupSlow || restoreSlow) add('backup-target-slow', w.id, { slug: w.slug, backup: Boolean(backupSlow), restore: Boolean(restoreSlow), remedy: 'raise the deadline or task size in ops/aws/backup-stack.yml' });
  }
  // leftovers / crashed tests
  const recent = runs.filter((r) => t - r.startedAt.getTime() <= 7 * DAY || (r.finishedAt && t - r.finishedAt.getTime() <= 7 * DAY));
  const swept = recent.some((r) => r.sweptTestDbs > 0);
  const abandoned = recent.some((r) => r.detail === 'abandoned');
  if ((a && ((a.leftoverTestDbs ?? 0) > 0 || (a.stuckTestDbs ?? 0) > 0)) || swept || abandoned) {
    add('restore-test-leftover', null, { leftover: a?.leftoverTestDbs ?? null, stuck: a?.stuckTestDbs ?? null, sweptRecently: swept, abandonedRecently: abandoned });
  }
  // permission drift, per role
  for (const role of ROLES) {
    const p = f.permission.get(role);
    if (!p) continue;
    if (!p.latestOk) add('backup-permission-drift', null, { role, probes: failedProbes(p.latestDetail) }, role);
    else if (t - p.latestAt.getTime() > 8 * DAY) add('backup-permission-drift', null, { role, lastChecked: p.latestAt.toISOString() }, role);
  }
  // region
  for (const w of live) {
    const r = f.latestWithRegion.get(w.id);
    if (r && r.region !== 'us-east-1') add('backup-region', w.id, { slug: w.slug, region: r.region });
  }
  const cpRegion = f.latestWithRegion.get(null);
  if (cpRegion && cpRegion.region !== 'us-east-1') add('backup-region', null, { slug: 'control-plane', region: cpRegion.region }, 'control-plane');
  // coverage (§5's 13-week rule itself)
  for (const w of live) {
    if (!w.hasUrl) continue;
    const ok = f.latestOk.get(w.id);
    const first = f.firstOk.get(w.id);
    if (!ok || t - ok.finishedAt.getTime() > 36 * HOUR || !first || t - first.getTime() <= 13 * WEEK) continue;
    const pass = f.lastPass.get(w.id);
    if (!pass || t - pass.getTime() > 13 * WEEK) add('restore-test-coverage', w.id, { slug: w.slug, lastPass: pass?.toISOString() ?? null });
  }
  return out;
}

export interface BackupFilter {
  /** Tests: only these tenants' rows and alerts (plus the control-plane / global rows of the run ids below). */
  tenantIds?: string[];
  /** Tests: only rows whose run_id starts with this. */
  runIdPrefix?: string;
}

function runFilter<T extends { runId: unknown }>(table: T, filter?: BackupFilter): SQL | undefined {
  return filter?.runIdPrefix ? like(table.runId as never, `${filter.runIdPrefix}%`) : undefined;
}

export async function readBackupFacts(now: Date, filter?: BackupFilter): Promise<BackupFacts> {
  return withLockedPool(async (db) => {
    const tenantScope = (col: typeof databaseBackups.tenantId) => (filter?.tenantIds
      ? or(isNull(col), filter.tenantIds.length ? inArray(col, filter.tenantIds) : sql`false`)
      : undefined);
    const bWhere = (...extra: Array<SQL | undefined>) => and(runFilter(databaseBackups, filter), tenantScope(databaseBackups.tenantId), ...extra);

    const tenantRows = await db.select({ id: tenants.id, slug: tenants.slug, status: tenants.status, url: tenants.dbUrlEncrypted, createdAt: tenants.createdAt })
      .from(tenants).where(filter?.tenantIds ? (filter.tenantIds.length ? inArray(tenants.id, filter.tenantIds) : sql`false`) : undefined);

    const fact = {
      tenantId: databaseBackups.tenantId, runId: databaseBackups.runId, status: databaseBackups.status, region: databaseBackups.region,
      targetDeadlineMs: databaseBackups.targetDeadlineMs, error: databaseBackups.error, startedAt: databaseBackups.startedAt, finishedAt: databaseBackups.finishedAt,
    };
    const latest = (where: SQL | undefined) => db.selectDistinctOn([databaseBackups.tenantId], fact).from(databaseBackups).where(where)
      .orderBy(databaseBackups.tenantId, desc(databaseBackups.finishedAt));
    const toMap = (rows: BackupRowFact[]) => new Map(rows.map((r) => [r.tenantId, r] as const));
    const latestRow = toMap(await latest(bWhere()));
    const latestOk = toMap(await latest(bWhere(eq(databaseBackups.status, 'ok'))));
    const latestWithRegion = toMap(await latest(bWhere(isNotNull(databaseBackups.region))));
    const firstOkRows = await db.select({ tenantId: databaseBackups.tenantId, first: min(databaseBackups.finishedAt) }).from(databaseBackups)
      .where(bWhere(eq(databaseBackups.status, 'ok'))).groupBy(databaseBackups.tenantId);
    const firstOk = new Map(firstOkRows.filter((r) => r.first).map((r) => [r.tenantId, r.first!] as const));

    let latestCpRunSpan: BackupFacts['latestCpRunSpan'] = null;
    const cpOk = latestOk.get(null);
    if (cpOk) {
      const [span] = await db.select({ s: min(databaseBackups.startedAt), f: max(databaseBackups.finishedAt) }).from(databaseBackups)
        .where(eq(databaseBackups.runId, cpOk.runId));
      if (span?.s && span.f) latestCpRunSpan = { startedAt: span.s, finishedAt: span.f };
    }

    const aWhere = runFilter(backupAudits, filter);
    const [audit] = await db.select().from(backupAudits).where(aWhere).orderBy(desc(backupAudits.runAt)).limit(1);
    const [firstAudit] = await db.select({ at: min(backupAudits.runAt) }).from(backupAudits).where(aWhere);

    const rWhere = runFilter(restoreTestRuns, filter);
    const since30 = new Date(now.getTime() - 30 * DAY);
    const runRows = await db.select().from(restoreTestRuns).where(and(rWhere, gte(restoreTestRuns.startedAt, since30))).orderBy(desc(restoreTestRuns.startedAt));
    const [latestEver] = await db.select().from(restoreTestRuns).where(rWhere).orderBy(desc(restoreTestRuns.startedAt)).limit(1);
    if (latestEver && !runRows.some((r) => r.id === latestEver.id)) runRows.unshift(latestEver);
    const ids = runRows.map((r) => r.id);
    const resultStats = ids.length ? await db.select({
      runId: restoreTestResults.testRunId,
      n: sql<number>`count(*)::int`,
      bad: sql<number>`count(*) FILTER (WHERE ${restoreTestResults.result} IN ('FAIL:stopped', 'FAIL:not-reached'))::int`,
    }).from(restoreTestResults).where(inArray(restoreTestResults.testRunId, ids)).groupBy(restoreTestResults.testRunId) : [];
    const stats = new Map(resultStats.map((s) => [s.runId, s]));
    const restoreRuns: RestoreRunFact[] = runRows.map((r) => ({
      id: r.id, status: r.status, planned: r.planned, sweptTestDbs: r.sweptTestDbs, deadlineMs: r.deadlineMs, targetDeadlineMs: r.targetDeadlineMs,
      detail: r.detail, startedAt: r.startedAt, finishedAt: r.finishedAt, resultCount: stats.get(r.id)?.n ?? 0, stoppedOrNotReached: (stats.get(r.id)?.bad ?? 0) > 0,
    }));

    const resWhere = and(runFilter(restoreTestResults, filter), isNotNull(restoreTestResults.tenantId),
      filter?.tenantIds ? (filter.tenantIds.length ? inArray(restoreTestResults.tenantId, filter.tenantIds) : sql`false`) : undefined);
    const passes = await db.select({ tenantId: restoreTestResults.tenantId, at: max(restoreTestResults.testedAt) }).from(restoreTestResults)
      .where(and(resWhere, eq(restoreTestResults.result, 'PASS'))).groupBy(restoreTestResults.tenantId);
    const since14 = new Date(now.getTime() - 14 * DAY);
    const recentResults = await db.selectDistinctOn([restoreTestResults.tenantId], {
      tenantId: restoreTestResults.tenantId, durationMs: restoreTestResults.durationMs, targetDeadlineMs: restoreTestRuns.targetDeadlineMs,
    }).from(restoreTestResults).innerJoin(restoreTestRuns, eq(restoreTestResults.testRunId, restoreTestRuns.id))
      .where(and(resWhere, gte(restoreTestResults.testedAt, since14))).orderBy(restoreTestResults.tenantId, desc(restoreTestResults.testedAt));

    const pWhere = runFilter(backupPermissionChecks, filter);
    const latestPerm = await db.selectDistinctOn([backupPermissionChecks.role], {
      role: backupPermissionChecks.role, ok: backupPermissionChecks.ok, at: backupPermissionChecks.checkedAt, detail: backupPermissionChecks.detail,
    }).from(backupPermissionChecks).where(pWhere).orderBy(backupPermissionChecks.role, desc(backupPermissionChecks.checkedAt));
    const firstPerm = await db.select({ role: backupPermissionChecks.role, at: min(backupPermissionChecks.checkedAt) }).from(backupPermissionChecks)
      .where(pWhere).groupBy(backupPermissionChecks.role);
    const firstPermBy = new Map(firstPerm.map((p) => [p.role, p.at!]));

    return {
      tenants: tenantRows.map((x) => ({ id: x.id, slug: x.slug, status: x.status, hasUrl: x.url !== null, createdAt: x.createdAt })),
      latestRow, latestOk, latestWithRegion, firstOk, latestCpRunSpan,
      latestAudit: audit ? {
        runAt: audit.runAt, objectsOver29Days: audit.objectsOver29Days, versioningStatus: audit.versioningStatus, staleUploads: audit.staleUploads,
        kmsKeyState: audit.kmsKeyState, alertEmailConfirmed: audit.alertEmailConfirmed, protectionDrift: audit.protectionDrift,
        leftoverTestDbs: audit.leftoverTestDbs, stuckTestDbs: audit.stuckTestDbs, errors: audit.errors,
      } : null,
      firstAuditAt: firstAudit?.at ?? null,
      restoreRuns,
      lastPass: new Map(passes.filter((p) => p.tenantId && p.at).map((p) => [p.tenantId!, p.at!])),
      latestResult: new Map(recentResults.filter((r) => r.tenantId).map((r) => [r.tenantId!, { durationMs: r.durationMs, targetDeadlineMs: r.targetDeadlineMs }])),
      permission: new Map(latestPerm.map((p) => [p.role, { latestOk: p.ok, latestAt: p.at, latestDetail: p.detail, firstAt: firstPermBy.get(p.role) ?? p.at }])),
    };
  });
}

export type BackupsExpected = 'on' | 'off' | 'not-configured' | 'silent';

/** How `BACKUPS_EXPECTED` reads in this deployment. */
export function backupsExpected(env: Record<string, string | undefined> = process.env): BackupsExpected {
  if (env.BACKUPS_EXPECTED === '1') return 'on';
  if (env.BACKUPS_EXPECTED === '0') return 'off';
  return env.NODE_ENV === 'production' ? 'not-configured' : 'silent';
}

const isProductionDomain = (env: Record<string, string | undefined> = process.env) =>
  (env.APP_ROOT_DOMAIN ?? '').split(':')[0].toLowerCase() === PRODUCTION_ROOT_DOMAIN;

/**
 * Raise every finding and resolve every open backup alert that is no longer true (scopes matching), and resolve
 * `backup-check-failed`. When monitoring is not on, resolve every backup alert kind instead.
 */
export async function syncBackupAlerts(now: Date, filter?: BackupFilter): Promise<{ synced: boolean; findings: number }> {
  if (backupsExpected() !== 'on') {
    await withLockedPool((db) => resolveAlertsByKindPrefix(db as unknown as ControlTx, BACKUP_ALERT_PREFIXES, now, { note: 'backup monitoring off', tenantIds: filter?.tenantIds }));
    return { synced: false, findings: 0 };
  }
  const facts = await readBackupFacts(now, filter);
  const findings = backupFindings(facts, now);
  const liveIds = new Set(facts.tenants.filter((x) => LIVE.has(x.status)).map((x) => x.id));
  await withLockedPool(async (db) => {
    const open = await db.select({ scope: opsAlerts.scope, tenantId: opsAlerts.tenantId, kind: opsAlerts.kind, dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
      .where(and(isNull(opsAlerts.resolvedAt), inArray(opsAlerts.kind, [...FINDING_KINDS]),
        filter?.tenantIds ? or(eq(opsAlerts.scope, 'global'), filter.tenantIds.length ? inArray(opsAlerts.scope, filter.tenantIds) : sql`false`) : undefined));
    const wanted = new Set(findings.map((x) => `${x.tenantId ?? 'global'}|${x.kind}|${x.dedupKey}`));
    for (const x of findings) await raiseAlert(db as unknown as ControlTx, { tenantId: x.tenantId, kind: x.kind, dedupKey: x.dedupKey || undefined, detail: x.detail }, now);
    for (const o of open) {
      const key = `${o.scope}|${o.kind}|${o.dedupKey}`;
      if (wanted.has(key)) continue;
      const tenantId = o.scope === 'global' ? null : o.scope;
      const note = tenantId && !liveIds.has(tenantId) ? 'workspace no longer live' : 'condition cleared';
      await resolveAlert(db as unknown as ControlTx, { tenantId, kind: o.kind, dedupKey: o.dedupKey }, now, note);
    }
    await resolveAlert(db as unknown as ControlTx, { tenantId: null, kind: BACKUP_CHECK_FAILED }, now);
  });
  return { synced: true, findings: findings.length };
}

/** The route's isolated step: a throw raises the global `backup-check-failed` (best effort) and never stops the cron. */
export async function runBackupMonitoring(now: Date, filter?: BackupFilter): Promise<{ synced: boolean; findings: number } | { error: true }> {
  try {
    return await syncBackupAlerts(now, filter);
  } catch (err) {
    console.error('[backups] monitoring sync failed:', (err as Error)?.name ?? 'error');
    try {
      await withLockedPool((db) => raiseAlert(db as unknown as ControlTx, { tenantId: null, kind: BACKUP_CHECK_FAILED }, now));
    } catch { /* best effort */ }
    return { error: true };
  }
}

export interface BackupDigest {
  lines: string[];
  /** True when the section must count as news (could not be read; off on the production domain; not configured). */
  news: boolean;
}

/** The digest's "Backups" lines (plain text; the digest escapes them). Findings appear under "Unresolved alerts". */
export async function backupDigest(now: Date, env: Record<string, string | undefined> = process.env): Promise<BackupDigest> {
  const mode = backupsExpected(env);
  if (mode === 'silent') return { lines: [], news: false };
  if (mode === 'off') return { lines: ['Backup monitoring is off on this deployment (BACKUPS_EXPECTED=0).'], news: isProductionDomain(env) };
  if (mode === 'not-configured') return { lines: ['Backup monitoring is not configured (BACKUPS_EXPECTED).'], news: true };
  try {
    const f = await readBackupFacts(now);
    const live = f.tenants.filter((x) => LIVE.has(x.status) && x.hasUrl);
    const fresh = live.filter((x) => { const ok = f.latestOk.get(x.id); return ok && now.getTime() - ok.finishedAt.getTime() <= 26 * HOUR; });
    const cp = f.latestOk.get(null);
    const lines = [`${fresh.length} of ${live.length} workspaces backed up in the last 26 h. Newest control-plane backup: ${cp ? cp.finishedAt.toISOString() : 'none'}.`];
    const last = f.restoreRuns.filter(isCompleted).sort((x, y) => y.finishedAt!.getTime() - x.finishedAt!.getTime())[0];
    lines.push(last
      ? `Last restore test ${last.finishedAt!.toISOString().slice(0, 10)}: ${last.status}, control plane + ${Math.max(0, (last.planned ?? 1) - 1)} workspaces.`
      : 'No restore test has completed yet.');
    // feature-plan-disaster-restore.md §6.8: the disaster button's runs.
    lines.push(...await disasterLines(now));
    return { lines, news: false };
  } catch {
    return { lines: ['Backup status could not be read.'], news: true };
  }
}

/** feature-plan-disaster-restore.md §6.8: "Disaster runs in the last 7 days: …" (lazy import: no cycle with disaster-status.ts). */
async function disasterLines(now: Date): Promise<string[]> {
  try {
    const { disasterDigestLines } = await import('./disaster-status');
    return await disasterDigestLines(now);
  } catch {
    return ['Disaster runs could not be read.'];
  }
}
