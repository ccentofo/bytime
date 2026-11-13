import * as Sentry from '@sentry/nextjs';
import { createHash } from 'crypto';
import { render } from '@react-email/components';
import { resend, EMAIL_FROM } from './client';
import type { ReminderMessage } from './reminder-messages';

/**
 * feature-plan-reminder-capacity.md §6.2–§6.3: the two reminder crons send through Resend's batch endpoint, up to 100
 * emails per request, one workspace per request. Every request carries a fixed idempotency key, so a retry or a
 * duplicate cron run that builds the same batch gets Resend's stored response instead of a second email.
 *
 * Resend reports failures as `{ error }` (it doesn't throw), and the SDK wraps the API body: the `{ id }` array is at
 * `result.data.data`, per-email errors (permissive mode) at `result.data.errors`. A reminder counts as sent only with
 * a non-empty message id. This helper never throws on a send failure; it returns an outcome.
 */

export const REMINDER_BATCH_SIZE = 100;
/** The SDK sets no timeout on fetch. */
export const BATCH_ATTEMPT_TIMEOUT_MS = 12_000;
export const BATCH_RETRY_DELAY_MS = 2_000;
export const BATCH_MAX_ATTEMPTS = 3;

export type ReminderCron = 'daily-reminder' | 'submission-deadline';
export type BatchStopReason = 'email-quota' | 'email-config';
export type BatchOutcome =
  | { kind: 'disabled' }
  /** `failed` > 0 only for per-email rejections. */
  | { kind: 'sent'; sent: number; failed: number }
  /** The whole batch, after any retries. */
  | { kind: 'failed'; failed: number; errorName: string }
  | { kind: 'stop'; failed: number; reason: BatchStopReason };

/**
 * `rem:<cron>:<tenantId>:<localDate>:<sha256 of the sorted user ids>`: at most 136 characters (Resend allows 256), and
 * it holds only ids and a hash, never an address.
 */
export function reminderBatchKey(cron: ReminderCron, tenantId: string, localDate: string, userIds: string[]): string {
  const hex = createHash('sha256').update([...userIds].sort().join(',')).digest('hex');
  return `rem:${cron}:${tenantId}:${localDate}:${hex}`;
}

const QUOTA_ERRORS = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);
const KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key']);
const MAX_LOGGED_DOMAINS = 20;

type ErrorLike = { name?: unknown; message?: unknown; statusCode?: unknown };
type Payload = { from: string; to: string; subject: string; html: string }[];
type Attempt =
  | { kind: 'ok'; ids: unknown[]; errors: unknown[] }
  | { kind: 'unexpected' }
  | { kind: 'quota'; errorName: string; message: unknown }
  | { kind: 'config'; errorName: string; message: unknown }
  | { kind: 'retry'; errorName: string; message: unknown }
  | { kind: 'mismatch'; errorName: string; message: unknown }
  | { kind: 'rejected'; errorName: string; message: unknown };

const TIMED_OUT = Symbol('timed out');

function recipientDomain(to: string): string {
  const at = to.lastIndexOf('@');
  return at >= 0 ? to.slice(at + 1) : 'unknown';
}

/** Resend's per-email messages can contain the address: never log one. */
function redact(message: unknown): string | undefined {
  return typeof message === 'string' ? message.replace(/\S+@\S+/g, '[redacted]') : undefined;
}

function uniqueCapped(domains: string[]): string[] {
  return [...new Set(domains)].slice(0, MAX_LOGGED_DOMAINS);
}

/** §6.2 A2–A9 for a returned `{ error }`, first matching row wins. */
function classifyError(error: ErrorLike): Attempt {
  const name = typeof error.name === 'string' ? error.name : undefined;
  const status = error.statusCode;
  const message = error.message;
  const errorName = name ?? (typeof status === 'number' ? `http_${status}` : 'unknown_error');
  // A3 before any 429 rule: quota errors are 429s too, and retrying them is pointless.
  if (name && QUOTA_ERRORS.has(name)) return { kind: 'quota', errorName, message };
  if (
    status === 401 || status === 403 || (name !== undefined && KEY_ERRORS.has(name))
    || (status === 400 && name === 'validation_error' && typeof message === 'string' && /api key/i.test(message))
  ) return { kind: 'config', errorName, message };
  if (name === 'rate_limit_exceeded' || status === 429) return { kind: 'retry', errorName, message };
  if (name === 'concurrent_idempotent_requests') return { kind: 'retry', errorName, message };
  // Unknown or server-side: the first request may have gone through, and the same key makes a retry safe.
  if (typeof status !== 'number' || status >= 500 || name === undefined) return { kind: 'retry', errorName, message };
  if (name === 'invalid_idempotent_request') return { kind: 'mismatch', errorName, message };
  return { kind: 'rejected', errorName, message };
}

async function attemptOnce(client: NonNullable<typeof resend>, payload: Payload, idempotencyKey: string): Promise<Attempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    result = await Promise.race([
      client.batch.send(payload, { idempotencyKey, batchValidation: 'permissive' }),
      new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), BATCH_ATTEMPT_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    // A10: a throw is not retried.
    return { kind: 'rejected', errorName: err instanceof Error ? err.name : 'unknown_error', message: err instanceof Error ? err.message : undefined };
  } finally {
    clearTimeout(timer);
  }
  if (result === TIMED_OUT) return { kind: 'retry', errorName: 'send_timeout', message: undefined }; // A7
  const { data: body, error } = (result ?? {}) as { data?: { data?: unknown; errors?: unknown } | null; error?: ErrorLike | null };
  if (error) return classifyError(error);
  if (!Array.isArray(body?.data)) return { kind: 'unexpected' }; // A2
  return { kind: 'ok', ids: body.data, errors: Array.isArray(body.errors) ? body.errors : [] }; // A1
}

