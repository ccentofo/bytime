/** Timesheet copy shared by the grid, its descriptions and tests (feature-plan-ux-timesheet-ui.md §4.13). */
export const CLOSED_TO_NEW_HOURS = 'Closed to new hours';

/**
 * UX-TIMESHEET-B-AUDIT H3: what saveTimesheetBatch and submitPeriod refuse with when the session now belongs to someone
 * other than the person whose timesheet the page shows (a different account signed in from another tab). Lives here, not
 * in a 'use server' module, so the client can match it.
 */
export const SESSION_USER_CHANGED = "You're signed in as a different person now. Reload this page to continue.";
