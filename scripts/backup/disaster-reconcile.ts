/**
 * The window reconcile (feature-plan-control-plane-disaster.md §6.4; state table §7.2 = R3's table): what changed after
 * the control-plane backup the rebuild used. Run by mode `control-plane` (step 9, against the new control plane), by mode
 * `reconcile` (the live control plane, re-runnable) and by the control-plane rehearsal (`dryRun`, against the copy).
 *
 * Invariant 4: it never deletes a project and never tombstones a tenant. Its only tenant writes re-apply confirmed `LINKED`
 * rebuilds with 3c's switch conditions (R2); everything else is proof rows, alerts, action rows and the email. Logs carry
 * ids only (`RELINKED <tenant> <start> <end>`); the email may name slugs (the topic is private).
 */
import type postgres from 'postgres';
import { decrypt, encrypt } from '../../src/lib/encryption';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { RT_NAME_RE } from './lib/keys';
import { classifyGoneEndpoint, pgConnector, tenantCandidateRule, type Connector } from './lib/classify-endpoint';
import { appendAction, ChangedMeanwhile, LOCK_TIMEOUT_SQLSTATE, raiseGlobalAlert, type TenantFacts } from './lib/disaster-sql';
import { NeonApiError, directHost, type NeonProject } from './lib/neon-api';
import { parseNeonHost } from './lib/neon-host';
import { clientUrl } from './lib/pg-url';
import { summaryOf } from './lib/summarize-error';
import { runPool } from './lib/util';
import type { RebuildLine } from './lib/log-reader';
import {
  CANARY_PROJECT_NAME, CONTROL_PLANE_REBUILD_NAME_RE, CONTROL_PLANE_REHEARSAL_NAME_RE, windowProjectType, type WindowProjectType,
} from './lib/project-names';
import { pollRecoverable, switchGuards, throwIfAborted, type Built, type StepEnv } from './disaster-steps';
import { rebuildSettings } from './disaster-settings';
import { DEFAULT_TIMING } from './disaster-workspace';
import type { DisasterDeps, RunContext, RunOutcome } from './disaster';

export interface ReconcileInput {
  /** The control plane to reconcile: the new one (mode control-plane), the live one (mode reconcile) or the rehearsal copy. */
  cp: postgres.Sql;
  /** Its direct host (R2's guard: a chain end may never be the control plane's host). */
  cpDirectHost: string;
  windowStart: Date;
  windowEnd: Date;
  runId: string;
  deps: DisasterDeps;
  /** §6.5: R2 resolves without switching, R4 raises nothing; R3's proof rows go into `cp` (the copy). */
  dryRun: boolean;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  signal: AbortSignal;
  /** The old and new control-plane project ids (R4 excludes them; R1's positive control may use them). */
  controlPlaneProjectIds: string[];
}

export type ReconcileClass =
  | 'fine' | 'in-progress' | 'lost' | 'window-deleted' | 'recoverable-deleted' | 'stale-project-id' | 'unconfirmed-rebuild' | 'unknown';

export interface ReconcileResult {
  r1Failed: boolean;
  counts: Record<string, number>;
  /** The run row's summary part (counts per class). */
  summary: Record<string, unknown>;
  /** Email lines (may name slugs: the topic is private). */
  email: string[];
  /** Per tenant (tests and the rehearsal). */
  classes: Map<string, { cls: ReconcileClass; slug: string; detail?: string }>;
  windowProjects: Array<{ projectId: string; name: string; createdAt: string | null; type: WindowProjectType; slug: string | null }>;
}

/** §6.4 R3: proof statuses written for each class (none for fine, in progress, unknown). New skippable ones in disaster-proofs.ts. */
const PROOF_OF: Partial<Record<ReconcileClass, string>> = {
  lost: 'gone', 'window-deleted': 'window-deleted', 'recoverable-deleted': 'recoverable-deleted', 'stale-project-id': 'refused:reachable', 'unconfirmed-rebuild': 'chain-unconfirmed',
};
const CLASSIFIED = new Set(['provisioning', 'active', 'suspended', 'deleting']);
const LIVE = new Set(['provisioning', 'active', 'suspended']);
const LIST_LIMIT = 200;
const MASS_WARNING_AT = 3;

interface Row extends TenantFacts {
  url: string | null;
}

