/**
 * Mode `control-plane` (feature-plan-control-plane-disaster.md §6.3; state table §7.1): rebuild a LOST control plane from
 * its newest verified backup into a NEW Neon project, record the run in it, then reconcile the window since that backup.
 *
 * The control plane is gone, so this mode has its own run harness: the deadline (330 min), SIGTERM, the hard exit and the
 * email as 3c, but no control-plane lock, no abandoned-run closing, and no run row until step 8. ECS oldest-task-wins and
 * the startedBy gate run first (in runDisaster). Invariants: the old control plane is never written (only (d)'s login
 * attempt touches its address); the task writes only inside the new project, its log and its one email (§5 invariant 3);
 * logs carry ids only. Before step 8 commits, a stop or failure deletes the new project (verified); after it, the
 * project is a complete control plane and is kept.
 */
import postgres from 'postgres';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { tenantDbHistoryRetentionSeconds } from '../../src/lib/tenant/lifecycle-config';
import { CONTROL_PLANE_ID, DUMP_SUFFIX, sidecarKeyFor, targetPrefix } from './lib/keys';
import { CONTROL_PLANE_RULE, classifyGoneEndpoint, pgConnector, type Connector } from './lib/classify-endpoint';
import { connectUrl } from './lib/host-map';
import { clientUrl } from './lib/pg-url';
import { directHost, type NeonProject } from './lib/neon-api';
import { raiseGlobalAlert } from './lib/disaster-sql';
import { summaryOf } from './lib/summarize-error';
import { CONTROL_PLANE_REBUILD_NAME_RE, controlPlaneRebuildName } from './lib/project-names';
import { Aborted, buildCore, pollRecoverable, throwIfAborted, type BuildEnv, type BuildResult, type Built, type Candidate, type StepEnv } from './disaster-steps';
import { DEFAULT_TIMING } from './disaster-workspace';
import { runReconcile, type ReconcileResult } from './disaster-reconcile';
import { DISASTER_DEFAULTS, type DisasterArgs, type DisasterDeps, type RunOutcome } from './disaster';

export const CP_REFUSALS = {
  'network-unproven': "this task's own network couldn't be proven (the restore-test database didn't connect)",
  'original-exists': "Neon still has the control plane's project: if it's an outage, wait for Neon (RESTORE.md B.1)",
  recoverable: 'the control plane is recoverable: recover it in the Neon console, nothing is lost (RESTORE.md B.1)',
  reachable: "the control plane at SSM control-plane-url answers. If you rebuilt before, check that SSM's URL and project id match Vercel's (RESTORE.md B.5)",
  served: "a live project holds the control plane's address: fix /cadenzpoint/backup/control-plane-project-id",
  'proof-failed': 'the proof could not be completed (a Neon lookup failed or a list was incomplete): press again',
  'no-backup': 'no verified control-plane backup (no object with a sidecar and a BACKUP line)',
} as const;

export type CpRefusal = keyof typeof CP_REFUSALS | 'rebuild-exists';

/** Plain values the run row's summary and the email use. */
interface CpSummary {
  target: 'control-plane';
  previousProjectId: string;
  newProjectId: string;
  newProjectName: string;
  backupKey: string;
  backupStartedAt: string | null;
  sha256: string;
  cpRunStartedAt: string;
}

