/**
 * The export task (feature-plan-cloud-export.md §6.3; image command `export`). The founder never downloads customer data:
 * a button press (`.github/workflows/export-workspace.yml`) starts this task in the backup AWS account, which builds the
 * workspace's export ZIP straight from its database into the exports bucket and records a delivery (with its
 * `export-ready` notice) or a legal hold. The hourly sweep is `export sweep` (export-sweep.ts, its own task family).
 *
 *   export deliver --workspace <uuid> [--extra <email>] [--reason <text>] [--run-id <id>]
 *   export hold    --workspace <uuid> --reason <text> [--run-id <id>]
 *   export release --hold <uuid> --reason <text> [--run-id <id>]
 *   export sweep
 *
 * Invariant 5: logs and the SNS lines carry ids and codes only, never emails, slugs, S3 keys (they contain the slug),
 * tokens or the reason (its length only).
 *
 * The record rule (§6.3 step 4): once the record transaction has started, the object is never deleted after an error.
 * Only errors that certainly committed nothing delete it at once: a server error returned before COMMIT was sent (lock or
 * statement timeouts included), a refusal at the re-resolve, a failed read on the fresh connection, the deadline before
 * BEGIN, and the deliberate `changed` rollback. Anything else is "outcome unknown": the object stays, and the hourly
 * sweep decides (a delivery orphan is deleted after a day; a hold orphan is only reported).
 */
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  createWorkspaceZipStream,
  ExportTooLargeError,
  openExportSnapshot,
  type ExportSnapshot,
  type WorkspaceZipOptions,
} from '../../src/lib/export/workspace-export';
import { decrypt, encrypt } from '../../src/lib/encryption';
import { EXPORT_LOCK_KEY } from '../../src/lib/tenant/backup-locks';
import { clientUrl } from './lib/pg-url';
import { summaryOf } from './lib/summarize-error';
import type { DisasterEcs, Publisher } from './lib/aws-clients';
import type { ExportStore } from './lib/export-store';
import { recipientCountRefusal, resolveExportRecipients, isExtraOnly } from './lib/export-recipients';
import { MINUTE, DAY } from './lib/util';

// ---- grammar (§6.3 "Grammar") ---------------------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUN_ID_RE = /^[A-Za-z0-9_/-]{1,80}$/;
/** The button's pattern too (export-button.sh): one address, at most 254 characters. */
export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_REASON_LENGTH = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type ExportMode = 'deliver' | 'hold' | 'release' | 'sweep';
export const EXPORT_MODES: readonly ExportMode[] = ['deliver', 'hold', 'release', 'sweep'];

export interface ExportArgs {
  mode: ExportMode;
  workspaceId?: string;
  holdId?: string;
  extra?: string;
  reason?: string;
  runId: string;
}

export type ExportParseResult =
  | { ok: true; args: ExportArgs }
  | { ok: false; exitCode: 1 | 2; code: string; message: string; mode?: ExportMode; target?: string };

const FLAGS = new Set(['--workspace', '--hold', '--extra', '--reason', '--run-id']);