type ChainOutcome =
  | { kind: 'applied'; start: string; end: string; chain: string[] }
  | { kind: 'would-apply'; start: string; end: string; chain: string[] }
  | { kind: 'already'; end: string }
  | { kind: 'listed'; reason: string; end: string | null }
  | { kind: 'unknown'; reason: string; end: string | null };

/** The reconcile's StepEnv (3c's helpers read neon, cp, cpDirectHost, args.runId, sleep, timing). */
function reconcileEnv(input: ReconcileInput, connect: Connector): StepEnv {
  return {
    args: { mode: 'reconcile', targets: 'control-plane', override: 'none', runId: input.runId }, deps: input.deps, cp: input.cp, cpId: input.deps.cpId,
    cpDirectHost: input.cpDirectHost, neon: input.deps.neon, connect, now: input.now, sleep: input.sleep, log: input.log, signal: input.signal,
    projectKind: 'rebuild', timing: { ...DEFAULT_TIMING, ...input.deps.timing },
  };
}

async function loadRows(cp: postgres.Sql): Promise<Row[]> {
  const rows = await cp<Array<TenantFacts>>`SELECT id::text AS id, slug, status::text AS status, db_url_encrypted AS "dbUrlEncrypted",
    neon_project_id AS "neonProjectId", deletion_scheduled_for AS "deletionScheduledFor" FROM tenants ORDER BY id`;
  return rows.map((r) => {
    let url: string | null = null;
    if (r.dbUrlEncrypted) { try { url = decrypt(r.dbUrlEncrypted); } catch { url = null; } }
    return { ...r, url };
  });
}

const isDue = (r: TenantFacts, now: Date) => r.status === 'deleting' || (r.deletionScheduledFor !== null && r.deletionScheduledFor.getTime() <= now.getTime());

// ---- R1 ---------------------------------------------------------------------------------------------------------------

interface SharedLegs { ok: boolean; projects: NeonProject[]; recoverable: Set<string>; reason?: string }

async function sharedLegs(input: ReconcileInput, env: StepEnv, rows: Row[]): Promise<SharedLegs> {
  const fail = (reason: string): SharedLegs => ({ ok: false, projects: [], recoverable: new Set(), reason });
  // Network first: a live workspace (up to 3), or the restore-test database.
  let network = false;
  let tried = 0;
  for (const r of rows) {
    if (!LIVE.has(r.status) || !r.url || tried >= 3) continue;
    tried++;
    if ((await env.connect(r.url)).cls === 'ok') { network = true; break; }
  }
  if (!network && input.deps.restoreTestUrl) network = (await env.connect(input.deps.restoreTestUrl)).cls === 'ok';
  if (!network) return fail("this task's own network couldn't be proven");
  // The positive control: a complete list containing the restore-test or a control-plane project, which answers 200.
  let projects: NeonProject[];
  try {
    const all = await input.deps.neon.listProjects();
    if (all.unavailable.length > 0) return fail('the organisation list was incomplete');
    projects = all.projects;
  } catch (e) {
    return fail(`the organisation list failed (${summaryOf('neon', e)})`);
  }
  const listed = new Set(projects.map((p) => p.id));
  let control = false;
  for (const id of [input.deps.restoreTestProjectId, ...input.controlPlaneProjectIds]) {
    if (!id || !listed.has(id)) continue;
    try { if ((await input.deps.neon.getProject(id)).found) { control = true; break; } } catch { /* the next */ }
  }
  if (!control) return fail("the positive control failed (the key or org can't see the restore-test or control-plane project)");
  const rec = await pollRecoverable(env);
  if (!rec) return fail('the recoverable list was incomplete or failed');
  return { ok: true, projects, recoverable: rec.ids };
}

// ---- R2 ---------------------------------------------------------------------------------------------------------------

const neonStatus = (e: unknown) => (e instanceof NeonApiError ? e.status : 0);
const isGoneStatus = (s: number) => s === 403 || s === 404;

