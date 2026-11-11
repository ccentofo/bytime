/**
 * The landing page's marketing copy (feature-plan-ux-integrations-billing.md L1), exactly as written in
 * BUSINESS-DECISIONS.md §2, with the product owner's accuracy amendments of 2026-11-11 (LAUNCH-TRACKER.md decisions log)
 * for features 1, 2, 4 and 5. Feature 6 uses the pre-approval text until the product owner says to switch.
 *
 * Copy is business-owned: any wording change here needs the product owner's approval.
 */

export const LANDING_BADGE = 'DCAA Compliant';

export const LANDING_HEADLINE = 'DCAA-compliant timekeeping for government contractors';

export const LANDING_SUBHEAD =
  'Daily time entry, a revision history that never overwrites, and certified, supervisor-approved timesheets, in a modern app your team will actually use.';

export const LANDING_FEATURES_HEADING = 'Built for DCAA compliance';

export const LANDING_FEATURES: ReadonlyArray<{ title: string; blurb: string }> = [
  {
    title: 'Nothing is overwritten',
    // Amended (product owner, 2026-11-11): the database enforcement wording.
    blurb: 'Every change creates a new revision with a reason, and the database itself blocks overwriting or deleting entries. Auditors see who changed what, when, and why.',
  },
  {
    title: 'Daily time entry',
    // Amended: "keep employees on track" (replaces "everyone").
    blurb: 'Late entries are flagged and need a reason, future dates are blocked, and daily reminders keep employees on track.',
  },
  {
    title: 'People see only their codes',
    blurb: 'Employees can charge only the charge codes assigned to them, enforced on the server.',
  },
  {
    title: 'Signed and approved',
    // Amended: "return" not "reject"; "Submitted and approved timesheets lock."
    blurb: 'Employees certify each timesheet when they submit it. Supervisors approve or return it. Submitted and approved timesheets lock.',
  },
  {
    title: 'Reports auditors ask for',
    // Amended: "an audit trail you can filter by person, contract and reason".
    blurb: 'PDF timesheets, cost reports in CSV and Excel, and an audit trail you can filter by person, contract and reason.',
  },
  {
    title: 'Works with your systems',
    // Pre-approval text (until Intuit approves the QuickBooks production app).
    blurb: 'Payroll files for Gusto, ADP and Paychex, and a REST API. QuickBooks Online integration coming soon.',
  },
];

export const LANDING_FOOTER_DISCLAIMER =
  'DCAA does not certify or endorse software. CadenzPoint is designed to support DCAA timekeeping requirements; compliance also depends on your organization\'s policies and how you use it.';
