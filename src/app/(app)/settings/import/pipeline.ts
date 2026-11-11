import { parseCSV } from '@/lib/csv-parser';
import { generateCsv } from '@/lib/reports/csv-generator';
import { formatCount } from '@/lib/format';
import { serializedBytes } from '@/lib/migration/import-plan';
import {
  IMPORT_MAX_BYTES, IMPORT_ROW_LIMIT, TOO_BIG_MESSAGE, hasInvalidCharacter, invalidCharacterMessage, spreadsheetRow, tooManyRowsMessage,
} from '@/lib/import/limits';
import type { MigrationEntryRow, MigrationPeriodRow } from '@/types/migration';
import type { HistoryTypeDef, SetupTypeDef } from './import-types';

/**
 * The import pipeline's pure steps (feature-plan-ux-setup-import.md §4.2, §4.4): parse a file into numbered rows,
 * refuse files over the limits, merge a check's result into per-row outcomes, order the check table, and build the
 * "rows with problems" file. Client-safe; unit-tested without rendering.
 */

/** One file row: its number, the original cells, and a problem found in the browser (never sent). */
export interface PreparedRow { row: number; data: Record<string, string>; clientError: string | null }

export type RowOutcome = { kind: 'problem'; message: string } | { kind: 'skip'; reason: string } | { kind: 'ready' };
export interface CheckedRow extends PreparedRow { outcome: RowOutcome }

export type PreparedFile = { ok: true; headers: string[]; rows: PreparedRow[] } | { ok: false; error: string };

/** What a check (or an import) reports, normalized across the setup and history actions. */
export interface CheckOutcome { errors: Array<{ row: number; message: string }>; skippedRows: Array<{ row: number; reason: string }> }

export const missingColumnsMessage = (missing: string[]) => `This file is missing required columns: ${missing.join(', ')}.`;
export const NO_ROWS_MESSAGE = 'This file has no rows under the header.';

/** A setup type's row as its action takes it: `{ row, ...fields }` (P11: the server echoes the spreadsheet row). */
export function setupPayloadRow(def: SetupTypeDef, r: PreparedRow): Record<string, unknown> {
  const out: Record<string, unknown> = { row: r.row };
  for (const c of [...def.required, ...def.optional]) out[c.field] = r.data[c.header] ?? '';
  return out;
}

/**
 * A setup file: required columns present and filled, a control character refused (§4.3, the same check as the server),
 * spreadsheet row numbers (P11), and the P13 limits — rows and the payload's size — checked before anything is sent.
 */
export function prepareSetupFile(text: string, def: SetupTypeDef): PreparedFile {
  const required = def.required.map((c) => c.header);
  const parsed = parseCSV(text, required, (data, index) => (hasInvalidCharacter(data) ? [invalidCharacterMessage(spreadsheetRow(index))] : []));
  if (parsed.missingColumns.length > 0) return { ok: false, error: missingColumnsMessage(parsed.missingColumns) };
  if (parsed.rows.length === 0) return { ok: false, error: NO_ROWS_MESSAGE };
  const limit = IMPORT_ROW_LIMIT[def.key];
  if (parsed.rows.length > limit) return { ok: false, error: tooManyRowsMessage(parsed.rows.length, limit) };
  const rows: PreparedRow[] = parsed.rows.map((r, index) => ({
    row: spreadsheetRow(index),
    data: r.data,
    clientError: r.errors.length > 0 ? r.errors.join('; ') : null,
  }));
  const payload = rows.filter((r) => r.clientError === null).map((r) => setupPayloadRow(def, r));
  if (serializedBytes(payload) > IMPORT_MAX_BYTES) return { ok: false, error: TOO_BIG_MESSAGE };
  return { ok: true, headers: parsed.headers, rows };
}

/**
 * An Hours or Timesheet status file (§4.4): the columns must be in the header (blank cells are allowed), and EVERY row
 * is kept and sent, so runMigrationBatches' file-row numbers (row 1 = the first data row, batch-runner.ts) stay right.
 */
export function prepareHistoryFile(text: string, def: HistoryTypeDef): PreparedFile {
  const parsed = parseCSV(text, [], undefined, { headerColumns: def.headerColumns });
  if (parsed.missingColumns.length > 0) return { ok: false, error: missingColumnsMessage(parsed.missingColumns) };
  if (parsed.rows.length === 0) return { ok: false, error: NO_ROWS_MESSAGE };
  return { ok: true, headers: parsed.headers, rows: parsed.rows.map((r, i) => ({ row: i + 1, data: r.data, clientError: null })) };
}

export function hoursPayloadRow(d: Record<string, string>): MigrationEntryRow {
  return {
    employeeEmail: d['Employee Email'] ?? '', entryDate: d['Entry Date'] ?? '', contractNumber: d['Contract Number'] ?? '',
    clinNumber: d['CLIN Number'] ?? '', indirectCode: d['Indirect Code'] ?? '', hours: d['Hours'] ?? '', changeReason: d['Change Reason'] ?? '',
    comment: d['Comment'] ?? '', createdAt: d['Created At'] ?? '', enteredBy: d['Entered By'] ?? '',
  };
}

