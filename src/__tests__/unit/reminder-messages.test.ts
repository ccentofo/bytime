import { describe, it, expect } from 'vitest';
import type React from 'react';
import { DailyReminderEmail } from '@/lib/email/templates/daily-reminder';
import { SubmissionDeadlineEmail } from '@/lib/email/templates/submission-deadline';
import { dailyReminderMessage, submissionDeadlineMessage } from '@/lib/email/reminder-messages';

/**
 * feature-plan-reminder-capacity.md §11 M1: the reminder builders keep the single-send senders' subjects and template
 * props exactly, address the employee, and carry the caller's tenant appUrl (replaces email-send.test.ts:123-124).
 */
const appUrl = 'https://acme.cadenzpoint.com';
type Props = Record<string, unknown>;

describe('reminder message builders (M1)', () => {
  it('dailyReminderMessage', () => {
    const m = dailyReminderMessage({ employeeEmail: 'e@acme.com', employeeName: 'Erin', todayDate: 'Thursday, Nov 12, 2026', appUrl });
    expect(m.to).toBe('e@acme.com');
    expect(m.subject).toBe('Reminder: Enter Your Time for Thursday, Nov 12, 2026');
    expect(m.react.type).toBe(DailyReminderEmail);
    expect((m.react as React.ReactElement<Props>).props).toEqual({ employeeName: 'Erin', todayDate: 'Thursday, Nov 12, 2026', appUrl });
  });

  it('submissionDeadlineMessage', () => {
    const m = submissionDeadlineMessage({
      employeeEmail: 'e@acme.com', employeeName: 'Erin', periodLabel: 'Nov 1 – Nov 15, 2026', deadlineDate: 'Friday, Nov 13, 2026', appUrl,
    });
    expect(m.to).toBe('e@acme.com');
    expect(m.subject).toBe('Submit Your Timesheet — Due Friday, Nov 13, 2026');
    expect(m.react.type).toBe(SubmissionDeadlineEmail);
    expect((m.react as React.ReactElement<Props>).props).toEqual({
      employeeName: 'Erin', periodLabel: 'Nov 1 – Nov 15, 2026', deadlineDate: 'Friday, Nov 13, 2026', appUrl,
    });
  });
});
