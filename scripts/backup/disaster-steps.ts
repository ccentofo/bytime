/**
 * The steps of a disaster rebuild (feature-plan-disaster-restore.md §6.4, §6.4.1), shared by mode `workspace`
 * (disaster-workspace.ts) and mode `rehearse` (disaster-rehearse.ts). Every log line carries ids only (invariant 6).
 */
import type postgres from 'postgres';
import { decrypt, encrypt } from '../../src/lib/encryption';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { baseKey, DUMP_SUFFIX, sidecarKeyFor, targetPrefix } from './lib/keys';
import { decryptBuffer, encryptionContext } from './lib/crypto';
import { restoreObject } from './lib/restore-stream';
import { childConnection, childEnv, clientUrl } from './lib/pg-url';
import { compareCounts, countTables, describeDiffs } from './lib/counts';
import { realSpawn } from './lib/child';
import { labelFor, StageError, summaryOf } from './lib/summarize-error';
import { parseNeonHost } from './lib/neon-host';
import { connectUrl } from './lib/host-map';
import { createdIdOf, directHost, NeonApiError, type NeonApi } from './lib/neon-api';
import {
  candidateServes, classifyGoneEndpoint, classifyOverride, pgQuery, tenantCandidateRule, type Connector, type OverrideClass,
} from './lib/classify-endpoint';
import {
  appendAction, ChangedMeanwhile, evidenceFacts, liveTenants, lockedProjectId, okBackupRows, otherTenants, raiseGlobalAlert,
  LOCK_TIMEOUT_SQLSTATE, type EvidenceFacts, type TenantFacts,
} from './lib/disaster-sql';
import type { DisasterArgs, DisasterDeps } from './disaster';
import { rebuildSettings } from './disaster-settings';
import { rebuildName } from './lib/project-names';
import postgresLib from 'postgres';

export const HOUR = 3600_000;

/** Everything the steps share within one run. */
export interface StepEnv {
  args: DisasterArgs;
  deps: DisasterDeps;
  cp: postgres.Sql;
  cpId: string;
  cpDirectHost: string;
  neon: NeonApi;
  connect: Connector;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** The run's signal ('deadline' or 'stopped'). */
  signal: AbortSignal;
  /** `rebuild` (workspace) or `rehearse`: the kind of the project rows. */
  projectKind: 'rebuild' | 'rehearse';
  /** Seams for the 60-second gaps and the 10-second polls (tests shorten them). */
  timing: { recoverablePolls: number; recoverablePollMs: number; overrideGapMs: number; lockRetryMs: number; cleanupRetryMs: number; cleanupLockTimeout: string; cleanupBudgetMs?: number; deletedEndpointWaitMs?: number; deletedEndpointPollMs?: number; schemaNoteTimeoutSeconds?: number };
}

export class Aborted extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'Aborted'; }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted(String(signal.reason ?? 'stopped'));
}

export const record = (env: StepEnv, tenantId: string | null, kind: 'proof' | 'rebuild' | 'rehearse', status: string, o: Partial<Parameters<typeof appendAction>[1]> = {}) =>
  appendAction(env.cp, { runId: env.args.runId, tenantId, kind, status, ...o }, env.now());

// ---- the proof (§5 invariant 2; §6.4 step 2) ----------------------------------------------------------------------

/**
 * (b) the positive control: the key and org list every project completely, and one known project answers 200 AND is in
 * that list. (GET by id doesn't take the org, so a wrong org would pass a 200 alone: its list comes back empty but
 * complete, and every recoverable check would then pass vacuously.)
 */
export async function positiveControl(env: StepEnv, excludeTenantId: string | null): Promise<boolean> {
  let listed: Set<string>;
  try {
    const all = await env.neon.listProjects();
    if (all.unavailable.length > 0) return false;
    listed = new Set(all.projects.map((p) => p.id));
  } catch {
    return false;
  }
  const known = [env.deps.restoreTestProjectId, env.deps.controlPlaneProjectId];
  try {
    for (const t of await liveTenants(env.cp)) if (t.id !== excludeTenantId && t.neonProjectId) known.push(t.neonProjectId);
  } catch { /* the two parameters still count */ }
  for (const id of known) {
    if (!listed.has(id)) continue;
    try {
      if ((await env.neon.getProject(id)).found) return true;
    } catch { /* try the next */ }
  }
  return false;
}

