import { addDays, isAfter, isBefore, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';

/**
 * Migration-import planning (feature-plan-certified-outputs.md C1, CO-D1). Pure: the server action reads the facts
 * under the import-window and per-employee locks, then these functions decide, row by row, what is inserted. Also
 * used by the client to split a file into batches the server accepts.
 */

/** Server-enforced batch limits (§4 C1 "Batch limits", §7). The client splits files to stay within them. */
export const MIGRATION_BATCH_MAX_ROWS = 2000;
export const MIGRATION_BATCH_MAX_EMPLOYEES = 200;
/** Serialized-size target per batch: under Next's 1 MB server-action body limit with headroom. */
export const MIGRATION_BATCH_MAX_BYTES = 800_000;
/** Rows per INSERT statement (Postgres allows 65,535 bind parameters per statement). */
export const MIGRATION_INSERT_CHUNK = 1000;

export const IMPORT_WINDOW_CLOSED_MESSAGE =
  'Timesheet history can only be imported before your first submitted timesheet. Contact support if you need to import a missed period.';

/** Refuse a batch over the server limits (a validation error the admin sees). */
export function assertMigrationBatchWithinLimits<T>(rows: T[], employeeOf: (row: T) => string): void {
  if (rows.length > MIGRATION_BATCH_MAX_ROWS) {
    throw new UserFacingError(`A batch can have at most ${MIGRATION_BATCH_MAX_ROWS} rows (this one has ${rows.length}). Split the file into smaller batches.`);
  }
  const employees = new Set(rows.map((r) => employeeOf(r).trim().toLowerCase()));
  if (employees.size > MIGRATION_BATCH_MAX_EMPLOYEES) {
    throw new UserFacingError(`A batch can cover at most ${MIGRATION_BATCH_MAX_EMPLOYEES} employees (this one has ${employees.size}). Split the file into smaller batches.`);
  }
}

/**
 * Split rows into batches of ≤ MIGRATION_BATCH_MAX_ROWS rows, ≤ MIGRATION_BATCH_MAX_EMPLOYEES distinct employees and
 * ≤ MIGRATION_BATCH_MAX_BYTES serialized, preserving file order. Used for both validation and import.
 */
export function splitMigrationBatches<T>(rows: T[], employeeOf: (row: T) => string): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let employees = new Set<string>();
  let bytes = 2; // the enclosing [ ]
  for (const row of rows) {
    const employee = employeeOf(row).trim().toLowerCase();
    const size = JSON.stringify(row).length + 1;
    const overRows = current.length + 1 > MIGRATION_BATCH_MAX_ROWS;
    const overEmployees = !employees.has(employee) && employees.size + 1 > MIGRATION_BATCH_MAX_EMPLOYEES;
    const overBytes = bytes + size > MIGRATION_BATCH_MAX_BYTES;
    if (current.length > 0 && (overRows || overEmployees || overBytes)) {
      batches.push(current);
      current = [];
      employees = new Set();
      bytes = 2;
    }
    current.push(row);
    employees.add(employee);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface LockedPeriod {
  userId: string;
  start: CalendarDate;
  end: CalendarDate; // inclusive
  status: string;
}

export interface ExistingCell {
  userId: string;
  clinId: string | null;
  indirectCodeId: string | null;
  entryDate: CalendarDate;
}

export interface EntryCandidate {
  rowIndex: number;
  userId: string;
  clinId: string | null;
  indirectCodeId: string | null;
  entryDate: CalendarDate;
  hours: number;
}

export interface RowError {
  row: number;
  message: string;
}

/**
 * Decide which validated entry rows are inserted (§4 C1 "Per row"). In order, a row is refused when:
 *  - its date is not before the workspace's today;
 *  - it falls inside ANY submitted or approved period of that employee, whatever its source (an imported approval must
 *    never cover hours added after it; a submitted period is in an approval queue);
 *  - the employee already has an entry that day for the same CLIN (app charge-code rows carry clin_id) or the same
 *    indirect code (overlap guard — also covers an existing cell);
 *  - an earlier file row has the same (employee, cell code, date) (in-file duplicate).
 */
export function planEntryImport(
  candidates: EntryCandidate[],
  facts: { today: CalendarDate; existing: ExistingCell[]; locked: LockedPeriod[] },
): { accepted: EntryCandidate[]; errors: RowError[] } {
  const existing = new Set<string>();
  for (const c of facts.existing) {
    if (c.clinId) existing.add(`${c.userId}|clin:${c.clinId}|${c.entryDate}`);
    if (c.indirectCodeId) existing.add(`${c.userId}|ind:${c.indirectCodeId}|${c.entryDate}`);
  }
  const lockedByUser = new Map<string, LockedPeriod[]>();
  for (const p of facts.locked) lockedByUser.set(p.userId, [...(lockedByUser.get(p.userId) ?? []), p]);

  const firstRowFor = new Map<string, number>();
  const accepted: EntryCandidate[] = [];
  const errors: RowError[] = [];
  for (const c of candidates) {
    const cell = c.clinId ? `clin:${c.clinId}` : `ind:${c.indirectCodeId}`;
    const key = `${c.userId}|${cell}|${c.entryDate}`;
    const earlier = firstRowFor.get(key);
    if (earlier === undefined) firstRowFor.set(key, c.rowIndex);

    if (!isBefore(c.entryDate, facts.today)) {
      errors.push({ row: c.rowIndex, message: `Entry date ${c.entryDate} must be before today — only past history can be imported.` });
      continue;
    }
    const lock = (lockedByUser.get(c.userId) ?? []).find((p) => !isBefore(c.entryDate, p.start) && !isAfter(c.entryDate, p.end));
    if (lock) {
      errors.push({ row: c.rowIndex, message: `${c.entryDate} is inside ${lock.status === 'approved' ? 'an approved' : 'a submitted'} period (${lock.start} – ${lock.end}). Import entries before importing period statuses.` });
      continue;
    }
    if (existing.has(key)) {
      errors.push({ row: c.rowIndex, message: `This employee already has hours on this ${c.clinId ? 'CLIN' : 'indirect code'} on ${c.entryDate}.` });
      continue;
    }
    if (earlier !== undefined) {
      errors.push({ row: c.rowIndex, message: `Duplicate of row ${earlier} (same employee, code and date).` });
      continue;
    }
    accepted.push(c);
  }
  return { accepted, errors };
}

export type ImportablePeriodStatus = 'submitted' | 'approved' | 'rejected';

export interface PeriodCandidate {
  rowIndex: number;
  userId: string;
  periodStart: CalendarDate;
  numDays: number;
  status: string;
}

export interface ExistingPeriodFact {
  userId: string;
  periodStart: CalendarDate;
  /** Imported = at least one period_events row with source 'migration' and none app-sourced. */
  imported: boolean;
}

/**
 * Decide which validated period rows are inserted (§4 C1 "Periods import"). A row is:
 *  - an error when its status is not submitted/approved/rejected (a draft has nothing to certify);
 *  - an error when its end date (start + numDays − 1) is not before today (an imported current/future period would lock
 *    the employee's live timesheet forever — approved is terminal);
 *  - an error when an earlier file row has the same employee and period;
 *  - SKIPPED (a duplicate, not counted as imported) when that period was already imported;
 *  - an error when the employee already has a non-imported period row there, or app-recorded entries in that period.
 */
export function planPeriodImport(
  candidates: PeriodCandidate[],
  facts: { today: CalendarDate; existing: ExistingPeriodFact[]; appEntryDays: Array<{ userId: string; entryDate: CalendarDate }> },
): { accepted: Array<PeriodCandidate & { status: ImportablePeriodStatus }>; skipped: number[]; errors: RowError[] } {
  const existing = new Map(facts.existing.map((p) => [`${p.userId}|${p.periodStart}`, p]));
  const appDays = new Map<string, CalendarDate[]>();
  for (const d of facts.appEntryDays) appDays.set(d.userId, [...(appDays.get(d.userId) ?? []), d.entryDate]);

  const firstRowFor = new Map<string, number>();
  const accepted: Array<PeriodCandidate & { status: ImportablePeriodStatus }> = [];
  const skipped: number[] = [];
  const errors: RowError[] = [];
  for (const c of candidates) {
    const key = `${c.userId}|${c.periodStart}`;
    const earlier = firstRowFor.get(key);
    if (earlier === undefined) firstRowFor.set(key, c.rowIndex);
    const status = c.status.trim().toLowerCase();
    const end = addDays(c.periodStart, c.numDays - 1);

    if (status !== 'submitted' && status !== 'approved' && status !== 'rejected') {
      errors.push({
        row: c.rowIndex,
        message: status === 'draft'
          ? 'Draft periods are not imported — there is nothing to certify. Only submitted, approved or rejected periods can be imported.'
          : `Status "${c.status}" is not importable. Use submitted, approved or rejected.`,
      });
      continue;
    }
    if (!isBefore(end, facts.today)) {
      errors.push({ row: c.rowIndex, message: `The period ${c.periodStart} – ${end} has not ended yet. Only periods that ended before today can be imported.` });
      continue;
    }
    if (earlier !== undefined) {
      errors.push({ row: c.rowIndex, message: `Duplicate of row ${earlier} (same employee and period).` });
      continue;
    }
    const prior = existing.get(key);
    if (prior?.imported) {
      skipped.push(c.rowIndex);
      continue;
    }
    if (prior) {
      errors.push({ row: c.rowIndex, message: 'This employee already has this period in CadenzPoint — it was not imported, so it is left as it is.' });
      continue;
    }
    const recorded = (appDays.get(c.userId) ?? []).find((d) => !isBefore(d, c.periodStart) && !isAfter(d, end));
    if (recorded) {
      errors.push({ row: c.rowIndex, message: `This employee has hours recorded in CadenzPoint in this period (${recorded}) — an imported status can't certify them.` });
      continue;
    }
    accepted.push({ ...c, status });
  }
  return { accepted, skipped, errors };
}
