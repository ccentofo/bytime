/**
 * The `disaster` command (feature-plan-disaster-restore.md §6.4–§6.5): rebuild a lost workspace from its newest verified
 * backup into a NEW Neon project and switch it over (mode `workspace`), or prove the whole path without the switch (mode
 * `rehearse`). Started by the founder's button (`gh-…`), the CloudShell fallback (`cloudshell-…`) or, rehearse only, the
 * monthly schedule.
 *
 *   disaster workspace --targets <uuid,…|all-lost> [--override none|unreachable-4h] [--run-id <id>]
 *   disaster rehearse  --targets <uuid|auto>       [--override none|canary]         [--run-id <id>]
 *
 * An unknown flag exits 2 (reserved: the button reports "this image is older than the button"); every other failure
 * exits 1. Logs carry ids only, never a slug or a URL (the disaster log group keeps 365 days; invariant 6).
 *
 * Start (§6.4 "Start"): who started it (workspace needs gh-/cloudshell-); one run at a time (oldest running task wins);
 * DISASTER_LOCK_KEY through 3b's lock factory, waiting up to 3 minutes; older `running` runs closed `fail`/`abandoned`;
 * this run's row. End: the run row set once (never over a row the digest already closed), one email to the alert topic.
 * The deadline (330 min) and SIGTERM stop the work; a hard exit fires 5 minutes after the deadline.
 */