/** (c) the recoverable list, polled (it may lag): the union of ids seen, or null when a list was incomplete or failed. */
export async function pollRecoverable(env: StepEnv, polls = env.timing.recoverablePolls): Promise<{ ids: Set<string>; names: Map<string, string> } | null> {
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (let i = 0; i < polls; i++) {
    try {
      const l = await env.neon.listProjects({ recoverable: true });
      if (l.unavailable.length > 0) return null;
      for (const p of l.projects) { ids.add(p.id); names.set(p.name, p.id); }
    } catch {
      return null;
    }
    if (i < polls - 1) await env.sleep(env.timing.recoverablePollMs);
  }
  return { ids, names };
}

/** Network first: another live workspace (or the control plane) connects, so an unreachable result isn't our own network. */
export async function networkProven(env: StepEnv, excludeTenantId: string): Promise<boolean> {
  let tried = 0;
  try {
    for (const t of await liveTenants(env.cp)) {
      if (t.id === excludeTenantId || !t.dbUrlEncrypted || tried >= 3) continue;
      tried++;
      let url: string;
      try { url = decrypt(t.dbUrlEncrypted); } catch { continue; }
      if ((await env.connect(url)).cls === 'ok') return true;
    }
  } catch { /* fall through to the control plane */ }
  return (await env.connect(env.deps.controlPlaneUrl)).cls === 'ok';
}

export type ProofStatus = 'gone' | 'unreachable-4h' | 'observed-unreachable' | `refused:${string}`;

export interface ProofResult {
  /** proven: rebuild may continue. */
  proven: boolean;
  status: ProofStatus;
  /** The workspace's result when not proven. */
  result: string;
  message: string;
  /** Which evidence an override used (named in the email). */
  evidence?: string;
}

const OVERRIDE_REFUSAL: Record<Exclude<OverrideClass, 'unreachable'>, { status: ProofStatus; result: string; message: string }> = {
  'database-missing': { status: 'refused:database-missing', result: 'database-missing', message: "the database is missing inside a live project: see RESTORE.md's in-place restore section (it needs the customer's written consent); deploys can skip this workspace meanwhile" },
  answers: { status: 'refused:reachable', result: 'reachable', message: 'the original answers: nothing to rebuild' },
  'served-elsewhere': { status: 'refused:reachable', result: 'reachable', message: 'a live project serves the workspace\'s address (a stale project id): nothing to rebuild' },
  credentials: { status: 'refused:credentials', result: 'credentials', message: 'credentials problem: the data is intact and deploys can skip this workspace; contact the lead (RESTORE.md A.8a)' },
  'proof-failed': { status: 'refused:proof-failed', result: 'proof-failed', message: 'the proof could not be completed (a Neon lookup failed)' },
};

/** The override's evidence rules (§6.4 step 2.3). Pure. */
export function evaluateEvidence(f: EvidenceFacts, now: Date): { found: boolean; kind?: 'observation' | 'backups'; detail?: string } {
  const cutoff = [f.rebuiltAt, f.reachableAt].filter((d): d is Date => d !== null).reduce<number>((m, d) => Math.max(m, d.getTime()), -Infinity);
  const t = now.getTime();
  for (const o of f.observations) {
    const at = o.at.getTime();
    if (at > t - 4 * HOUR || at < t - 48 * HOUR || at <= cutoff) continue;
    if (f.lastOkAt && f.lastOkAt.getTime() > at) continue;
    if (f.reachableAgainAt && f.reachableAgainAt.getTime() > at) continue;
    return { found: true, kind: 'observation', detail: `observed unreachable at ${o.at.toISOString()}` };
  }
  const connect = f.failedBackups
    .filter((r) => r.at.getTime() > cutoff && r.at.getTime() >= t - 26 * HOUR && /^connect\b.*\blabel=(connection-refused|timeout)\b/.test(r.error ?? ''))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 0; i < connect.length; i++) {
    const first = connect[i];
    if (f.lastOkAt && f.lastOkAt.getTime() > first.at.getTime()) continue;
    const second = connect.find((r) => r.runId !== first.runId && r.at.getTime() - first.at.getTime() >= 4 * HOUR);
    if (second) return { found: true, kind: 'backups', detail: `backups failed to connect at ${first.at.toISOString()} and ${second.at.toISOString()}` };
  }
  return { found: false };
}

