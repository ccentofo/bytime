import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DailyReminderEmail } from '@/lib/email/templates/daily-reminder';
import { SubmissionDeadlineEmail } from '@/lib/email/templates/submission-deadline';

/**
 * feature-plan-launch-hardening.md H1 / Q3 (T5): the daily reminder can't be switched off, so its email no longer says it
 * can; the deadline reminder still can, so its sentence stays.
 */
describe('reminder email footers (T5)', () => {
  const appUrl = 'https://acme.cadenzpoint.com';
  it('the daily reminder has no "disable these reminders" sentence', () => {
    const html = renderToStaticMarkup(React.createElement(DailyReminderEmail, { employeeName: 'Jane', todayDate: 'Monday, Nov 9, 2026', appUrl }));
    expect(html).toContain('Enter Time Now');
    expect(html).not.toContain('disable these reminders');
  });
  it('the deadline reminder still has it', () => {
    const html = renderToStaticMarkup(React.createElement(SubmissionDeadlineEmail, { employeeName: 'Jane', periodLabel: 'Nov 1 – Nov 15, 2026', deadlineDate: 'Friday, Nov 13', appUrl }));
    expect(html).toContain('You can disable these reminders in your notification settings.');
  });
});
