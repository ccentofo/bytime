/**
 * Mode `rehearse` (feature-plan-disaster-restore.md §6.5): mode `workspace` for one workspace without the switch, plus
 * every Neon and AWS read the real path needs. Monthly by schedule (`--targets auto`) and on demand from the button.
 *
 *  - step 2 runs the full proof against the LIVE original and requires: 200, the positive control, the recoverable list;
 *    with override `canary` (the founder's first rehearsal), the list must contain `cadenzpoint-recoverable-canary` and
 *    GET on its id must 404 (legs (a) and (c) for another member's deleted project). Its proof row is `rehearse-ok`.
 *  - steps 4–7 as mode workspace (the guards are plain reads); no re-check, no switch, no tenant lock.
 *  - step 10 always: delete the project, verify the 404, append `deleted`; see it in the recoverable list (polled); then
 *    classify its deleted endpoint, retrying up to 5 minutes, and require "doesn't answer"; append `rehearsed-deleted`.
 */
import { decrypt } from '../../src/lib/encryption';
import { loadTenant } from './lib/disaster-sql';
import { classifyGoneEndpoint, tenantCandidateRule } from './lib/classify-endpoint';
import { summaryOf } from './lib/summarize-error';
import {
  backupCandidates, buildOnce, cleanupProject, networkProven, pollRecoverable, positiveControl, record, switchGuards, throwIfAborted,
  type Built, type StepEnv,
} from './disaster-steps';
import { cleanupBudgetMs, stepEnv } from './disaster-workspace';
import type { RunContext, RunOutcome, WorkspaceResult } from './disaster';
import { CANARY_PROJECT_NAME, controlPlaneRehearsalName } from './lib/project-names';
import { CONTROL_PLANE_TARGET } from './disaster';
import { CONTROL_PLANE_ID } from './lib/keys';
import { connectUrl } from './lib/host-map';
import { clientUrl } from './lib/pg-url';
import { directHost } from './lib/neon-api';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { tenantDbHistoryRetentionSeconds } from '../../src/lib/tenant/lifecycle-config';
import { buildCore, record as recordAction } from './disaster-steps';
import { controlPlaneCandidates, earlierRebuilds } from './disaster-control-plane';
import { runReconcile } from './disaster-reconcile';
import postgres from 'postgres';

export const CANARY_NAME = CANARY_PROJECT_NAME;
export const REHEARSAL_SLUG = 'rehearsal';
const LIVE = new Set(['active', 'suspended', 'provisioning']);

/**
 * `auto`: the `rehearsal` workspace when eligible; otherwise a random workspace that is live, not due for deletion, and
 * has an `ok` backup in the last 36 h. None → null (the rehearsal fails "no eligible workspace").
 */
export async function pickAuto(env: StepEnv, random: () => number = Math.random): Promise<string | null> {
  const since = new Date(env.now().getTime() - 36 * 3600_000);
  const rows = await env.cp<Array<{ id: string; slug: string }>>`
    SELECT t.id::text AS id, t.slug FROM tenants t
    WHERE t.status IN ('active', 'suspended', 'provisioning') AND t.db_url_encrypted IS NOT NULL AND t.neon_project_id IS NOT NULL
      AND (t.deletion_scheduled_for IS NULL OR t.deletion_scheduled_for > ${env.now()})
      AND EXISTS (SELECT 1 FROM database_backups b WHERE b.tenant_id = t.id AND b.status = 'ok' AND b.finished_at >= ${since})
    ORDER BY t.id`;
  if (rows.length === 0) return null;
  return (rows.find((r) => r.slug === REHEARSAL_SLUG) ?? rows[Math.floor(random() * rows.length)]).id;
}

