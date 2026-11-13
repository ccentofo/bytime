import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { Resend, type CreateBatchResponse } from 'resend';

/**
 * feature-plan-reminder-capacity.md §11 "Batch helper" (B1–B24, B9b, K1): `deliverReminderBatch` against the SDK's
 * real envelope (`{ data: { data, errors }, error, headers }`), the §6.2 classification table, retries with the same
 * key and body, the time cap, PII-free logging, and the idempotency key format.
 */

type Resp = CreateBatchResponse<{ batchValidation: 'permissive' }>;
type SendFn = (payload: unknown, options?: unknown) => Promise<Resp>;

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/email/client', () => ({
  get resend() { return h.client; },
  EMAIL_FROM: 'CadenzPoint <noreply@cadenzpoint.com>',
  isEmailEnabled: () => h.client !== null,
}));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import {
  deliverReminderBatch, reminderBatchKey, BATCH_ATTEMPT_TIMEOUT_MS, BATCH_RETRY_DELAY_MS,
} from '@/lib/email/send-batch';
import { dailyReminderMessage, type ReminderMessage } from '@/lib/email/reminder-messages';

const send = vi.fn<SendFn>();
/** Fake time (ms) at the start of each batch.send call. */
let callTimes: number[] = [];
let consoleLines: string[] = [];

const msg = (to: string): ReminderMessage =>
  dailyReminderMessage({ employeeEmail: to, employeeName: 'Employee', todayDate: 'Thursday, Nov 12, 2026', appUrl: 'https://acme.example.com' });
const msgs = (n: number) => Array.from({ length: n }, (_, i) => msg(`e${i}@acme.com`));
const ok = (ids: string[], errors: Array<{ index: number; message: string }> = []): Resp =>
  ({ data: { data: ids.map((id) => ({ id })), errors }, error: null, headers: null });
const err = (name: NonNullable<Resp['error']>['name'], statusCode: number | null, message = 'x'): Resp =>
  ({ data: null, error: { name, message, statusCode }, headers: null });
const never = () => new Promise<Resp>(() => {});
const FAR = 8_640_000_000_000_000;
const opts = (over: Partial<{ idempotencyKey: string; notAfter: number }> = {}) => ({ idempotencyKey: 'k1', notAfter: FAR, ...over });

/** Real setImmediate ticks (not faked): lets rendering and promise chains settle without moving fake time. */
async function ticks(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
/**
 * Poll on real setImmediate until `pred` holds, for at most 10 s of REAL time (audit FR7: a slow CI render mustn't trip
 * a tick count). Unlike vi.waitFor, this never advances fake timers.
 */
async function until(pred: () => boolean) {
  const started = performance.now();
  while (!pred() && performance.now() - started < 10_000) await new Promise((r) => setImmediate(r));
  if (!pred()) throw new Error('until: condition never held within 10 s');
  await ticks();
}
const calls = (n: number) => until(() => send.mock.calls.length >= n);
const sentryCalls = () => sentry.captureMessage.mock.calls as Array<[string, { level: string; extra: Record<string, unknown> }]>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-12T20:00:00Z'));
  callTimes = [];
  consoleLines = [];
  send.mockReset();
  send.mockImplementation(async () => ok([]));
  h.client = { batch: { send: (...args: Parameters<SendFn>) => { callTimes.push(Date.now()); return send(...args); } } };
  sentry.captureMessage.mockReset();
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(' ')); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deliverReminderBatch: success and partial results (A1, A2)', () => {
  it('B1: one batch.send with rendered html, no react key, the key and permissive mode; no Sentry', async () => {
    send.mockResolvedValueOnce(ok(['m1', 'm2', 'm3']));
    const m = [msg('a@acme.com'), msg('b@beta.com'), msg('c@acme.com')];
    await expect(deliverReminderBatch('daily-reminder', m, opts())).resolves.toEqual({ kind: 'sent', sent: 3, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0] as [Array<Record<string, unknown>>, unknown];
    expect(payload).toHaveLength(3);
    payload.forEach((p, i) => {
      expect(p.from).toBe('CadenzPoint <noreply@cadenzpoint.com>');
      expect(p.to).toBe(m[i].to);
      expect(p.subject).toBe(m[i].subject);
      expect(typeof p.html).toBe('string');
      expect((p.html as string).length).toBeGreaterThan(0);
      expect(p).not.toHaveProperty('react');
    });
    expect(options).toEqual({ idempotencyKey: 'k1', batchValidation: 'permissive' });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('B2: a per-email rejection → sent 2, failed 1; one Sentry warning with the domain only; no address logged', async () => {
    send.mockResolvedValueOnce(ok(['m1', 'm3'], [{ index: 1, message: 'Invalid `to` field: bad@x-corp.com' }]));
    const m = [msg('a@acme.com'), msg('bad@x-corp.com'), msg('c@acme.com')];
    await expect(deliverReminderBatch('daily-reminder', m, opts())).resolves.toEqual({ kind: 'sent', sent: 2, failed: 1 });
    expect(sentryCalls()).toHaveLength(1);
    const [, ctx] = sentryCalls()[0];
    expect(ctx.level).toBe('warning');
    expect(ctx.extra.recipientDomains).toEqual(['x-corp.com']);
    expect(ctx.extra.firstErrorMessage).toBe('Invalid `to` field: [redacted]');
    expect(consoleLines).toEqual(['Reminder batch failed (daily-reminder): partial [1 of 3; domains: x-corp.com]']);
    expect(JSON.stringify(sentryCalls()) + consoleLines.join('\n')).not.toContain('bad@');
  });

  it('B3: an empty id is not a send; failures with no error index list "unknown"', async () => {
    send.mockResolvedValueOnce({ data: { data: [{ id: '' }, { id: 'm2' }], errors: [] }, error: null, headers: null });
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'sent', sent: 1, failed: 1 });
    expect(sentryCalls()[0][1].extra.recipientDomains).toEqual(['unknown']);
  });

  it('B3 (cap): more ids than messages → sent is capped at the batch size, failed 0, and the mismatch warns', async () => {
    send.mockResolvedValueOnce(ok(['m1', 'm2', 'm3']));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'sent', sent: 2, failed: 0 });
    expect(sentryCalls()).toHaveLength(1);
    expect(sentryCalls()[0][1].level).toBe('warning');
  });

  it('B4: body.data not an array → failed unexpected_response, no retry', async () => {
    send.mockResolvedValueOnce({ data: { data: {} }, error: null, headers: null } as unknown as Resp);
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'unexpected_response' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('B23: bad error indexes never throw; they count as "unknown"', async () => {
    send.mockResolvedValueOnce({
      data: { data: [{ id: 'm1' }, { id: 'm2' }], errors: [{ index: 999, message: 'x' }, { index: 'a', message: 'y' }] }, error: null, headers: null,
    } as unknown as Resp);
    await expect(deliverReminderBatch('daily-reminder', msgs(3), opts())).resolves.toEqual({ kind: 'sent', sent: 2, failed: 1 });
    expect(sentryCalls()[0][1].extra.recipientDomains).toContain('unknown');
  });
});

