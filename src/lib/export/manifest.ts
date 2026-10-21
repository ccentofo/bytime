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
    'This export contains every Customer Data table for this workspace. All timestamps are ' +
      'ISO-8601 in UTC. All CSV files are UTF-8 with a BOM (so Excel opens them correctly) and ' +
      'RFC 4180 quoting. See manifest.json for exact row counts.',
    '',
    '## Conventions',
    '',
    '- A column ending in `_id` is a foreign key to another file\'s `id` column (or to a record ' +
      'this workspace no longer has, if it was later removed — the id is kept, the label is not).',
    '- `status`, `role`, `category`, `work_location`, and similar columns are fixed sets of ' +
      'values used by the app; the choices are visible in each file\'s data.',
    '- A blank cell means the column was null.',
    '',
    '## Files',
    '',
  ];

  for (const t of EXPORT_TABLES) {
    lines.push(`### ${t.file}.csv`);
    lines.push('');
    lines.push(t.columns.map((c) => c.header).join(', '));
    lines.push('');
  }

  for (const extra of EXTRA_FILES) {
    lines.push(`### ${extra.file}`);
    lines.push('');
    lines.push(extra.description);
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
