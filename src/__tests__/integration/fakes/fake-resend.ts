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
  reset() {
    this.enabled = true;
    this.script = [];
    this.calls = [];
    this.delivered = [];
    this.keys.clear();
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

export const clientModule = {
  get resend() {
    return fakeResend;
  },
  EMAIL_FROM: 'CadenzPoint Test <test@cadenzpoint.test>',
  isEmailEnabled: () => resendState.enabled,
};