/** §6.4 R2 for one tenant: follow its links from the row's project to the chain's end; check only the end. */
async function resolveChain(input: ReconcileInput, env: StepEnv, row: Row | undefined, lines: RebuildLine[], legs: SharedLegs): Promise<ChainOutcome> {
  if (lines.some((l) => l.kind === 'LINKED' && l.healed && l.oldProjectId === null)) {
    return { kind: 'listed', reason: "a healed LINKED line has no old project id, so the chain can't be followed", end: null };
  }
  const links = lines.filter((l) => l.kind === 'LINKED' || l.kind === 'RELINKED').sort((a, b) => a.at - b.at);
  if (!row) return { kind: 'listed', reason: 'no tenant row for these rebuild lines', end: null };
  if (row.status === 'deleted') return { kind: 'listed', reason: 'the tenant row is deleted', end: null };
  const start = row.neonProjectId;
  if (!start) return { kind: 'listed', reason: 'the tenant row has no project id', end: null };
  const inChains = links.some((l) => l.oldProjectId === start || l.newProjectId === start) || lines.some((l) => l.kind === 'SWITCHING' && l.oldProjectId === start);
  if (!inChains) return { kind: 'listed', reason: "the row's project is outside every rebuild chain", end: null };
  const chain = [start];
  let end = start;
  for (const l of links) if (l.oldProjectId === end && l.newProjectId !== end) { end = l.newProjectId; chain.push(end); }
  // A SWITCHING at the chain's end with no matching LINKED: that commit may or may not have happened.
  const open = lines.find((l) => l.kind === 'SWITCHING' && l.oldProjectId === end && !links.some((k) => k.oldProjectId === end && k.newProjectId === l.newProjectId));
  if (open) return { kind: 'listed', reason: `a SWITCHING line (${end} → ${open.newProjectId}) has no matching LINKED`, end };
  if (end === start) return { kind: 'already', end };
  if (!legs.ok) return { kind: 'unknown', reason: 'the shared proof failed', end };
  if (!LIVE.has(row.status) || isDue(row, input.now())) return { kind: 'listed', reason: `the row is ${row.status}${isDue(row, input.now()) ? ', due for deletion' : ''}`, end };
  if (!row.dbUrlEncrypted) return { kind: 'listed', reason: 'the row has no database URL', end };
  // 2. the end answers 200.
  let endName = '';
  try {
    const g = await input.deps.neon.getProject(end);
    if (!g.found) return { kind: 'listed', reason: `the chain's end ${end} is gone (404)`, end };
    endName = g.project.name;
  } catch (e) {
    return { kind: 'unknown', reason: `the chain's end lookup failed (${summaryOf('neon', e)})`, end };
  }
  // 3–4. the database's owner role, then the pooled URI (approved detail D5).
  let stored: string;
  try {
    const branches = await input.deps.neon.listBranches(end);
    const branch = branches.find((b) => b.isDefault);
    if (!branch) return { kind: 'listed', reason: `the chain's end ${end} has no default branch`, end };
    const dbName = rebuildSettings(row.slug).databaseName;
    const db = (await input.deps.neon.listDatabases(end, branch.id)).find((d) => d.name === dbName);
    if (!db) return { kind: 'listed', reason: `the chain's end ${end} has no database ${dbName}`, end };
    const uri = await input.deps.neon.getConnectionUri({ projectId: end, branchId: branch.id, databaseName: dbName, roleName: db.ownerName, pooled: true });
    stored = clientUrl(uri); // sslmode only: postgres.js would send channel_binding to the server as a startup setting
  } catch (e) {
    const s = neonStatus(e);
    if (isGoneStatus(s)) return { kind: 'listed', reason: `the chain's end ${end} refused its connection details (HTTP ${s})`, end };
    return { kind: 'unknown', reason: `the chain's end connection details failed (${summaryOf('neon', e)})`, end };
  }
  // 6. the guards: a pooled us-east-1 Neon host, not an rt_ database, 3c's switchGuards with the NEW control plane's host.
  const u = new URL(stored);
  const parsed = parseNeonHost(u.hostname);
  if (!parsed || parsed.region !== 'us-east-1' || !parsed.pooled) return { kind: 'listed', reason: "the chain's end URI is not a pooled us-east-1 Neon host", end };
  if (RT_NAME_RE.test(decodeURIComponent(u.pathname.replace(/^\//, '')))) return { kind: 'listed', reason: "the chain's end URI names a restore-test database", end };
  const built: Built = { projectId: end, name: endName, pooledUri: stored, connectionUri: toDirectConnectionUrl(stored), counts: {}, backupStartedAt: null };
  let guard: string | null;
  try {
    guard = await switchGuards(env, row, built);
  } catch (e) {
    return { kind: 'unknown', reason: `the guards failed (${summaryOf('guards', e)})`, end };
  }
  if (guard) return { kind: 'listed', reason: guard, end };
  if (input.dryRun) return { kind: 'would-apply', start, end, chain };
  // 5, 7–10. one guarded UPDATE with switchWorkspace's conditions, under the tenant lock.
  const r = await applyChain(input, env, row, built, start, chain);
  if (r === 'linked') {
    input.log(`RELINKED ${row.id} ${start} ${end}`);
    return { kind: 'applied', start, end, chain };
  }
  return { kind: 'unknown', reason: r === 'changed-meanwhile' ? 'the row changed meanwhile: re-run reconcile' : 'the tenant lock stayed busy: re-run reconcile', end };
}

async function applyChain(input: ReconcileInput, env: StepEnv, row: Row, built: Built, start: string, chain: string[]): Promise<'linked' | 'changed-meanwhile' | 'lock-timeout'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await input.cp.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '5s'");
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + row.id}))`;
        const at = input.now();
        const rows = await tx`UPDATE tenants SET db_url_encrypted = ${encrypt(built.pooledUri)}, neon_project_id = ${built.projectId},
            lifecycle_version = lifecycle_version + 1, updated_at = now()
          WHERE id = ${row.id} AND status IN ('provisioning', 'active', 'suspended')
            AND db_url_encrypted = ${row.dbUrlEncrypted} AND neon_project_id = ${start}
            AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for > now())
          RETURNING id`;
        if (rows.length === 0) throw new ChangedMeanwhile();
        const detail = { reapplied: true, chain, oldProjectId: start, newProjectId: built.projectId };
        await tx`INSERT INTO tenant_audit_events (tenant_id, kind, detail, actor, created_at)
          VALUES (${row.id}, 'database-rebuilt', ${JSON.stringify(detail)}, ${`disaster:${input.runId}`.slice(0, 100)}, ${at})`;
        await appendAction(tx, { runId: input.runId, tenantId: row.id, kind: 'rebuild', status: 'linked', projectName: built.name || null, newProjectId: built.projectId, oldProjectId: start, detail: 'reapplied by the reconcile' }, at);
        await raiseGlobalAlert(tx, { kind: 'rebuild-original-watch', dedupKey: start, detail: { tenantId: row.id, slug: row.slug, oldProjectId: start, newProjectId: built.projectId, backupStartedAt: null, watchStartedAt: at.toISOString(), override: false, reapplied: true } }, at);
      });
      return 'linked';
    } catch (e) {
      if (e instanceof ChangedMeanwhile) return 'changed-meanwhile';
      if ((e as { code?: string })?.code === LOCK_TIMEOUT_SQLSTATE) {
        if (attempt > 3) return 'lock-timeout';
        await input.sleep(env.timing.lockRetryMs);
        continue;
      }
      throw e;
    }
  }
}

// ---- R3 ---------------------------------------------------------------------------------------------------------------

async function classify(input: ReconcileInput, env: StepEnv, row: Row, chain: ChainOutcome | undefined, legs: SharedLegs): Promise<{ cls: ReconcileClass; detail?: string }> {
  if (chain?.kind === 'listed') return { cls: 'unconfirmed-rebuild', detail: chain.reason };
  if (!row.neonProjectId) return { cls: 'unknown', detail: 'no Neon project id on record' };
  if (!legs.ok) return { cls: 'unknown', detail: legs.reason };
  if (chain?.kind === 'unknown') return { cls: 'unknown', detail: chain.reason };
  const project = row.neonProjectId;
  let found: boolean;
  try {
    found = (await input.deps.neon.getProject(project)).found;
  } catch (e) {
    return { cls: 'unknown', detail: `the project lookup failed (${summaryOf('neon', e)})` };
  }
  if (found) return row.status === 'deleting' || row.status === 'provisioning' ? { cls: 'in-progress', detail: row.status } : { cls: 'fine' };
  if (!row.url) return { cls: 'unknown', detail: 'no database URL to check' };
  const d = await classifyGoneEndpoint({ url: row.url, connect: env.connect, neon: input.deps.neon, rule: tenantCandidateRule(row.slug, row.id) });
  if (d.cls === 'answers' || d.cls === 'served') return { cls: 'stale-project-id', detail: d.cls === 'answers' ? 'its address still answers' : 'a live project serves its address' };
  if (d.cls === 'unproven') return { cls: 'unknown', detail: "the address check couldn't be completed" };
  if (isDue(row, input.now())) return { cls: 'window-deleted' };
  if (legs.recoverable.has(project)) return { cls: 'recoverable-deleted' };
  return { cls: 'lost' };
}

// ---- the whole reconcile ------------------------------------------------------------------------------------------------

export async function runReconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { log } = input;
  const connect: Connector = input.deps.connector ?? pgConnector({ hostMap: input.deps.hostMap });
  const env = reconcileEnv(input, connect);
  if (!input.deps.disasterLogReader) throw new Error('DISASTER_LOG_GROUP is not configured');
  log(`reconcile ${input.dryRun ? '(dry run) ' : ''}window ${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()}`);
  const rows = await loadRows(input.cp);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // R1, once.
  const legs = await sharedLegs(input, env, rows);
  if (!legs.ok) log(`reconcile: the shared proof failed (${legs.reason}); every tenant is unknown`);

  // R2: the window's rebuild lines, per tenant.
  throwIfAborted(input.signal);
  const lines = await input.deps.disasterLogReader.rebuildLines(input.windowStart);
  const perTenant = new Map<string, RebuildLine[]>();
  for (const l of lines) perTenant.set(l.tenantId, [...(perTenant.get(l.tenantId) ?? []), l]);
  const chains = new Map<string, ChainOutcome>();
  /** Every `new` project id in each tenant's rebuild lines (fix round 1, FR2: a listed chain's projects are kept). */
  const chainProjects = new Map<string, string[]>();
  for (const [tenantId, ls] of perTenant) chainProjects.set(tenantId, [...new Set(ls.map((l) => l.newProjectId))].sort());
  for (const [tenantId, ls] of [...perTenant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    throwIfAborted(input.signal);
    const c = await resolveChain(input, env, byId.get(tenantId), ls, legs);
    chains.set(tenantId, c);
    if (c.kind === 'listed' || c.kind === 'unknown') log(`reconcile: ${tenantId} rebuild chain ${c.kind}`);
  }
  // Re-applied rows changed: read them again before classifying.
  const fresh = [...chains.values()].some((c) => c.kind === 'applied') ? await loadRows(input.cp) : rows;

  // R3, concurrency 4.
  const classes = new Map<string, { cls: ReconcileClass; slug: string; detail?: string }>();
  const targets = fresh.filter((r) => CLASSIFIED.has(r.status));
  await runPool(targets, 4, async (row) => {
    throwIfAborted(input.signal);
    let c: { cls: ReconcileClass; detail?: string };
    try {
      c = await classify(input, env, row, chains.get(row.id), legs);
    } catch (e) {
      c = { cls: 'unknown', detail: summaryOf('classify', e) };
    }
    classes.set(row.id, { ...c, slug: row.slug });
    const status = PROOF_OF[c.cls];
    if (status) await appendAction(input.cp, { runId: input.runId, tenantId: row.id, kind: 'proof', status, oldProjectId: row.neonProjectId, detail: `reconcile${c.detail ? `: ${c.detail}` : ''}`.slice(0, 500) }, input.now());
  });

  // R4: projects created in the window.
  const windowProjects: ReconcileResult['windowProjects'] = [];
  const alertIds = new Map<string, string>();
  if (legs.ok) {
    const referenced = new Set(rows.map((r) => r.neonProjectId).filter((x): x is string => Boolean(x)));
    const chainEnds = new Set([...chains.values()].map((c) => ('end' in c ? c.end : null)).filter((x): x is string => Boolean(x)));
    // FR2: every project a LISTED (or unknown) chain names is kept out of R4, ends or not: with no resolvable end (no row,
    // a deleted row, a row off the chain, a healed `-`), its new project may be a customer's only copy, so it must never
    // be offered as a `rebuild` to delete. They're named under "unconfirmed rebuilds" instead.
    for (const [tenantId, c] of chains) if (c.kind === 'listed' || c.kind === 'unknown') for (const id of chainProjects.get(tenantId) ?? []) chainEnds.add(id);
    const alerted = new Set((await input.cp<Array<{ k: string }>>`SELECT dedup_key AS k FROM ops_alerts WHERE kind = 'window-project'`).map((a) => a.k));
    const lo = input.windowStart.getTime() - 3600_000;
    const hi = input.windowEnd.getTime();
    for (const p of legs.projects.sort((a, b) => a.id.localeCompare(b.id))) {
      const created = p.createdAt ? Date.parse(p.createdAt) : NaN;
      if (!(created > lo && created <= hi)) continue;
      if (referenced.has(p.id) || input.controlPlaneProjectIds.includes(p.id) || p.id === input.deps.restoreTestProjectId) continue;
      if (CONTROL_PLANE_REBUILD_NAME_RE.test(p.name) || CONTROL_PLANE_REHEARSAL_NAME_RE.test(p.name) || p.name === CANARY_PROJECT_NAME) continue;
      if (chainEnds.has(p.id) || alerted.has(p.id)) continue;
      const t = windowProjectType(p.name);
      windowProjects.push({ projectId: p.id, name: p.name, createdAt: p.createdAt ?? null, type: t.type, slug: t.slug });
    }
    if (!input.dryRun) {
      for (const wp of windowProjects) {
        const at = input.now();
        await raiseGlobalAlert(input.cp, { kind: 'window-project', dedupKey: wp.projectId, detail: { projectId: wp.projectId, name: wp.name, createdAt: wp.createdAt, slug: wp.slug, type: wp.type } }, at);
        // FR6: the alert's id, printed in the email (B.9 resolves it by id).
        const [a] = await input.cp<Array<{ id: string }>>`SELECT id::text AS id FROM ops_alerts WHERE kind = 'window-project' AND dedup_key = ${wp.projectId} AND resolved_at IS NULL`;
        if (a) alertIds.set(wp.projectId, a.id);
        await appendAction(input.cp, { runId: input.runId, tenantId: null, kind: 'window-project', status: 'listed', projectName: wp.name, newProjectId: wp.projectId, detail: wp.type }, at);
      }
    }
  }

  // R5: counts, lists, the email.
  const counts: Record<string, number> = {};
  for (const k of ['fine', 'in-progress', 'lost', 'window-deleted', 'recoverable-deleted', 'stale-project-id', 'unconfirmed-rebuild', 'unknown'] as const) counts[k] = 0;
  for (const c of classes.values()) counts[c.cls]++;
  const chainCount = (k: ChainOutcome['kind']) => [...chains.values()].filter((c) => c.kind === k).length;
  counts.reapplied = chainCount('applied');
  counts['would-reapply'] = chainCount('would-apply');
  counts['already-applied'] = chainCount('already');
  counts['window-projects'] = windowProjects.length;
  const email = reconcileEmail(input, legs, classes, chains, byId, windowProjects, counts, chainProjects, alertIds);
  const summary = { windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(), dryRun: input.dryRun, r1Failed: !legs.ok, counts };
  log(`reconcile counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return { r1Failed: !legs.ok, counts, summary, email, classes, windowProjects };
}

