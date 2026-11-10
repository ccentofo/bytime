import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseExportedFunctions, stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-setup-import.md §4.3 / P9–P13, the pure parts:
 * - throwIfDryRun / catchDryRun: a check returns the body's value (passwords stripped, both shapes); other errors rethrow;
 * - importRowMessage on a check doesn't report to Sentry;
 * - strict money and rates (P12), the control-character check, the row number (P11), the limits (P13);
 * - static: every setup import action wraps its transaction in catchDryRun( and ends it with throwIfDryRun( (or passes
 *   dryRun to scopeChange), and notifies only when it isn't a check.
 */

const h = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: h.capture }));

import { catchDryRun, throwIfDryRun } from '@/server/internal/import-run';
import { importRowMessage } from '@/server/internal/import-errors';
import {
  IMPORT_ROW_LIMIT, hasInvalidCharacter, invalidCharacterMessage, rowNumberOf, strictMoney, strictRate, tooManyRowsMessage,
} from '@/lib/import/limits';

beforeEach(() => { h.capture.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('the dry-run helpers (P9)', () => {
  it('a real run returns the value; a check rolls back carrying it, and catchDryRun hands it back without passwords', async () => {
    const value = { created: 1, skipped: 0, errors: [], skippedRows: [], generatedPasswords: [{ email: 'a@x', password: 'p' }] };
    expect(throwIfDryRun(false, value)).toBe(value);
    expect(() => throwIfDryRun(true, value)).toThrow();
    expect(await catchDryRun(Promise.resolve().then(() => throwIfDryRun(true, value)))).toEqual({ ...value, generatedPasswords: [] });
    expect(await catchDryRun(Promise.resolve().then(() => throwIfDryRun(true, { result: value, rerouted: [] }))))
      .toEqual({ result: { ...value, generatedPasswords: [] }, rerouted: [] });
    expect(await catchDryRun(Promise.resolve(value))).toBe(value);                      // a real import keeps its passwords
    await expect(catchDryRun(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('importRowMessage: an unexpected error is reported on an import, not on a check', () => {
    expect(importRowMessage(new Error('x'), 'dup', { dryRun: true })).toBe('Could not import this row.');
    expect(h.capture).not.toHaveBeenCalled();
    importRowMessage(new Error('x'), 'dup');
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
});

describe('P11–P13 rules', () => {
  it('strict money and rates: plain numbers only; blank is none unless required', () => {
    expect(strictMoney('1250000.00', 'Funded Value')).toBe('1250000.00');
    expect(strictMoney(' 12 ', 'Funded Value')).toBe('12');
    expect(strictMoney('', 'Funded Value')).toBeNull();
    for (const bad of ['1,000,000', '$100', '1e6', '12.345', '-5', '1234567890']) {
      expect(() => strictMoney(bad, 'Funded Value'), bad).toThrow('Funded Value must be a plain number (for example 1250000.00).');
    }
    expect(strictRate('145', 'Hourly Rate', true)).toBe('145');
    expect(() => strictRate('1,450.00', 'Hourly Rate')).toThrow('Hourly Rate must be a plain number (for example 145.00).');
    expect(() => strictRate('12345', 'Hourly Rate')).toThrow(/plain number/);
    expect(() => strictRate('  ', 'Hourly Rate', true)).toThrow('Hourly Rate is required.');
    expect(strictRate(undefined, 'Ceiling Rate')).toBeNull();
  });

  it('a control character in any cell (not the row number) marks the row; tabs and newlines inside a cell are allowed', () => {
    expect(hasInvalidCharacter({ email: 'a\u0000@x.dev' })).toBe(true);
    expect(hasInvalidCharacter({ name: 'bell\u0007' })).toBe(true);
    expect(hasInvalidCharacter({ name: 'del\u007f' })).toBe(true);
    expect(hasInvalidCharacter({ name: 'tab\there', note: 'line\nbreak', row: 3 })).toBe(false);
    expect(invalidCharacterMessage(4)).toBe('Row 4 contains an invalid character.');
  });

  it('row numbers: the browser\'s spreadsheet row if it sent one, else index + 2; the limits', () => {
    expect(rowNumberOf({ row: 9 }, 0)).toBe(9);
    expect(rowNumberOf({}, 0)).toBe(2);
    expect(rowNumberOf({ row: 'x' }, 3)).toBe(5);
    expect(IMPORT_ROW_LIMIT).toMatchObject({ people: 1000, contracts: 1000, approvalScope: 500 });
    expect(tooManyRowsMessage(1001, 1000)).toBe('This file has 1001 rows. Split it into files of 1000 rows or fewer.');
  });
});

describe('static: every setup import is a dry-runnable transaction', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const fns = parseExportedFunctions(stripComments(readFileSync(path.join(ROOT, 'src/server/actions/import.ts'), 'utf8')));
  const SETUP_IMPORTS = ['bulkImportEmployees', 'bulkImportContracts', 'bulkImportClins', 'bulkImportLaborCategories', 'bulkImportChargeCodes', 'bulkImportChargeCodeAccess', 'bulkImportAssignments'];

  it('each one wraps its transaction in catchDryRun( and ends it with throwIfDryRun( (or scopeChange(…, { dryRun })', () => {
    for (const name of SETUP_IMPORTS) {
      const body = fns.find((f) => f.name === name)?.bodyText ?? '';
      expect(body, name).toMatch(/catchDryRun\((db\.transaction|scopeChange)\(/);
      expect(/throwIfDryRun\(dryRun,/.test(body) || /scopeChange\([\s\S]*\{ dryRun \}\)\)/.test(body), name).toBe(true);
      expect(body, `${name}: requireAdminFresh first`).toMatch(/^\s*\{?\s*return userAction\(async \(\) => \{\s*(const actor = )?await requireAdminFresh\(\);/);
      if (body.includes('notifyReroutedApprovals')) expect(body, name).toMatch(/if \(!dryRun\) await notifyReroutedApprovals\(/);
    }
  });

  it('fixture: a transaction without catchDryRun (every check would become an error) is flagged', () => {
    expect('return db.transaction(async (tx) => { return throwIfDryRun(dryRun, r); });').not.toMatch(/catchDryRun\((db\.transaction|scopeChange)\(/);
  });
});
