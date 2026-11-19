/**
 * Who is expected to submit a timesheet (UX2-Q1 default, pending the product owner): active employees and supervisors,
 * plus any admin who recorded hours or has a period row for that period. Change it here — one line.
 *
 * Client-safe, so the Notifications page and the server share ONE rule (SWEEP-FINDINGS.md A3-D7, the product owner's
 * decision 2): everyone in these roles gets the daily and deadline reminders, and sees and controls them.
 * `src/server/internal/team-period-status.ts` re-exports it for the server readers.
 */
export const EXPECTED_SUBMITTER_ROLES = ['employee', 'supervisor'] as const;

export function isExpectedSubmitter(role: string): boolean {
  return (EXPECTED_SUBMITTER_ROLES as readonly string[]).includes(role);
}