function reconcileEmail(
  input: ReconcileInput, legs: SharedLegs, classes: ReconcileResult['classes'], chains: Map<string, ChainOutcome>, byId: Map<string, Row>,
  windowProjects: ReconcileResult['windowProjects'], counts: Record<string, number>,
  chainProjects: Map<string, string[]>, alertIds: Map<string, string>,
): string[] {
  const out: string[] = [];
  const list = (ids: string[], fmt: (id: string) => string) => {
    const lines = ids.slice(0, LIST_LIMIT).map((id) => `  - ${fmt(id)}`);
    if (ids.length > LIST_LIMIT) lines.push(`  … and ${ids.length - LIST_LIMIT} more (the full list is in the disaster log by id)`);
    return lines;
  };
  const of = (cls: ReconcileClass) => [...classes.entries()].filter(([, c]) => c.cls === cls).map(([id]) => id).sort();
  const named = (id: string) => { const c = classes.get(id); return `${id} (${c?.slug ?? byId.get(id)?.slug ?? '?'})${c?.detail ? `: ${c.detail}` : ''}`; };
  const massCount = counts['window-deleted'] + counts['recoverable-deleted'];
  if (massCount >= MASS_WARNING_AT) out.push(`POSSIBLE MASS DELETION (${massCount} workspaces deleted in the window): check Neon's status page and console before closing any workspace.`);
  out.push(`Reconcile${input.dryRun ? ' (dry run, on the rehearsal copy)' : ''}: the window is ${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()} UTC.`);
  if (!legs.ok) out.push(`The shared proof failed (${legs.reason}): every workspace is unknown. Press mode reconcile again later (RESTORE.md B.5a).`);
  out.push(`Counts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const unconfirmed = of('unconfirmed-rebuild');
  const lost = of('lost');
  // FR4: all-lost is offered only when no workspace is an unconfirmed rebuild AND no workspace with rebuild lines in the
  // window is unknown (its chain couldn't be checked, so it has no chain-unconfirmed proof for all-lost to skip).
  const chainUnknown = [...chains.entries()].some(([id, c]) => c.kind === 'unknown' || classes.get(id)?.cls === 'unknown');
  const offerAllLost = unconfirmed.length === 0 && !chainUnknown;
  const section = (title: string, ids: string[], todo: string) => { if (ids.length) out.push(`${title} (${ids.length}): ${todo}`, ...list(ids, named)); };
  section('Lost', lost, offerAllLost
    ? 'runbook A from step 3; press mode workspace with all-lost (check your deletion receipts for the window first; deleted on purpose → `tenant:delete <slug> --project-proven-gone --force-with-reason`).'
    : `runbook A from step 3, pressing these ids explicitly (NOT all-lost: ${unconfirmed.length ? 'an unconfirmed rebuild is listed below' : 'a workspace rebuilt in the window is still unknown; press reconcile again first'}): ${lost.join(',')}. Check your deletion receipts for the window first.`);
  section('Deleted in the window', of('window-deleted'), 'npm run tenant:delete -- <slug> --project-proven-gone --yes. If it aborts on a live subscription, the deletion was cancelled in the window: treat it as lost (runbook A).');
  section('Recoverable, not due', of('recoverable-deleted'), 'check your deletion receipts for the window first. Not deleted on purpose → recover it in the Neon console. Deleted on purpose (e.g. forced) → `--project-proven-gone --force-with-reason`.');
  section('In progress', of('in-progress'), '`deleting` → re-run `npm run tenant:delete -- <slug>` (it finishes or restores); `provisioning` → contact the lead.');
  section('Stale project id', of('stale-project-id'), 'contact the lead.');
  // FR2: every listed chain (classified or not) names the projects it kept.
  const kept = (id: string) => { const ps = chainProjects.get(id) ?? []; return ps.length ? `; project(s) ${ps.join(', ')} kept: contact the lead; don't delete` : ''; };
  const orphanListed = [...chains.entries()].filter(([id, c]) => c.kind === 'listed' && !classes.has(id)).map(([id]) => id).sort();
  const allUnconfirmed = [...unconfirmed, ...orphanListed];
  if (allUnconfirmed.length) {
    out.push(`Unconfirmed rebuilds (${allUnconfirmed.length}): contact the lead; never all-lost. The newest data may sit in a rebuilt project.`);
    out.push(...list(allUnconfirmed, (id) => {
      const c = chains.get(id) as { reason?: string } | undefined;
      const slug = classes.get(id)?.slug ?? byId.get(id)?.slug;
      return `${id}${slug ? ` (${slug})` : ''}: ${classes.get(id)?.detail ?? c?.reason ?? 'listed'}${kept(id)}`;
    }));
  }
  section('Unknown', of('unknown'), 'press mode reconcile again later; if the same workspace is unknown after 2 presses, contact the lead.');
  const reapplied = [...chains.entries()].filter(([, c]) => c.kind === 'applied' || c.kind === 'would-apply');
  if (reapplied.length) {
    out.push(`Rebuilds ${input.dryRun ? 'that would be re-applied' : 're-applied'} from the window (${reapplied.length}):`);
    out.push(...list(reapplied.map(([id]) => id), (id) => { const c = chains.get(id) as { start: string; end: string }; return `${id} (${byId.get(id)?.slug ?? '?'}): ${c.start} → ${c.end}`; }));
  }
  if (counts['already-applied']) out.push(`Rebuilds already applied: ${counts['already-applied']}.`);
  const orphanChains = [...chains.entries()].filter(([id, c]) => c.kind === 'unknown' && !classes.has(id)).map(([id]) => id).sort();
  if (orphanChains.length) {
    out.push(`Rebuild lines that couldn't be checked, for workspaces this control plane doesn't classify (${orphanChains.length}): press reconcile again later; contact the lead if it repeats.`);
    out.push(...list(orphanChains, (id) => { const c = chains.get(id) as { reason: string }; return `${id}${byId.get(id) ? ` (${byId.get(id)!.slug})` : ''}: ${c.reason}${kept(id)}`; }));
  }
  if (windowProjects.length) {
    out.push(`Projects created in the window (${windowProjects.length}), each with a window-project alert${input.dryRun ? ' (not raised: dry run)' : ''}:`);
    for (const type of ['signup', 'rebuild', 'other'] as const) {
      const ps = windowProjects.filter((p) => p.type === type);
      if (!ps.length) continue;
      const todo = type === 'signup'
        ? 'find the person (`npm run tenant:admin -- window-signup <slug>`, then Stripe, then the email log), refund and cancel, resolve the alert, email template B2; delete the project BY ID once they confirm (Q3: by id 30 days after this reconcile if nobody can be found; never a staging workspace).'
        : type === 'rebuild' ? 'delete it in Neon if nothing in this email names it.' : 'staging, or unknown: resolve the alert by hand.';
      out.push(`  ${type} (${ps.length}): ${todo}`);
      out.push(...list(ps.map((p) => p.projectId), (id) => { const p = ps.find((x) => x.projectId === id)!; return `${p.projectId} ${p.name} created ${p.createdAt ?? '?'}${p.slug ? ` (slug ${p.slug})` : ''}${alertIds.get(id) ? `; alert ${alertIds.get(id)}` : ''}`; }));
    }
  }
  return out;
}

// ---- mode `reconcile` (standalone; §6.4 "Inputs") -----------------------------------------------------------------------

/**
 * Standalone, against the LIVE control plane (3c's normal start: lock, run row of mode `reconcile`, target
 * control-plane). The window comes from the newest `control-plane` run row; none → `no-rebuild`. Pass (exit 0) when it
 * completes, even with `unknown` listed; fail only when R1 fails or it throws (approved detail P1).
 */
export async function runReconcileMode(ctx: RunContext): Promise<RunOutcome> {
  const head = `Reconcile (mode reconcile), run ${ctx.args.runId}.`;
  const [last] = await ctx.cp<Array<{ summary: Record<string, unknown> | null }>>`SELECT summary FROM disaster_runs WHERE mode = 'control-plane' ORDER BY started_at DESC, id DESC LIMIT 1`;
  const s = last?.summary ?? null;
  const start = typeof s?.backupStartedAt === 'string' ? new Date(s.backupStartedAt) : null;
  const end = typeof s?.cpRunStartedAt === 'string' ? new Date(s.cpRunStartedAt) : null;
  if (!s || !end || Number.isNaN(end.getTime())) {
    return { pass: false, results: [{ tenantId: 'control-plane', result: 'no-rebuild' }], email: [head, 'Refused (no-rebuild): this control plane has no control-plane rebuild run to reconcile. Nothing was changed.'] };
  }
  const ids = [s.previousProjectId, s.newProjectId, ctx.deps.controlPlaneProjectId].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const r = await runReconcile({
    cp: ctx.cp, cpDirectHost: directHost(new URL(toDirectConnectionUrl(ctx.deps.controlPlaneUrl)).hostname),
    windowStart: start && !Number.isNaN(start.getTime()) ? start : end, windowEnd: end, runId: ctx.args.runId, deps: ctx.deps, dryRun: false,
    now: ctx.now, sleep: ctx.sleep, log: ctx.log, signal: ctx.signal, controlPlaneProjectIds: [...new Set(ids)],
  });
  return {
    pass: !r.r1Failed,
    results: [{ tenantId: 'control-plane', result: r.r1Failed ? 'shared-proof-failed' : 'reconciled' }],
    summary: { reconcile: r.summary },
    email: [head, ...r.email, '', 'Next: RESTORE.md runbook B from where you are (B.5a re-press while any workspace is unknown; B.9 the lists above).'],
  };
}