/** Override classification twice, `gap` apart; both must say unreachable. */
async function overrideTwice(env: StepEnv, url: string, projectId: string, rule: ReturnType<typeof tenantCandidateRule>) {
  const first = await classifyOverride({ url, projectId, connect: env.connect, neon: env.neon, rule });
  if (first.cls !== 'unreachable') return first;
  await env.sleep(env.timing.overrideGapMs);
  throwIfAborted(env.signal);
  return classifyOverride({ url, projectId, connect: env.connect, neon: env.neon, rule });
}

export interface SharedProof {
  /** For all-lost: one positive control and one recoverable list for every 404 tenant. */
  control?: boolean;
  recoverable?: Awaited<ReturnType<typeof pollRecoverable>>;
}

/** Step 2: prove the original gone, or unreachable for 4 hours (override). Records nothing; the caller appends the row. */
export async function proveOriginal(env: StepEnv, t: TenantFacts, url: string, oldProjectId: string, shared: SharedProof = {}): Promise<ProofResult> {
  const refuse = (status: ProofStatus, result: string, message: string): ProofResult => ({ proven: false, status, result, message });
  const rule = tenantCandidateRule(t.slug, t.id);
  let project: Awaited<ReturnType<NeonApi['getProject']>>;
  try {
    project = await env.neon.getProject(oldProjectId);
  } catch (e) {
    return refuse('refused:proof-failed', 'proof-failed', `the original's project lookup failed (${summaryOf('neon', e)})`);
  }
  if (project.found) {
    if (env.args.override !== 'unreachable-4h') {
      return refuse('refused:original-exists', 'original-exists', 'the original project exists: if it has been unreachable for hours, press with the override');
    }
    if (!(await networkProven(env, t.id))) return refuse('refused:network-unproven', 'network-unproven', "this task's own network couldn't be proven (no other database connected)");
    const c = await overrideTwice(env, url, oldProjectId, rule);
    if (c.cls !== 'unreachable') {
      const r = OVERRIDE_REFUSAL[c.cls];
      return refuse(r.status, r.result, r.message);
    }
    const ev = evaluateEvidence(await evidenceFacts(env.cp, t.id, oldProjectId, env.now()), env.now());
    if (!ev.found) {
      const after = new Date(env.now().getTime() + 4 * HOUR).toISOString();
      return refuse('observed-unreachable', 'observed', `observed unreachable now (${c.reason}); press again with the override after ${after}`);
    }
    return { proven: true, status: 'unreachable-4h', result: 'proven', message: `unreachable for 4 hours (${c.reason}; ${ev.detail})`, evidence: ev.detail };
  }

  // 404: the full gone proof.
  const control = shared.control ?? await positiveControl(env, t.id);
  if (!control) return refuse('refused:proof-failed', 'proof-failed', "the positive control failed (the key or org can't see the organisation)");
  const rec = shared.recoverable !== undefined ? shared.recoverable : await pollRecoverable(env);
  if (!rec) return refuse('refused:proof-failed', 'proof-failed', 'the recoverable list was incomplete or failed');
  if (rec.ids.has(oldProjectId)) return refuse('refused:recoverable', 'recoverable', 'the original is recoverable: recover it in the Neon console, nothing is lost');
  if (!(await networkProven(env, t.id))) return refuse('refused:network-unproven', 'network-unproven', "this task's own network couldn't be proven (no other database connected)");
  const d = await classifyGoneEndpoint({ url, connect: env.connect, neon: env.neon, rule });
  if (d.cls === 'answers' || d.cls === 'served') return refuse('refused:reachable', 'reachable', 'the workspace\'s address still answers or is served by a live project: nothing to rebuild');
  if (d.cls === 'unproven') return refuse('refused:proof-failed', 'proof-failed', "the address check couldn't be completed");
  return { proven: true, status: 'gone', result: 'proven', message: 'the original is gone' };
}

/** Step 8's gone-mode re-check: still 404, still not recoverable (one poll), and the address still doesn't answer. */
export async function recheckGone(env: StepEnv, t: TenantFacts, url: string, oldProjectId: string): Promise<boolean> {
  try {
    if ((await env.neon.getProject(oldProjectId)).found) return false;
  } catch {
    return false;
  }
  const rec = await pollRecoverable(env, 1);
  if (!rec || rec.ids.has(oldProjectId)) return false;
  const d = await classifyGoneEndpoint({ url, connect: env.connect, neon: env.neon, rule: tenantCandidateRule(t.slug, t.id) });
  return d.cls === 'doesnt-answer';
}

