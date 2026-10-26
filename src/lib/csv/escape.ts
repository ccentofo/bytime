/**
 * CSV field escaping for every CSV the app writes (feature-plan-certified-outputs.md C7): payroll exports, report
 * CSVs, and (via the re-export in workspace-export.ts) the workspace export.
 *
 * - Formula-injection guard: a value starting with = + @ tab or CR — or `-` unless it is a plain number — is prefixed
 *   with `'`, so a spreadsheet shows it as text instead of evaluating it.
 * - RFC 4180: a field containing the delimiter, a double quote, LF or CR is quoted, with quotes doubled.
 */
export const FORMULA_PATTERN = /^[=+@\t\r]|^-(?!\d+(\.\d+)?$)/;

export function escapeCsvField(value: string, delimiter = ','): string {
  const guarded = FORMULA_PATTERN.test(value) ? `'${value}` : value;
  if (guarded.includes(delimiter) || guarded.includes('"') || guarded.includes('\n') || guarded.includes('\r')) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}
