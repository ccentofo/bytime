import { UserFacingError } from '@/lib/errors';

/**
 * The setup imports' shared rules (feature-plan-ux-setup-import.md P11–P13, §4.3), used by the browser AND the server.
 * Client-safe.
 */

export type SetupImportType = 'people' | 'contracts' | 'clins' | 'laborCategories' | 'chargeCodes' | 'chargeCodeAccess' | 'approvalScope';

/** P13: rows per file (approval scope as feature-plan-approval-scope.md §4.2). */
export const IMPORT_ROW_LIMIT: Record<SetupImportType, number> = {
  people: 1000, contracts: 1000, clins: 1000, laborCategories: 1000, chargeCodes: 1000, chargeCodeAccess: 1000, approvalScope: 500,
};

/** P13: the payload's serialized size (serializedBytes), under Next's 1 MB server-action default. */
export const IMPORT_MAX_BYTES = 800_000;

export const tooManyRowsMessage = (n: number, limit: number) => `This file has ${n} rows. Split it into files of ${limit} rows or fewer.`;
export const TOO_BIG_MESSAGE = 'This file is too large to send in one go. Split it into smaller files.';

/** P11: a parsed record's spreadsheet row (header = row 1; papaparse skips blank lines, so they aren't counted). */
export const spreadsheetRow = (recordIndex: number) => recordIndex + 2;

/** The row number the server reports: the one the browser sent, else the array position as a spreadsheet row. */
export function rowNumberOf(row: { row?: unknown } | null | undefined, index: number): number {
  const n = row?.row;
  return typeof n === 'number' && Number.isInteger(n) && n >= 2 ? n : spreadsheetRow(index);
}

/** §4.3: a control character in any cell (NUL included) — Postgres would refuse it, so the row is refused first. */
const INVALID_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export function hasInvalidCharacter(row: object): boolean {
  return Object.entries(row).some(([k, v]) => k !== 'row' && typeof v === 'string' && INVALID_CHAR.test(v));
}
export const invalidCharacterMessage = (row: number) => `Row ${row} contains an invalid character.`;

/**
 * §4.3 strict numbers: the shared validators use parseFloat, which reads "12,500,000" as 12. Money is up to 9 digits
 * with ≤ 2 decimals; a rate up to 4 digits with ≤ 2 decimals. Blank → null (the column is optional) unless `required`.
 */
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const RATE = /^\d{1,4}(\.\d{1,2})?$/;
/** A UserFacingError, so a row reports its message verbatim. */
export class PlainNumberError extends UserFacingError {}
function strictNumber(value: unknown, column: string, pattern: RegExp, example: string, required: boolean): string | null {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (text === '') {
    if (required) throw new PlainNumberError(`${column} is required.`);
    return null;
  }
  if (!pattern.test(text)) throw new PlainNumberError(`${column} must be a plain number (for example ${example}).`);
  return text;
}
export const strictMoney = (value: unknown, column: string) => strictNumber(value, column, MONEY, '1250000.00', false);
export const strictRate = (value: unknown, column: string, required = false) => strictNumber(value, column, RATE, '145.00', required);

export const SKIP_REASON = {
  user: 'Already a user',
  contract: 'Contract already exists',
  clin: 'CLIN already exists on this contract',
  laborCategory: 'Labor category already exists on this CLIN',
  chargeCode: 'Code already exists',
  access: 'Already has access to this code',
  scope: 'Already approves this CLIN',
} as const;