/** Step 8's override re-check: rerun the classifier; anything but unreachable aborts with the mapped proof. */
export async function recheckOverride(env: StepEnv, t: TenantFacts, url: string, oldProjectId: string): Promise<{ ok: true } | { ok: false; status: ProofStatus }> {
  let projectFound: boolean;
  try {
    projectFound = (await env.neon.getProject(oldProjectId)).found;
  } catch {
    return { ok: false, status: 'refused:proof-failed' };
  }
  if (!projectFound) return { ok: false, status: 'refused:proof-failed' };
  const c = await classifyOverride({ url, projectId: oldProjectId, connect: env.connect, neon: env.neon, rule: tenantCandidateRule(t.slug, t.id) });
  if (c.cls === 'unreachable') return { ok: true };
  return { ok: false, status: OVERRIDE_REFUSAL[c.cls].status };
}

// ---- backup candidates (§6.4 step 4) ------------------------------------------------------------------------------

export interface Candidate {
  key: string;
  sha256: string;
  /** The row's counts; null = take them from the sidecar (a log-confirmed object). */
  rowCounts: Record<string, unknown> | null;
  startedAt: Date | null;
  source: 'row' | 'log';
}

/** Objects under v1/<current cp>/tenant/<id>/, newest first, each with a SHA-256 from an `ok` row or a BACKUP line. */
export async function backupCandidates(env: StepEnv, tenantId: string): Promise<{ candidates: Candidate[]; skipped: number }> {
  const listed = await env.deps.reader.list(targetPrefix(env.cpId, 'tenant', tenantId));
  const keys = new Set(listed.map((o) => o.key));
  const dumps = listed.filter((o) => o.key.endsWith(DUMP_SUFFIX) && keys.has(sidecarKeyFor(o.key)))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const rows = new Map((await okBackupRows(env.cp, tenantId)).map((r) => [r.key, r]));
  let lines = new Map<string, string>();
  try {
    lines = new Map((await env.deps.logReader.backupLines(env.cpId, tenantId)).map((l) => [l.key, l.sha256]));
  } catch (e) {
    env.log(`${tenantId}: the backup log lines could not be read (${summaryOf('logs', e)}); using rows only`);
  }
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const d of dumps) {
    const row = rows.get(d.key);
    if (row) candidates.push({ key: d.key, sha256: row.sha256, rowCounts: row.rowCounts, startedAt: row.startedAt, source: 'row' });
    else if (lines.has(d.key)) candidates.push({ key: d.key, sha256: lines.get(d.key)!, rowCounts: null, startedAt: null, source: 'log' });
    else skipped++;
  }
  return { candidates, skipped };
}

// ---- build: create + restore + verify (§6.4 steps 5–6) -------------------------------------------------------------

export type FailureKind = 'integrity' | 'infra' | 'other' | 'create';

export interface Failure {
  kind: FailureKind;
  summary: string;
}

export interface Built {
  projectId: string;
  name: string;
  connectionUri: string;
  pooledUri: string;
  /** The restored counts (the email's evidence). */
  counts: Record<string, number>;
  backupStartedAt: Date | null;
}

const INFRA_LABELS = new Set(['connection-refused', 'timeout', 's3-error', 'kms-error', 'killed']);

/** Classify a restore failure (§6.4 step 4). */
export function classifyRestoreFailure(e: unknown): Failure {
  if (e instanceof Aborted) return { kind: 'infra', summary: e.reason };
  if (e instanceof NeonApiError) return { kind: e.infrastructure ? 'infra' : 'create', summary: e.message };
  const summary = summaryOf('restore', e);
  const stage = e instanceof StageError ? e.stage : 'restore';
  const label = /label=([a-z-]+)/.exec(summary)?.[1] ?? labelFor(e);
  if (stage === 'context' || stage === 'sha256' || stage === 'sidecar' || stage === 'counts') return { kind: 'integrity', summary };
  if (stage === 'decrypt') return { kind: INFRA_LABELS.has(label) ? 'infra' : 'integrity', summary };
  if (INFRA_LABELS.has(label)) return { kind: 'infra', summary };
  return { kind: 'other', summary };
}

