import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { databaseBackups, disasterActions, disasterRuns, opsAlerts, tenants } from '@/db/control-plane/schema';
import { withLockedPool, type ControlTx } from '@/db/control-plane/locked';
import { raiseAlert, resolveAlert } from './lifecycle-store';
import { backupsExpected } from './backup-status';

/**
 * The disaster button's daily checks (feature-plan-disaster-restore.md §6.8; state table §7.2). Run by the lifecycle cron
 * as its own isolated step (approved detail D7), only where backup monitoring is on (`BACKUPS_EXPECTED=1`): staging and
 * development are silent. Neon calls use the app's NEON_API_KEY, which must be an ORGANIZATION key (the organisation
 * is inferred, so the lists cover every project), with 10-second timeouts.
 *
 * These kinds are NOT in 3b's FINDING_KINDS and don't match its `backup-`/`restore-test-` prefixes, so 3b's sync and its
 * "monitoring off resolves every backup kind" never touch them; `tenant:admin resolve-alert` refuses them (they close
 * only on the facts below).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const STUCK_MS = 345 * 60_000;
export const LEFTOVER_AFTER_MS = 6 * HOUR;
export const WATCH_MIN_MS = 30 * DAY;
export const REHEARSAL_MAX_GAP_MS = 40 * DAY;
const MIGRATABLE = new Set(['active', 'suspended', 'provisioning', 'deleting']);
const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export const DISASTER_ALERT_KINDS = [
  'rebuild-orphan-project', 'workspace-needs-deploy', 'disaster-run-stuck', 'disaster-rehearse-failed',
  'rebuild-original-watch', 'rebuild-original-returned', 'rebuild-original-recoverable', 'rebuild-watch-check-failed',
] as const;
export type DisasterAlertKind = (typeof DISASTER_ALERT_KINDS)[number];
/** The kinds `tenant:admin resolve-alert` refuses (prefix match: rebuild-*, disaster-*). */
export const isDisasterKind = (kind: string) => kind.startsWith('rebuild-') || kind.startsWith('disaster-');

// ---- facts --------------------------------------------------------------------------------------------------------

export interface ProjectGroup {
  name: string;
  id: string | null;
  latestStatus: string;
  latestAt: Date;
  tenantId: string | null;
  slug: string | null;
  oldProjectId: string | null;
  /** The tenant whose row references this project id, if any. */
  referencedBy: string | null;
}

export interface DeployFact {
  tenantId: string;
  slug: string;
  status: string;
  hasUrl: boolean;
  skippedAt: Date | null;
  migratedAt: Date | null;
  linkedAt: Date | null;
  lastOkAt: Date | null;
}

export interface WatchFact {
  oldProjectId: string;
  tenantId: string | null;
  slug: string | null;
  watchStartedAt: Date;
  /** A `rebuild-original-returned` alert ever existed for it (open or resolved). */
  everReturned: boolean;
  detail: Record<string, unknown>;
}

export interface DisasterFacts {
  runs: Array<{ id: string; runId: string; mode: string; status: string; startedAt: Date; finishedAt: Date | null }>;
  firstCpOkAt: Date | null;
  projects: ProjectGroup[];
  deploy: DeployFact[];
  watches: WatchFact[];
}

/** What Neon said today. `failed` = a call failed or the key check failed: Neon-based conditions are then left as they are. */
export interface NeonView {
  failed: boolean;
  keyOk: boolean;
  /** Project id → exists (200) or not (404). */
  exists: Map<string, boolean>;
  /** Project name → id of a live project with exactly that name. */
  byName: Map<string, string | null>;
  /** Deleted, recoverable projects: id → recoverable_until (or null). */
  recoverable: Map<string, string | null>;
}

export interface Finding {
  kind: DisasterAlertKind;
  dedupKey: string;
  detail: Record<string, unknown>;
}

