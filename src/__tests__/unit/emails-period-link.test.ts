import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimesheetApprovedEmail } from '@/lib/email/templates/timesheet-approved';
import { TimesheetRejectedEmail } from '@/lib/email/templates/timesheet-rejected';

/** feature-plan-ux-timesheet.md A-T12 (A4.8): the approved and returned emails open that period, not just /timesheet. */

describe('approved / returned emails link to the period', () => {
  const appUrl = 'https://acme.cadenzpoint.com';
  it('rejected → /timesheet?period={start}', () => {
    const html = renderToStaticMarkup(React.createElement(TimesheetRejectedEmail, { employeeName: 'Jane', periodLabel: 'Oct 1 – Oct 15, 2026', rejectedBy: 'Sarah', rejectedAt: 'Oct 16', rejectionComment: 'Fix Tuesday', appUrl, periodStart: '2026-10-01' }));
    expect(html).toContain(`href="${appUrl}/timesheet?period=2026-10-01"`);
  });
  it('approved → /timesheet?period={start}', () => {
    const html = renderToStaticMarkup(React.createElement(TimesheetApprovedEmail, { employeeName: 'Jane', periodLabel: 'Oct 1 – Oct 15, 2026', approvedBy: 'Sarah', approvedAt: 'Oct 16', appUrl, periodStart: '2026-10-01' }));
    expect(html).toContain(`href="${appUrl}/timesheet?period=2026-10-01"`);
  });
});