/** `cadenzpoint-r-<tenant id first 8>-<yyyymmddhhmmss>-<try>`: moved to lib/project-names.ts (feature-plan-control-plane-disaster.md §6.11). */
export { rebuildName };

export type BuildResult =
  | { ok: true; built: Built }
  | { ok: false; failure: Failure; project: { id: string | null; name: string } | null };

/**
 * What one build restores and how it records itself (approved detail D4, feature-plan-control-plane-disaster.md §6.3
 * step 6): 3c's workspace rebuild and rehearsal (a tenant dump, `rebuild`/`rehearse` action rows), the control-plane
 * rebuild (the control-plane dump; no control plane to record into, so it logs `DISASTER-PROJECT` instead) and the
 * control-plane rehearsal (the control-plane dump; `rehearse` rows with no tenant in the real control plane).
 */
export interface BuildTarget {
  target: 'tenant' | 'control-plane';
  /** The tenant id, or `control-plane`: the S3 prefix's and the encryption context's `id`. */
  id: string;
  /** The project name for this try (computed once per try, before the intent row). */
  name: string;
  databaseName: string;
  historyRetentionSeconds: number;
  /** The intent/created/failed record (action rows, or a log line). Never throws past a failure it can't record. */
  record: (status: 'intended' | 'created' | 'failed', fields: { projectName: string; newProjectId?: string; backupKey?: string; backupStartedAt?: Date | null; detail?: string }) => Promise<void>;
}

/** The parts of a StepEnv a build uses (mode `control-plane` has no control-plane client yet). */
export type BuildEnv = Pick<StepEnv, 'deps' | 'neon' | 'cpId' | 'cpDirectHost' | 'now'>;