describe('deliverReminderBatch: stops and rejections (A3, A4, A8–A10)', () => {
  /** Audit FR3: a stop logs exactly one Sentry error and the console line the checks file relies on. */
  const expectStopLogged = (line: string) => {
    expect(sentryCalls()).toHaveLength(1);
    expect(sentryCalls()[0][1].level).toBe('error');
    expect(consoleLines).toEqual([line]);
  };

  it.each([['B7', 'daily_quota_exceeded'], ['B8', 'monthly_quota_exceeded']] as const)('%s: %s → stop email-quota, one call', async (_n, name) => {
    send.mockResolvedValueOnce(err(name, 429));
    await expect(deliverReminderBatch('daily-reminder', msgs(3), opts())).resolves.toEqual({ kind: 'stop', failed: 3, reason: 'email-quota' });
    expect(send).toHaveBeenCalledTimes(1);
    expectStopLogged(`Reminder batch failed (daily-reminder): ${name} [3 of 3; domains: acme.com]`);
  });

  it.each([401, 403])('B9: %i validation_error → stop email-config, one call', async (status) => {
    send.mockResolvedValueOnce(err('validation_error', status));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'stop', failed: 2, reason: 'email-config' });
    expect(send).toHaveBeenCalledTimes(1);
    expectStopLogged('Reminder batch failed (daily-reminder): validation_error [2 of 2; domains: acme.com]');
  });

  it('B9c: restricted_api_key with a status outside 401/403 → stop email-config (by name)', async () => {
    send.mockResolvedValueOnce(err('restricted_api_key', 422));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'stop', failed: 2, reason: 'email-config' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('B9b: 400 "API key is invalid" → stop email-config; another 400 validation_error → failed', async () => {
    send.mockResolvedValueOnce(err('validation_error', 400, 'API key is invalid'));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'stop', failed: 2, reason: 'email-config' });
    expect(send).toHaveBeenCalledTimes(1);
    expectStopLogged('Reminder batch failed (daily-reminder): validation_error [2 of 2; domains: acme.com]');
    send.mockResolvedValueOnce(err('validation_error', 400, 'The `subject` field is required'));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'validation_error' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B14: invalid_idempotent_request → failed, one call, Sentry warning', async () => {
    send.mockResolvedValueOnce(err('invalid_idempotent_request', 409));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'invalid_idempotent_request' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentryCalls().map(([, c]) => c.level)).toEqual(['warning']);
  });

  it('B15: 422 validation_error → failed, one call', async () => {
    send.mockResolvedValueOnce(err('validation_error', 422));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'validation_error' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentryCalls().map(([, c]) => c.level)).toEqual(['error']);
  });

  it('B16: no client → disabled, no call', async () => {
    h.client = null;
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('B17: batch.send throws (async or sync) → failed, one call each, the helper does not throw', async () => {
    send.mockRejectedValueOnce(new TypeError('boom'));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'TypeError' });
    send.mockImplementationOnce(() => { throw new RangeError('sync boom'); });
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts())).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'RangeError' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B18: 0 or 101 messages → RangeError, no call', async () => {
    await expect(deliverReminderBatch('daily-reminder', [], opts())).rejects.toBeInstanceOf(RangeError);
    await expect(deliverReminderBatch('daily-reminder', msgs(101), opts())).rejects.toBeInstanceOf(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  it('B22: rendering throws → failed, no call', async () => {
    const Broken = () => { throw new Error('render boom'); };
    const bad: ReminderMessage = { to: 'a@acme.com', subject: 's', react: React.createElement(Broken) };
    const r = await deliverReminderBatch('daily-reminder', [bad], opts());
    expect(r).toMatchObject({ kind: 'failed', failed: 1 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('deliverReminderBatch: retries (A5–A7), same key and body, time cap', () => {
  async function retriedOnce(first: Resp | (() => Promise<Resp>)) {
    if (typeof first === 'function') send.mockImplementationOnce(first); else send.mockResolvedValueOnce(first);
    send.mockResolvedValueOnce(ok(['m1', 'm2']));
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts());
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    return p;
  }

  it('B5: rate limited, then success → two calls with the same key and an identical body, 2 s apart', async () => {
    await expect(retriedOnce(err('rate_limit_exceeded', 429))).resolves.toEqual({ kind: 'sent', sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(JSON.stringify(send.mock.calls[1][0])).toBe(JSON.stringify(send.mock.calls[0][0]));
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(2000);
  });

  it('B6: rate limited three times → exactly 3 calls, failed, one Sentry error', async () => {
    send.mockResolvedValue(err('rate_limit_exceeded', 429));
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts());
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(3);
    await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'rate_limit_exceeded' });
    await ticks();
    expect(send).toHaveBeenCalledTimes(3);
    expect(sentryCalls().map(([, c]) => c.level)).toEqual(['error']);
  });

  it('B10: the first call never settles → the second starts 14 s later with the same key; success', async () => {
    send.mockImplementationOnce(never);
    send.mockResolvedValueOnce(ok(['m1', 'm2']));
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts());
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    await expect(p).resolves.toEqual({ kind: 'sent', sent: 2, failed: 0 });
    expect(callTimes[1] - callTimes[0]).toBe(14_000);
    expect((send.mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey).toBe('k1');
  });

  it('B11: network failure (statusCode null), then success → 2 calls', async () => {
    await expect(retriedOnce(err('application_error', null))).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B12: 500, then success → 2 calls', async () => {
    await expect(retriedOnce(err('internal_server_error', 500))).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B13: concurrent_idempotent_requests, then success → 2 calls, same key', async () => {
    await expect(retriedOnce(err('concurrent_idempotent_requests', 409))).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
  });

  it('B24: an error with no name and no statusCode (a proxy 502), then success → 2 calls', async () => {
    const bare = { data: null, error: { message: 'Bad Gateway' }, headers: null } as unknown as Resp;
    await expect(retriedOnce(bare)).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B5b: a 429 with another name (too_many_requests), then success → 2 calls', async () => {
    const other = { data: null, error: { name: 'too_many_requests', message: 'slow down', statusCode: 429 }, headers: null } as unknown as Resp;
    await expect(retriedOnce(other)).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B24b: a JSON 4xx with no name ({ message: "Bad Request", statusCode: 400 }), then success → 2 calls', async () => {
    const bare = { data: null, error: { message: 'Bad Request', statusCode: 400 }, headers: null } as unknown as Resp;
    await expect(retriedOnce(bare)).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('B25 (audit FR1): times out, then concurrent-409, then concurrent-409 → failed with send_timeout (the breaker counts it)', async () => {
    send.mockImplementationOnce(never);
    send.mockResolvedValue(err('concurrent_idempotent_requests', 409));
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts());
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(3);
    await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'send_timeout' });
    expect(consoleLines).toEqual(['Reminder batch failed (daily-reminder): send_timeout [2 of 2; domains: acme.com]']);
  });

  it('B25 (contrast): concurrent-409 on every attempt, no timeout → keeps concurrent_idempotent_requests (exempt)', async () => {
    send.mockResolvedValue(err('concurrent_idempotent_requests', 409));
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts());
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(3);
    await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'concurrent_idempotent_requests' });
  });

  it('B19: three timeouts in a row, notAfter far away → failed 40 s after the first call, not later', async () => {
    send.mockImplementation(never);
    let settledAt: number | null = null;
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts()).then((r) => { settledAt = Date.now(); return r; });
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(2);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
    await calls(3);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS - 1);
    await ticks();
    expect(settledAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await ticks();
    await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'send_timeout' });
    expect(settledAt! - callTimes[0]).toBe(40_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('B21: notAfter 13 s away and the first attempt times out → no second attempt, failed at 12 s; past notAfter the first attempt still runs', async () => {
    send.mockImplementationOnce(never);
    let settledAt: number | null = null;
    const p = deliverReminderBatch('daily-reminder', msgs(2), opts({ notAfter: Date.now() + 13_000 })).then((r) => { settledAt = Date.now(); return r; });
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'send_timeout' });
    expect(settledAt! - callTimes[0]).toBe(12_000);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce(ok(['m1', 'm2']));
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts({ notAfter: Date.now() - 1 }))).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('deliverReminderBatch: the retry time cap, exactly (B21b, audit FR2/FR6)', () => {
  // `now` is injected (ms since the first attempt started). The first attempt times out at 12 s; a retry needs
  // 2 s wait + 12 s attempt, so it runs only if 12 + 2 + 12 = 26 s ≤ notAfter.
  it.each([
    [15_000, 1],
    [25_000, 1],
    [27_000, 2],
  ])('notAfter = start + %i ms → %i attempt(s)', async (notAfter, attempts) => {
    const start = Date.now();
    send.mockImplementationOnce(never);
    send.mockResolvedValueOnce(ok(['m1', 'm2']));
    const p = deliverReminderBatch('daily-reminder', msgs(2), { idempotencyKey: 'k1', notAfter, now: () => Date.now() - start });
    await calls(1);
    await vi.advanceTimersByTimeAsync(BATCH_ATTEMPT_TIMEOUT_MS);
    await ticks();
    if (attempts === 1) {
      await expect(p).resolves.toEqual({ kind: 'failed', failed: 2, errorName: 'send_timeout' });
    } else {
      await vi.advanceTimersByTimeAsync(BATCH_RETRY_DELAY_MS);
      await calls(2);
      await expect(p).resolves.toMatchObject({ kind: 'sent', sent: 2 });
    }
    expect(send).toHaveBeenCalledTimes(attempts);
  });
});