export function statusPayloadRow(d: Record<string, string>): MigrationPeriodRow {
  return {
    employeeEmail: d['Employee Email'] ?? '', periodStart: d['Period Start'] ?? '', status: d['Status'] ?? '',
    submittedAt: d['Submitted At'] ?? '', reviewedAt: d['Reviewed At'] ?? '', reviewedByEmail: d['Reviewed By Email'] ?? '',
    reviewComment: d['Review Comment'] ?? '',
  };
}

/** Each row's outcome: a browser problem, else the check's error, else its skip, else ready. */
export function mergeCheck(rows: PreparedRow[], check: CheckOutcome): CheckedRow[] {
  const errors = new Map<number, string[]>();
  for (const e of check.errors) errors.set(e.row, [...(errors.get(e.row) ?? []), e.message]);
  const skips = new Map(check.skippedRows.map((s) => [s.row, s.reason]));
  return rows.map((r) => {
    if (r.clientError !== null) return { ...r, outcome: { kind: 'problem', message: r.clientError } };
    const message = errors.get(r.row);
    if (message) return { ...r, outcome: { kind: 'problem', message: message.join('; ') } };
    const reason = skips.get(r.row);
    if (reason !== undefined) return { ...r, outcome: { kind: 'skip', reason } };
    return { ...r, outcome: { kind: 'ready' } };
  });
}

export function counts(rows: CheckedRow[]) {
  let ready = 0, problems = 0, skipped = 0;
  for (const r of rows) {
    if (r.outcome.kind === 'ready') ready++;
    else if (r.outcome.kind === 'problem') problems++;
    else skipped++;
  }
  return { ready, problems, skipped };
}

const rowsPhrase = (n: number) => `${formatCount(n)} ${n === 1 ? 'row' : 'rows'}`;

/** The check's summary line (§4.2); `warn` when some rows have problems. */
export function checkSummary(rows: CheckedRow[]): { text: string; warn: boolean } {
  const { ready, problems, skipped } = counts(rows);
  const skip = skipped > 0 ? ` ${rowsPhrase(skipped)} will be skipped because ${skipped === 1 ? 'it already exists' : 'they already exist'}.` : '';
  if (problems === 0) {
    return { text: skipped === 0 ? `All ${rowsPhrase(ready)} ${ready === 1 ? 'is' : 'are'} ready.` : `${rowsPhrase(ready)} ${ready === 1 ? 'is' : 'are'} ready.${skip}`, warn: false };
  }
  return {
    text: `${rowsPhrase(ready)} ${ready === 1 ? 'is' : 'are'} ready. ${rowsPhrase(problems)} ${problems === 1 ? 'has' : 'have'} problems and won't be imported unless you fix them in the file and choose it again.${skip}`,
    warn: true,
  };
}

/** How many ready rows the table shows before "Show all". */
export const READY_ROWS_SHOWN = 50;

/** The check table's order: problems, then skips, then ready rows (the first 50 unless `showAll`). */
export function tableRows(rows: CheckedRow[], showAll: boolean): { visible: CheckedRow[]; hiddenReady: number } {
  const byRow = (a: CheckedRow, b: CheckedRow) => a.row - b.row;
  const problems = rows.filter((r) => r.outcome.kind === 'problem').sort(byRow);
  const skips = rows.filter((r) => r.outcome.kind === 'skip').sort(byRow);
  const ready = rows.filter((r) => r.outcome.kind === 'ready').sort(byRow);
  const shown = showAll ? ready : ready.slice(0, READY_ROWS_SHOWN);
  return { visible: [...problems, ...skips, ...shown], hiddenReady: ready.length - shown.length };
}

/**
 * "Download rows with problems" (§4.2): the original columns plus "Problem", through the shared CSV writer (RFC 4180
 * quoting and the formula guard — a cell starting with = + - @ is never evaluated by a spreadsheet).
 */
export function problemsCsv(rows: CheckedRow[], headers: string[]): string {
  const problems = rows.filter((r) => r.outcome.kind === 'problem');
  const data = problems.map((r) => ({ ...r.data, Problem: r.outcome.kind === 'problem' ? r.outcome.message : '' }));
  const columns = [...headers.filter((h) => h !== 'Problem'), 'Problem'].map((h) => ({ key: h, header: h }));
  return generateCsv(data as Array<Record<string, string>>, columns);
}

export const doneSummary = (r: { created: number; skipped: number; errors: unknown[] }) =>
  `${formatCount(r.created)} imported · ${formatCount(r.skipped)} skipped · ${formatCount(r.errors.length)} ${r.errors.length === 1 ? 'problem' : 'problems'}`;

export const NOTHING_TO_IMPORT = 'Nothing to import. Fix the rows with problems first.';
