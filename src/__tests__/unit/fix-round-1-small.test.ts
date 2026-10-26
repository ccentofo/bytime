import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Certified outputs fix round 1 — the small pure items: F3 (import hours never truncated), F13 (passwords CSV through
 * the shared writer), F14 (UTF-8 batch sizing, coerced import fields, `tenant:admin show` closed rule), F16 (control
 * plane behind its journal → one clear message). F7's SQL grouping is checked statically here and on Postgres in
 * integration/grid-corrections.test.ts.
 */

vi.mock('server-only', () => ({}));

import { coerceImportRow, IMPORT_HOURS_ERROR, parseImportHours, serializedBytes, splitMigrationBatches, MIGRATION_BATCH_MAX_BYTES } from '@/lib/migration/import-plan';
import { describeImportWindowState } from '../../../scripts/lib/import-window-state';
import { controlPlaneBehindMessage, controlPlaneJournalWhens, controlPlaneMigrationGap } from '../helpers/control-plane-migrations';

const ROOT = path.resolve(__dirname, '../../..');

describe('F3 — import hours', () => {
  it('"7,5", "8h", "", "abc", "25", "-1" are invalid; "7.5" → 7.5; " 8 " → 8; 7.555 → 7.56 (2 decimals)', () => {
    for (const bad of ['7,5', '8h', '', '   ', 'abc', '25', '-1', 'NaN', 'Infinity', null, undefined]) {
      expect(parseImportHours(bad), String(bad)).toBeNull();
    }
    expect(parseImportHours('7.5')).toBe(7.5);
    expect(parseImportHours(' 8 ')).toBe(8);
    expect(parseImportHours(7.555)).toBe(7.56);
    expect(parseImportHours('0')).toBe(0);
    expect(IMPORT_HOURS_ERROR).toMatch(/between 0 and 24/);
  });

  it('the validator and the import both use it (no parseFloat on hours)', () => {
    const internal = readFileSync(path.join(ROOT, 'src/server/internal/migration.ts'), 'utf8');
    const action = readFileSync(path.join(ROOT, 'src/server/actions/migration.ts'), 'utf8');
    expect(internal).toMatch(/if \(parseImportHours\(row\.hours\) === null\) errors\.push\(IMPORT_HOURS_ERROR\);/);
    expect(action).toMatch(/hours: parseImportHours\(v\.data\.hours\)!/);
    expect(internal + action).not.toMatch(/parseFloat\([^)]*hours/);
  });
});

describe('F14 — import batches and the window line', () => {
  it('batch size counts UTF-8 bytes, not UTF-16 characters', () => {
    expect(serializedBytes('é')).toBe(4);       // "\\"é\\"" → 1 + 2 + 1
    expect(serializedBytes('€')).toBe(5);
    // 700 rows of ~1,200 bytes (600 × "é") must split even though they are only ~600 characters each.
    const rows = Array.from({ length: 700 }, (_, i) => ({ employeeEmail: `e${i % 5}@x`, comment: 'é'.repeat(600) }));
    const batches = splitMigrationBatches(rows, (r) => r.employeeEmail);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(serializedBytes(b)).toBeLessThanOrEqual(MIGRATION_BATCH_MAX_BYTES);
  });

  it('validators coerce every field with String(x ?? "") (spreadsheet numbers / nulls never crash .trim())', () => {
    expect(coerceImportRow({ hours: 7.5, employeeEmail: null, entryDate: undefined, x: 0 } as never)).toEqual({ hours: '7.5', employeeEmail: '', entryDate: '', x: '0' });
    const internal = readFileSync(path.join(ROOT, 'src/server/internal/migration.ts'), 'utf8');
    expect(internal.match(/const row = coerceImportRow\(raw\);/g)).toHaveLength(2);
  });

  it('`tenant:admin show` says closed when an app submission exists, even if the column was never written', () => {
    expect(describeImportWindowState({ settingsRowExists: true, closedAt: null, hasAppSubmittedEvent: true })).toMatch(/^closed/);
    expect(describeImportWindowState({ settingsRowExists: true, closedAt: null, hasAppSubmittedEvent: false })).toMatch(/^open/);
    expect(describeImportWindowState({ settingsRowExists: true, closedAt: new Date('2026-01-02T00:00:00Z'), hasAppSubmittedEvent: false })).toMatch(/^closed 2026-01-02/);
    expect(describeImportWindowState({ settingsRowExists: false, closedAt: null, hasAppSubmittedEvent: false })).toMatch(/CLOSED/);
    expect(readFileSync(path.join(ROOT, 'scripts/tenant-admin.ts'), 'utf8')).toMatch(/hasAppSubmittedEvent: !!submitted/);
  });
});

describe('F13 — generated passwords CSV', () => {
  it('uses the shared CSV writer (formula guard + quoting), never a hand-built join', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/import/ImportClient.tsx'), 'utf8');
    expect(src).toMatch(/generateCsv\(importResult\.generatedPasswords, \[\{ key: 'email', header: 'Email' \}, \{ key: 'password', header: 'Password' \}\]\)/);
    expect(src).not.toMatch(/'Email,Password\\n'/);
  });
});

describe('F16 — control plane behind its journal', () => {
  it('counts journal entries at or before the last applied migration; message names the fix', () => {
    expect(controlPlaneMigrationGap([10, 20, 30], 30)).toEqual({ applied: 3, total: 3, behind: false });
    expect(controlPlaneMigrationGap([10, 20, 30], 20)).toEqual({ applied: 2, total: 3, behind: true });
    expect(controlPlaneMigrationGap([10, 20, 30], null)).toEqual({ applied: 0, total: 3, behind: true });
    expect(controlPlaneBehindMessage({ applied: 8, total: 10 })).toBe('Control-plane database is behind (8 of 10 migrations) — run `npm run db:migrate:cp` with CONTROL_PLANE_DATABASE_URL set.');
    expect(controlPlaneJournalWhens(ROOT).length).toBeGreaterThanOrEqual(10);
  });

  it('the integration setup runs the check when CONTROL_PLANE_DATABASE_URL is set', () => {
    const setup = readFileSync(path.join(ROOT, 'src/__tests__/integration/setup-db.ts'), 'utf8');
    expect(setup).toMatch(/if \(gap\.behind\) throw new Error\(controlPlaneBehindMessage\(gap\)\);/);
  });
});

describe('F7 — revision map uses the COALESCE cell identity (static; Postgres case in grid-corrections)', () => {
  it('groups by COALESCE(charge, indirect, clin) + entry_date and keys the map by it', () => {
    const ts = readFileSync(path.join(ROOT, 'src/server/actions/timesheet.ts'), 'utf8');
    const fn = ts.slice(ts.indexOf('async function revisionMapFor'), ts.indexOf('type CellRef'));
    expect(fn).toMatch(/const cellId = sql<string>`COALESCE\(\$\{timesheetEntries\.chargeCodeId\}, \$\{timesheetEntries\.indirectCodeId\}, \$\{timesheetEntries\.clinId\}\)`;/);
    expect(fn).toMatch(/\.groupBy\(cellId, timesheetEntries\.entryDate\)/);
    expect(fn).toMatch(/revisionMap\[`\$\{row\.cellId\}-\$\{dayIndex\}`\]/);
  });
});
