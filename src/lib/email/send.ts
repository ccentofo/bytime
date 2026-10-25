import * as Sentry from '@sentry/nextjs';
import { resend, EMAIL_FROM, isEmailEnabled } from './client';
import { TimesheetSubmittedEmail } from './templates/timesheet-submitted';
import { TimesheetApprovedEmail } from './templates/timesheet-approved';
import { TimesheetRejectedEmail } from './templates/timesheet-rejected';
import { DailyReminderEmail } from './templates/daily-reminder';
import { SubmissionDeadlineEmail } from './templates/submission-deadline';
import { PasswordResetEmail } from './templates/password-reset';
import React from 'react';

/**
 * Every sender returns a SendOutcome and never throws. Success is recorded only when Resend returns a message id
 * (Resend 6.x reports API failures as `{ error }`, it does not throw). Server actions schedule sends with
 * `scheduleEmail` (`after()`); crons await them. Links are passed in as `appUrl` by the caller — a tenant's own
 * host (`tenantBaseUrl(slug)`) for workspace emails, the apex only for signup.
 */
export type SendOutcome = { ok: true; id: string } | { ok: false; reason: 'disabled' | 'error' };

const RATE_LIMIT_RETRY_DELAY_MS = 2000;

function recipientDomain(to: string): string {
  const at = to.lastIndexOf('@');
  return at >= 0 ? to.slice(at + 1) : 'unknown';
}

function reportFailure(label: string, to: string, errorName: string): SendOutcome {
  const domain = recipientDomain(to);
  // Recipient DOMAIN only — never the full address in logs or Sentry.
  console.error(`Email send failed (${label}): ${errorName} [recipient domain: ${domain}]`);
  Sentry.captureMessage(`Email send failed: ${label}`, { level: 'error', extra: { errorName, recipientDomain: domain } });
  return { ok: false, reason: 'error' };
}

type Attempt = { kind: 'ok'; id: string } | { kind: 'rate_limited' } | { kind: 'failed'; errorName: string };

async function attemptSend(to: string, subject: string, react: React.ReactElement): Promise<Attempt> {
  try {
    const result = await resend!.emails.send({ from: EMAIL_FROM, to, subject, react });
    if (result.error) {
      if (result.error.statusCode === 429 || result.error.name === 'rate_limit_exceeded') return { kind: 'rate_limited' };
      return { kind: 'failed', errorName: result.error.name };
    }
    const id = result.data?.id;
    return id ? { kind: 'ok', id } : { kind: 'failed', errorName: 'missing_message_id' };
  } catch (err) {
    return { kind: 'failed', errorName: err instanceof Error ? err.name : 'unknown_error' };
  }
}

/** Send one email. A 429 is retried once after 2 s; anything else unsuccessful is a failure. */
export async function deliverEmail(label: string, to: string, subject: string, react: React.ReactElement): Promise<SendOutcome> {
  if (!isEmailEnabled() || !resend) return { ok: false, reason: 'disabled' };

  let attempt = await attemptSend(to, subject, react);
  if (attempt.kind === 'rate_limited') {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
    attempt = await attemptSend(to, subject, react);
  }
  if (attempt.kind === 'ok') return { ok: true, id: attempt.id };
  return reportFailure(label, to, attempt.kind === 'rate_limited' ? 'rate_limit_exceeded' : attempt.errorName);
}

/** Notify a reviewer that an employee submitted their timesheet. */
export async function sendTimesheetSubmittedEmail(data: {
  supervisorEmail: string;
  supervisorName: string;
  employeeName: string;
  employeeEmail: string;
  periodLabel: string;
  submittedAt: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'timesheet-submitted',
    data.supervisorEmail,
    `Timesheet Submitted — ${data.employeeName} — ${data.periodLabel}`,
    React.createElement(TimesheetSubmittedEmail, {
      supervisorName: data.supervisorName,
      employeeName: data.employeeName,
      employeeEmail: data.employeeEmail,
      periodLabel: data.periodLabel,
      submittedAt: data.submittedAt,
      appUrl: data.appUrl,
    }),
  );
}

/** Notify an employee that their timesheet was approved. */
export async function sendTimesheetApprovedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  approvedBy: string;
  approvedAt: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'timesheet-approved',
    data.employeeEmail,
    `Timesheet Approved — ${data.periodLabel}`,
    React.createElement(TimesheetApprovedEmail, {
      employeeName: data.employeeName,
      periodLabel: data.periodLabel,
      approvedBy: data.approvedBy,
      approvedAt: data.approvedAt,
      appUrl: data.appUrl,
    }),
  );
}

/** Notify an employee that their timesheet was returned for corrections. */
export async function sendTimesheetRejectedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  rejectedBy: string;
  rejectedAt: string;
  rejectionComment: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'timesheet-rejected',
    data.employeeEmail,
    `Timesheet Returned for Corrections — ${data.periodLabel}`,
    React.createElement(TimesheetRejectedEmail, {
      employeeName: data.employeeName,
      periodLabel: data.periodLabel,
      rejectedBy: data.rejectedBy,
      rejectedAt: data.rejectedAt,
      rejectionComment: data.rejectionComment,
      appUrl: data.appUrl,
    }),
  );
}

/** Daily time-entry reminder. */
export async function sendDailyReminderEmail(data: {
  employeeEmail: string;
  employeeName: string;
  todayDate: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'daily-reminder',
    data.employeeEmail,
    `Reminder: Enter Your Time for ${data.todayDate}`,
    React.createElement(DailyReminderEmail, {
      employeeName: data.employeeName,
      todayDate: data.todayDate,
      appUrl: data.appUrl,
    }),
  );
}

/** Submission-deadline reminder. */
export async function sendSubmissionDeadlineEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  deadlineDate: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'submission-deadline',
    data.employeeEmail,
    `Submit Your Timesheet — Due ${data.deadlineDate}`,
    React.createElement(SubmissionDeadlineEmail, {
      employeeName: data.employeeName,
      periodLabel: data.periodLabel,
      deadlineDate: data.deadlineDate,
      appUrl: data.appUrl,
    }),
  );
}

/** Password reset link. `resetUrl` is on the tenant's own host. */
export async function sendPasswordResetEmail(data: {
  employeeEmail: string;
  employeeName: string;
  resetUrl: string;
  expiresIn: string;
  appUrl: string;
}): Promise<SendOutcome> {
  return deliverEmail(
    'password-reset',
    data.employeeEmail,
    'Reset Your CadenzPoint Password',
    React.createElement(PasswordResetEmail, {
      employeeName: data.employeeName,
      resetUrl: data.resetUrl,
      expiresIn: data.expiresIn,
      appUrl: data.appUrl,
    }),
  );
}
