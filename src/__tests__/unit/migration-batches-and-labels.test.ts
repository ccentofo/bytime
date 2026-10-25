import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-certified-outputs.md C1 / §9: "Batch limits" (validation of a large file is batched; a partial
 * multi-batch close reports committed batches; the server refuses 2,001 rows / 201 employees), "Window" (reopen without
 * a reason refused, nothing written), "Attribution" (MIGRATION is system-only), "Display" (labels), and the 0014 /
 * control-plane 0009 migrations as shipped.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x.dev', fullName: 'A', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin, requireApprover: admin, requireApproverFresh: admin };
});
const dbCalls = vi.hoisted(() => ({ transactions: 0 }));
vi.mock('@/db', () => {
  const db = { transaction: async () => { dbCalls.transactions++; throw new Error('transaction reached'); }, select: () => { throw new Error('select reached'); } };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

import { runMigrationBatches, toFileRow } from '@/lib/migration/batch-runner';
import { MIGRATION_BATCH_MAX_ROWS } from '@/lib/migration/import-plan';
import { importMigrationData, importMigrationPeriods, validateMigrationData } from '@/server/actions/migration';
import { REASON_CODES, REASON_LABELS, reasonLabel } from '@/lib/reason-codes';
import { provenanceKind, provenanceLines, provenanceText } from '@/lib/provenance';
import type { MigrationEntryRow } from '@/types/migration';

const ROOT = path.resolve(__dirname, '../../..');
const rows = (n: number, employees = 1) => Array.from({ length: n }, (_, i) => ({ employeeEmail: `e${i % employees}@x.dev`, i }));

describe('multi-batch driver', () => {
  it('validation of a large file is batched — every request stays within the server limits (no 1 MB failure)', async () => {
    const sizes: number[] = [];
    const report = await runMigrationBatches(rows(5000, 3), (r) => r.employeeEmail, async (batch) => {
      sizes.push(batch.length);
      return { ok: true as const, data: batch.length };
    });
    expect(sizes).toEqual([2000, 2000, 1000]);
    expect(report).toMatchObject({ stopped: null, totalBatches: 3 });
    expect(report.completed.map((b) => [b.firstRow, b.lastRow])).toEqual([[1, 2000], [2001, 4000], [4001, 5000]]);
    expect(toFileRow(2001, 5)).toBe(2005);
  });

  it('window closes mid-file: committed batches reported, the refused batch and the remaining rows listed', async () => {
    let call = 0;
    const report = await runMigrationBatches(rows(5000), (r) => r.employeeEmail, async () => {
      call++;
      return call === 2
        ? { ok: false as const, code: 'validation' as const, error: 'Timesheet history can only be imported before your first submitted timesheet.' }
        : { ok: true as const, data: 'ok' };
    });
    expect(call).toBe(2); // stops at the refused batch
    expect(report.completed.map((b) => b.index)).toEqual([1]);
    expect(report.stopped).toEqual({ index: 2, firstRow: 2001, lastRow: 4000, message: expect.stringMatching(/only be imported before/), remainingRows: 3000 });
  });
});

describe('server-side batch limits', () => {
  const entry = (i: number, employees = 1): MigrationEntryRow => ({
    employeeEmail: `e${i % employees}@x.dev`, entryDate: '2026-01-05', contractNumber: 'C', clinNumber: '1', indirectCode: '', hours: '8',
    changeReason: '', comment: '', createdAt: '',
  });

  it('2,001 rows or 201 employees → validation error before any database work (import + validate, entries + periods)', async () => {
    const tooMany = Array.from({ length: MIGRATION_BATCH_MAX_ROWS + 1 }, (_, i) => entry(i));
    const tooManyPeople = Array.from({ length: 201 }, (_, i) => entry(i, 201));
    for (const result of [
      await importMigrationData({ rows: tooMany, sourceSystem: 'Legacy' }),
      await importMigrationData({ rows: tooManyPeople, sourceSystem: 'Legacy' }),
      await validateMigrationData(tooMany),
      await importMigrationPeriods({ rows: tooManyPeople.map((r) => ({ employeeEmail: r.employeeEmail, periodStart: '2026-01-01', status: 'approved', submittedAt: '', reviewedAt: '', reviewedByEmail: '', reviewComment: '' })), sourceSystem: 'Legacy' }),
    ]) {
      expect(result).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/A batch can (have|cover) at most/) });
    }
    expect(dbCalls.transactions).toBe(0);
  });

  it('a missing or over-long source system → validation error', async () => {
    expect(await importMigrationData({ rows: [entry(0)], sourceSystem: '  ' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await importMigrationData({ rows: [entry(0)], sourceSystem: 'x'.repeat(101) })).toMatchObject({ ok: false, code: 'validation' });
  });
});

describe('founder escape hatch: reopen-import-window', () => {
  it('a missing / blank reason or bad --days is refused by the planner before any write; a valid one sets the expiry and audits it', async () => {
    const { plans, AdminCommandError, MAX_IMPORT_WINDOW_REOPEN_DAYS } = await import('@/lib/tenant/admin-commands');
    const row = { id: 't1', status: 'active', importWindowUntil: null } as never;
    const now = new Date('2026-10-25T12:00:00Z');
    expect(() => plans.reopenImportWindow(5, '   ')(row, {} as never, now)).toThrow(AdminCommandError);
    for (const days of [0, MAX_IMPORT_WINDOW_REOPEN_DAYS + 1, 1.5, NaN]) {
      expect(() => plans.reopenImportWindow(days, 'missed March payroll')(row, {} as never, now)).toThrow(/--days between 1 and 30/);
    }
    const plan = plans.reopenImportWindow(7, 'missed March payroll')(row, {} as never, now);
    expect(plan.patch).toEqual({ importWindowUntil: new Date('2026-11-01T12:00:00Z') });
    expect(plan.auditKind).toBe('import-window-reopened');
    expect(plan.auditDetail).toContain('reason=missed March payroll');
  });

  it('the script requires --days and --reason (argument validation) before change() runs', () => {
    const script = readFileSync(path.join(ROOT, 'scripts/tenant-admin.ts'), 'utf8');
    const block = script.slice(script.indexOf("case 'reopen-import-window':"), script.indexOf("case 'waitlist':"));
    expect(block).toMatch(/flag\(rest, '--days'\) \?\? fail\(/);
    expect(block).toMatch(/flag\(rest, '--reason'\) \?\? fail\(/);
    expect(block.indexOf("'--reason') ?? fail(")).toBeLessThan(block.indexOf('await change('));
  });
});

describe('labels', () => {
  it('MIGRATION has a label but is NOT a user-pickable reason (saveTimesheetBatch validates against REASON_CODES)', () => {
    expect(REASON_LABELS.MIGRATION).toBe('Imported (migration)');
    expect(REASON_CODES.map((r) => r.value)).not.toContain('MIGRATION');
    expect(reasonLabel('CORRECTION')).toBe('Correction of Error');
    expect(reasonLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });

  it('imported rows: source system, import date, admin; original author or "author not recorded"', () => {
    const base = { source: 'migration', importSourceSystem: 'Deltek', importedAt: new Date('2026-10-20T15:00:00Z'), importedByName: 'Pat Admin' };
    expect(provenanceLines({ ...base, originalMetadata: { enteredBy: 'jo@old.example', enteredAt: '2025-03-02T17:00:00Z' } })).toEqual([
      'Imported from Deltek on 2026-10-20 by Pat Admin',
      'originally entered by jo@old.example on 2025-03-02T17:00:00Z',
    ]);
    expect(provenanceText({ ...base, originalMetadata: { enteredBy: null, enteredAt: null } }))
      .toBe('Imported from Deltek on 2026-10-20 by Pat Admin — originally entered by author not recorded');
  });

  it('old-importer rows (source app, reason MIGRATION) → "Legacy import — details not recorded"; app rows → no label', () => {
    expect(provenanceKind({ source: 'app', changeReasonCode: 'MIGRATION' })).toBe('legacy-import');
    expect(provenanceLines({ source: 'app', changeReasonCode: 'MIGRATION' })).toEqual(['Legacy import — details not recorded']);
    expect(provenanceLines({ source: 'app', changeReasonCode: 'CORRECTION' })).toBeNull();
  });
});

describe('migrations as shipped', () => {
  const tenant = readFileSync(path.join(ROOT, 'drizzle/0014_certified_outputs.sql'), 'utf8');

  it('import_batches and admin_change_log get UPDATE/DELETE (row) and TRUNCATE (statement) guards with the shared function', () => {
    for (const table of ['import_batches', 'admin_change_log']) {
      expect(tenant).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"\\s+FOR EACH ROW EXECUTE FUNCTION cadenzpoint_block_entry_mutation\\(\\)`));
      expect(tenant).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"\\s+FOR EACH STATEMENT EXECUTE FUNCTION cadenzpoint_block_entry_mutation\\(\\)`));
    }
  });

  it('backfill maps LV-AL/SL/HOL/LWOP → pto/sick/holiday/unpaid; the settings row is upserted; the window closes on any non-draft period or submitted event', () => {
    expect(tenant).toContain("WHEN 'LV-AL' THEN 'pto' WHEN 'LV-SL' THEN 'sick' WHEN 'LV-HOL' THEN 'holiday' WHEN 'LV-LWOP' THEN 'unpaid'");
    expect(tenant).toContain('INSERT INTO "workspace_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING');
    expect(tenant).toMatch(/SET "history_import_closed_at" = now\(\)[\s\S]*"status" <> 'draft'[\s\S]*"event" = 'submitted'/);
    // Provenance columns are additive with a constant default (metadata-only; no UPDATE trigger fires).
    expect(tenant).toContain(`ALTER TABLE "timesheet_entries" ADD COLUMN "source" varchar(20) DEFAULT 'app' NOT NULL`);
    expect(tenant).toContain(`ALTER TABLE "period_events" ADD COLUMN "source" varchar(20) DEFAULT 'app' NOT NULL`);
    expect(tenant).not.toMatch(/UPDATE "timesheet_entries"|UPDATE "period_events"/);
  });

  it('the control-plane migration is drizzle-kit generated as 0009 (the newest journal entry) and adds tenants.import_window_until', () => {
    const journal = JSON.parse(readFileSync(path.join(ROOT, 'drizzle/control-plane/meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const last = journal.entries[journal.entries.length - 1];
    expect(last.idx).toBe(9);
    expect(last.when).toBe(Math.max(...journal.entries.map((e) => e.when)));
    expect(readFileSync(path.join(ROOT, `drizzle/control-plane/${last.tag}.sql`), 'utf8')).toContain('ADD COLUMN "import_window_until" timestamp with time zone');
  });
});
