import { describe, it, expect } from 'vitest';
import { EXPORT_TABLES } from '@/lib/export/allowlists';

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

  it('every allowlisted column key exists on its underlying table', () => {
    for (const table of EXPORT_TABLES) {
      const realColumnKeys = new Set(Object.keys(table.table));
      for (const col of table.columns) {
        expect(realColumnKeys.has(col.key), `${table.file}.${col.key} is not a real column`).toBe(true);
      }
    }
  });

  it('has no duplicate CSV filenames', () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every table includes an id column (required for keyset pagination)', () => {
    for (const table of EXPORT_TABLES) {
      expect(table.columns.some((c) => c.key === 'id'), `${table.file} has no id column`).toBe(true);
    }
  });
});