function report(
  level: 'error' | 'warning',
  label: ReminderCron,
  errorName: string,
  failed: number,
  batchSize: number,
  recipientDomains: string[],
  message: unknown,
): void {
  console.error(`Reminder batch failed (${label}): ${errorName} [${failed} of ${batchSize}; domains: ${recipientDomains.join(', ')}]`);
  Sentry.captureMessage(`Reminder batch failed (${label}): ${errorName}`, {
    level,
    extra: { label, errorName, batchSize, failed, recipientDomains, firstErrorMessage: redact(message) },
  });
}

/** A1: count non-empty ids (never maps `data[i]` to `messages[i]`); failed recipients come from `errors[].index`. */
function settleOk(label: ReminderCron, messages: ReminderMessage[], ids: unknown[], errors: unknown[]): BatchOutcome {
  const size = messages.length;
  const idCount = ids.filter((e) => typeof (e as { id?: unknown } | null)?.id === 'string' && (e as { id: string }).id !== '').length;
  const sent = Math.min(idCount, size);
  const failed = size - sent;
  if (errors.length > 0 || idCount + errors.length !== size) {
    const validIndexes = new Set<number>();
    const domains: string[] = [];
    for (const e of errors) {
      const index = (e as { index?: unknown } | null)?.index;
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < size) {
        validIndexes.add(index);
        domains.push(recipientDomain(messages[index].to));
      } else {
        domains.push('unknown');
      }
    }
    if (failed > validIndexes.size) domains.push('unknown');
    report('warning', label, 'partial', failed, size, uniqueCapped(domains), (errors[0] as { message?: unknown } | null)?.message);
  }
  return { kind: 'sent', sent, failed };
}

export async function deliverReminderBatch(
  label: ReminderCron,
  messages: ReminderMessage[],
  opts: { idempotencyKey: string; notAfter: number; now?: () => number },
): Promise<BatchOutcome> {
  if (messages.length < 1 || messages.length > REMINDER_BATCH_SIZE) {
    throw new RangeError(`deliverReminderBatch: ${messages.length} messages (must be 1–${REMINDER_BATCH_SIZE})`);
  }
  const client = resend;
  if (!client) return { kind: 'disabled' };
  const now = opts.now ?? Date.now;
  const size = messages.length;
  const allDomains = () => uniqueCapped(messages.map((m) => recipientDomain(m.to)));

  // Render once, outside the attempt timeout. No `react` field, so the SDK neither renders nor mutates anything, and
  // every retry sends a byte-identical body under the same idempotency key.
  const payload: Payload = [];
  try {
    for (const m of messages) payload.push({ from: EMAIL_FROM, to: m.to, subject: m.subject, html: await render(m.react) });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'render_error';
    report('error', label, errorName, size, size, allDomains(), err instanceof Error ? err.message : undefined);
    return { kind: 'failed', failed: size, errorName };
  }

  // Audit FR1: once an attempt has timed out, later attempts with the same key usually get a concurrent-409 (the first
  // request is still in flight; the SDK can't abort it). A batch that then fails is named for the timeout, so the
  // run-level breaker counts it; only a batch whose retries were all concurrent-409s keeps that (exempt) name.
  let timedOut = false;
  for (let attempt = 1; ; attempt++) {
    // The first attempt always runs: the caller flushes only when it must.
    const a = await attemptOnce(client, payload, opts.idempotencyKey);
    if (a.kind === 'retry' && a.errorName === 'send_timeout') timedOut = true;
    switch (a.kind) {
      case 'ok':
        return settleOk(label, messages, a.ids, a.errors);
      case 'unexpected':
        report('error', label, 'unexpected_response', size, size, allDomains(), undefined);
        return { kind: 'failed', failed: size, errorName: 'unexpected_response' };
      case 'quota':
      case 'config':
        report('error', label, a.errorName, size, size, allDomains(), a.message);
        return { kind: 'stop', failed: size, reason: a.kind === 'quota' ? 'email-quota' : 'email-config' };
      case 'mismatch':
        report('warning', label, a.errorName, size, size, allDomains(), a.message);
        return { kind: 'failed', failed: size, errorName: a.errorName };
      case 'rejected':
        report('error', label, a.errorName, size, size, allDomains(), a.message);
        return { kind: 'failed', failed: size, errorName: a.errorName };
      case 'retry':
        // Checked before waiting: a retry must be able to finish by `notAfter`.
        if (attempt >= BATCH_MAX_ATTEMPTS || now() + BATCH_RETRY_DELAY_MS + BATCH_ATTEMPT_TIMEOUT_MS > opts.notAfter) {
          const errorName = timedOut ? 'send_timeout' : a.errorName;
          report('error', label, errorName, size, size, allDomains(), a.message);
          return { kind: 'failed', failed: size, errorName };
        }
        await new Promise((r) => setTimeout(r, BATCH_RETRY_DELAY_MS));
    }
  }
}