const pad = (n: number) => String(n).padStart(2, '0');
/** `task-<YYYYMMDDTHHMMSSZ>` when no `--run-id` is passed (disaster.ts's pattern). */
export function exportRunId(now: Date): string {
  return `task-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

export function validEmail(v: string): boolean {
  return v.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(v);
}

export function validReason(v: string): boolean {
  return v.trim().length > 0 && v.length <= MAX_REASON_LENGTH && !CONTROL_RE.test(v);
}

/** Parse `export <mode> …`. An unknown flag exits 2 (an image older than the button); every other refusal exits 1. */
export function parseExportArgs(argv: string[], now: Date = new Date()): ExportParseResult {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) return { ok: false, exitCode: 2, code: 'version-skew', message: `unknown flag ${a.slice(0, 40)}` };
      const v = argv[i + 1];
      if (v === undefined) return { ok: false, exitCode: 1, code: 'bad-args', message: `${a} needs a value` };
      if (v.startsWith('-')) return { ok: false, exitCode: 1, code: 'bad-args', message: `${a}: a value can't start with -` };
      if (flags.has(a)) return { ok: false, exitCode: 1, code: 'bad-args', message: `${a} given twice` };
      flags.set(a, v);
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return { ok: false, exitCode: 1, code: 'bad-args', message: 'usage: export deliver|hold|release|sweep …' };
  const mode = positional[0] as ExportMode;
  if (!EXPORT_MODES.includes(mode)) return { ok: false, exitCode: 1, code: 'bad-args', message: 'mode must be deliver, hold, release or sweep' };
  const target = mode === 'release' ? flags.get('--hold') : flags.get('--workspace');
  const bad = (code: string, message: string): ExportParseResult => ({ ok: false, exitCode: 1, code, message, mode, target: target && UUID_RE.test(target) ? target : undefined });

  if (mode === 'sweep') {
    if (flags.size > 0) return bad('bad-args', 'sweep takes no flags');
    return { ok: true, args: { mode, runId: exportRunId(now) } };
  }
  // §6.3: --extra on hold or release is refused with exit 1, not exit 2.
  if ((mode === 'hold' || mode === 'release') && flags.has('--extra')) return bad('extra-not-allowed', `--extra is only for deliver`);
  if (mode === 'release') {
    if (flags.has('--workspace')) return bad('bad-args', 'release takes --hold, not --workspace');
    const hold = flags.get('--hold');
    if (!hold || !UUID_RE.test(hold)) return bad('bad-args', '--hold must be a hold id (uuid, lowercase)');
  } else {
    if (flags.has('--hold')) return bad('bad-args', `${mode} takes --workspace, not --hold`);
    const ws = flags.get('--workspace');
    if (!ws || !UUID_RE.test(ws)) return bad('bad-args', '--workspace must be a workspace id (uuid, lowercase)');
  }
  const extra = flags.get('--extra');
  if (extra !== undefined && !validEmail(extra)) return bad('bad-args', '--extra must be one email address (at most 254 characters)');
  const reason = flags.get('--reason');
  if (reason !== undefined && !validReason(reason)) return bad('bad-args', '--reason must be 1-200 characters with no control characters');
  // §6.4: a reason is required for hold, release, and deliver with an extra address.
  if (reason === undefined && (mode !== 'deliver' || extra !== undefined)) return bad('bad-args', `--reason is required for ${mode === 'deliver' ? 'deliver with --extra' : mode}`);
  const runId = flags.get('--run-id') ?? exportRunId(now);
  if (!RUN_ID_RE.test(runId)) return bad('bad-args', '--run-id must be letters, digits, -, _ or / (at most 80)');
  return {
    ok: true,
    args: {
      mode,
      ...(mode === 'release' ? { holdId: flags.get('--hold') } : { workspaceId: flags.get('--workspace') }),
      ...(extra !== undefined ? { extra } : {}),
      ...(reason !== undefined ? { reason } : {}),
      runId,
    },
  };
}

// ---- the closing SNS lines (§6.3 "Every run … ends with one SNS line") --------------------------------------------------

export const EXPORT_SUBJECT = 'CadenzPoint export';

export const lines = {
  delivered: (ws: string, delivery: string, n: number, expires: Date) => `export delivered: workspace ${ws}, delivery ${delivery}, ${n} recipient(s), expires ${expires.toISOString()}`,
  held: (ws: string, hold: string) => `export held: workspace ${ws}, hold ${hold}`,
  released: (hold: string) => `export released: hold ${hold}`,
  refused: (mode: string, target: string, code: string) => `export refused: ${mode}, ${target}, ${code}`,
  failed: (mode: string, target: string, code: string) => `export failed: ${mode}, ${target}, ${code}`,
  unknown: (mode: string, ws: string, kind: 'delivery' | 'hold', id: string) => `export outcome unknown: ${mode}, workspace ${ws}, ${kind} ${id}`,
};

/** The SNS line for a parse refusal: exit 2 is `export failed: parse, -, version-skew` (§6.3). */
export function parseFailureLine(p: Extract<ExportParseResult, { ok: false }>): string {
  if (p.exitCode === 2) return lines.failed('parse', '-', 'version-skew');
  const target = p.target ? (p.mode === 'release' ? `hold ${p.target}` : `workspace ${p.target}`) : '-';
  return lines.refused(p.mode ?? 'parse', target, p.code);
}