describe('deliverReminderBatch: the real SDK envelope (B20)', () => {
  it('B20: real Resend client, stubbed fetch → sent 2; /emails/batch with the key, permissive mode, html and no react', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    h.client = new Resend('re_test');
    const key = reminderBatchKey('daily-reminder', '00000000-0000-4000-8000-000000000001', '2026-11-12', ['u1', 'u2']);
    await expect(deliverReminderBatch('daily-reminder', msgs(2), opts({ idempotencyKey: key }))).resolves.toEqual({ kind: 'sent', sent: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith('/emails/batch')).toBe(true);
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe(key);
    expect(headers.get('x-batch-validation')).toBe('permissive');
    const body = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    for (const e of body) {
      expect(typeof e.html).toBe('string');
      expect(e).not.toHaveProperty('react');
    }
  });
});

describe('reminderBatchKey (K1)', () => {
  const T = '00000000-0000-4000-8000-000000000001';
  it('K1: order-independent; differs by cron, tenant, date or any id; ≤ 256 characters; no address', () => {
    const base = reminderBatchKey('daily-reminder', T, '2026-11-12', ['b', 'a', 'c']);
    expect(reminderBatchKey('daily-reminder', T, '2026-11-12', ['c', 'b', 'a'])).toBe(base);
    expect(reminderBatchKey('submission-deadline', T, '2026-11-12', ['a', 'b', 'c'])).not.toBe(base);
    expect(reminderBatchKey('daily-reminder', '00000000-0000-4000-8000-000000000002', '2026-11-12', ['a', 'b', 'c'])).not.toBe(base);
    expect(reminderBatchKey('daily-reminder', T, '2026-11-13', ['a', 'b', 'c'])).not.toBe(base);
    expect(reminderBatchKey('daily-reminder', T, '2026-11-12', ['a', 'b', 'd'])).not.toBe(base);
    expect(reminderBatchKey('daily-reminder', T, '2026-11-12', ['a', 'b'])).not.toBe(base);
    expect(base).toMatch(/^rem:daily-reminder:00000000-0000-4000-8000-000000000001:2026-11-12:[0-9a-f]{64}$/);
    const longest = reminderBatchKey('submission-deadline', T, '2026-11-12', Array.from({ length: 100 }, (_, i) => `user-${i}@acme.com`));
    expect(longest.length).toBeLessThanOrEqual(256);
    expect(longest).not.toContain('@');
  });
});