/** One try: intent → create → restore → sidecar → counts. A failure returns the project (if any) for cleanup. */
export async function buildCore(env: BuildEnv, bt: BuildTarget, cand: Candidate, signal: AbortSignal): Promise<BuildResult> {
  const name = bt.name;
  await bt.record('intended', { projectName: name, backupKey: cand.key, backupStartedAt: cand.startedAt });
  let created;
  try {
    throwIfAborted(signal);
    created = await env.neon.createProject({ name, databaseName: bt.databaseName, historyRetentionSeconds: bt.historyRetentionSeconds, regionId: env.deps.regionId }, signal);
  } catch (e) {
    let id = createdIdOf(e);
    if (!id && !(e instanceof Aborted)) {
      try {
        const found = await env.neon.findByName(name);
        if (found.projects.length === 1) id = found.projects[0].id; // adopted: tracked, then cleaned up
      } catch { /* not found: no project */ }
    }
    if (id) {
      await bt.record('created', { projectName: name, newProjectId: id, detail: 'adopted after a failed create' });
      return { ok: false, failure: classifyRestoreFailure(e instanceof NeonApiError || e instanceof Aborted ? e : new NeonApiError('create-project', 0, 'network')), project: { id, name } };
    }
    await bt.record('failed', { projectName: name, detail: `create: ${summaryOf('neon', e)}` });
    return { ok: false, failure: classifyRestoreFailure(e), project: null };
  }
  await bt.record('created', { projectName: name, newProjectId: created.projectId, backupKey: cand.key });
  const project = { id: created.projectId, name };
  try {
    // The region and control-plane guards on the real host (the host map only redirects the connection).
    const host = new URL(created.connectionUri).hostname.toLowerCase();
    const parsed = parseNeonHost(host);
    if (!parsed || parsed.region !== 'us-east-1' || parsed.pooled) throw new StageError('guard', new Error('the new host is not a direct us-east-1 Neon host'));
    if (directHost(host) === env.cpDirectHost) throw new StageError('guard', new Error('the new host is the control plane\'s'));
    const target = connectUrl(created.connectionUri, env.deps.hostMap);
    const child = childConnection(target);
    const expectedContext = encryptionContext({ cp: env.cpId, kind: 'dump', target: bt.target, id: bt.id, key: baseKey(cand.key) });
    await restoreObject({
      reader: env.deps.reader, key: cand.key, factory: env.deps.keyring, spawn: env.deps.spawn ?? realSpawn, bin: env.deps.pgRestoreBin,
      args: ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${child.url}`],
      env: childEnv(child.password), expectedContext, expectedSha256: cand.sha256, signal,
    });
    // The sidecar: same SHA-256; for a row, the same counts.
    let manifest: { sha256?: string; rowCounts?: Record<string, unknown>; startedAt?: string };
    try {
      const buf = await streamToBuffer(await env.deps.reader.get(sidecarKeyFor(cand.key)));
      manifest = JSON.parse((await decryptBuffer(env.deps.keyring, buf, encryptionContext({ cp: env.cpId, kind: 'manifest', target: bt.target, id: bt.id, key: baseKey(cand.key) }))).toString('utf8'));
    } catch (e) {
      throw new StageError('sidecar', e);
    }
    if (manifest.sha256 !== cand.sha256) throw new StageError('sidecar', new Error('sidecar sha256 differs'));
    if (cand.rowCounts && !compareCounts(cand.rowCounts, manifest.rowCounts ?? {}).equal) throw new StageError('sidecar', new Error('sidecar counts differ'));
    const expected = cand.rowCounts ?? manifest.rowCounts ?? {};
    throwIfAborted(signal);
    const db = postgresLib(clientUrl(target), { max: 1, connect_timeout: 30, onnotice: () => {} });
    let counts: Record<string, number>;
    try {
      counts = await countTables(db);
    } finally {
      await db.end({ timeout: 5 }).catch(() => {});
    }
    const cmp = compareCounts(expected, counts);
    if (!cmp.equal) throw new StageError('counts', new Error(describeDiffs(cmp.diffs).slice(0, 500)));
    const backupStartedAt = cand.startedAt ?? (manifest.startedAt ? new Date(manifest.startedAt) : null);
    return { ok: true, built: { projectId: created.projectId, name, connectionUri: created.connectionUri, pooledUri: created.pooledUri, counts, backupStartedAt } };
  } catch (e) {
    return { ok: false, failure: classifyRestoreFailure(e), project };
  }
}

/** 3c's workspace build (rebuild or rehearsal): a tenant dump, recorded as `rebuild`/`rehearse` action rows. Unchanged behaviour. */
export async function buildOnce(env: StepEnv, t: TenantFacts, cand: Candidate, tryNo: number, signal: AbortSignal): Promise<BuildResult> {
  const settings = rebuildSettings(t.slug);
  const kind = env.projectKind;
  return buildCore(env, {
    target: 'tenant', id: t.id, name: rebuildName(t.id, env.now(), tryNo), databaseName: settings.databaseName, historyRetentionSeconds: settings.historyRetentionSeconds,
    record: (status, f) => record(env, t.id, kind, status, { ...f, oldProjectId: t.neonProjectId }),
  }, cand, signal);
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

// ---- guards (§6.4 step 7) -----------------------------------------------------------------------------------------

/** The new endpoint belongs to the new project and isn't the control plane's; no other tenant holds the project or host. */
export async function switchGuards(env: StepEnv, t: TenantFacts, built: Built): Promise<string | null> {
  const host = directHost(new URL(built.connectionUri).hostname);
  try {
    const eps = await env.neon.listEndpoints(built.projectId);
    if (!eps.some((e) => directHost(e.host) === host)) return 'the new endpoint is not listed on the new project';
  } catch (e) {
    return `the new project's endpoints could not be read (${summaryOf('neon', e)})`;
  }
  if (host === env.cpDirectHost) return "the new endpoint is the control plane's";
  for (const o of await otherTenants(env.cp, t.id)) {
    if (o.neonProjectId === built.projectId) return 'another workspace already holds the new project';
    if (!o.dbUrlEncrypted) continue;
    let url: string;
    try { url = decrypt(o.dbUrlEncrypted); } catch { return `another workspace's URL (${o.id}) can't be decrypted, so sharing can't be ruled out`; }
    try {
      if (directHost(new URL(toDirectConnectionUrl(url)).hostname) === host) return 'another workspace already uses the new host';
    } catch { /* not a URL: can't be the new host */ }
  }
  return null;
}

// ---- the switch (§6.4 step 8) -------------------------------------------------------------------------------------

export interface SwitchInput {
  t: TenantFacts;
  oldUrlEncrypted: string;
  oldProjectId: string;
  built: Built;
  backupKey: string;
  sha256: string;
  override: boolean;
}

/**
 * One transaction under the app's tenant lock: the guarded UPDATE, the audit, `linked`, the watch (and, with the override,
 * `returned` at once). SWITCHING is logged just before COMMIT; LINKED after. A lock timeout retries 3 times, 10 s apart.
 */
export async function switchWorkspace(env: StepEnv, s: SwitchInput): Promise<'linked' | 'changed-meanwhile' | 'lock-timeout'> {
  const line = `${s.t.id} ${s.oldProjectId} ${s.built.projectId} ${s.backupKey} ${s.sha256}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await env.cp.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '5s'");
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + s.t.id}))`;
        const at = env.now();
        const rows = await tx`UPDATE tenants SET db_url_encrypted = ${encrypt(s.built.pooledUri)}, neon_project_id = ${s.built.projectId},
            lifecycle_version = lifecycle_version + 1, updated_at = now()
          WHERE id = ${s.t.id} AND status IN ('provisioning', 'active', 'suspended')
            AND db_url_encrypted = ${s.oldUrlEncrypted} AND neon_project_id = ${s.oldProjectId}
            AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for > now())
          RETURNING id`;
        if (rows.length === 0) throw new ChangedMeanwhile();
        const detail = { oldProjectId: s.oldProjectId, newProjectId: s.built.projectId, backupKey: s.backupKey, backupStartedAt: s.built.backupStartedAt?.toISOString() ?? null, sha256: s.sha256, override: s.override };
        await tx`INSERT INTO tenant_audit_events (tenant_id, kind, detail, actor, created_at)
          VALUES (${s.t.id}, 'database-rebuilt', ${JSON.stringify(detail)}, ${`disaster:${env.args.runId}`.slice(0, 100)}, ${at})`;
        await appendAction(tx, { runId: env.args.runId, tenantId: s.t.id, kind: 'rebuild', status: 'linked', projectName: s.built.name, newProjectId: s.built.projectId, oldProjectId: s.oldProjectId, backupKey: s.backupKey, backupStartedAt: s.built.backupStartedAt }, at);
        const watch = { tenantId: s.t.id, slug: s.t.slug, oldProjectId: s.oldProjectId, newProjectId: s.built.projectId, backupStartedAt: s.built.backupStartedAt?.toISOString() ?? null, watchStartedAt: at.toISOString(), override: s.override };
        await raiseGlobalAlert(tx, { kind: 'rebuild-original-watch', dedupKey: s.oldProjectId, detail: watch }, at);
        if (s.override) await raiseGlobalAlert(tx, { kind: 'rebuild-original-returned', dedupKey: s.oldProjectId, detail: watch }, at);
        env.log(`SWITCHING ${line}`);
        await env.deps.hooks?.beforeCommit?.(s.t.id);
      });
      await env.deps.hooks?.afterCommit?.(s.t.id);
      env.log(`LINKED ${line}`);
      return 'linked';
    } catch (e) {
      if (e instanceof ChangedMeanwhile) return 'changed-meanwhile';
      // A lock timeout is retried up to 3 times (4 attempts in total), 10 s apart (§6.4 step 8; fix round 1, FR7).
      if ((e as { code?: string })?.code === LOCK_TIMEOUT_SQLSTATE) {
        if (attempt > 3) return 'lock-timeout';
        await env.sleep(env.timing.lockRetryMs);
        continue;
      }
      throw e;
    }
  }
}

