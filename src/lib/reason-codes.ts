export const REASON_CODES: { value: string; label: string }[] = [
  // feature-plan-ux-people-codes.md R4: sentence-case labels, UI only (no PDF, CSV or API prints them; the audit CSV
  // writes the raw code). ReasonModal requires a comment for every reason, so no label carries a hint.
  { value: 'CORRECTION', label: 'Correction' },
  { value: 'LATE_ENTRY', label: 'Late entry' },
  { value: 'TRANSFER', label: 'Transfer between accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-directed change' },
  { value: 'OTHER', label: 'Other' },
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
