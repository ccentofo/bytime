export const REASON_CODES: { value: string; label: string }[] = [
  { value: 'CORRECTION', label: 'Correction of Error' },
  { value: 'LATE_ENTRY', label: 'Late Entry (>24hrs)' },
  { value: 'TRANSFER', label: 'Transfer Between Accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-Directed Change' },
  { value: 'OTHER', label: 'Other (explain in comments)' },
];