// ---- cleanup (§6.4 step 10; invariant 5) --------------------------------------------------------------------------

export type CleanupOutcome = 'deleted' | 'failed' | 'linked';

/**
 * Before deleting a project this task created: wait for any in-flight switch, then re-read the tenant row under the
 * tenant lock. Pointing at it → `linked` (a commit whose acknowledgement was lost), never deleted. A lock timeout or read
 * error → retried within `budgetMs`, then kept (`failed`; the leftover finding handles it).
 */
export async function cleanupProject(env: StepEnv, t: TenantFacts, p: { id: string | null; name: string }, o: {
  switchInFlight?: Promise<unknown>; budgetMs: number; lockedReRead: boolean; oldProjectId?: string | null;
  /** The backup the project was restored from: a healed `linked` row and LINKED line carry the same fields (FR8). */
  backup?: { key: string; sha256: string; startedAt: Date | null };
}): Promise<CleanupOutcome> {
  const kind = env.projectKind;
  if (o.switchInFlight) await o.switchInFlight.catch(() => {});
  if (!p.id) return 'failed';
  const end = Date.now() + o.budgetMs;
  let pointsAtIt: boolean | null = null;
  for (;;) {
    try {
      const current = o.lockedReRead
        ? await lockedProjectId(env.cp, t.id, env.timing.cleanupLockTimeout)
        : ((await env.cp<Array<{ p: string | null }>>`SELECT neon_project_id AS p FROM tenants WHERE id = ${t.id}`)[0]?.p ?? null);
      pointsAtIt = current === p.id;
      break;
    } catch (e) {
      env.log(`${t.id}: cleanup re-read failed (${summaryOf('reread', e)})`);
      if (Date.now() + env.timing.cleanupRetryMs > end) break;
      await env.sleep(env.timing.cleanupRetryMs);
    }
  }
  if (pointsAtIt === null) {
    await record(env, t.id, kind, 'failed', { projectName: p.name, newProjectId: p.id, oldProjectId: o.oldProjectId ?? null, detail: 'kept: the tenant row could not be re-read' }).catch(() => {});
    return 'failed';
  }
  if (pointsAtIt) {
    await record(env, t.id, 'rebuild', 'linked', { projectName: p.name, newProjectId: p.id, oldProjectId: o.oldProjectId ?? null, backupKey: o.backup?.key ?? null, backupStartedAt: o.backup?.startedAt ?? null, detail: 'healed: the switch committed' }).catch(() => {});
    env.log(`LINKED ${t.id} ${o.oldProjectId ?? '-'} ${p.id} ${o.backup?.key ?? '-'} ${o.backup?.sha256 ?? '-'} (healed by the re-read)`);
    return 'linked';
  }
  try {
    await env.neon.deleteProject(p.id);
    if (!(await env.neon.verifyGone(p.id))) {
      await record(env, t.id, kind, 'failed', { projectName: p.name, newProjectId: p.id, oldProjectId: o.oldProjectId ?? null, detail: 'delete: the project still answers after DELETE (kept; the leftover check lists it)' }).catch(() => {});
      return 'failed';
    }
    await record(env, t.id, kind, 'deleted', { projectName: p.name, newProjectId: p.id, oldProjectId: o.oldProjectId ?? null });
    return 'deleted';
  } catch (e) {
    await record(env, t.id, kind, 'failed', { projectName: p.name, newProjectId: p.id, oldProjectId: o.oldProjectId ?? null, detail: `delete: ${summaryOf('neon', e)}` }).catch(() => {});
    return 'failed';
  }
}

