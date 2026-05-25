import { resend, EMAIL_FROM, isEmailEnabled } from './client';
import { TimesheetSubmittedEmail } from './templates/timesheet-submitted';
import { TimesheetApprovedEmail } from './templates/timesheet-approved';
import { TimesheetRejectedEmail } from './templates/timesheet-rejected';
import { DailyReminderEmail } from './templates/daily-reminder';
import { SubmissionDeadlineEmail } from './templates/submission-deadline';
import React from 'react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Email Send Functions (fire-and-forget — never await in user-facing actions)
// ---------------------------------------------------------------------------

/**
 * Send notification to supervisor(s) when an employee submits their timesheet.
 */
export async function sendTimesheetSubmittedEmail(data: {
  supervisorEmail: string;
  supervisorName: string;
  employeeName: string;
  employeeEmail: string;
  periodLabel: string;
  submittedAt: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.supervisorEmail,
      subject: `Timesheet Submitted — ${data.employeeName} — ${data.periodLabel}`,
      react: React.createElement(TimesheetSubmittedEmail, {
        supervisorName: data.supervisorName,
        employeeName: data.employeeName,
        employeeEmail: data.employeeEmail,
        periodLabel: data.periodLabel,
        submittedAt: data.submittedAt,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet submitted email:', error);
  }
}

/**
 * Send notification to employee when their timesheet is approved.
 */
export async function sendTimesheetApprovedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  approvedBy: string;
  approvedAt: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Timesheet Approved — ${data.periodLabel}`,
      react: React.createElement(TimesheetApprovedEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        approvedBy: data.approvedBy,
        approvedAt: data.approvedAt,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet approved email:', error);
  }
}

/**
 * Send notification to employee when their timesheet is rejected.
 */
export async function sendTimesheetRejectedEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  rejectedBy: string;
  rejectedAt: string;
  rejectionComment: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Timesheet Returned for Corrections — ${data.periodLabel}`,
      react: React.createElement(TimesheetRejectedEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        rejectedBy: data.rejectedBy,
        rejectedAt: data.rejectedAt,
        rejectionComment: data.rejectionComment,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send timesheet rejected email:', error);
  }
}

/**
 * Send daily time entry reminder to an employee.
 */
export async function sendDailyReminderEmail(data: {
  employeeEmail: string;
  employeeName: string;
  todayDate: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Reminder: Enter Your Time for ${data.todayDate}`,
      react: React.createElement(DailyReminderEmail, {
        employeeName: data.employeeName,
        todayDate: data.todayDate,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send daily reminder email:', error);
  }
}

/**
 * Send submission deadline reminder to an employee.
 */
export async function sendSubmissionDeadlineEmail(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  deadlineDate: string;
}): Promise<void> {
  if (!isEmailEnabled() || !resend) return;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: data.employeeEmail,
      subject: `Submit Your Timesheet — Due ${data.deadlineDate}`,
      react: React.createElement(SubmissionDeadlineEmail, {
        employeeName: data.employeeName,
        periodLabel: data.periodLabel,
        deadlineDate: data.deadlineDate,
        appUrl: APP_URL,
      }),
    });
  } catch (error) {
    console.error('Failed to send submission deadline email:', error);
  }
}