/** Publish one line; a failure is logged and never changes the exit code (§8 F22). */
export async function publishLine(publish: Publisher, log: (l: string) => void, line: string): Promise<void> {
  try {
    await publish(EXPORT_SUBJECT, line);
  } catch (e) {
    log(`the email could not be sent (${summaryOf('sns', e)})`);
  }
}

// ---- the run ------------------------------------------------------------------------------------------------------

export const EXPORT_DEFAULTS = {
  deadlineMs: 45 * MINUTE,
  hardExitAfterDeadlineMs: 5 * MINUTE,
  /** The snapshot's server-side statement and idle-in-transaction timeouts (§6.3). */
  snapshotTimeoutMs: 45 * MINUTE,
  linkValidityMs: 7 * DAY,
};

export const EXPORT_FAMILY = 'cadenzpoint-backup-export';

export interface ExportHooks {
  /** After the upload completed, before the recipients are re-resolved (T3 mid-build suspension, T29 deactivation). */
  afterUpload?: () => Promise<void>;
  /** Immediately before BEGIN (the deadline-before-BEGIN case), with the run's deadline/stop signal. */
  beforeBegin?: (signal: AbortSignal) => Promise<void>;
  /** Inside the record transaction, after every write, before COMMIT (with the run's deadline/stop signal). */
  beforeCommit?: (tx: postgres.TransactionSql, signal: AbortSignal) => Promise<void>;
  /** After COMMIT returned: throwing simulates a lost acknowledgement. */
  afterCommit?: () => Promise<void>;
}

export interface ExportDeps {
  controlPlaneUrl: string;
  store: ExportStore;
  ecs: DisasterEcs;
  publish: Publisher;
  log: (line: string) => void;
  now?: () => Date;
  stopSignal?: AbortSignal;
  deadlineMs?: number;
  hardExit?: (code: number) => void;
  hardExitAfterDeadlineMs?: number;
  snapshotTimeoutMs?: number;
  hooks?: ExportHooks;
  /** Tests only: replaces the ZIP stream (a stalled or failing body). main.ts never sets it. */
  zipStream?: (snapshot: ExportSnapshot, opts: WorkspaceZipOptions) => ReadableStream<Uint8Array>;
}

export interface ExportResult {
  exitCode: number;
  /** The closing SNS line (also published). */
  line: string;
}

interface TenantFacts {
  id: string;
  slug: string;
  status: string;
  suspensionReason: string | null;
  policyExportAllowed: boolean;
  dbUrlEncrypted: string | null;
  billingEmail: string | null;
  signupEmail: string | null;
}