// ---- the schema note (§6.4 step 3) --------------------------------------------------------------------------------

/** The applied-migration count, through pgQuery's hard deadline (FR11: the postgres.js reconnect loop can't hang it). */
async function migrationCount(env: StepEnv, url: string): Promise<number | null> {
  const r = await pgQuery(toDirectConnectionUrl(url), async (db) => {
    const [row] = await db<Array<{ n: number }>>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    return row.n;
  }, { hostMap: env.deps.hostMap, connectTimeoutSeconds: env.timing.schemaNoteTimeoutSeconds ?? 15 });
  return r.ok ? r.value : null;
}

/** "the app is N migrations ahead of this backup", from up to two other reachable live workspaces. */
export async function schemaNote(env: StepEnv, t: TenantFacts, restoredUrl: string): Promise<string> {
  const restored = await migrationCount(env, restoredUrl);
  const others: number[] = [];
  let tried = 0;
  for (const o of await liveTenants(env.cp).catch(() => [] as TenantFacts[])) {
    // At most 2 answers from at most 4 tries: a dead neighbourhood can't stretch the note (each try has a hard deadline).
    if (o.id === t.id || !o.dbUrlEncrypted || others.length >= 2 || tried >= 4) continue;
    tried++;
    let url: string;
    try { url = decrypt(o.dbUrlEncrypted); } catch { continue; }
    const n = await migrationCount(env, url);
    if (n !== null) others.push(n);
    else env.log(`schema note: workspace ${o.id} didn't answer; skipped`);
  }
  if (others.length === 0 || restored === null) return 'no other workspace was reachable: run Deploy to Production now to be safe';
  const ahead = Math.max(...others) - restored;
  return ahead > 0 ? `the app is ${ahead} migration(s) ahead of this backup: run Deploy to Production now` : 'the backup is at the current schema; run Deploy to Production now anyway (normal)';
}

export { candidateServes };