export async function runRehearse(ctx: RunContext): Promise<RunOutcome> {
  if (ctx.args.targets === CONTROL_PLANE_TARGET) return runRehearseControlPlane(ctx);
  const env = stepEnv(ctx, 'rehearse');
  const started = Date.now();
  let id: string | null;
  if (ctx.args.targets === 'auto') id = await pickAuto(env);
  else id = Array.isArray(ctx.args.targets) && ctx.args.targets.length === 1 ? ctx.args.targets[0] : null;
  if (!id) {
    return { pass: false, results: [], email: ['Rehearsal FAILED: no eligible workspace (no live workspace with an ok backup in the last 36 hours, and no `rehearsal` workspace).'] };
  }
  let r: WorkspaceResult;
  try {
    r = await rehearseOne(env, id);
  } catch (e) {
    r = { tenantId: id, result: 'error', detail: summaryOf('rehearse', e) };
  }
  const pass = r.result === 'rehearsed';
  return {
    pass,
    results: [r],
    email: [
      `Disaster rehearsal ${pass ? 'passed' : 'FAILED'} (run ${ctx.args.runId}${ctx.args.override === 'canary' ? ', canary check' : ''}), workspace ${id}${r.slug ? ` (${r.slug})` : ''}.`,
      `- ${r.result}${r.detail ? `: ${r.detail}` : ''}`,
      r.backupKey ? `- backup restored: ${r.backupKey} (started ${r.backupStartedAt?.toISOString() ?? 'unknown'} UTC); every count matched; the copy was deleted.` : '',
      `- took ${Math.round((Date.now() - started) / 1000)} s. No workspace was changed.`,
    ].filter(Boolean),
  };
}