class Changed extends Error {
  constructor() { super('changed'); this.name = 'Changed'; }
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** A server-returned error (postgres.js PostgresError with a SQLSTATE). */
function sqlState(e: unknown): string | null {
  const err = e as { name?: unknown; code?: unknown };
  return err && err.name === 'PostgresError' && typeof err.code === 'string' && SQLSTATE_RE.test(err.code) ? err.code : null;
}

async function readTenant(cp: postgres.Sql, id: string): Promise<TenantFacts | null> {
  const [row] = await cp<TenantFacts[]>`SELECT id::text AS id, slug, status::text AS status, suspension_reason AS "suspensionReason",
      policy_export_allowed AS "policyExportAllowed", db_url_encrypted AS "dbUrlEncrypted", billing_email AS "billingEmail",
      signup_email AS "signupEmail"
    FROM tenants WHERE id = ${id}`;
  return row ?? null;
}

const exportable = (t: TenantFacts | null): t is TenantFacts & { dbUrlEncrypted: string } =>
  t !== null && (t.status === 'active' || t.status === 'suspended') && t.dbUrlEncrypted !== null;

const sameFacts = (a: TenantFacts, b: TenantFacts) =>
  a.status === b.status && a.suspensionReason === b.suspensionReason && a.policyExportAllowed === b.policyExportAllowed && a.dbUrlEncrypted === b.dbUrlEncrypted;

const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
export const deliveryKey = (deliveryId: string, slug: string, at: Date) => `delivery/${deliveryId}/${slug}-export-${ymd(at)}.zip`;
export const holdKey = (holdId: string, slug: string, at: Date) => `hold/${holdId}/${slug}-export-${ymd(at)}.zip`;
export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** 32 random bytes, base64url (43 characters): the link token (§5 invariant 3). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

type BuildFailure = { ok: false; kind: 'refused' | 'failed'; code: string };
type BuildSuccess = { ok: true; bytes: number; sha256: string };

interface RunState {
  phase: 'start' | 'build' | 'record' | 'done';
  /** Set when the record transaction starts: the hard exit's "outcome unknown" line. */
  unknownLine: string | null;
  failedLine: string;
}

/** Run deliver, hold or release (sweep is export-sweep.ts). */
export async function runExport(args: ExportArgs, deps: ExportDeps): Promise<ExportResult> {
  const log = deps.log;
  const mode = args.mode;
  const target = mode === 'release' ? `hold ${args.holdId}` : `workspace ${args.workspaceId}`;
  // Exactly one closing line per run (audit round 1, FR6): the hard exit and finish() share this. Whichever comes first
  // publishes; the other waits for that publish instead of sending a second line.
  let closing: Promise<void> | null = null;
  const finish = async (exitCode: number, line: string): Promise<ExportResult> => {
    if (!closing) {
      log(line);
      closing = publishLine(deps.publish, log, line);
    }
    await closing;
    return { exitCode, line };
  };

  // ---- who started it (§6.3 "The start"; an honour-system convention, as 3c's gate) ----------------------------------
  let self;
  try {
    self = await deps.ecs.self();
  } catch (e) {
    log(`refused: could not read this task's own record (${summaryOf('ecs', e)})`);
    return finish(1, lines.refused(mode, target, 'ecs-unreadable'));
  }
  const startedBy = self.startedBy ?? '';
  if (!/^(gh-|cloudshell-)/.test(startedBy)) {
    log(`refused: export ${mode} runs only from the button (gh-…) or CloudShell (cloudshell-…)`);
    return finish(1, lines.refused(mode, target, 'not-from-button'));
  }
  // Only the button enforces the type-twice check, so an extra address is accepted only from a `gh-` start.
  if (args.extra !== undefined && !startedBy.startsWith('gh-')) {
    log('refused: --extra is accepted only from the button (gh-…)');
    return finish(1, lines.refused(mode, target, 'extra-needs-button'));
  }

  // ---- one export at a time: the oldest running task of the family wins ---------------------------------------------
  try {
    const mine = self.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const older = (await deps.ecs.running()).filter((t) => {
      if (t.taskArn === self.taskArn) return false;
      const theirs = t.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return theirs < mine || (theirs === mine && t.taskArn < self.taskArn);
    });
    if (older.length > 0) {
      log('refused: another export task is running');
      return finish(1, lines.refused(mode, target, 'another-export-running'));
    }
  } catch (e) {
    log(`refused: could not list running export tasks (${summaryOf('ecs', e)})`);
    return finish(1, lines.refused(mode, target, 'ecs-unreadable'));
  }

  log(`export ${mode} run ${args.runId} started by ${startedBy}${args.reason !== undefined ? ` (reason: ${args.reason.length} characters)` : ''}`);

  // ---- deadline, stop and the hard exit (D2) ----------------------------------------------------------------------
  const deadlineMs = deps.deadlineMs ?? EXPORT_DEFAULTS.deadlineMs;
  const abort = new AbortController();
  const onStop = () => abort.abort('stopped');
  deps.stopSignal?.addEventListener('abort', onStop, { once: true });
  if (deps.stopSignal?.aborted) onStop();
  const deadline = setTimeout(() => abort.abort('deadline'), deadlineMs);
  const state: RunState = { phase: 'start', unknownLine: null, failedLine: lines.failed(mode, target, 'deadline') };
  const hardExit = setTimeout(() => {
    void (async () => {
      log('hard exit: still running 5 minutes after the deadline');
      if (!closing) {
        const line = state.phase === 'record' && state.unknownLine ? state.unknownLine : state.failedLine;
        log(line);
        closing = publishLine(deps.publish, log, line);
      }
      await Promise.race([closing, new Promise((r) => setTimeout(r, 10_000))]);
      (deps.hardExit ?? ((c: number) => process.exit(c)))(1);
    })();
  }, deadlineMs + (deps.hardExitAfterDeadlineMs ?? EXPORT_DEFAULTS.hardExitAfterDeadlineMs));
  hardExit.unref?.();

  const cp = postgres(clientUrl(deps.controlPlaneUrl), { max: 2, connect_timeout: 30, onnotice: () => {}, connection: { statement_timeout: 60_000 } });
  let leaveConnection = false;
  try {
    if (mode === 'release') return await runRelease(args, deps, cp, finish);
    return await runBuildMode(args, deps, cp, abort.signal, state, finish, () => { leaveConnection = true; });
  } catch (e) {
    log(`run failed: ${summaryOf('export', e)}`);
    return finish(1, lines.failed(mode, target, 'internal-error'));
  } finally {
    state.phase = 'done';
    clearTimeout(deadline);
    clearTimeout(hardExit);
    deps.stopSignal?.removeEventListener('abort', onStop);
    // An unknown-outcome record may still be committing: give it a short grace instead of cutting it.
    await cp.end({ timeout: leaveConnection ? 5 : 1 }).catch(() => {});
  }
}

type Finish = (exitCode: number, line: string) => Promise<ExportResult>;

/** deliver and hold: load, schema check, (deliver) recipient pre-check, build and upload, record. */
async function runBuildMode(
  args: ExportArgs,
  deps: ExportDeps,
  cp: postgres.Sql,
  signal: AbortSignal,
  state: RunState,
  finish: Finish,
  leaveConnection: () => void,
): Promise<ExportResult> {
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  const mode = args.mode as 'deliver' | 'hold';
  const wsId = args.workspaceId!;
  const target = `workspace ${wsId}`;

  // 1. Load the tenant (a plain read).
  let tenant: TenantFacts | null;
  try {
    tenant = await readTenant(cp, wsId);
  } catch (e) {
    log(`control-plane read failed (${summaryOf('control-plane', e)})`);
    return finish(1, lines.failed(mode, target, 'database-error'));
  }
  if (!exportable(tenant)) return finish(1, lines.refused(mode, target, 'not-exportable'));
  const first = tenant;
  if (mode === 'deliver' && isExtraOnly(first) && args.extra === undefined) return finish(1, lines.refused(mode, target, 'extra-required'));

  // The ids are generated before the upload: they're in the S3 key.
  const id = randomUUID();
  const startedAt = now();
  const key = mode === 'deliver' ? deliveryKey(id, first.slug, startedAt) : holdKey(id, first.slug, startedAt);
  state.phase = 'build';

  const built = await buildAndUpload(args, deps, first, key, signal);
  if (!built.ok) {
    return finish(1, built.kind === 'refused' ? lines.refused(mode, target, built.code) : lines.failed(mode, target, built.code));
  }
  log(`uploaded ${mode === 'deliver' ? 'delivery' : 'hold'} ${id} (${built.bytes} bytes)`);

  /** A certain no-commit outcome: delete the object at once (§6.3 step 4). */
  const deleteNow = async (kind: 'refused' | 'failed', code: string): Promise<ExportResult> => {
    try {
      await deps.store.delete(key);
    } catch (e) {
      log(`the object could not be deleted (${summaryOf('s3', e)}); the sweep removes it`);
    }
    return finish(1, kind === 'refused' ? lines.refused(mode, target, code) : lines.failed(mode, target, code));
  };

  await deps.hooks?.afterUpload?.();

  // 2. deliver: the recipients, re-resolved on a fresh connection after the snapshot closed.
  let recipients: { to: string[]; timeZone: string } | null = null;
  if (mode === 'deliver') {
    try {
      const fresh = await readTenant(cp, wsId);
      if (!exportable(fresh) || !sameFacts(first, fresh)) return deleteNow('refused', 'changed');
      const ws = postgres(clientUrl(decrypt(fresh.dbUrlEncrypted)), { max: 1, connect_timeout: 30, onnotice: () => {}, connection: { statement_timeout: 60_000 } });
      try {
        const r = await resolveExportRecipients(fresh, ws, args.extra);
        recipients = { to: r.to, timeZone: r.timeZone };
      } finally {
        await ws.end({ timeout: 5 }).catch(() => {});
      }
    } catch (e) {
      log(`the recipients could not be read (${summaryOf('workspace', e)})`);
      return deleteNow('failed', 'database-error');
    }
    const refusal = recipientCountRefusal(recipients.to.length);
    if (refusal) return deleteNow('refused', refusal);
  }

  if (signal.aborted) return deleteNow('failed', String(signal.reason ?? 'deadline'));
  await deps.hooks?.beforeBegin?.(signal);
  if (signal.aborted) return deleteNow('failed', String(signal.reason ?? 'deadline'));

  // 4. Record, in one control-plane transaction under the export lock and the tenant lock (D1).
  const token = mode === 'deliver' ? newToken() : null;
  let callbackReturned = false;
  state.phase = 'record';
  state.unknownLine = lines.unknown(mode, wsId, mode === 'deliver' ? 'delivery' : 'hold', id);
  const record = cp.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe("SET LOCAL statement_timeout = '10s'");
    await tx`SELECT pg_advisory_xact_lock(${EXPORT_LOCK_KEY})`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + wsId}))`;
    const [again] = await tx<TenantFacts[]>`SELECT id::text AS id, slug, status::text AS status, suspension_reason AS "suspensionReason",
        policy_export_allowed AS "policyExportAllowed", db_url_encrypted AS "dbUrlEncrypted", billing_email AS "billingEmail",
        signup_email AS "signupEmail"
      FROM tenants WHERE id = ${wsId}`;
    if (!again || !sameFacts(first, again)) throw new Changed();
    let expiresAt: Date | null = null;
    if (mode === 'deliver') {
      const [notice] = await tx<{ id: string }[]>`INSERT INTO tenant_notices (tenant_id, kind, scheduled_for)
        VALUES (${wsId}, 'export-ready', date_trunc('milliseconds', now())) RETURNING id::text AS id`;
      const extraOnly = isExtraOnly(again);
      const [row] = await tx<{ expiresAt: Date }[]>`INSERT INTO export_deliveries (id, tenant_id, notice_id, s3_key, bytes, sha256, token_hash,
          token_encrypted, recipients_encrypted, time_zone, extra_recipient, extra_only, reason, expires_at, run_id)
        VALUES (${id}, ${wsId}, ${notice.id}, ${key}, ${built.bytes}, ${built.sha256}, ${sha256Hex(token!)}, ${encrypt(token!)},
          ${encrypt(JSON.stringify(recipients!.to))}, ${recipients!.timeZone}, ${args.extra !== undefined}, ${extraOnly},
          ${args.reason ?? null}, now() + make_interval(secs => ${EXPORT_DEFAULTS.linkValidityMs / 1000}), ${args.runId})
        RETURNING expires_at AS "expiresAt"`;
      expiresAt = row.expiresAt;
      const detail = { deliveryId: id, recipients: recipients!.to.length, extraAddress: args.extra !== undefined, reasonLength: args.reason?.length ?? 0 };
      await tx`INSERT INTO tenant_audit_events (tenant_id, kind, detail, actor)
        VALUES (${wsId}, 'export-delivered', ${JSON.stringify(detail)}, ${`export:${args.runId}`.slice(0, 100)})`;
    } else {
      await tx`INSERT INTO export_holds (id, tenant_id, s3_key, bytes, sha256, reason, run_id)
        VALUES (${id}, ${wsId}, ${key}, ${built.bytes}, ${built.sha256}, ${args.reason!}, ${args.runId})`;
      const detail = { holdId: id, bytes: built.bytes, reasonLength: args.reason!.length };
      await tx`INSERT INTO tenant_audit_events (tenant_id, kind, detail, actor)
        VALUES (${wsId}, 'export-held', ${JSON.stringify(detail)}, ${`export:${args.runId}`.slice(0, 100)})`;
    }
    await deps.hooks?.beforeCommit?.(tx, signal);
    callbackReturned = true;
    return expiresAt;
  });
  record.catch(() => {}); // settled below or abandoned (unknown outcome)

  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  let expiresAt: Date | null;
  try {
    const r = await Promise.race([record, aborted]);
    if (r === 'aborted') {
      // The deadline or a stop landed mid-record: it may still commit.
      leaveConnection();
      log(`record interrupted (${String(signal.reason)}): the object is left for the sweep`);
      return finish(1, state.unknownLine);
    }
    expiresAt = r;
    await deps.hooks?.afterCommit?.();
  } catch (e) {
    if (e instanceof Changed) return deleteNow('refused', 'changed');
    const code = sqlState(e);
    if (!callbackReturned && code !== null) {
      // The server returned an error before COMMIT was sent: nothing committed.
      log(`record refused by the server (${summaryOf('record', e)})`);
      return code === '55P03' ? deleteNow('refused', 'lock-timeout') : deleteNow('failed', 'database-error');
    }
    log(`record outcome unknown (${summaryOf('record', e)}): the object is left for the sweep`);
    return finish(1, state.unknownLine);
  }

  // 5. The founder's email (a publish failure after the commit is logged; the exit stays 0).
  if (mode === 'deliver') return finish(0, lines.delivered(wsId, id, recipients!.to.length, expiresAt!));
  return finish(0, lines.held(wsId, id));
}

/** The ZIP, built from a REPEATABLE READ snapshot and streamed to S3 with its SHA-256 (§6.3 steps 1b and 3). */
async function buildAndUpload(
  args: ExportArgs,
  deps: ExportDeps,
  tenant: TenantFacts & { dbUrlEncrypted: string },
  key: string,
  signal: AbortSignal,
): Promise<BuildFailure | BuildSuccess> {
  const log = deps.log;
  const timeoutMs = deps.snapshotTimeoutMs ?? EXPORT_DEFAULTS.snapshotTimeoutMs;
  let snapshot: ExportSnapshot;
  try {
    snapshot = await openExportSnapshot(decrypt(tenant.dbUrlEncrypted), {
      connectTimeoutSeconds: 30,
      connection: { statement_timeout: timeoutMs, idle_in_transaction_session_timeout: timeoutMs },
    });
  } catch (e) {
    log(`the workspace database could not be opened (${summaryOf('workspace', e)})`);
    return { ok: false, kind: 'failed', code: 'database-error' };
  }

  // 1b. Schema check, inside the snapshot: the applied tenant migrations must equal the image's journal.
  let applied: number;
  try {
    const [row] = await snapshot.conn<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    applied = row.n;
  } catch (e) {
    const code = sqlState(e);
    await snapshot.close(false);
    if (code === '42P01' || code === '3F000') return { ok: false, kind: 'refused', code: 'schema-skew' };
    log(`the schema check failed (${summaryOf('workspace', e)})`);
    return { ok: false, kind: 'failed', code: 'database-error' };
  }
  if (applied !== __TENANT_JOURNAL_LENGTH__) {
    await snapshot.close(false);
    log(`schema-skew: the workspace has ${applied} tenant migrations, this image expects ${__TENANT_JOURNAL_LENGTH__}`);
    return { ok: false, kind: 'refused', code: 'schema-skew' };
  }

  // deliver only: the recipient count, pre-checked so nothing is built in vain (re-checked after the build).
  if (args.mode === 'deliver') {
    try {
      const r = await resolveExportRecipients(tenant, snapshot.conn, args.extra);
      const refusal = recipientCountRefusal(r.to.length);
      if (refusal) {
        await snapshot.close(false);
        return { ok: false, kind: 'refused', code: refusal };
      }
    } catch (e) {
      await snapshot.close(false);
      log(`the recipients could not be read (${summaryOf('workspace', e)})`);
      return { ok: false, kind: 'failed', code: 'database-error' };
    }
  }

  // 3. Build → hash → upload.
  if (signal.aborted) {
    await snapshot.close(false);
    return { ok: false, kind: 'failed', code: String(signal.reason ?? 'deadline') };
  }
  let zipError: unknown = null;
  const web = (deps.zipStream ?? createWorkspaceZipStream)(snapshot, { tenantSlug: tenant.slug, signal, onError: (e) => { zipError = e; } });
  const source = Readable.fromWeb(web as unknown as NodeWebReadableStream<Uint8Array>);
  const hash = createHash('sha256');
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const piped = pipeline(source, hasher);
  piped.catch(() => {});
  const upload = deps.store.putStream(key, hasher);
  upload.done.catch(() => {});
  const onAbort = () => {
    const err = new Error(`export ${String(signal.reason ?? 'aborted')}`);
    void upload.abort().catch(() => {});
    source.destroy(err);
    hasher.destroy(err);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await upload.done;
    await piped;
    return { ok: true, bytes, sha256: hash.digest('hex') };
  } catch (e) {
    source.destroy();
    hasher.destroy();
    await piped.catch(() => {});
    await upload.abort().catch(() => {});
    await snapshot.close(false);
    try {
      await deps.store.delete(key);
    } catch (d) {
      log(`the partial object could not be deleted (${summaryOf('s3', d)}); the sweep removes it`);
    }
    if (signal.aborted) return { ok: false, kind: 'failed', code: String(signal.reason ?? 'deadline') };
    if (zipError instanceof ExportTooLargeError || e instanceof ExportTooLargeError) return { ok: false, kind: 'failed', code: 'too-large' };
    if (zipError) {
      log(`the export failed while reading the workspace (${summaryOf('workspace', zipError)})`);
      return { ok: false, kind: 'failed', code: 'database-error' };
    }
    log(`the upload failed (${summaryOf('s3', e)})`);
    return { ok: false, kind: 'failed', code: 'upload-error' };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** release: delete the hold's object, verify a 404, then mark it released (§6.3 `release`, §8 F13). */
async function runRelease(args: ExportArgs, deps: ExportDeps, cp: postgres.Sql, finish: Finish): Promise<ExportResult> {
  const log = deps.log;
  const holdId = args.holdId!;
  const target = `hold ${holdId}`;
  let hold: { tenantId: string; s3Key: string; releasedAt: Date | null } | undefined;
  try {
    [hold] = await cp<{ tenantId: string; s3Key: string; releasedAt: Date | null }[]>`SELECT tenant_id::text AS "tenantId", s3_key AS "s3Key",
      released_at AS "releasedAt" FROM export_holds WHERE id = ${holdId}`;
  } catch (e) {
    log(`control-plane read failed (${summaryOf('control-plane', e)})`);
    return finish(1, lines.failed('release', target, 'database-error'));
  }
  if (!hold) return finish(1, lines.refused('release', target, 'unknown-hold'));
  if (hold.releasedAt) return finish(1, lines.refused('release', target, 'released'));
  try {
    await deps.store.delete(hold.s3Key);
    if (await deps.store.exists(hold.s3Key)) return finish(1, lines.failed('release', target, 'delete-unverified'));
  } catch (e) {
    log(`the hold's object could not be deleted (${summaryOf('s3', e)})`);
    return finish(1, lines.failed('release', target, 's3-error'));
  }
  try {
    const released = await cp.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '10s'");
      await tx`SELECT pg_advisory_xact_lock(${EXPORT_LOCK_KEY})`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant:' + hold!.tenantId}))`;
      const rows = await tx`UPDATE export_holds SET released_at = now(), release_reason = ${args.reason!}
        WHERE id = ${holdId} AND released_at IS NULL RETURNING id`;
      if (rows.length === 0) return false;
      const detail = { holdId, reasonLength: args.reason!.length };
      await tx`INSERT INTO tenant_audit_events (tenant_id, kind, detail, actor)
        VALUES (${hold!.tenantId}, 'export-hold-released', ${JSON.stringify(detail)}, ${`export:${args.runId}`.slice(0, 100)})`;
      return true;
    });
    if (!released) return finish(1, lines.refused('release', target, 'released'));
  } catch (e) {
    log(`the release could not be recorded (${summaryOf('record', e)}); the object is gone: press release again`);
    return finish(1, lines.failed('release', target, sqlState(e) === '55P03' ? 'lock-timeout' : 'database-error'));
  }
  return finish(0, lines.released(holdId));
}
