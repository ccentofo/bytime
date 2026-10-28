import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgDialect, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';
import { EXPORT_TABLES } from '@/lib/export/allowlists';
import { TIMESHEET_COLUMNS } from '@/lib/export/manifest';

/**
 * T6/R8: the export is an explicit column ALLOWLIST, never a denylist, so a future secret column
 * is excluded by default. These checks don't need a database — they verify the allowlist itself
 * never names a forbidden column, every entry corresponds to a column that actually exists, and
 * the whole security-record tables (D12) never sneak in.
 */

const FORBIDDEN_COLUMN_HEADERS = [
  'password_hash',
  'totp_secret',
  'totp_recovery_codes',
  'totp_last_used_step',
  'session_version',
  'key_hash',
  'token_hash',
  'access_token_encrypted',
  'refresh_token_encrypted',
];

const NEVER_EXPORTED_TABLE_FILES = [
  'api_keys',
  'login_attempts',
  'password_reset_tokens',
  'integration_connections',
];

describe('EXPORT_TABLES allowlist', () => {
  it('includes at least the §1/D12 baseline tables', () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  it('never includes a forbidden secret column, by header name', () => {
    for (const table of EXPORT_TABLES) {
      for (const col of table.columns) {
        expect(FORBIDDEN_COLUMN_HEADERS, `${table.file}.${col.header}`).not.toContain(col.header);
      }
    }
  });

  it('never exports api_keys, login_attempts, password_reset_tokens, or integration_connections', () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    for (const forbidden of NEVER_EXPORTED_TABLE_FILES) {
      expect(files).not.toContain(forbidden);
    }
  });

  it('every allowlisted column key exists on its underlying table (derived columns are computed, never stored)', () => {
    for (const table of EXPORT_TABLES) {
      const realColumnKeys = new Set(Object.keys(table.table));
      for (const col of table.columns) {
        if (col.expr) {
          expect(realColumnKeys.has(col.key), `${table.file}.${col.key} is derived but shadows a real column`).toBe(false);
          continue;
        }
        expect(realColumnKeys.has(col.key), `${table.file}.${col.key} is not a real column`).toBe(true);
      }
    }
  });

  it('has no duplicate CSV filenames', () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every column has a README description (data dictionary, §5.2)', () => {
    for (const table of EXPORT_TABLES) {
      for (const col of table.columns) {
        expect(col.description.trim().length, `${table.file}.${col.header} has no description`).toBeGreaterThan(0);
      }
    }
  });

  it('exports workspace_settings (the timezone the calendar dates are in)', () => {
    expect(EXPORT_TABLES.map((t) => t.file)).toContain('workspace_settings');
  });

  it('every table includes an id column (required for keyset pagination)', () => {
    for (const table of EXPORT_TABLES) {
      expect(table.columns.some((c) => c.key === 'id'), `${table.file} has no id column`).toBe(true);
    }
  });
});

/**
 * feature-plan-certified-outputs.md C8: every table in the tenant schema is either exported or deliberately never
 * exported — a new table can't silently miss the workspace export.
 */
const NEVER_EXPORTED_TABLES: Record<string, string> = {
  api_keys: 'security record (key hashes), not Customer Data (T6 D12)',
  login_attempts: 'security record, not Customer Data (T6 D12)',
  password_reset_tokens: 'security record (token hashes), not Customer Data (T6 D12)',
  integration_connections: 'holds encrypted OAuth credentials',
};
/** Exported outside EXPORT_TABLES (workspace-export.ts timesheetSource: raw + current files). */
const EXPORTED_SEPARATELY = ['timesheet_entries'];

