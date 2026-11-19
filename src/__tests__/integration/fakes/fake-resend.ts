/**
 * Fake Resend client for the outbox tests: scripted responses, recorded calls, and Resend's documented 24-hour
 * idempotency semantics (same key + same body → the same message id; same key + different body → 409
 * invalid_idempotent_request).
 */

export type ScriptedResponse =
  | 'ok'
  | 'throw'
  | 'hang'
  | { error: { name: string; message: string; statusCode: number } }
  | { noId: true };

/** feature-plan-cloud-export.md §6.5: a scripted batch response (strict validation is always applied first). */
export type BatchScripted =
  | 'ok'
  | 'throw'
  | 'hang'
  | { error: { name: string; message: string; statusCode: number | null } }
  | { short: number }
  | { malformed: true };

export interface BatchCall {
  messages: Array<{ from: string; to: string[]; subject: string; html: string; bcc?: unknown; cc?: unknown }>;
  idempotencyKey?: string;
  batchValidation?: string;
}

export interface SentCall {
  to: string[];
  subject: string;
  html: string;
  idempotencyKey?: string;
}

export const resendState = {
  enabled: true,
  /** Consumed in order; when empty every send is 'ok'. */
  script: [] as ScriptedResponse[],
  calls: [] as SentCall[],
  /** Accepted messages (one per distinct idempotency key). */
  delivered: [] as SentCall[],
  keys: new Map<string, { body: string; id: string }>(),
  seq: 0,
  /** Batch sends (export-ready): consumed in order; when empty every batch is 'ok'. */
  batchScript: [] as BatchScripted[],
  batchCalls: [] as BatchCall[],
  /** One entry per message Resend accepted (each with its single recipient). */
  batchDelivered: [] as SentCall[],
  batchKeys: new Map<string, { body: string; ids: string[] }>(),
  reset() {
    this.enabled = true;
    this.script = [];
    this.calls = [];
    this.delivered = [];
    this.keys.clear();
    this.batchScript = [];
    this.batchCalls = [];
    this.batchDelivered = [];
    this.batchKeys.clear();
  },
};

export const fakeResend = {
  emails: {
    async send(params: { to: string | string[]; subject: string; html: string }, opts?: { idempotencyKey?: string }) {
      const call: SentCall = {
        to: Array.isArray(params.to) ? params.to : [params.to],
        subject: params.subject,
        html: params.html,
        idempotencyKey: opts?.idempotencyKey,
      };
      resendState.calls.push(call);
      const next = resendState.script.shift() ?? 'ok';
      if (next === 'throw') throw new Error('network error');
      if (next === 'hang') return new Promise(() => {});
      if (typeof next === 'object' && 'error' in next) return { data: null, error: next.error };
      if (typeof next === 'object' && 'noId' in next) return { data: null, error: null };

      const body = JSON.stringify([call.to, call.subject, call.html]);
      if (call.idempotencyKey) {
        const seen = resendState.keys.get(call.idempotencyKey);
        if (seen && seen.body !== body) {
          return { data: null, error: { name: 'invalid_idempotent_request', message: 'body changed', statusCode: 409 } };
        }
        if (seen) return { data: { id: seen.id }, error: null };
      }
      const id = `msg_${++resendState.seq}`;
      if (call.idempotencyKey) resendState.keys.set(call.idempotencyKey, { body, id });
      resendState.delivered.push(call);
      return { data: { id }, error: null };
    },
  },
};

/**
 * Resend's batch endpoint as the SDK reports it (resend 6.12.4): `{ data: { data: [{ id }] }, error: null }` in input
 * order, or `{ data: null, error }` (never thrown). Strict validation (the SDK default) fails the whole batch on one
 * invalid message. The idempotency key's 24-hour semantics as for single sends.
 */
(fakeResend as unknown as { batch: unknown }).batch = {
  async send(messages: BatchCall['messages'], opts?: { idempotencyKey?: string; batchValidation?: string }) {
    const call: BatchCall = { messages: messages.map((m) => ({ ...m, to: Array.isArray(m.to) ? m.to : [m.to as unknown as string] })), idempotencyKey: opts?.idempotencyKey, batchValidation: opts?.batchValidation };
    resendState.batchCalls.push(call);
    const next = resendState.batchScript.shift() ?? 'ok';
    if (next === 'throw') throw new Error('network error');
    if (next === 'hang') return new Promise(() => {});
    if (typeof next === 'object' && 'error' in next) return { data: null, error: next.error, headers: null };
    if ((opts?.batchValidation ?? 'strict') === 'strict' && call.messages.some((m) => m.to.some((a) => !/^[^@\s]+@[^@\s]+$/.test(a)))) {
      return { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.', statusCode: 422 }, headers: null };
    }
    const body = JSON.stringify(call.messages.map((m) => [m.to, m.subject, m.html]));
    let ids: string[];
    const seen = call.idempotencyKey ? resendState.batchKeys.get(call.idempotencyKey) : undefined;
    if (seen && seen.body !== body) return { data: null, error: { name: 'invalid_idempotent_request', message: 'body changed', statusCode: 409 }, headers: null };
    if (seen) {
      ids = seen.ids;
    } else {
      ids = call.messages.map(() => `msg_b${++resendState.seq}`);
      if (call.idempotencyKey) resendState.batchKeys.set(call.idempotencyKey, { body, ids });
      for (const m of call.messages) resendState.batchDelivered.push({ to: m.to, subject: m.subject, html: m.html, idempotencyKey: call.idempotencyKey });
    }
    if (typeof next === 'object' && 'short' in next) return { data: { data: ids.slice(0, next.short).map((id) => ({ id })) }, error: null, headers: null };
    if (typeof next === 'object' && 'malformed' in next) return { data: { data: ids.map(() => ({ id: '' })) }, error: null, headers: null };
    return { data: { data: ids.map((id) => ({ id })) }, error: null, headers: null };
  },
};

export const clientModule = {
  get resend() {
    return fakeResend;
  },
  EMAIL_FROM: 'CadenzPoint Test <test@cadenzpoint.test>',
  isEmailEnabled: () => resendState.enabled,
};
