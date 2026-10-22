import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P1 §4 / §9 "Emails": the send outcome contract. Resend 6.x reports API
 * failures as `{ error }` instead of throwing, so success is recorded only when a message id comes back.
 */

const resendState = vi.hoisted(() => ({
  enabled: true,
  send: vi.fn(),
}));

vi.mock('@/lib/email/client', () => ({
  get resend() { return resendState.enabled ? { emails: { send: resendState.send } } : null; },
  EMAIL_FROM: 'CadenzPoint <noreply@cadenzpoint.com>',
  isEmailEnabled: () => resendState.enabled,
}));

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

import {
  deliverEmail,
  sendTimesheetSubmittedEmail,
  sendTimesheetApprovedEmail,
  sendTimesheetRejectedEmail,
  sendDailyReminderEmail,
  sendSubmissionDeadlineEmail,
  sendPasswordResetEmail,
} from '@/lib/email/send';
import React from 'react';

const el = React.createElement('div');

beforeEach(() => {
  resendState.enabled = true;
  resendState.send.mockReset();
  sentry.captureMessage.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('deliverEmail outcome', () => {
  it('returns { ok: true, id } when Resend returns a message id', async () => {
    resendState.send.mockResolvedValue({ data: { id: 'msg_1' }, error: null, headers: null });
    await expect(deliverEmail('t', 'a@acme.com', 's', el)).resolves.toEqual({ ok: true, id: 'msg_1' });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a returned { error } is a failure (not a throw) and is reported to Sentry', async () => {
    resendState.send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad', statusCode: 422 }, headers: null });
    await expect(deliverEmail('t', 'a@acme.com', 's', el)).resolves.toEqual({ ok: false, reason: 'error' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('a missing message id counts as a failure', async () => {
    resendState.send.mockResolvedValue({ data: {}, error: null, headers: null });
    await expect(deliverEmail('t', 'a@acme.com', 's', el)).resolves.toEqual({ ok: false, reason: 'error' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('a thrown network error is a failure, never rethrown', async () => {
    resendState.send.mockRejectedValue(new TypeError('fetch failed'));
    await expect(deliverEmail('t', 'a@acme.com', 's', el)).resolves.toEqual({ ok: false, reason: 'error' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('disabled email → { ok: false, reason: "disabled" } with no Sentry noise and no send', async () => {
    resendState.enabled = false;
    await expect(deliverEmail('t', 'a@acme.com', 's', el)).resolves.toEqual({ ok: false, reason: 'disabled' });
    expect(resendState.send).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a 429 is retried once after 2 s', async () => {
    resendState.send
      .mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 }, headers: null })
      .mockResolvedValueOnce({ data: { id: 'msg_2' }, error: null, headers: null });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = deliverEmail('t', 'a@acme.com', 's', el);
    await vi.advanceTimersByTimeAsync(1999);
    expect(resendState.send).toHaveBeenCalledTimes(1); // still backing off
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true, id: 'msg_2' });
    expect(resendState.send).toHaveBeenCalledTimes(2);
  });

  it('a second 429 counts as a failure (exactly one retry)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    resendState.send.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 }, headers: null });
    const pending = deliverEmail('t', 'a@acme.com', 's', el);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'error' });
    expect(resendState.send).toHaveBeenCalledTimes(2);
  });

  it('logs the recipient DOMAIN only, never the full address', async () => {
    resendState.send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad', statusCode: 422 }, headers: null });
    await deliverEmail('t', 'jane.doe@acme.com', 's', el);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
    expect(logged).toContain('acme.com');
    expect(logged).not.toContain('jane.doe');
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toContain('jane.doe');
  });
});

describe('every workspace email carries the caller-supplied tenant appUrl', () => {
  const appUrl = 'https://acme.cadenzpoint.com';
  const props = () => (resendState.send.mock.calls[0][0].react as React.ReactElement<{ appUrl: string }>).props;

  beforeEach(() => {
    resendState.send.mockResolvedValue({ data: { id: 'msg' }, error: null, headers: null });
  });

  it.each([
    ['submitted', () => sendTimesheetSubmittedEmail({ supervisorEmail: 's@a.com', supervisorName: 'S', employeeName: 'E', employeeEmail: 'e@a.com', periodLabel: 'P', submittedAt: 'now', appUrl })],
    ['approved', () => sendTimesheetApprovedEmail({ employeeEmail: 'e@a.com', employeeName: 'E', periodLabel: 'P', approvedBy: 'A', approvedAt: 'now', appUrl })],
    ['rejected', () => sendTimesheetRejectedEmail({ employeeEmail: 'e@a.com', employeeName: 'E', periodLabel: 'P', rejectedBy: 'A', rejectedAt: 'now', rejectionComment: 'fix', appUrl })],
    ['daily reminder', () => sendDailyReminderEmail({ employeeEmail: 'e@a.com', employeeName: 'E', todayDate: 'Mon', appUrl })],
    ['deadline', () => sendSubmissionDeadlineEmail({ employeeEmail: 'e@a.com', employeeName: 'E', periodLabel: 'P', deadlineDate: 'Fri', appUrl })],
    ['password reset', () => sendPasswordResetEmail({ employeeEmail: 'e@a.com', employeeName: 'E', resetUrl: `${appUrl}/reset-password`, expiresIn: '1 hour', appUrl })],
  ])('%s', async (_name, send) => {
    await expect(send()).resolves.toEqual({ ok: true, id: 'msg' });
    expect(props().appUrl).toBe(appUrl);
  });
});
