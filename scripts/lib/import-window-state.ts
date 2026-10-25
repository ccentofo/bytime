/**
 * `tenant:admin show`'s history-import line (certified-outputs C1; fix round 1, F14). Same rule as the app
 * (src/server/internal/import-window.ts): closed once history_import_closed_at is set OR any app-sourced `submitted`
 * period event exists (covers code that ran before the column was written). The founder's reopen is printed separately.
 */
export function describeImportWindowState(f: { settingsRowExists: boolean; closedAt: Date | null; hasAppSubmittedEvent: boolean }): string {
  if (!f.settingsRowExists) return 'no workspace_settings row (treated as CLOSED)';
  if (f.closedAt) return `closed ${f.closedAt.toISOString()} (first submission)`;
  if (f.hasAppSubmittedEvent) return 'closed (a timesheet was submitted in the app; history_import_closed_at not recorded)';
  return 'open (no submission yet)';
}
