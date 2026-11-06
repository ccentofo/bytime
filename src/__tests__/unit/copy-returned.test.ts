import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-approvals-payroll.md §3.3.6 (A1: display only — the stored status, events, action and email ids keep
 * "rejected"): the UI says "Return for corrections" / "Returned". The listed screens and the submit guard use the new
 * wording, and the Approvals UI files carry no user-facing "Reject".
 */
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

describe('"Returned", not "Rejected" (§3.3.6)', () => {
  it('Notifications, Migration and the submit guard', () => {
    expect(read('src/app/(app)/profile/notifications/NotificationsClient.tsx')).toContain('Receive an email when your timesheet is returned for corrections');
    expect(read('src/app/(app)/settings/migration/MigrationClient.tsx')).toContain('Only submitted, approved or returned periods that ended before today are imported.');
    expect(read('src/server/actions/periods.ts')).toContain('Only draft or returned timesheets can be submitted.');
  });

  it('the Approvals UI files have no user-facing "Reject" text', () => {
    for (const f of ['src/app/(app)/admin/approvals/ApprovalsClient.tsx', 'src/components/approvals/DecisionCard.tsx', 'src/components/approvals/ReviewGrid.tsx']) {
      // Strings and JSX text only (identifiers like rejectPeriod are code, not copy).
      const copy = [...read(f).matchAll(/(['"`])((?:(?!\1).)*)\1|>([^<>{}]+)</g)].map((m) => m[2] ?? m[3] ?? '');
      expect(copy.filter((t) => /\bReject(ed|ion)?\b/.test(t)), f).toEqual([]);
    }
  });
});