export interface FindingsResult {
  raise: Finding[];
  /** Watches done (resolved). */
  watchesDone: string[];
  /** `gone-confirmed` rows to append (leftovers proven gone). */
  goneConfirmed: ProjectGroup[];
  /** Leftovers a tenant row references: append `linked` and raise the watch. */
  healed: ProjectGroup[];
  /** Runs to close as `fail`/`abandoned` (stuck). */
  closeRuns: string[];
}

/** The §6.8 table. Pure. */
export function disasterFindings(f: DisasterFacts, neon: NeonView, now: Date): FindingsResult {
  const t = now.getTime();
  const out: FindingsResult = { raise: [], watchesDone: [], goneConfirmed: [], healed: [], closeRuns: [] };

  // Leftover projects.
  for (const p of f.projects) {
    if (!['intended', 'created', 'failed'].includes(p.latestStatus) || t - p.latestAt.getTime() <= LEFTOVER_AFTER_MS) continue;
    if (p.id && p.referencedBy) { out.healed.push(p); continue; }
    if (neon.failed) {
      out.raise.push({ kind: 'rebuild-orphan-project', dedupKey: p.id ?? p.name, detail: orphanDetail(p, p.id) });
      continue;
    }
    const id = p.id ?? neon.byName.get(p.name) ?? null;
    const alive = p.id ? neon.exists.get(p.id) === true : id !== null;
    if (alive) out.raise.push({ kind: 'rebuild-orphan-project', dedupKey: p.id ?? p.name, detail: orphanDetail(p, id) });
    else out.goneConfirmed.push(p);
  }

  // Workspaces that need a deploy.
  for (const d of f.deploy) {
    if (!MIGRATABLE.has(d.status) || !d.hasUrl) continue;
    const afterMigrated = (x: Date | null) => x !== null && (d.migratedAt === null || x.getTime() > d.migratedAt.getTime());
    const skippedBack = afterMigrated(d.skippedAt) && d.lastOkAt !== null && d.lastOkAt.getTime() > d.skippedAt!.getTime();
    const rebuilt = afterMigrated(d.linkedAt) && t - d.linkedAt!.getTime() >= HOUR;
    if (skippedBack || rebuilt) {
      out.raise.push({
        kind: 'workspace-needs-deploy', dedupKey: d.tenantId,
        detail: { slug: d.slug, reason: rebuilt ? 'rebuilt since the last deploy' : 'skipped by a deploy, reachable again', todo: 'run Deploy to Production (normal) now' },
      });
    }
  }

  // Stuck runs: raise and close them in the same run (the task's own final update never overwrites a closed row).
  const stuck = f.runs.filter((r) => r.status === 'running' && t - r.startedAt.getTime() > STUCK_MS);
  if (stuck.length > 0) {
    out.raise.push({ kind: 'disaster-run-stuck', dedupKey: '', detail: { runIds: stuck.map((r) => r.runId), todo: 'see RESTORE.md A.11; the run was closed as abandoned' } });
    out.closeRuns.push(...stuck.map((r) => r.id));
  }

  // Rehearsals.
  const rehearsals = f.runs.filter((r) => r.mode === 'rehearse' && r.status !== 'running').sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  const newest = rehearsals[0];
  const lastPass = rehearsals.find((r) => r.status === 'pass');
  const anchored = f.firstCpOkAt !== null && t - f.firstCpOkAt.getTime() > REHEARSAL_MAX_GAP_MS;
  const stale = anchored && (!lastPass || t - lastPass.startedAt.getTime() > REHEARSAL_MAX_GAP_MS);
  if ((newest && newest.status === 'fail') || stale) {
    out.raise.push({ kind: 'disaster-rehearse-failed', dedupKey: '', detail: { reason: newest?.status === 'fail' ? `the newest rehearsal (${newest.runId}) failed` : 'no rehearsal has passed in 40 days', todo: 'contact the lead (the disaster key or pipeline may not work)' } });
  }

  // The original watch (§7.2).
  for (const wch of f.watches) {
    if (neon.failed) continue;
    const exists = neon.exists.get(wch.oldProjectId);
    if (exists === true) {
      out.raise.push({ kind: 'rebuild-original-returned', dedupKey: wch.oldProjectId, detail: { ...wch.detail, todo: "the original exists. Don't open it: ask the customer whether their re-entered hours are complete, then delete it in the Neon console (runbook A.6)" } });
      continue;
    }
    const recoverable = neon.recoverable.has(wch.oldProjectId);
    if (recoverable && !wch.everReturned) {
      const until = neon.recoverable.get(wch.oldProjectId) ?? null;
      out.raise.push({ kind: 'rebuild-original-recoverable', dedupKey: wch.oldProjectId, detail: { ...wch.detail, recoverableUntil: until, todo: `the original can still be recovered in Neon until about ${until ?? '7 days after it was first seen'}. Recovering it won't switch the workspace back; it would become a 'returned' copy to settle with the customer (runbook A.6)` } });
    }
    if (!recoverable && t - wch.watchStartedAt.getTime() >= WATCH_MIN_MS) out.watchesDone.push(wch.oldProjectId);
  }

  if (neon.failed || !neon.keyOk) {
    out.raise.push({ kind: 'rebuild-watch-check-failed', dedupKey: '', detail: { keyOk: neon.keyOk, todo: neon.keyOk ? 'a Neon call failed; it is retried tomorrow' : "the app's Neon key can't see the organisation: use an Organization API key and set CONTROL_PLANE_PROJECT_ID (PRODUCTION-DEPLOY.md 5.5)" } });
  }
  return out;
}