async function rehearseOne(env: StepEnv, id: string): Promise<WorkspaceResult> {
  const out = (result: string, detail?: string, more: Partial<WorkspaceResult> = {}): WorkspaceResult => ({ tenantId: id, result, detail, ...more });
  const t = await loadTenant(env.cp, id);
  if (!t) return out('facts', 'no such workspace');
  const slug = t.slug;
  if (!LIVE.has(t.status) || !t.dbUrlEncrypted || !t.neonProjectId) return out('facts', `status ${t.status}; a live workspace with a database and a project id is required`, { slug });
  try { decrypt(t.dbUrlEncrypted); } catch { return out('facts', 'the database URL could not be decrypted', { slug }); }
  const oldProjectId = t.neonProjectId;

  // ---- step 2 against the live original --------------------------------------------------------------------------
  const fail = async (status: string, detail: string) => {
    await record(env, id, 'proof', `refused:${status}`, { oldProjectId, detail });
    return out('proof-failed', detail, { slug });
  };
  let found: boolean;
  try {
    found = (await env.neon.getProject(oldProjectId)).found;
  } catch (e) {
    return fail('proof-failed', `the original's project lookup failed (${summaryOf('neon', e)})`);
  }
  if (!found) return fail('proof-failed', 'the original project does not answer 200: not a rehearsal target');
  if (!(await positiveControl(env, id))) return fail('proof-failed', "the positive control failed (the key or org can't see the organisation)");
  const rec = await pollRecoverable(env);
  if (!rec) return fail('proof-failed', 'the recoverable list could not be read completely');
  if (env.args.override === 'canary') {
    const canaryId = rec.names.get(CANARY_NAME);
    if (!canaryId) return fail('proof-failed', `the canary ${CANARY_NAME} is not in this key's recoverable list (Q1: try the Editor role)`);
    try {
      if ((await env.neon.getProject(canaryId)).found) return fail('proof-failed', 'the canary answers 200; it must be deleted');
    } catch (e) {
      return fail('proof-failed', `GET on the canary did not return 404 (${summaryOf('neon', e)})`);
    }
  }
  await record(env, id, 'proof', 'rehearse-ok', { oldProjectId, detail: env.args.override === 'canary' ? 'canary seen in the recoverable list; GET 404' : null });

  // ---- steps 4–7 -------------------------------------------------------------------------------------------------
  const { candidates } = await backupCandidates(env, id);
  if (candidates.length === 0) return out('no-backup', 'no verified backup object for this workspace', { slug });
  let built: Built | null = null;
  let used: (typeof candidates)[number] | null = null;
  let tryNo = 0;
  const clean = (p: { id: string | null; name: string } | null) => (p
    ? cleanupProject(env, t, p, { budgetMs: cleanupBudgetMs(env.signal, env.timing.cleanupBudgetMs), lockedReRead: false, oldProjectId })
    : Promise.resolve('failed' as const));
  candidatesLoop:
  for (const cand of candidates.slice(0, 3)) {
    let infraRetried = false;
    for (;;) {
      throwIfAborted(env.signal);
      tryNo++;
      const r = await buildOnce(env, t, cand, tryNo, env.signal);
      if (r.ok) { built = r.built; used = cand; break candidatesLoop; }
      await clean(r.project); // a rehearsal that fails mid-restore still deletes its project
      if (env.signal.aborted) return out('not-finished', String(env.signal.reason), { slug });
      if (r.failure.kind === 'integrity') continue candidatesLoop;
      if (r.failure.kind === 'infra' && !infraRetried) { infraRetried = true; continue; }
      return out(r.failure.kind === 'infra' ? 'retryable' : r.failure.kind === 'create' ? 'create' : 'restore-failed', r.failure.summary, { slug });
    }
  }
  if (!built || !used) return out('no-backup', 'no candidate verified', { slug });
  const project = { id: built.projectId, name: built.name };
  const guard = await switchGuards(env, t, built).catch((e) => `guards failed (${summaryOf('guards', e)})`);

  // ---- step 10, always: delete, verify, see it recoverable, classify the deleted endpoint ---------------------------
  const deleted = await clean(project);
  if (deleted !== 'deleted') return out('cleanup-failed', 'the rehearsal copy could not be deleted (the leftover finding will list it)', { slug });
  if (guard) return out('guard', guard, { slug });
  const seen = await pollRecoverable(env);
  if (!seen || !seen.ids.has(built.projectId)) return out('proof-failed', "the deleted copy didn't appear in this key's recoverable list: the real proof would misjudge", { slug });
  const t0 = Date.now();
  const waitMs = env.timing.deletedEndpointWaitMs ?? 5 * 60_000;
  let cls = 'unproven';
  let code: string | null = null;
  for (;;) {
    const c = await classifyGoneEndpoint({ url: built.connectionUri, connect: env.connect, neon: env.neon, rule: tenantCandidateRule(t.slug, t.id) });
    cls = c.cls;
    code = c.code;
    if (cls === 'doesnt-answer' || Date.now() - t0 >= waitMs) break;
    await env.sleep(env.timing.deletedEndpointPollMs ?? 15_000);
  }
  const delay = Math.round((Date.now() - t0) / 1000);
  if (cls !== 'doesnt-answer') {
    await record(env, id, 'rehearse', 'failed', { projectName: built.name, newProjectId: built.projectId, detail: `deleted endpoint classified ${cls} (${code ?? 'no code'}) after ${delay} s` });
    return out('proof-failed', `the deleted endpoint still classifies "${cls}" after ${delay} s: the real proof would misjudge a lost workspace`, { slug });
  }
  await record(env, id, 'rehearse', 'rehearsed-deleted', { projectName: built.name, newProjectId: built.projectId, backupKey: used.key, detail: `deleted endpoint: doesn't answer (${code ?? 'no code'}) after ${delay} s` });
  return out('rehearsed', `deleted endpoint answers ${code ?? 'nothing'} (doesn't answer) after ${delay} s`, { slug, backupKey: used.key, backupStartedAt: built.backupStartedAt });
}


// ---- the control-plane rehearsal (feature-plan-control-plane-disaster.md §6.5) -----------------------------------------

/**
 * `rehearse --targets control-plane` (monthly on the 15th, and once at setup): the control plane is live, so 3c's normal
 * start applies (lock, run row in the real control plane, target control-plane). Proof legs against the live control
 * plane; the earlier-rebuild check read-only; build into the rehearsal name with 3c's `rehearse` rows in the REAL control
 * plane (intended → created → rehearsed-deleted, so the leftover check covers a crash); a dry-run reconcile of the
 * restored copy (proof rows land in the copy only); then always delete the copy and verify the 404.
 */
