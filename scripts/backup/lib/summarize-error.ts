/**
 * Error summaries with no customer values (feature-plan-database-backups.md §6.4 "Error summaries", F30).
 *
 * Postgres messages can quote row values (`CONTEXT: COPY …, line N: "…"`, `DETAIL: Key (…)=(…)`, `Failing row contains
 * (…)`, `invalid input syntax …: "…"`), and even "safe" lines carry hosts and user names. So no message line is ever kept.
 * A summary holds only:
 *  - the stage;
 *  - a child's exit code and signal;
 *  - the SQLSTATE, ONLY from postgres.js's structured `err.code` on a PostgresError (never parsed from text);
 *  - a table name from a `COPY <schema.table>` form (an identifier from our schema, never data);
 *  - one label from a fixed list.
 * This string is what goes into `database_backups.error`, `restore_test_results.detail`, `backup_audits.errors`, logs and
 * alert details.
 */

export const ERROR_LABELS = [
  'connection-refused', 'timeout', 'auth-failed', 'server-version', 'lock-timeout', 'access-denied',
  'kms-error', 's3-error', 'disk', 'killed', 'other',
] as const;
export type ErrorLabel = (typeof ERROR_LABELS)[number];

/** A child process's outcome, attached to errors raised for it. */
export interface ChildFailure {
  exitCode?: number | null;
  signal?: string | null;
}

interface ErrLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  $metadata?: unknown;
  cause?: unknown;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function text(err: unknown, stderr?: string): string {
  const e = (err ?? {}) as ErrLike;
  const parts = [typeof e.name === 'string' ? e.name : '', typeof e.code === 'string' ? e.code : '',
    typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '', stderr ?? ''];
  const cause = e.cause as ErrLike | undefined;
  if (cause && typeof cause === 'object') parts.push(String(cause.name ?? ''), String(cause.code ?? ''), String(cause.message ?? ''));
  return parts.join('\n');
}

/** The label for a message, from a fixed list of value-free patterns. Order matters: the first match wins. */
export function labelFor(err: unknown, stderr?: string): ErrorLabel {
  const e = (err ?? {}) as ErrLike;
  const t = text(err, stderr);
  const sig = typeof e.signal === 'string' ? e.signal : null;
  if (sig === 'SIGKILL' || sig === 'SIGTERM' || /\bkilled\b|terminated by signal/i.test(t)) return 'killed';
  if (/password authentication failed|authentication failed|\b28P01\b|\b28000\b|no pg_hba\.conf entry/i.test(t)) return 'auth-failed';
  if (/lock timeout|could not obtain lock|\b55P03\b/i.test(t)) return 'lock-timeout';
  if (/server version|version mismatch|aborting because of server version/i.test(t)) return 'server-version';
  if (/ENOSPC|no space left on device|disk full/i.test(t)) return 'disk';
  if (/AccessDenied|\bForbidden\b|not authorized|permission denied/i.test(t)) return 'access-denied';
  if (/timed out|timeout|ETIMEDOUT|CONNECT_TIMEOUT|\b57014\b/i.test(t)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection refused|could not connect|could not translate host|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|server closed the connection|\b57P01\b|\b08\d{3}\b/i.test(t)) return 'connection-refused';
  if (/\bKMS\b|KMSInvalid|KeyUnavailable|InvalidCiphertext|DisabledException|NotFoundException.*key|kms\./i.test(t)) return 'kms-error';
  if (e.$metadata !== undefined || /\bS3\b|NoSuchBucket|NoSuchKey|SlowDown|PreconditionFailed|EntityTooSmall|InvalidRequest/i.test(t)) return 's3-error';
  return 'other';
}

/** `COPY <schema.table>` → the identifier. Lower-case snake identifiers only (ours); `COPY failed …` is not a table. */
export function copyTableName(err: unknown, stderr?: string): string | null {
  const t = text(err, stderr);
  const re = /\bCOPY\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)(?=[\s,(;]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (!['failed', 'to', 'from'].includes(m[1])) return m[1];
  }
  return null;
}

/** The SQLSTATE, only from a postgres.js PostgresError's structured `code`. */
export function sqlstateOf(err: unknown): string | null {
  const e = (err ?? {}) as ErrLike;
  if (e.name === 'PostgresError' && typeof e.code === 'string' && SQLSTATE_RE.test(e.code)) return e.code;
  return null;
}

export function summarizeError(stage: string, err?: unknown, stderr?: string): string {
  const e = (err ?? {}) as ErrLike;
  const out = [stage];
  if (typeof e.exitCode === 'number') out.push(`exit=${e.exitCode}`);
  if (typeof e.signal === 'string' && e.signal) out.push(`signal=${e.signal}`);
  const state = sqlstateOf(err);
  if (state) out.push(`sqlstate=${state}`);
  const table = copyTableName(err, stderr);
  if (table) out.push(`table=${table}`);
  if (err !== undefined || stderr) out.push(`label=${labelFor(err, stderr)}`);
  return out.join(' ');
}

/** A stage failure carrying its summary; thrown inside the commands so every catch can record `summary` as-is. */
export class StageError extends Error {
  readonly summary: string;
  constructor(readonly stage: string, cause?: unknown, stderr?: string) {
    const summary = summarizeError(stage, cause, stderr);
    super(summary);
    this.name = 'StageError';
    this.summary = summary;
  }
}

/** The summary of any thrown value: a StageError keeps its own; anything else is summarized under `stage`. */
export function summaryOf(stage: string, err: unknown): string {
  return err instanceof StageError ? err.summary : summarizeError(stage, err);
}

/**
 * Replace Node's default crash print (which would include a PostgresError's `detail`) with the summary only, then exit 1.
 * Returns an uninstall function (tests).
 */
export function installCrashHandler(log: (line: string) => void, exit: (code: number) => void = (c) => process.exit(c)): () => void {
  const onError = (err: unknown) => {
    log(`FATAL ${summaryOf('crash', err)}`);
    exit(1);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return () => {
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  };
}