function orphanDetail(p: ProjectGroup, id: string | null): Record<string, unknown> {
  return { tenantId: p.tenantId, slug: p.slug, projectId: id, projectName: p.name, status: p.latestStatus, todo: 'delete it in the Neon console' };
}

// ---- reading -------------------------------------------------------------------------------------------------------

export async function readDisasterFacts(now: Date): Promise<DisasterFacts> {
  return withLockedPool(async (db) => {
    const runs = await db.select({ id: disasterRuns.id, runId: disasterRuns.runId, mode: disasterRuns.mode, status: disasterRuns.status, startedAt: disasterRuns.startedAt, finishedAt: disasterRuns.finishedAt })
      .from(disasterRuns).where(sql`${disasterRuns.startedAt} > ${new Date(now.getTime() - 90 * DAY).toISOString()}::timestamptz OR ${disasterRuns.status} = 'running'`);
    const [cp] = await db.select({ at: sql<Date | null>`min(${databaseBackups.finishedAt})` }).from(databaseBackups)
      .where(and(isNull(databaseBackups.tenantId), eq(databaseBackups.status, 'ok')));
    const rows = await db.select({ name: disasterActions.projectName, id: disasterActions.newProjectId, status: disasterActions.status, at: disasterActions.at, tenantId: disasterActions.tenantId, oldProjectId: disasterActions.oldProjectId })
      .from(disasterActions).where(and(inArray(disasterActions.kind, ['rebuild', 'rehearse']), sql`${disasterActions.projectName} IS NOT NULL`))
      .orderBy(disasterActions.at);
    const groups = new Map<string, ProjectGroup>();
    for (const r of rows) {
      const g = groups.get(r.name!) ?? { name: r.name!, id: null, latestStatus: r.status, latestAt: r.at, tenantId: r.tenantId, slug: null, oldProjectId: null, referencedBy: null };
      g.id = r.id ?? g.id;
      g.oldProjectId = r.oldProjectId ?? g.oldProjectId;
      g.tenantId = r.tenantId ?? g.tenantId;
      g.latestStatus = r.status;
      g.latestAt = r.at;
      groups.set(g.name, g);
    }
    const allTenants = await db.select({ id: tenants.id, slug: tenants.slug, status: tenants.status, url: tenants.dbUrlEncrypted, projectId: tenants.neonProjectId }).from(tenants);
    const byId = new Map(allTenants.map((x) => [x.id, x]));
    const byProject = new Map(allTenants.filter((x) => x.projectId && x.status !== 'deleted').map((x) => [x.projectId!, x.id]));
    for (const g of groups.values()) {
      g.slug = g.tenantId ? byId.get(g.tenantId)?.slug ?? null : null;
      g.referencedBy = g.id ? byProject.get(g.id) ?? null : null;
    }
    const per = await db.select({
      tenantId: disasterActions.tenantId,
      skippedAt: sql<Date | null>`max(${disasterActions.at}) FILTER (WHERE ${disasterActions.kind} = 'skip' AND ${disasterActions.status} = 'skipped')`,
      migratedAt: sql<Date | null>`max(${disasterActions.at}) FILTER (WHERE ${disasterActions.kind} = 'skip' AND ${disasterActions.status} = 'migrated')`,
      linkedAt: sql<Date | null>`max(${disasterActions.at}) FILTER (WHERE ${disasterActions.kind} = 'rebuild' AND ${disasterActions.status} = 'linked')`,
    }).from(disasterActions).where(sql`${disasterActions.tenantId} IS NOT NULL`).groupBy(disasterActions.tenantId);
    const oks = await db.select({ tenantId: databaseBackups.tenantId, at: sql<Date | null>`max(${databaseBackups.finishedAt})` }).from(databaseBackups)
      .where(and(eq(databaseBackups.status, 'ok'), sql`${databaseBackups.tenantId} IS NOT NULL`)).groupBy(databaseBackups.tenantId);
    const okBy = new Map(oks.map((o) => [o.tenantId!, o.at ? new Date(o.at) : null]));
    const toDate = (x: Date | string | null) => (x === null ? null : new Date(x));
    const deploy: DeployFact[] = per.filter((p) => byId.has(p.tenantId!)).map((p) => {
      const tn = byId.get(p.tenantId!)!;
      return { tenantId: tn.id, slug: tn.slug, status: tn.status, hasUrl: tn.url !== null, skippedAt: toDate(p.skippedAt), migratedAt: toDate(p.migratedAt), linkedAt: toDate(p.linkedAt), lastOkAt: okBy.get(tn.id) ?? null };
    });
    const openWatches = await db.select({ dedupKey: opsAlerts.dedupKey, detail: opsAlerts.detail, firstSeenAt: opsAlerts.firstSeenAt }).from(opsAlerts)
      .where(and(eq(opsAlerts.kind, 'rebuild-original-watch'), isNull(opsAlerts.resolvedAt)));
    const returned = await db.select({ dedupKey: opsAlerts.dedupKey }).from(opsAlerts).where(eq(opsAlerts.kind, 'rebuild-original-returned'));
    const everReturned = new Set(returned.map((r) => r.dedupKey));
    const watches: WatchFact[] = openWatches.map((wt) => {
      const d = (wt.detail ?? {}) as Record<string, unknown>;
      const started = typeof d.watchStartedAt === 'string' ? new Date(d.watchStartedAt) : wt.firstSeenAt;
      return { oldProjectId: wt.dedupKey, tenantId: (d.tenantId as string) ?? null, slug: (d.slug as string) ?? null, watchStartedAt: started, everReturned: everReturned.has(wt.dedupKey), detail: d };
    });
    return { runs, firstCpOkAt: toDate(cp?.at ?? null), projects: [...groups.values()], deploy, watches };
  });
}