import postgres from 'postgres';
import { DISASTER_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { acquireLock, type Connect, type HeldLock, type LockTiming } from './lib/locks';
import { controlPlaneClient } from './lib/sql';
import { summaryOf } from './lib/summarize-error';
import type { DisasterEcs, Publisher } from './lib/aws-clients';
import type { NeonApi } from './lib/neon-api';
import type { LogReader } from './lib/log-reader';
import type { BackupReader } from './lib/store';
import type { KeyringFactory } from './lib/crypto';
import type { SpawnFn } from './lib/child';
import type { HostMap } from './lib/host-map';
import { MINUTE } from './lib/util';
import { runWorkspace } from './disaster-workspace';
import { runRehearse } from './disaster-rehearse';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUN_ID_RE = /^[A-Za-z0-9_/-]{1,80}$/;
export const MAX_TARGETS = 50;

export type DisasterMode = 'workspace' | 'rehearse';
export type DisasterOverride = 'none' | 'unreachable-4h' | 'canary';

export interface DisasterArgs {
  mode: DisasterMode;
  /** Workspace ids (deduplicated), or `all-lost` (workspace), or `auto` (rehearse). */
  targets: string[] | 'all-lost' | 'auto';
  override: DisasterOverride;
  runId: string;
}

export type ParseResult = { ok: true; args: DisasterArgs } | { ok: false; exitCode: 1 | 2; message: string };

const pad = (n: number) => String(n).padStart(2, '0');
/** `task-<YYYYMMDDTHHMMSSZ>`: the run id when none is passed (the monthly schedule). */
export function taskRunId(now: Date): string {
  return `task-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

/**
 * The one argv grammar (the task, the button's tests and the schedule's D7 check all use it). `argv` starts at the mode:
 * `["workspace", "--targets", "…", "--override", "none", "--run-id", "gh-1-1"]`.
 */
export function parseDisasterArgs(argv: string[], now: Date = new Date()): ParseResult {
  const bad = (message: string): ParseResult => ({ ok: false, exitCode: 1, message });
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (a !== '--targets' && a !== '--override' && a !== '--run-id') return { ok: false, exitCode: 2, message: `unknown flag ${a.slice(0, 40)}` };
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return bad(`${a} needs a value`);
      if (flags.has(a)) return bad(`${a} given twice`);
      flags.set(a, v);
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return bad('usage: disaster workspace|rehearse --targets … [--override …] [--run-id …]');
  const mode = positional[0];
  if (mode !== 'workspace' && mode !== 'rehearse') return bad('mode must be workspace or rehearse');
  const override = (flags.get('--override') ?? 'none') as DisasterOverride;
  if (!['none', 'unreachable-4h', 'canary'].includes(override)) return bad('override must be none, unreachable-4h or canary');
  if (mode === 'workspace' && override === 'canary') return bad('override canary is only for rehearse');
  if (mode === 'rehearse' && override === 'unreachable-4h') return bad('override unreachable-4h is only for workspace');
  const raw = flags.get('--targets');
  if (!raw) return bad('--targets is required');
  let targets: DisasterArgs['targets'];
  if (raw === 'all-lost') {
    if (mode !== 'workspace') return bad('all-lost is only for workspace');
    if (override !== 'none') return bad("all-lost can't be combined with an override");
    targets = 'all-lost';
  } else if (raw === 'auto') {
    if (mode !== 'rehearse') return bad('auto is only for rehearse');
    targets = 'auto';
  } else {
    const ids = raw.split(',');
    if (ids.length > MAX_TARGETS || ids.some((id) => !UUID_RE.test(id))) return bad('targets must be lowercase workspace ids (uuid), comma-separated, up to 50');
    targets = [...new Set(ids)];
    if (mode === 'rehearse' && targets.length !== 1) return bad('rehearse takes exactly one workspace id');
  }
  const runId = flags.get('--run-id') ?? taskRunId(now);
  if (!RUN_ID_RE.test(runId)) return bad('--run-id must be letters, digits, -, _ or / (at most 80)');
  return { ok: true, args: { mode, targets, override, runId } };
}

export const DISASTER_DEFAULTS = {
  deadlineMs: 330 * MINUTE,
  hardExitAfterDeadlineMs: 5 * MINUTE,
  lockWaitMs: 3 * MINUTE,
  lockRetryMs: 10_000,
  concurrency: 2,
};

/** Everything the task needs; production wires the real clients (main.ts), tests the fakes. */
export interface DisasterDeps {
  controlPlaneUrl: string;
  neon: NeonApi;
  ecs: DisasterEcs;
  logReader: LogReader;
  reader: BackupReader;
  keyring: KeyringFactory;
  publish: Publisher;
  pgRestoreBin: string;
  /** NEON_REGION_ID (the stack constant `aws-us-east-1`). */
  regionId: string;
  restoreTestProjectId: string;
  controlPlaneProjectId: string;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawn?: SpawnFn;
  stopSignal?: AbortSignal;
  deadlineMs?: number;
  /** The process exit used by the hard-exit timer (tests replace it). */
  hardExit?: (code: number) => void;
  hardExitAfterDeadlineMs?: number;
  lockWaitMs?: number;
  lockRetryMs?: number;
  lockTiming?: LockTiming;
  lockConnect?: Connect;
  concurrency?: number;
  /** Tests only: shorter polls and gaps (the 10-second recoverable polls, the 60-second override gap, retries). */
  timing?: Partial<{ recoverablePolls: number; recoverablePollMs: number; overrideGapMs: number; lockRetryMs: number; cleanupRetryMs: number; cleanupLockTimeout: string; cleanupBudgetMs: number; deletedEndpointWaitMs: number; deletedEndpointPollMs: number }>;
  /** Tests only, in-process: fake Neon hosts → the local server (impact analysis §4, D10). main.ts never sets it. */
  hostMap?: HostMap;
  /** Tests only: seams for the termination and concurrency cases (R9). */
  hooks?: DisasterHooks;
}

export interface DisasterHooks {
  /** Called inside the switch transaction, after the UPDATE and its rows, before COMMIT. */
  beforeCommit?: (tenantId: string) => Promise<void>;
  /** Replaces the switch's result after it committed (a lost acknowledgement). */
  afterCommit?: (tenantId: string) => Promise<void>;
}

export { rebuildSettings } from './disaster-settings';

export interface WorkspaceResult {
  tenantId: string;
  result: string;
  detail?: string;
  /** Private email only (never logged). */
  slug?: string;
  backupStartedAt?: Date | null;
  backupKey?: string | null;
  newProjectId?: string | null;
  evidence?: string | null;
  skippedBackups?: number;
}

export interface RunOutcome {
  pass: boolean;
  results: WorkspaceResult[];
  /** Lines for the founder's email (may name slugs: the topic is private). */
  email: string[];
}

export interface RunContext {
  args: DisasterArgs;
  deps: DisasterDeps;
  cp: postgres.Sql;
  runRowId: string;
  /** Aborted at the deadline ('deadline') or on SIGTERM ('stopped'). */
  signal: AbortSignal;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** The modes (filled in by feature-plan-disaster-restore.md §6.4 and §6.5). */
export type ModeRunner = (ctx: RunContext) => Promise<RunOutcome>;

export const MODES: Record<DisasterMode, ModeRunner> = { workspace: runWorkspace, rehearse: runRehearse };

export async function runDisaster(args: DisasterArgs, deps: DisasterDeps): Promise<{ exitCode: number; outcome: RunOutcome | null }> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log;
  const deadlineMs = deps.deadlineMs ?? DISASTER_DEFAULTS.deadlineMs;

  // ---- who started it ------------------------------------------------------------------------------------------------
  let self;
  try {
    self = await deps.ecs.self();
  } catch (e) {
    log(`refused: could not read this task's own record (${summaryOf('ecs', e)})`);
    return { exitCode: 1, outcome: null };
  }
  const startedBy = self.startedBy ?? '';
  if (args.mode === 'workspace' && !/^(gh-|cloudshell-)/.test(startedBy)) {
    log('refused: mode workspace runs only from the button (gh-…) or the CloudShell fallback (cloudshell-…)');
    return { exitCode: 1, outcome: null };
  }

  // ---- one run at a time: the oldest running task wins ---------------------------------------------------------------
  try {
    const mine = self.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const older = (await deps.ecs.running()).filter((t) => {
      if (t.taskArn === self.taskArn) return false;
      const theirs = t.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return theirs < mine || (theirs === mine && t.taskArn < self.taskArn);
    });
    if (older.length > 0) {
      log('refused: another disaster task is running');
      return { exitCode: 1, outcome: null };
    }
  } catch (e) {
    log(`refused: could not list running disaster tasks (${summaryOf('ecs', e)})`);
    return { exitCode: 1, outcome: null };
  }

  // ---- the lock (a cancelled task can hold it for its 120-second stop) -----------------------------------------------
  let lock: HeldLock | null = null;
  const lockStart = now().getTime();
  for (;;) {
    try {
      lock = await acquireLock(deps.controlPlaneUrl, DISASTER_LOCK_KEY, { timing: deps.lockTiming, connect: deps.lockConnect });
    } catch (e) {
      log(`lock attempt failed (${summaryOf('lock', e)})`);
    }
    if (lock || now().getTime() - lockStart >= (deps.lockWaitMs ?? DISASTER_DEFAULTS.lockWaitMs)) break;
    await sleep(deps.lockRetryMs ?? DISASTER_DEFAULTS.lockRetryMs);
  }
  if (!lock) {
    log('refused: the disaster lock is still held after 3 minutes');
    return { exitCode: 1, outcome: null };
  }

  const cp = controlPlaneClient(deps.controlPlaneUrl);
  const runAbort = new AbortController();
  const onStop = () => runAbort.abort('stopped');
  deps.stopSignal?.addEventListener('abort', onStop, { once: true });
  if (deps.stopSignal?.aborted) onStop();
  const deadline = setTimeout(() => runAbort.abort('deadline'), deadlineMs);
  // A hung task must not outlive the button's wait and block every later press.
  const hardExit = setTimeout(() => {
    log('hard exit: still running 5 minutes after the deadline');
    (deps.hardExit ?? ((c: number) => process.exit(c)))(1);
  }, deadlineMs + (deps.hardExitAfterDeadlineMs ?? DISASTER_DEFAULTS.hardExitAfterDeadlineMs));
  hardExit.unref?.();
  let runRowId: string | null = null;
  try {
    const abandoned = await cp`UPDATE disaster_runs SET status = 'fail', finished_at = ${now()},
      summary = coalesce(summary, '{}'::jsonb) || '{"detail":"abandoned"}'::jsonb WHERE status = 'running' RETURNING id`;
    if (abandoned.length > 0) log(`closed ${abandoned.length} abandoned disaster run(s)`);
    const [row] = await cp<{ id: string }[]>`INSERT INTO disaster_runs (run_id, mode, started_at, status)
      VALUES (${args.runId}, ${args.mode}, ${now()}, 'running') RETURNING id::text AS id`;
    runRowId = row.id;
    log(`disaster ${args.mode} run ${args.runId} started by ${startedBy || 'unknown'}`);

    let outcome: RunOutcome;
    try {
      outcome = await MODES[args.mode]({ args, deps, cp, runRowId, signal: runAbort.signal, now, sleep, log });
    } catch (e) {
      outcome = { pass: false, results: [], email: [`the run stopped: ${summaryOf('run', e)}`] };
      log(`run failed: ${summaryOf('run', e)}`);
    }

    const summary = { mode: args.mode, override: args.override, results: outcome.results.map((r) => ({ tenantId: r.tenantId, result: r.result, detail: r.detail ?? null, newProjectId: r.newProjectId ?? null })) };
    // Set once; never over a row the digest already closed as abandoned (§6.8 "disaster run stuck").
    await cp`UPDATE disaster_runs SET status = ${outcome.pass ? 'pass' : 'fail'}, finished_at = ${now()}, summary = ${cp.json(summary)}
      WHERE id = ${runRowId} AND status = 'running'`;
    for (const r of outcome.results) log(`  ${r.tenantId} ${r.result}${r.detail ? ` (${r.detail})` : ''}`);
    try {
      await deps.publish(`CadenzPoint disaster ${args.mode} ${outcome.pass ? 'passed' : 'FAILED'}: run ${args.runId}`, outcome.email.join('\n'));
    } catch (e) {
      log(`the email could not be sent (${summaryOf('sns', e)}); results are in the digest`);
    }
    return { exitCode: outcome.pass ? 0 : 1, outcome };
  } catch (e) {
    log(`fatal: ${summaryOf('run', e)}`);
    if (runRowId) await cp`UPDATE disaster_runs SET status = 'fail', finished_at = ${now()} WHERE id = ${runRowId} AND status = 'running'`.catch(() => {});
    return { exitCode: 1, outcome: null };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardExit);
    deps.stopSignal?.removeEventListener('abort', onStop);
    await cp.end({ timeout: 5 }).catch(() => {});
    await lock.release();
  }
}
