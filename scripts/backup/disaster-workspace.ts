/**
 * Mode `workspace` (feature-plan-disaster-restore.md §6.4; state table §7.1). For each target, concurrency 2: facts →
 * proof (recorded) → backup candidates → create + restore + verify (integrity failures fall back to an older backup, up
 * to 3; an infrastructure failure retries the same backup once, then stops without switching; anything unclassified
 * stops) → guards → the re-check → the switch → `linked` (terminal). Any failure before the commit cleans up only after
 * a locked re-read proves the tenant row doesn't point at the new project.
 */
import { decrypt } from '../../src/lib/encryption';
import { toDirectConnectionUrl } from '../../src/lib/tenant/direct-url';
import { pgConnector } from './lib/classify-endpoint';
import { liveTenants, loadTenant, type TenantFacts } from './lib/disaster-sql';
import { summaryOf } from './lib/summarize-error';
import { runPool } from './lib/util';
import {
  Aborted, backupCandidates, buildOnce, cleanupProject, pollRecoverable, positiveControl, proveOriginal, recheckGone, recheckOverride,
  record, schemaNote, switchGuards, switchWorkspace, throwIfAborted, type Built, type Candidate, type SharedProof, type StepEnv,
} from './disaster-steps';
import type { RunContext, RunOutcome, WorkspaceResult } from './disaster';
import { DISASTER_DEFAULTS } from './disaster';
import { directHost } from './lib/neon-api';

export const DEFAULT_TIMING: StepEnv['timing'] = {
  recoverablePolls: 6, recoverablePollMs: 10_000, overrideGapMs: 60_000, lockRetryMs: 10_000, cleanupRetryMs: 30_000, cleanupLockTimeout: '30s',
};

const LIVE = new Set(['active', 'suspended', 'provisioning']);

export function stepEnv(ctx: RunContext, projectKind: StepEnv['projectKind']): StepEnv {
  return {
    args: ctx.args, deps: ctx.deps, cp: ctx.cp, cpId: ctx.deps.cpId,
    cpDirectHost: directHost(new URL(toDirectConnectionUrl(ctx.deps.controlPlaneUrl)).hostname),
    neon: ctx.deps.neon, connect: ctx.deps.connector ?? pgConnector({ hostMap: ctx.deps.hostMap }), now: ctx.now, sleep: ctx.sleep, log: ctx.log,
    signal: ctx.signal, projectKind, timing: { ...DEFAULT_TIMING, ...ctx.deps.timing },
  };
}

/** How long cleanup may keep retrying its locked re-read: the 120-second stop window after SIGTERM, else the run's slack. */
export function cleanupBudgetMs(signal: AbortSignal, override?: number): number {
  if (override !== undefined) return override;
  return signal.aborted && signal.reason === 'stopped' ? 100_000 : 4 * 60_000;
}

export async function runWorkspace(ctx: RunContext): Promise<RunOutcome> {
  const env = stepEnv(ctx, 'rebuild');
  const results: WorkspaceResult[] = [];
  let ids: string[];
  let shared: SharedProof = {};
  if (ctx.args.targets === 'all-lost') {
    // Only tenants whose project 404s are candidates (never via the override); then ONE control and ONE list for all.
    const live = (await liveTenants(ctx.cp)).filter((t) => t.neonProjectId);
    const gone: string[] = [];
    await runPool(live, 4, async (t) => {
      try {
        if (!(await env.neon.getProject(t.neonProjectId!)).found) gone.push(t.id);
      } catch (e) {
        // FR9: never dropped silently: reported as proof-failed ("press again"), and the run isn't a pass.
        ctx.log(`${t.id}: project lookup failed (${summaryOf('neon', e)})`);
        results.push({ tenantId: t.id, result: 'proof-failed', detail: "its project lookup failed, so it couldn't be checked: press again" });
      }
    });
    ids = gone.sort();
    ctx.log(`all-lost: ${ids.length} workspace(s) whose project is missing, of ${live.length} live`);
    if (ids.length > 0) shared = { control: await positiveControl(env, null), recoverable: await pollRecoverable(env) };
  } else if (Array.isArray(ctx.args.targets)) {
    ids = ctx.args.targets;
  } else {
    return { pass: false, results, email: ['mode workspace needs workspace ids or all-lost'] };
  }

  await runPool(ids, ctx.deps.concurrency ?? DISASTER_DEFAULTS.concurrency, async (id) => {
    if (ctx.signal.aborted) {
      results.push({ tenantId: id, result: 'not-started', detail: 'not started; press again' });
      return;
    }
    let r: WorkspaceResult;
    try {
      r = await rebuildOne(env, id, shared);
    } catch (e) {
      r = { tenantId: id, result: e instanceof Aborted ? 'not-finished' : 'error', detail: summaryOf('workspace', e) };
    }
    if (ctx.args.targets === 'all-lost' && r.result === 'reachable') r = { ...r, result: 'not-lost' };
    results.push(r);
    ctx.log(`${id}: ${r.result}`);
  });

  const ok = (r: WorkspaceResult) => r.result === 'linked' || r.result === 'not-lost';
  const email = [
    `Disaster restore (workspace${ctx.args.override === 'unreachable-4h' ? ', override unreachable-4h' : ''}), run ${ctx.args.runId}.`,
    ids.length === 0 && results.length === 0 ? 'No workspace is proven lost: nothing was rebuilt.' : '',
    ...results.flatMap((r) => emailLines(r)),
    results.some((r) => r.result === 'linked') ? 'Next: run Deploy to Production now (tick skip_lost_workspaces if other workspaces are still lost), then email each customer with template A (RESTORE.md runbook A).' : '',
  ].filter(Boolean);
  return { pass: results.length > 0 ? results.every(ok) : true, results, email };
}

