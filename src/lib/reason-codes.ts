export const REASON_CODES: { value: string; label: string }[] = [
  { value: 'CORRECTION', label: 'Correction of Error' },
  { value: 'LATE_ENTRY', label: 'Late Entry (>24hrs)' },
  { value: 'TRANSFER', label: 'Transfer Between Accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-Directed Change' },
  { value: 'OTHER', label: 'Other (explain in comments)' },
];

/**
 * Display labels for every change-reason code that can appear on an entry (feature-plan-certified-outputs.md C1/C6).
 * `MIGRATION` is system-only — written by the migration import — so it is deliberately NOT in REASON_CODES (the list
 * users pick from and saveTimesheetBatch validates against).
 */
export const REASON_LABELS: Record<string, string> = {
  ...Object.fromEntries(REASON_CODES.map((r) => [r.value, r.label])),
  MIGRATION: 'Imported (migration)',
};

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return '';
  return REASON_LABELS[code] ?? code;
}

/** certified-outputs C8: the "Other" reason must be explained (server and client). */
export const OTHER_REASON_COMMENT_REQUIRED = 'Add a comment explaining the change — a comment is required when the reason is Other.';

export function reasonNeedsComment(code: string | null | undefined, comment: string | null | undefined): boolean {
  return code === 'OTHER' && !(comment ?? '').trim();
}