describe('every tenant table is exported or on the never-exported list (certified-outputs C8)', () => {
  const tenantTables = Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t as PgTable)).sort();
  const exported = new Set([...EXPORT_TABLES.map((t) => getTableName(t.table)), ...EXPORTED_SEPARATELY]);

  it('no table is unaccounted for, and none is both exported and never-exported', () => {
    expect(tenantTables.filter((t) => !exported.has(t) && !(t in NEVER_EXPORTED_TABLES))).toEqual([]);
    expect(Object.keys(NEVER_EXPORTED_TABLES).filter((t) => exported.has(t))).toEqual([]);
    expect(Object.keys(NEVER_EXPORTED_TABLES).filter((t) => !tenantTables.includes(t))).toEqual([]); // no stale entries
  });

  it('the certified-outputs tables are exported as their own files', () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(files).toContain('import_batches');
    expect(files).toContain('admin_change_log');
  });

  it('the new columns are exported, each with a description', () => {
    const headers = (file: string) => EXPORT_TABLES.find((t) => t.file === file)!.columns.map((c) => c.header);
    expect(headers('users')).toContain('approver_id');
    expect(headers('indirect_charge_codes')).toContain('leave_pay_type');
    expect(headers('timesheet_periods')).toEqual(expect.arrayContaining(['submission_count', 'self_approved']));
    expect(headers('workspace_settings')).toEqual(expect.arrayContaining(['history_import_closed_at', 'workweek_start_day']));
    expect(headers('period_events')).toEqual(expect.arrayContaining(['source', 'import_batch_id', 'original_metadata', 'approval_context', 'self_approved']));
    expect(EXPORT_TABLES.find((t) => t.file === 'period_events')!.columns.find((c) => c.header === 'actor_id')!.description)
      .toMatch(/imported rows .* admin who ran the import/);
  });

  it('A-T3 (UX-3 A4.1): timesheet notes are exported with every column, each described', () => {
    const notes = EXPORT_TABLES.find((t) => t.file === 'timesheet_notes');
    expect(notes, 'timesheet_notes is exported').toBeDefined();
    const columns = Object.values(getTableColumns(schema.timesheetNotes)).map((c) => c.name).sort();
    expect(notes!.columns.map((c) => c.header).sort()).toEqual(columns);
    for (const c of notes!.columns) expect(c.description, c.header).not.toBe('');
  });

  it('timesheet entries carry provenance (source, batch, original metadata) and the derived label, in column order', () => {
    expect(TIMESHEET_COLUMNS.slice(-4).map((c) => c.header)).toEqual(['source', 'import_batch_id', 'original_metadata', 'provenance']);
    const src = readFileSync(path.resolve(__dirname, '../../lib/export/workspace-export.ts'), 'utf8');
    const out = src.slice(src.indexOf('const out: Array<(row: Row) => unknown> = ['), src.indexOf('];', src.indexOf('const out: Array<(row: Row) => unknown> = [')));
    expect(out.match(/\(r\) =>/g)).toHaveLength(TIMESHEET_COLUMNS.length);
    expect(out).toMatch(/\(r\) => r\.source, \(r\) => r\.importBatchId, \(r\) => r\.originalMetadata,\s*\(r\) => provenanceText\(/);
  });

  it('self_approved mirrors approvalLabel: latest approved event (else reviewed_by) is the employee, never an imported approval', () => {
    const render = (file: string) => new PgDialect().sqlToQuery(EXPORT_TABLES.find((t) => t.file === file)!.columns.find((c) => c.header === 'self_approved')!.expr!).sql.replace(/\s+/g, ' ');
    const period = render('timesheet_periods');
    expect(period).toContain(`"timesheet_periods"."status" = 'approved'`);
    // UX-3 fix round 2 (M4): the outer column is written literally — the export's single-table select renders an
    // interpolated column unqualified ("id"), which binds to pe.id. (This dialect render qualifies it, which hid the bug.)
    expect(period).toContain(`COALESCE((SELECT pe.source FROM period_events pe WHERE pe.period_id = timesheet_periods.id AND pe.event = 'approved' ORDER BY pe.created_at DESC LIMIT 1), 'app') <> 'migration'`);
    expect(period).toContain(`COALESCE((SELECT pe.actor_id FROM period_events pe WHERE pe.period_id = timesheet_periods.id AND pe.event = 'approved' ORDER BY pe.created_at DESC LIMIT 1), "timesheet_periods"."reviewed_by") = "timesheet_periods"."user_id"`);
    expect(period).not.toMatch(/pe\.period_id = "timesheet_periods"\."id"/);
    const event = render('period_events');
    expect(event).toContain(`"period_events"."event" = 'approved' AND "period_events"."source" <> 'migration' AND "period_events"."actor_id" = "period_events"."user_id"`);
  });
});