export async function runControlPlane(args: DisasterArgs, deps: DisasterDeps, startedBy: string): Promise<{ exitCode: number; outcome: RunOutcome | null }> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log;
  const deadlineMs = deps.deadlineMs ?? DISASTER_DEFAULTS.deadlineMs;
  const runAbort = new AbortController();
  const onStop = () => runAbort.abort('stopped');
  deps.stopSignal?.addEventListener('abort', onStop, { once: true });
  if (deps.stopSignal?.aborted) onStop();
  const deadline = setTimeout(() => runAbort.abort('deadline'), deadlineMs);
  const hardExit = setTimeout(() => {
    log('hard exit: still running 5 minutes after the deadline');
    (deps.hardExit ?? ((c: number) => process.exit(c)))(1);
  }, deadlineMs + (deps.hardExitAfterDeadlineMs ?? DISASTER_DEFAULTS.hardExitAfterDeadlineMs));
  hardExit.unref?.();

  let outcome: RunOutcome;
  try {
    outcome = await controlPlaneSteps(args, deps, { now, sleep, log, signal: runAbort.signal, startedBy });
  } catch (e) {
    log(`run failed: ${summaryOf('run', e)}`);
    outcome = { pass: false, results: [], email: [`Control-plane rebuild, run ${args.runId}: the run stopped (${summaryOf('run', e)}). If the email names a new project, see RESTORE.md B.3.`] };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardExit);
    deps.stopSignal?.removeEventListener('abort', onStop);
  }
  for (const r of outcome.results) log(`  ${r.tenantId} ${r.result}${r.detail ? ` (${r.detail})` : ''}`);
  try {
    await deps.publish(`CadenzPoint disaster control-plane ${outcome.pass ? 'passed' : 'FAILED'}: run ${args.runId}`, outcome.email.join('\n'));
  } catch (e) {
    log(`the email could not be sent (${summaryOf('sns', e)}); see the disaster log`);
  }
  return { exitCode: outcome.pass ? 0 : 1, outcome };
}

interface Ctx { now: () => Date; sleep: (ms: number) => Promise<void>; log: (l: string) => void; signal: AbortSignal; startedBy: string }

/** The shared proof environment (pollRecoverable reads `neon`, `sleep` and `timing` only). */
function proofEnv(deps: DisasterDeps, c: Ctx): StepEnv {
  return { neon: deps.neon, sleep: c.sleep, now: c.now, log: c.log, signal: c.signal, timing: { ...DEFAULT_TIMING, ...deps.timing } } as unknown as StepEnv;
}

/** §6.3 step 3(b): the org list is complete and contains the restore-test project, which answers 200. Returns the list. */
export async function controlPlanePositiveControl(deps: DisasterDeps): Promise<NeonProject[] | null> {
  try {
    const all = await deps.neon.listProjects();
    if (all.unavailable.length > 0) return null;
    if (!all.projects.some((p) => p.id === deps.restoreTestProjectId)) return null;
    if (!(await deps.neon.getProject(deps.restoreTestProjectId)).found) return null;
    return all.projects;
  } catch {
    return null;
  }
}

/** §6.3 step 4: any LIVE org project named exactly like a control-plane rebuild (§6.11), at any age. */
export function earlierRebuilds(projects: NeonProject[]): NeonProject[] {
  return projects.filter((p) => CONTROL_PLANE_REBUILD_NAME_RE.test(p.name));
}

export function rebuildExistsMessage(p: NeonProject): string {
  return `a rebuilt control plane exists: ${p.id}, created ${p.createdAt ?? 'at an unknown time'}. If Vercel, GitHub or your .env.local use it, it's your live control plane: don't delete it. Put its pooled URL and id into SSM (RESTORE.md B.5) and stop. Delete it only if you never repointed to it (RESTORE.md B.3).`;
}

/** §6.3 step 5: control-plane dumps with a sidecar, newest first, each confirmed by a BACKUP line (no rows: the control plane is gone). */
export async function controlPlaneCandidates(deps: DisasterDeps, log: (l: string) => void): Promise<{ candidates: Candidate[]; skipped: number }> {
  const listed = await deps.reader.list(targetPrefix(deps.cpId, 'control-plane', CONTROL_PLANE_ID));
  const keys = new Set(listed.map((o) => o.key));
  const dumps = listed.filter((o) => o.key.endsWith(DUMP_SUFFIX) && keys.has(sidecarKeyFor(o.key))).sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  let lines = new Map<string, string>();
  try {
    lines = new Map((await deps.logReader.controlPlaneLines(deps.cpId)).map((l) => [l.key, l.sha256]));
  } catch (e) {
    log(`the control-plane backup lines could not be read (${summaryOf('logs', e)})`);
  }
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const d of dumps) {
    const sha = lines.get(d.key);
    if (sha) candidates.push({ key: d.key, sha256: sha, rowCounts: null, startedAt: null, source: 'log' });
    else skipped++;
  }
  return { candidates, skipped };
}

