import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Certified outputs fix round 2 (CERTIFIED-OUTPUTS-AUDIT.md §6): R1 generated passwords never start with a formula
 * trigger (the CSV cell equals the password); R4 sync triggers validate user dates with a user-facing error; R5 import
 * hours are plain decimals only. R2 is in approval-decisions.test.ts, R3 in audit-trail.test.ts.
 */

vi.mock('server-only', () => ({}));
const sync = vi.hoisted(() => ({ execute: vi.fn(async () => ({ syncLogId: 'l', result: { pushed: 0, failed: 0, skipped: 0, errors: [] } })) }));
vi.mock('@/lib/integrations/sync-engine', () => ({ executeSyncOperation: sync.execute }));
vi.mock('@/lib/session', () => {
  const admin = async () => ({ id: 'adm', email: 'a@x', fullName: 'A', role: 'admin' });
  return { requireAdmin: admin, requireAdminFresh: admin, AuthorizationError: class extends Error {} };
});
vi.mock('@/db', () => ({ getDb: async () => ({}), getDbForWrite: async () => ({}) }));
vi.mock('@/server/internal/workspace-settings', () => ({ getDefaultSyncWindow: async () => ({ periodStart: '2026-08-01', periodEnd: '2026-10-31' }) }));

import { generateImportPassword } from '@/server/internal/generated-password';
import { FORMULA_PATTERN } from '@/lib/csv/escape';
import { generateCsv } from '@/lib/reports/csv-generator';
import { parseImportHours } from '@/lib/migration/import-plan';
import { triggerGustoSync } from '@/server/actions/gusto';
import { triggerQBOSync } from '@/server/actions/qbo';

beforeEach(() => sync.execute.mockClear());

describe('R1 — generated passwords are CSV-safe', () => {
  it('10,000 generated passwords never match FORMULA_PATTERN, and the CSV cell equals the password exactly', () => {
    for (let i = 0; i < 10_000; i++) {
      const pw = generateImportPassword();
      expect(pw).toHaveLength(12);
      expect(FORMULA_PATTERN.test(pw), pw).toBe(false);
      const [, cells] = generateCsv([{ email: 'e@x', password: pw }], [{ key: 'email', header: 'Email' }, { key: 'password', header: 'Password' }]).split('\n');
      expect(cells, pw).toBe(`e@x,${pw}`);
    }
  });

  it('bulk import uses it (the old generator, which could start with @, is gone)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../../server/actions/import.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/generateImportPassword\(\)/);
    expect(src).not.toMatch(/function generateRandomPassword/);
  });
});

describe('R4 — sync triggers validate user dates', () => {
  it('Gusto and QBO: an invalid date is a validation result (never a thrown plain Error); valid dates reach the sync', async () => {
    expect(await triggerGustoSync({ connectionId: 'c', periodStart: 'nope' as never, periodEnd: '2026-10-15' as never }))
      .toEqual({ ok: false, code: 'validation', error: 'Start date must be a valid date (YYYY-MM-DD).' });
    expect(await triggerQBOSync({ connectionId: 'c', periodStart: '2026-10-01' as never, periodEnd: '2026-02-30' as never }))
      .toEqual({ ok: false, code: 'validation', error: 'End date must be a valid date (YYYY-MM-DD).' });
    expect(sync.execute).not.toHaveBeenCalled();
    expect((await triggerGustoSync({ connectionId: 'c', periodStart: '2026-10-01' as never, periodEnd: '2026-10-15' as never })).ok).toBe(true);
    expect(sync.execute).toHaveBeenCalledWith('c', 'timesheet_push', '2026-10-01', '2026-10-15', 'adm', 'manual');
  });
});

describe('R5 — import hours are plain decimals', () => {
  it('"0x8", "1e1", "+8", ".5", "8." and "Infinity" are refused; "8", "7.5", " 10.25 " accepted', () => {
    for (const bad of ['0x8', '1e1', '+8', '.5', '8.', 'Infinity', '0b1', '8 h']) expect(parseImportHours(bad), bad).toBeNull();
    expect(parseImportHours('8')).toBe(8);
    expect(parseImportHours('7.5')).toBe(7.5);
    expect(parseImportHours(' 10.25 ')).toBe(10.25);
  });
});