// ---- Neon (the app's organisation key) -----------------------------------------------------------------------------

export type NeonFetch = (path: string) => Promise<{ status: number; json: Record<string, unknown> | null }>;

export function appNeonFetch(apiKey: string, fetchImpl: typeof fetch = fetch): NeonFetch {
  return async (path) => {
    const res = await fetchImpl(`${NEON_API_BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    let json: Record<string, unknown> | null = null;
    try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
    return { status: res.status, json };
  };
}

async function listAll(neon: NeonFetch, q: string): Promise<Array<{ id: string; name: string; recoverable_until?: string }>> {
  const out: Array<{ id: string; name: string; recoverable_until?: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = await neon(`/projects?limit=400${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200 || !r.json) throw new Error(`neon list: HTTP ${r.status}`);
    if (Array.isArray(r.json.unavailable_project_ids) && r.json.unavailable_project_ids.length > 0) throw new Error('neon list: incomplete');
    const items = (Array.isArray(r.json.projects) ? r.json.projects : []) as Array<{ id: string; name: string; recoverable_until?: string }>;
    out.push(...items);
    const next = (r.json.pagination as { cursor?: string } | undefined)?.cursor;
    if (items.length === 0 || !next || next === cursor) break;
    cursor = next;
  }
  return out;
}

/** Every Neon read today's checks need; any failure marks the view failed (nothing Neon-based is resolved). */
export async function observeNeon(f: DisasterFacts, now: Date, neon: NeonFetch | null, controlPlaneProjectId: string | undefined): Promise<NeonView> {
  const view: NeonView = { failed: false, keyOk: false, exists: new Map(), byName: new Map(), recoverable: new Map() };
  if (!neon) return { ...view, failed: true };
  try {
    const all = await listAll(neon, '');
    view.keyOk = Boolean(controlPlaneProjectId) && all.some((p) => p.id === controlPlaneProjectId);
    const leftovers = f.projects.filter((p) => ['intended', 'created', 'failed'].includes(p.latestStatus) && now.getTime() - p.latestAt.getTime() > LEFTOVER_AFTER_MS && !(p.id && p.referencedBy));
    const ids = new Set([...leftovers.map((p) => p.id).filter((x): x is string => Boolean(x)), ...f.watches.map((w) => w.oldProjectId)]);
    for (const id of ids) {
      const r = await neon(`/projects/${encodeURIComponent(id)}`);
      if (r.status === 404) view.exists.set(id, false);
      else if (r.status === 200) view.exists.set(id, true);
      else throw new Error(`neon get: HTTP ${r.status}`);
    }
    for (const p of leftovers.filter((x) => !x.id)) {
      const hit = (await listAll(neon, `&search=${encodeURIComponent(p.name)}`)).find((x) => x.name === p.name);
      view.byName.set(p.name, hit?.id ?? null);
    }
    if (f.watches.length > 0) for (const p of await listAll(neon, '&recoverable=true')) view.recoverable.set(p.id, p.recoverable_until ?? null);
  } catch {
    view.failed = true;
  }
  return view;
}

// ---- the sync (the cron step) --------------------------------------------------------------------------------------

const NEON_KINDS = new Set<DisasterAlertKind>(['rebuild-orphan-project', 'rebuild-original-returned', 'rebuild-original-recoverable']);
const FACT_KINDS = new Set<DisasterAlertKind>(['workspace-needs-deploy', 'disaster-run-stuck', 'disaster-rehearse-failed']);

export async function syncDisasterAlerts(now: Date, o: { neon?: NeonFetch | null; env?: Record<string, string | undefined> } = {}): Promise<{ synced: boolean; findings: number }> {
  const env = o.env ?? process.env;
  if (backupsExpected(env) !== 'on') return { synced: false, findings: 0 };
  const facts = await readDisasterFacts(now);
  const neonFetch = o.neon !== undefined ? o.neon : env.NEON_API_KEY ? appNeonFetch(env.NEON_API_KEY) : null;
  const view = await observeNeon(facts, now, neonFetch, env.CONTROL_PLANE_PROJECT_ID);
  const res = disasterFindings(facts, view, now);
  await withLockedPool(async (db) => {
    const tx = db as unknown as ControlTx;
    for (const id of res.closeRuns) {
      await db.update(disasterRuns).set({ status: 'fail', finishedAt: now, summary: sql`coalesce(${disasterRuns.summary}, '{}'::jsonb) || '{"detail":"abandoned"}'::jsonb` })
        .where(and(eq(disasterRuns.id, id), eq(disasterRuns.status, 'running')));
    }
    for (const p of res.goneConfirmed) {
      await db.insert(disasterActions).values({ runId: `digest-${now.toISOString().slice(0, 10)}`, tenantId: p.tenantId, kind: 'rebuild', status: 'gone-confirmed', projectName: p.name, newProjectId: p.id, oldProjectId: p.oldProjectId, at: now });
    }
    for (const p of res.healed) {
      await db.insert(disasterActions).values({ runId: `digest-${now.toISOString().slice(0, 10)}`, tenantId: p.tenantId, kind: 'rebuild', status: 'linked', projectName: p.name, newProjectId: p.id, oldProjectId: p.oldProjectId, detail: 'healed by the leftover check: the tenant row references it', at: now });
      if (p.oldProjectId) {
        await raiseAlert(tx, { tenantId: null, kind: 'rebuild-original-watch', dedupKey: p.oldProjectId, detail: { tenantId: p.tenantId, slug: p.slug, oldProjectId: p.oldProjectId, newProjectId: p.id, watchStartedAt: now.toISOString(), healed: true } }, now);
      }
    }
    for (const x of res.raise) await raiseAlert(tx, { tenantId: null, kind: x.kind, dedupKey: x.dedupKey || undefined, detail: x.detail }, now);
    for (const id of res.watchesDone) await resolveAlert(tx, { tenantId: null, kind: 'rebuild-original-watch', dedupKey: id }, now, 'watch done: 30 days, gone, not recoverable');
    const wanted = new Set(res.raise.map((x) => `${x.kind}|${x.dedupKey}`));
    const open = await db.select({ kind: opsAlerts.kind, dedupKey: opsAlerts.dedupKey }).from(opsAlerts)
      .where(and(isNull(opsAlerts.resolvedAt), eq(opsAlerts.scope, 'global'), inArray(opsAlerts.kind, [...NEON_KINDS, ...FACT_KINDS, 'rebuild-watch-check-failed'])));
    for (const a of open) {
      if (wanted.has(`${a.kind}|${a.dedupKey}`)) continue;
      const kind = a.kind as DisasterAlertKind;
      if (NEON_KINDS.has(kind) && view.failed) continue; // unknown today: leave it open
      await resolveAlert(tx, { tenantId: null, kind, dedupKey: a.dedupKey }, now, 'condition cleared');
    }
  });
  return { synced: true, findings: res.raise.length };
}

/** The cron's isolated step: a throw raises `rebuild-watch-check-failed` (best effort) and never stops the cron. */
export async function runDisasterMonitoring(now: Date): Promise<{ synced: boolean; findings: number } | { error: true }> {
  try {
    return await syncDisasterAlerts(now);
  } catch (err) {
    console.error('[disaster] monitoring failed:', (err as Error)?.name ?? 'error');
    try {
      await withLockedPool((db) => raiseAlert(db as unknown as ControlTx, { tenantId: null, kind: 'rebuild-watch-check-failed', detail: { todo: 'the daily disaster checks failed; retried tomorrow' } }, now));
    } catch { /* best effort */ }
    return { error: true };
  }
}

/** The digest's line (Backups section): disaster runs in the last 7 days. */
export async function disasterDigestLines(now: Date): Promise<string[]> {
  const runs = await withLockedPool((db) => db.select({ mode: disasterRuns.mode, status: disasterRuns.status, startedAt: disasterRuns.startedAt }).from(disasterRuns)
    .where(sql`${disasterRuns.startedAt} >= ${new Date(now.getTime() - 7 * DAY).toISOString()}::timestamptz`).orderBy(desc(disasterRuns.startedAt)));
  if (runs.length === 0) return ['Disaster runs in the last 7 days: none.'];
  return [`Disaster runs in the last 7 days: ${runs.map((r) => `${r.mode} ${r.status} at ${r.startedAt.toISOString()}`).join('; ')}.`];
}