function emailLines(r: WorkspaceResult): string[] {
  const head = `- ${r.tenantId}${r.slug ? ` (${r.slug})` : ''}: ${r.result}${r.detail ? `: ${r.detail}` : ''}`;
  if (r.result !== 'linked') return [head];
  const when = r.backupStartedAt ? r.backupStartedAt.toISOString() : 'unknown';
  return [
    head,
    `  backup used: ${r.backupKey ?? '?'} (started ${when} UTC); changes after ${when} UTC need re-entering.`,
    r.skippedBackups ? `  ${r.skippedBackups} newer backup(s) failed verification and were skipped.` : '',
    r.evidence ? `  override evidence: ${r.evidence}; the original is kept and watched.` : '  the original is kept and watched.',
    `  in the Neon console, lower neon-ops@ to Viewer on project ${r.newProjectId} (runbook A.7).`,
  ].filter(Boolean);
}

/** One workspace (§7.1). */
async function rebuildOne(env: StepEnv, id: string, shared: SharedProof): Promise<WorkspaceResult> {
  const out = (result: string, detail?: string, more: Partial<WorkspaceResult> = {}): WorkspaceResult => ({ tenantId: id, result, detail, ...more });

  // ---- 1. facts ----------------------------------------------------------------------------------------------------
  const t = await loadTenant(env.cp, id);
  if (!t) return out('facts', 'no such workspace');
  const slug = t.slug;
  if (!LIVE.has(t.status) || !t.dbUrlEncrypted) return out('facts', `status ${t.status}${t.dbUrlEncrypted ? '' : ', no database URL'}`, { slug });
  if (!t.neonProjectId) return out('facts', 'no Neon project id on record', { slug });
  let url: string;
  try {
    url = decrypt(t.dbUrlEncrypted);
  } catch {
    return out('facts', 'the database URL could not be decrypted', { slug });
  }
  const oldUrlEncrypted = t.dbUrlEncrypted;
  const oldProjectId = t.neonProjectId;
  const deletionDue = t.deletionScheduledFor !== null && t.deletionScheduledFor.getTime() <= env.now().getTime();

  // ---- 2. proof (recorded: --skip-lost reads it) ---------------------------------------------------------------------
  throwIfAborted(env.signal);
  const proof = await proveOriginal(env, t, url, oldProjectId, shared);
  await record(env, id, 'proof', proof.status, { oldProjectId, detail: deletionDue ? 'deletion-due' : proof.evidence ?? null });
  if (deletionDue) return out('deletion-due', 'its deletion date has passed: not rebuilt (deploys can skip it; RESTORE.md A.8)', { slug });
  if (!proof.proven) return out(proof.result, proof.message, { slug });

  // ---- 4. candidates -----------------------------------------------------------------------------------------------
  const { candidates, skipped: unconfirmed } = await backupCandidates(env, id);
  if (candidates.length === 0) return out('no-backup', 'no verified backup object for this workspace', { slug });

  // ---- 5–6. build, falling back only on integrity failures ---------------------------------------------------------
  const ws = new AbortController();
  const onRun = () => ws.abort(env.signal.reason);
  env.signal.addEventListener('abort', onRun, { once: true });
  if (env.signal.aborted) onRun();
  let built: Built | null = null;
  let used: Candidate | null = null;
  /** A built project not yet linked or cleaned: the catch below cleans it up (step 10). */
  let pending: { id: string; name: string } | null = null;
  let inFlightSwitch: Promise<unknown> | undefined;
  let skippedBackups = 0;
  let tryNo = 0;
  const clean = async (p: { id: string | null; name: string } | null, inFlight?: Promise<unknown>) => {
    if (!p) return 'failed' as const;
    if (pending && pending.id === p.id) pending = null;
    const backup = built && used && built.projectId === p.id ? { key: used.key, sha256: used.sha256, startedAt: built.backupStartedAt } : undefined;
    return cleanupProject(env, t, p, { switchInFlight: inFlight, budgetMs: cleanupBudgetMs(env.signal, env.timing.cleanupBudgetMs), lockedReRead: true, oldProjectId, backup });
  };
  try {
    candidatesLoop:
    for (const cand of candidates.slice(0, 3)) {
      let infraRetried = false;
      for (;;) {
        throwIfAborted(ws.signal);
        tryNo++;
        const r = await buildOnce(env, t, cand, tryNo, ws.signal);
        if (r.ok) { built = r.built; used = cand; break candidatesLoop; }
        const c = await clean(r.project);
        if (c === 'linked') return out('linked', 'healed', { slug }); // can't happen before a switch; kept for safety
        if (ws.signal.aborted) return out('not-finished', String(ws.signal.reason), { slug });
        if (r.failure.kind === 'integrity') { skippedBackups++; env.log(`${id}: backup failed verification (${r.failure.summary}); trying an older one`); continue candidatesLoop; }
        if (r.failure.kind === 'infra' && !infraRetried) { infraRetried = true; env.log(`${id}: infrastructure failure (${r.failure.summary}); retrying the same backup once`); continue; }
        if (r.failure.kind === 'infra') return out('retryable', `${r.failure.summary}: press again`, { slug });
        if (r.failure.kind === 'create') return out('create', `Neon refused the project: ${r.failure.summary}`, { slug });
        return out('restore-failed', `${r.failure.summary}: contact the lead`, { slug });
      }
    }
    if (!built || !used) return out('no-backup', `no candidate verified (${skippedBackups} failed)`, { slug, skippedBackups });
    const project = { id: built.projectId, name: built.name };
    pending = project;

    // ---- 7. guards ---------------------------------------------------------------------------------------------------
    const guard = await switchGuards(env, t, built);
    if (guard) {
      await clean(project);
      return out('guard', guard, { slug });
    }

    // ---- 8. the re-check, then the switch ------------------------------------------------------------------------------
    // The re-check follows WHICH PROOF PASSED, never what was typed (fix round 1, FR1): an override press whose project
    // turns out gone (404) took the gone proof, so it re-checks "still gone" and raises no `returned` at the switch.
    const overrideProof = proof.status === 'unreachable-4h';
    throwIfAborted(ws.signal);
    if (overrideProof) {
      const re = await recheckOverride(env, t, url, oldProjectId);
      if (!re.ok) {
        await clean(project);
        await record(env, id, 'proof', re.status, { oldProjectId, detail: 're-check before the switch' });
        return out('reachable-now', 'reachable now, or unproven: nothing switched', { slug });
      }
    } else if (!(await recheckGone(env, t, url, oldProjectId))) {
      await clean(project);
      await record(env, id, 'proof', 'refused:proof-failed', { oldProjectId, detail: 'the original is back (re-check before the switch)' });
      return out('original-back', 'the original is back: nothing switched', { slug });
    }

    // FR5: a stop or the deadline during the guards or the re-check goes to cleanup, never to the switch.
    throwIfAborted(ws.signal);
    const inFlight = switchWorkspace(env, { t, oldUrlEncrypted, oldProjectId, built, backupKey: used.key, sha256: used.sha256, override: overrideProof });
    inFlightSwitch = inFlight;
    let s: Awaited<typeof inFlight>;
    try {
      s = await inFlight;
    } catch (e) {
      // The commit's outcome is unknown (a dropped acknowledgement): the locked re-read decides.
      env.log(`${id}: the switch call failed (${summaryOf('switch', e)}); re-reading under the tenant lock`);
      const c = await clean(project, inFlight);
      if (c === 'linked') return linkedResult(env, t, built, used, skippedBackups, unconfirmed, proof.evidence);
      return out('retryable', 'the switch did not complete: press again', { slug });
    }
    if (s === 'linked') { pending = null; return linkedResult(env, t, built, used, skippedBackups, unconfirmed, proof.evidence); }
    await clean(project);
    return s === 'changed-meanwhile' ? out('changed-meanwhile', 'the workspace changed during the rebuild: nothing switched', { slug }) : out('retryable', 'the tenant lock stayed busy: press again', { slug });
  } catch (e) {
    // Deadline, SIGTERM or an error mid-flight (step 10): a project built and not linked is cleaned up after the locked
    // re-read (which waits for an in-flight switch and keeps the project if the commit landed).
    if (pending) {
      const c = await clean(pending, inFlightSwitch);
      if (c === 'linked' && built && used) return linkedResult(env, t, built, used, skippedBackups, unconfirmed, proof.evidence);
    }
    if (e instanceof Aborted) return out('not-finished', `${e.reason} before the switch`, { slug });
    throw e;
  } finally {
    env.signal.removeEventListener('abort', onRun);
  }
}

async function linkedResult(env: StepEnv, t: TenantFacts, built: Built, used: Candidate, skippedBackups: number, unconfirmed: number, evidence?: string): Promise<WorkspaceResult> {
  const note = await schemaNote(env, t, built.connectionUri).catch(() => 'run Deploy to Production now to be safe');
  return {
    tenantId: t.id, slug: t.slug, result: 'linked', detail: note, backupKey: used.key, backupStartedAt: built.backupStartedAt,
    newProjectId: built.projectId, evidence: evidence ?? null, skippedBackups: skippedBackups + unconfirmed,
  };
}