export async function runRehearseControlPlane(ctx: RunContext): Promise<RunOutcome> {
  const env = stepEnv(ctx, 'rehearse');
  const deps = ctx.deps;
  const started = Date.now();
  const head = `Disaster rehearsal of the control plane (run ${ctx.args.runId}).`;
  const failed = (result: string, detail: string, more: Partial<WorkspaceResult> = {}): RunOutcome => ({
    pass: false, results: [{ tenantId: 'control-plane', result, detail, ...more }],
    email: [`${head} FAILED: ${result}: ${detail}.`, 'No workspace or control-plane data was changed. Tell the lead.'],
  });
  const record = (status: string, o: Parameters<typeof recordAction>[4] = {}) => recordAction(env, null, 'rehearse', status, o);

  // ---- 1. proof legs against the live control plane -------------------------------------------------------------------
  if (!(await networkProvenCp(env))) return failed('proof-failed', "this task's own network couldn't be proven");
  if (!(await positiveControl(env, null))) return failed('proof-failed', "the positive control failed (the key or org can't see the organisation)");
  try {
    if (!(await deps.neon.getProject(deps.controlPlaneProjectId)).found) return failed('proof-failed', "CONTROL_PLANE_PROJECT_ID doesn't answer 200 (the real proof would misjudge)");
  } catch (e) {
    return failed('proof-failed', `the control plane's project lookup failed (${summaryOf('neon', e)})`);
  }
  if (!(await pollRecoverable(env))) return failed('proof-failed', 'the recoverable list could not be read completely');
  let listed;
  try {
    listed = await controlPlaneCandidates(deps, ctx.log);
  } catch (e) {
    return failed('proof-failed', `the control-plane backup listing failed (${summaryOf('s3', e)})`);
  }
  if (listed.candidates.length === 0) return failed('no-backup', 'no verified control-plane backup (an object with a sidecar and a BACKUP line)');

  // ---- 2. the earlier-rebuild check, read-only ---------------------------------------------------------------------------
  try {
    const all = await deps.neon.listProjects();
    const earlier = all.unavailable.length ? null : earlierRebuilds(all.projects);
    ctx.log(earlier === null ? 'rehearsal: the earlier-rebuild check could not list every project' : `rehearsal: ${earlier.length} earlier control-plane rebuild(s) present`);
  } catch (e) {
    ctx.log(`rehearsal: the earlier-rebuild check failed (${summaryOf('neon', e)})`);
  }

  // ---- 3. build into the rehearsal name (3c's failure classes) -------------------------------------------------------------
  const cpUrl = new URL(toDirectConnectionUrl(deps.controlPlaneUrl));
  const databaseName = decodeURIComponent(cpUrl.pathname.replace(/^\//, '')) || 'cadenzpoint_control';
  let built: Built | null = null;
  let used: (typeof listed.candidates)[number] | null = null;
  let tryNo = 0;
  const removeCopy = async (p: { id: string | null; name: string } | null): Promise<boolean> => {
    if (!p?.id) return true;
    try {
      await deps.neon.deleteProject(p.id);
      if (await deps.neon.verifyGone(p.id)) { await record('deleted', { projectName: p.name, newProjectId: p.id }); return true; }
      await record('failed', { projectName: p.name, newProjectId: p.id, detail: 'delete: the copy still answers after DELETE (kept; the leftover check lists it)' }).catch(() => {});
    } catch (e) {
      await record('failed', { projectName: p.name, newProjectId: p.id, detail: `delete: ${summaryOf('neon', e)}` }).catch(() => {});
    }
    return false;
  };
  candidatesLoop:
  for (const cand of listed.candidates.slice(0, 3)) {
    let infraRetried = false;
    for (;;) {
      throwIfAborted(env.signal);
      tryNo++;
      const r = await buildCore(env, {
        target: 'control-plane', id: CONTROL_PLANE_ID, name: controlPlaneRehearsalName(env.now(), tryNo), databaseName, historyRetentionSeconds: tenantDbHistoryRetentionSeconds(),
        record: (status, f) => record(status, f),
      }, cand, env.signal);
      if (r.ok) { built = r.built; used = cand; break candidatesLoop; }
      if (!(await removeCopy(r.project))) return failed('cleanup-failed', `a failed rehearsal copy could not be deleted (${r.project?.id}); the leftover check lists it`);
      if (env.signal.aborted) return failed('not-finished', String(env.signal.reason));
      if (r.failure.kind === 'integrity') continue candidatesLoop;
      if (r.failure.kind === 'infra' && !infraRetried) { infraRetried = true; continue; }
      return failed(r.failure.kind === 'infra' ? 'retryable' : r.failure.kind === 'create' ? 'create' : 'restore-failed', r.failure.summary);
    }
  }
  if (!built || !used) return failed('no-backup', 'no candidate verified');

  // ---- 4. reconcile the restored copy, dry run ------------------------------------------------------------------------------
  let rc: Awaited<ReturnType<typeof runReconcile>> | null = null;
  let rcError: string | null = null;
  const copy = postgres(clientUrl(connectUrl(built.connectionUri, deps.hostMap)), { max: 4, connect_timeout: 30, onnotice: () => {}, prepare: false });
  try {
    rc = await runReconcile({
      cp: copy, cpDirectHost: directHost(new URL(built.connectionUri).hostname), windowStart: built.backupStartedAt ?? new Date(env.now().getTime() - 26 * 3600_000), windowEnd: env.now(),
      runId: ctx.args.runId, deps, dryRun: true, now: env.now, sleep: env.sleep, log: ctx.log, signal: env.signal,
      controlPlaneProjectIds: [deps.controlPlaneProjectId, built.projectId],
    });
  } catch (e) {
    rcError = summaryOf('reconcile', e);
    ctx.log(`rehearsal: the reconcile of the copy failed (${rcError})`);
  } finally {
    await copy.end({ timeout: 5 }).catch(() => {});
  }

  // ---- 5. always: delete the copy, verify the 404, rehearsed-deleted --------------------------------------------------------
  const p = { id: built.projectId, name: built.name };
  let deleted = false;
  try {
    await deps.neon.deleteProject(p.id);
    deleted = await deps.neon.verifyGone(p.id);
  } catch (e) {
    ctx.log(`rehearsal: deleting the copy ${p.id} failed (${summaryOf('neon', e)})`);
  }
  if (!deleted) {
    await record('failed', { projectName: p.name, newProjectId: p.id, detail: 'delete: the rehearsal copy still answers (kept; the leftover check lists it)' }).catch(() => {});
    return failed('cleanup-failed', `the rehearsal copy ${p.id} could not be deleted; the leftover check alerts after 6 hours`);
  }
  await record('rehearsed-deleted', { projectName: p.name, newProjectId: p.id, backupKey: used.key, detail: rcError ? `reconcile failed: ${rcError}` : 'copy restored, reconciled (dry run) and deleted' });
  if (rcError || !rc) return failed('reconcile-failed', `the dry-run reconcile of the copy threw (${rcError}); the copy was deleted`, { backupKey: used.key });
  const when = built.backupStartedAt?.toISOString() ?? 'unknown';
  return {
    pass: true,
    results: [{ tenantId: 'control-plane', result: 'rehearsed', backupKey: used.key, backupStartedAt: built.backupStartedAt, newProjectId: built.projectId }],
    summary: { reconcile: rc.summary },
    email: [
      `${head} passed.`,
      `- backup restored: ${used.key} (started ${when} UTC); every count matched; the copy ${p.id} was reconciled (dry run) and deleted.`,
      `- the dry-run reconcile's counts (informational): ${Object.entries(rc.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      `- took ${Math.round((Date.now() - started) / 1000)} s. No workspace or control-plane data was changed.`,
    ],
  };
}

/** Network first for the control-plane rehearsal: the restore-test database, or 3c's live-workspace check. */
async function networkProvenCp(env: StepEnv): Promise<boolean> {
  if (env.deps.restoreTestUrl && (await env.connect(env.deps.restoreTestUrl)).cls === 'ok') return true;
  try { return await networkProven(env, '00000000-0000-0000-0000-000000000000'); } catch { return false; }
}
