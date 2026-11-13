import React from 'react';
import { DailyReminderEmail } from './templates/daily-reminder';
import { SubmissionDeadlineEmail } from './templates/submission-deadline';

/**
 * feature-plan-reminder-capacity.md §6.1: the two reminder crons build their messages here and send them in batches
 * (`deliverReminderBatch`, ./send-batch). Pure builders: subjects and template props are exactly what the single-send
 * reminder senders used. A separate module (not ./send), because seven integration files mock `@/lib/email/send` with
 * an explicit export list and load the cron routes under it.
 */
export type ReminderMessage = { to: string; subject: string; react: React.ReactElement };

/** Daily time-entry reminder. */
export function dailyReminderMessage(data: {
  employeeEmail: string;
  employeeName: string;
  todayDate: string;
  appUrl: string;
}): ReminderMessage {
  return {
    to: data.employeeEmail,
    subject: `Reminder: Enter Your Time for ${data.todayDate}`,
    react: React.createElement(DailyReminderEmail, {
      employeeName: data.employeeName,
      todayDate: data.todayDate,
      appUrl: data.appUrl,
    }),
  };
}

/** Submission-deadline reminder. */
export function submissionDeadlineMessage(data: {
  employeeEmail: string;
  employeeName: string;
  periodLabel: string;
  deadlineDate: string;
  appUrl: string;
}): ReminderMessage {
  return {
    to: data.employeeEmail,
    subject: `Submit Your Timesheet — Due ${data.deadlineDate}`,
    react: React.createElement(SubmissionDeadlineEmail, {
      employeeName: data.employeeName,
      periodLabel: data.periodLabel,
      deadlineDate: data.deadlineDate,
      appUrl: data.appUrl,
    }),
  };
}