/** Delete a project this run created and verify the 404 (log ids only). */
async function deleteVerified(deps: DisasterDeps, log: (l: string) => void, p: { id: string | null; name: string } | null): Promise<{ deleted: boolean; kept: string | null }> {
  if (!p?.id) return { deleted: true, kept: null };
  try {
    await deps.neon.deleteProject(p.id);
    if (await deps.neon.verifyGone(p.id)) return { deleted: true, kept: null };
  } catch (e) {
    log(`delete ${p.id} failed (${summaryOf('neon', e)})`);
  }
  log(`DISASTER-PROJECT-KEPT ${p.id}`);
  return { deleted: false, kept: p.id };
}

async function controlPlaneSteps(args: DisasterArgs, deps: DisasterDeps, c: Ctx): Promise<RunOutcome> {
  const { log, now } = c;
  const cpRunStartedAt = now();
  log(`disaster control-plane run ${args.runId} started by ${c.startedBy || 'unknown'}`);
  const oldId = deps.controlPlaneProjectId;
  const kept: string[] = [];
  const head = `Control-plane rebuild (mode control-plane), run ${args.runId}.`;
  const refuse = (reason: CpRefusal, message?: string): RunOutcome => {
    log(`refused: ${reason}`);
    return {
      pass: false, results: [{ tenantId: 'control-plane', result: reason }],
      email: [head, `Refused (${reason}): ${message ?? CP_REFUSALS[reason as keyof typeof CP_REFUSALS]}.`, 'Nothing was created or changed.'],
    };
  };
  const connect: Connector = deps.connector ?? pgConnector({ hostMap: deps.hostMap });
  const env = proofEnv(deps, c);

  // ---- 2. network first ---------------------------------------------------------------------------------------------
  if (!deps.restoreTestUrl || (await connect(deps.restoreTestUrl)).cls !== 'ok') return refuse('network-unproven');

  // ---- 3. the gone-proof of the old control plane (no override, invariant 2) -----------------------------------------
  try {
    if ((await deps.neon.getProject(oldId)).found) return refuse('original-exists');
  } catch (e) {
    log(`the control plane's project lookup failed (${summaryOf('neon', e)})`);
    return refuse('proof-failed');
  }
  const listed = await controlPlanePositiveControl(deps);
  if (!listed) return refuse('proof-failed', "the positive control failed (the key or org can't see the restore-test project, or the list was incomplete)");
  const rec = await pollRecoverable(env);
  if (!rec) return refuse('proof-failed', 'the recoverable list was incomplete or failed');
  if (rec.ids.has(oldId)) return refuse('recoverable');
  const d = await classifyGoneEndpoint({ url: deps.controlPlaneUrl, connect, neon: deps.neon, rule: CONTROL_PLANE_RULE });
  if (d.cls === 'answers') return refuse('reachable');
  if (d.cls === 'served') return refuse('served');
  if (d.cls === 'unproven') return refuse('proof-failed', "the address check couldn't be completed");

  // ---- 4. an earlier rebuild still present (no age limit) ------------------------------------------------------------
  const earlier = earlierRebuilds(listed);
  if (earlier.length > 0) return refuse('rebuild-exists', rebuildExistsMessage(earlier.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]));

  // ---- 5. candidates --------------------------------------------------------------------------------------------------
  const { candidates, skipped } = await controlPlaneCandidates(deps, log);
  if (candidates.length === 0) return refuse('no-backup', `${CP_REFUSALS['no-backup']}${skipped ? `; ${skipped} object(s) had no BACKUP line` : ''}`);

  // ---- 6. build (3c's failure classes) --------------------------------------------------------------------------------
  const oldUrl = new URL(toDirectConnectionUrl(deps.controlPlaneUrl));
  const databaseName = decodeURIComponent(oldUrl.pathname.replace(/^\//, '')) || 'cadenzpoint_control';
  const buildEnv: BuildEnv = { deps, neon: deps.neon, cpId: deps.cpId, cpDirectHost: directHost(oldUrl.hostname), now };
  let built: Built | null = null;
  let used: Candidate | null = null;
  let skippedBackups = 0;
  let tryNo = 0;
  let pending: { id: string | null; name: string } | null = null;
  const fail = async (result: string, detail: string): Promise<RunOutcome> => {
    if (pending) { const k = await deleteVerified(deps, log, pending); if (k.kept) kept.push(k.kept); pending = null; }
    return {
      pass: false, results: [{ tenantId: 'control-plane', result, detail }],
      email: [head, `${result}: ${detail}.`, ...(kept.length ? [`Projects that could not be deleted (delete them in the Neon console): ${kept.join(', ')}.`] : ['Nothing was kept: the control plane was not changed.'])],
    };
  };
  try {
    candidatesLoop:
    for (const cand of candidates.slice(0, 3)) {
      let infraRetried = false;
      for (;;) {
        throwIfAborted(c.signal);
        tryNo++;
        const r: BuildResult = await buildCore(buildEnv, {
          target: 'control-plane', id: CONTROL_PLANE_ID, name: controlPlaneRebuildName(now(), tryNo), databaseName, historyRetentionSeconds: tenantDbHistoryRetentionSeconds(),
          record: async (status, f) => { if (status === 'created' && f.newProjectId) { pending = { id: f.newProjectId, name: f.projectName }; log(`DISASTER-PROJECT ${f.newProjectId} ${f.projectName}`); } },
        }, cand, c.signal);
        if (r.ok) { built = r.built; used = cand; break candidatesLoop; }
        const k = await deleteVerified(deps, log, r.project);
        if (k.kept) kept.push(k.kept);
        pending = null;
        if (c.signal.aborted) return await fail('not-finished', `${String(c.signal.reason)} before recording; nothing was kept`);
        if (r.failure.kind === 'integrity') { skippedBackups++; log(`control-plane backup failed verification (${r.failure.summary}); trying an older one`); continue candidatesLoop; }
        if (r.failure.kind === 'infra' && !infraRetried) { infraRetried = true; log(`infrastructure failure (${r.failure.summary}); retrying the same backup once`); continue; }
        if (r.failure.kind === 'infra') return await fail('retryable', `${r.failure.summary}: press again`);
        if (r.failure.kind === 'create') return await fail('create', `Neon refused the project: ${r.failure.summary}`);
        return await fail('restore-failed', `${r.failure.summary}: contact the lead`);
      }
    }
    if (!built || !used) return await fail('no-backup', `no candidate verified (${skippedBackups} failed verification)`);
    pending = { id: built.projectId, name: built.name };

    // ---- 7. the re-check: the original back → keep using it ---------------------------------------------------------
    throwIfAborted(c.signal);
    let back: boolean;
    try {
      back = (await deps.neon.getProject(oldId)).found;
      if (!back) {
        const again = await pollRecoverable(env, 1);
        if (!again) return await fail('proof-failed', 'the re-check before recording could not read the recoverable list: press again');
        back = again.ids.has(oldId);
      }
    } catch (e) {
      return await fail('proof-failed', `the re-check before recording failed (${summaryOf('neon', e)}): press again`);
    }
    if (back) {
      const r = await fail('original-back', 'the old control-plane project is back: keep using the original; nothing was changed');
      return r;
    }

    // ---- 8. record, in one transaction, in the NEW control plane -----------------------------------------------------
    throwIfAborted(c.signal);
    const summary: CpSummary = {
      target: 'control-plane', previousProjectId: oldId, newProjectId: built.projectId, newProjectName: built.name, backupKey: used.key,
      backupStartedAt: built.backupStartedAt?.toISOString() ?? null, sha256: used.sha256, cpRunStartedAt: cpRunStartedAt.toISOString(),
    };
    const sql = postgres(clientUrl(connectUrl(built.connectionUri, deps.hostMap)), { max: 2, connect_timeout: 30, onnotice: () => {}, prepare: false });
    let runRowId: string;
    try {
      runRowId = await sql.begin(async (tx) => {
        const at = now();
        const [row] = await tx<{ id: string }[]>`INSERT INTO disaster_runs (run_id, mode, started_at, status, summary)
          VALUES (${args.runId}, 'control-plane', ${cpRunStartedAt}, 'running', ${tx.json(summary as unknown as postgres.JSONValue)}) RETURNING id::text AS id`;
        await raiseGlobalAlert(tx, { kind: 'rebuild-original-watch', dedupKey: oldId, detail: { kind: 'control-plane', oldProjectId: oldId, newProjectId: built!.projectId, watchStartedAt: at.toISOString() } }, at);
        await deps.hooks?.beforeCommit?.('control-plane');
        return row.id;
      }) as string;
    } catch (e) {
      await sql.end({ timeout: 5 }).catch(() => {});
      if (e instanceof Aborted) throw e;
      return await fail('retryable', `recording in the new control plane failed (${summaryOf('record', e)}): press again`);
    }
    pending = null; // a complete, recorded control plane: kept from here on
    log(`recorded control-plane run ${runRowId} in the new project ${built.projectId}`);

    // ---- 9. the reconcile, against the new control plane -------------------------------------------------------------
    let rc: ReconcileResult | null = null;
    let rcError: string | null = null;
    try {
      rc = await runReconcile({
        cp: sql, cpDirectHost: directHost(new URL(built.connectionUri).hostname), windowStart: built.backupStartedAt ?? cpRunStartedAt, windowEnd: cpRunStartedAt,
        runId: args.runId, deps, dryRun: false, now, sleep: c.sleep, log, signal: c.signal,
        controlPlaneProjectIds: [oldId, built.projectId],
      });
    } catch (e) {
      rcError = summaryOf('reconcile', e);
      log(`the reconcile failed (${rcError})`);
    }
    // §6.3 step 10: `fail` only if the reconcile threw; its unknowns are listed (B.5a re-presses `reconcile`).
    const pass = rc !== null;
    // ---- 10. finish: merge into the run row (never replace) ---------------------------------------------------------
    try {
      await sql`UPDATE disaster_runs SET status = ${pass ? 'pass' : 'fail'}, finished_at = ${now()},
        summary = coalesce(summary, '{}'::jsonb) || ${sql.json({ reconcile: rc?.summary ?? { error: rcError } } as postgres.JSONValue)}
        WHERE id = ${runRowId} AND status = 'running'`;
    } catch (e) {
      log(`the run row could not be finished (${summaryOf('record', e)}); the digest closes it`);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
    const when = built.backupStartedAt?.toISOString() ?? 'unknown';
    return {
      pass,
      results: [{ tenantId: 'control-plane', result: pass ? 'rebuilt' : 'rebuilt-reconcile-failed', newProjectId: built.projectId, backupKey: used.key, backupStartedAt: built.backupStartedAt }],
      email: [
        head,
        `The control plane was rebuilt into the new Neon project ${built.projectId} (${built.name}), database ${databaseName}, from the backup ${used.key} (started ${when} UTC).`,
        skippedBackups + skipped ? `${skippedBackups + skipped} newer backup(s) were skipped (failed verification or had no BACKUP line).` : '',
        `Changes to the control plane after ${when} UTC are rolled back; the reconcile below lists what to do about them.`,
        "If the old control-plane project comes back before you repoint, keep the old one and delete the new project.",
        ...(kept.length ? [`Projects that could not be deleted (delete them in the Neon console): ${kept.join(', ')}.`] : []),
        '',
        ...(rc ? rc.email : [`The reconcile did not finish (${rcError}): after repointing (RESTORE.md B.5), press mode reconcile.`]),
        '',
        'Next (RESTORE.md runbook B): B.4 if the old project came back; B.5 repoint Vercel, GitHub, SSM and your .env.local to the new project (pooled URL) and id; B.5a press reconcile if this email shows FAILED or any unknown; B.6 Deploy to Production with Skip lost workspaces; B.7 check; B.8 the Stripe resync; B.9 the lists above; B.10 re-enable the crons; B.11 email customers.',
      ].filter((l) => l !== ''),
    };
  } catch (e) {
    if (pending) { const k = await deleteVerified(deps, log, pending); if (k.kept) kept.push(k.kept); pending = null; }
    if (e instanceof Aborted) {
      return { pass: false, results: [{ tenantId: 'control-plane', result: 'not-finished', detail: e.reason }], email: [head, `Stopped (${e.reason}) before recording: ${kept.length ? `kept ${kept.join(', ')} (delete it in the Neon console)` : 'the new project was deleted'}. Press again.`] };
    }
    throw e;
  }
}
