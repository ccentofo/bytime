import packageJson from '../../../package.json';
import { EXPORT_TABLES } from './allowlists';

export const APP_VERSION: string = packageJson.version;

export interface ExportManifest {
  tenantSlug: string;
  generatedAt: string;
  appVersion: string;
  schemaMigrationCount: number;
  schemaMigrationLastAppliedAt: string | null;
  rowCounts: Record<string, number>;
}

export function buildManifest(input: {
  tenantSlug: string;
  schemaMigrationCount: number;
  schemaMigrationLastAppliedAt: Date | null;
  rowCounts: Record<string, number>;
}): ExportManifest {
  return {
    tenantSlug: input.tenantSlug,
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    schemaMigrationCount: input.schemaMigrationCount,
    schemaMigrationLastAppliedAt: input.schemaMigrationLastAppliedAt?.toISOString() ?? null,
    rowCounts: input.rowCounts,
  };
}

/** timesheet_entries.csv / timesheet_entries_current.csv columns (resolved labels are a convenience). */
export const TIMESHEET_COLUMNS: { header: string; description: string }[] = [
  { header: 'id', description: 'Unique identifier of this revision row.' },
  { header: 'user_id', description: 'The employee (users.csv id).' },
  { header: 'user_email', description: 'The employee email (convenience label).' },
  { header: 'user_full_name', description: 'The employee name (convenience label).' },
  { header: 'entry_date', description: 'The day worked (calendar date in the workspace time zone, YYYY-MM-DD).' },
  { header: 'hours', description: 'Hours recorded for the cell in this revision.' },
  { header: 'revision_number', description: 'Revision of this cell (employee + code + date); the highest is current.' },
  { header: 'change_reason_code', description: 'Why a correction was made (blank on the first entry).' },
  { header: 'comment', description: 'Comment entered with the entry or correction.' },
  { header: 'created_at', description: 'When this revision was recorded (UTC).' },
  { header: 'created_by', description: 'Who recorded this revision (users.csv id).' },
  { header: 'created_by_email', description: 'Email of who recorded it (convenience label).' },
  { header: 'charge_code_id', description: 'Direct charge code (charge_codes.csv id), if any.' },
  { header: 'charge_code', description: 'Charge code (convenience label).' },
  { header: 'charge_code_name', description: 'Charge code name (convenience label).' },
  { header: 'clin_id', description: 'Contract line item (clins.csv id), if any.' },
  { header: 'clin_number', description: 'CLIN number (convenience label).' },
  { header: 'slin_id', description: 'Sub-line item (slins.csv id), if any.' },
  { header: 'slin_number', description: 'SLIN number (convenience label).' },
  { header: 'indirect_code_id', description: 'Indirect charge code (indirect_charge_codes.csv id), if any.' },
  { header: 'indirect_code', description: 'Indirect code (convenience label).' },
  { header: 'indirect_code_name', description: 'Indirect code name (convenience label).' },
  { header: 'source', description: 'app = recorded in CadenzPoint; migration = imported from another system during onboarding (never typed here by the employee).' },
  { header: 'import_batch_id', description: 'For imported rows: the import (import_batches.csv id); blank otherwise.' },
  { header: 'original_metadata', description: 'For imported rows: who originally entered the hours and when, from the source file, as data (JSON).' },
  { header: 'provenance', description: 'Derived label for imported rows ("Imported from … on … by …" + the original author, or "Legacy import — details not recorded"); blank for rows recorded in the app.' },
];

const EXTRA_FILES: { file: string; description: string }[] = [
  {
    file: 'timesheet_entries.csv',
    description:
      'The raw, append-only time-entry table — EVERY revision of every cell, never just the ' +
      'latest. revision_number increments per (employee, charge code/CLIN/indirect code, date) ' +
      'cell; change_reason_code and comment explain a correction. charge_code/clin_number/' +
      'slin_number/indirect_code are resolved to human labels as a convenience — the _id columns ' +
      'are the authoritative foreign keys.',
  },
  {
    file: 'timesheet_entries_current.csv',
    description:
      'Convenience view: only the LATEST revision_number per cell (same columns as ' +
      'timesheet_entries.csv). Use timesheet_entries.csv for the full audit trail.',
  },
];

/** The data dictionary required by T6: every file, every column, and what it means. */
export function buildReadme(manifest: ExportManifest): string {
  const lines: string[] = [
    `# CadenzPoint workspace export — ${manifest.tenantSlug}`,
    '',
    `Generated: ${manifest.generatedAt}`,
    `App version: ${manifest.appVersion}`,
    '',
    'This export contains every Customer Data table for this workspace, read from one consistent ' +
      'snapshot. All timestamps are ISO-8601 in UTC; calendar dates (YYYY-MM-DD) are days in the ' +
      'workspace time zone (workspace_settings.csv). All CSV files are UTF-8 with a BOM (so Excel ' +
      'opens them correctly), RFC 4180 quoting, and CRLF line endings. See manifest.json for exact ' +
      'row counts.',
    '',
    '## Conventions',
    '',
    '- A column ending in `_id` is a foreign key to another file\'s `id` column (or to a record ' +
      'this workspace no longer has, if it was later removed — the id is kept, the label is not).',
    '- `status`, `role`, `category`, `work_location`, and similar columns are fixed sets of ' +
      'values used by the app; the choices are visible in each file\'s data.',
    '- A blank cell means the column was null.',
    '- **Leading apostrophe:** a cell that would start with `=`, `+`, `@`, a tab, a carriage return, ' +
      'or a `-` that is not part of a plain number is written with a leading `\'` so spreadsheet ' +
      'programs show it as text instead of running it as a formula. Remove that one leading `\'` to ' +
      'recover the exact original value.',
    '',
    '## Files',
    '',
  ];

  for (const t of EXPORT_TABLES) {
    lines.push(`### ${t.file}.csv`);
    lines.push('');
    for (const c of t.columns) lines.push(`- \`${c.header}\`: ${c.description}`);
    lines.push('');
  }

  for (const extra of EXTRA_FILES) {
    lines.push(`### ${extra.file}`);
    lines.push('');
    lines.push(extra.description);
    lines.push('');
    for (const c of TIMESHEET_COLUMNS) lines.push(`- \`${c.header}\`: ${c.description}`);
    lines.push('');
  }

  lines.push('## Never included');
  lines.push('');
  lines.push(
    'Password hashes, TOTP secrets/recovery codes, session versions, API key hashes, password-' +
      'reset tokens, and integration OAuth tokens are never exported, in any form.',
  );
  lines.push('');

  return lines.join('\n');
}
