import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C8: OTHER needs a comment (server + client); clearTenantData clears the new tables
 * in FK order inside the bypass and resets the new settings; the demo seeder conforms (period_events, C2-conformant
 * approvals, designees, workweek, leave pay types). The export items are in export-allowlists.test.ts.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const emp = async () => ({ id: '11111111-1111-4111-8111-111111111111', email: 'e@x', fullName: 'Emp', role: 'employee' });
  return { AuthorizationError, requireSession: emp, assertCanAccessEmployee: async () => {} };
});
vi.mock('@/server/internal/periods', () => ({
  resolvePeriod: async () => ({ numDays: 15, config: { periodType: 'semimonthly' } }),
  lockEmployeeTimesheet: async () => {},
  assertEntryDatesEditable: async () => {},
  getPeriodStatusFor: async () => ({ id: null, status: 'draft' }),
}));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-10-10', getWorkspaceTimezone: async () => 'UTC' }));
vi.mock('@/server/internal/pay-period-config', () => ({ configAt: async () => ({}), existingPeriodLength: async () => 15 }));

import * as dbModule from '@/db';
import { chargeCodes, timesheetEntries, userChargeCodes } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { OTHER_REASON_COMMENT_REQUIRED, reasonNeedsComment } from '@/lib/reason-codes';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const CODE = '22222222-2222-4222-8222-222222222222';
beforeEach(() => db.reset());

function correctionFacts() {
  db.onSelect(chargeCodes, [{ id: CODE, clinId: 'clin-1', slinId: null }]);
  db.onSelect(userChargeCodes, [{ id: CODE }]);
  db.onSelect(chargeCodes, [{ id: CODE, codeActive: true, clinStatus: 'active', slinStatus: null, contractStatus: 'active' }]);
  db.onSelect(timesheetEntries, []);                 // UX-3 A4.5: the day's total before the save
  db.onSelect(timesheetEntries, [{ maxRevision: 1 }]); // prior revision (a correction)
}
const correct = (changeReasonCode: string, comment?: string) => saveTimesheetBatch({
  periodStart: '2026-10-01' as never,
  cells: [{ chargeCodeId: CODE, dayIndex: 2, hours: 5, isEdit: true, isLateEntry: false }],
  changeReasonCode, comment, skipConflictCheck: true,
});

describe('OTHER reason requires a comment', () => {
  it('server: OTHER with a blank / missing comment is refused; with a comment it saves; other reasons unchanged', async () => {
    correctionFacts();
    expect(await correct('OTHER', '   ')).toEqual({ ok: false, code: 'validation', error: OTHER_REASON_COMMENT_REQUIRED });
    db.reset();
    correctionFacts();
    expect(await correct('OTHER')).toMatchObject({ ok: false, error: OTHER_REASON_COMMENT_REQUIRED });
    db.reset();
    correctionFacts();
    expect((await correct('OTHER', 'Badge reader outage')).ok).toBe(true);
    db.reset();
    correctionFacts();
    expect((await correct('CORRECTION')).ok).toBe(true);
    expect(reasonNeedsComment('OTHER', '')).toBe(true);
    expect(reasonNeedsComment('OTHER', 'x')).toBe(false);
    expect(reasonNeedsComment('CORRECTION', '')).toBe(false);
  });

  it('client: the reason modal and the daily-note modal both block OTHER without a comment', () => {
    const modal = readFileSync(path.join(ROOT, 'src/components/timesheet/ReasonModal.tsx'), 'utf8');
    expect(modal).toMatch(/const canSubmit = reasonCode !== null && comment\.trim\(\)\.length > 0 && !reasonNeedsComment\(reasonCode, comment\);/);
    const note = readFileSync(path.join(ROOT, 'src/components/timesheet/DailyNoteModal.tsx'), 'utf8');
    expect(note).toMatch(/disabled=\{reasonNeedsComment\(reasonCode, comment\)\}/);
  });
});

describe('clearTenantData (C1/C8)', () => {
  const src = stripComments(readFileSync(path.join(ROOT, 'src/db/clear-tenant-data.ts'), 'utf8'));
  const at = (s: string) => { const i = src.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };

  it('deletes import_batches after period_events / entries, admin_change_log before users — inside the bypass', () => {
    expect(at('tx.delete(schema.importBatches)')).toBeGreaterThan(at('tx.delete(schema.periodEvents)'));
    expect(at('tx.delete(schema.importBatches)')).toBeGreaterThan(at('tx.delete(schema.timesheetEntries)'));
    expect(at('tx.delete(schema.adminChangeLog)')).toBeLessThan(at('tx.delete(schema.users)'));
    expect(at('tx.delete(schema.importBatches)')).toBeGreaterThan(at("allow_entry_delete"));
  });

  it('UX-3 A4.1: deletes timesheet_notes inside the bypass, after entries and before the codes, CLINs and users it references', () => {
    const notes = at('tx.delete(schema.timesheetNotes)');
    expect(notes).toBeGreaterThan(at("allow_entry_delete"));
    expect(notes).toBeGreaterThan(at('tx.delete(schema.timesheetEntries)'));
    for (const t of ['chargeCodes', 'indirectChargeCodes', 'clins', 'users']) expect(notes, t).toBeLessThan(at(`tx.delete(schema.${t})`));
  });

  it('resets workweek_start_day and history_import_closed_at with the timezone', () => {
    expect(src).toMatch(/timezone: 'America\/New_York', historyImportClosedAt: null, workweekStartDay: null/);
  });
});

describe('demo seeder conformance (seed-full.ts, reused by seed:demo)', () => {
  const seed = stripComments(readFileSync(path.join(ROOT, 'scripts/seed-full.ts'), 'utf8'));

  it('writes period_events (source app) for every seeded submission and approval', () => {
    expect(seed).toMatch(/if \(submittedAt\) \{\s*await db\.insert\(schema\.periodEvents\)\.values\(\{ periodId, userId: emp\.id, event: 'submitted', actorId: emp\.id/);
    expect(seed).toMatch(/if \(reviewedAt && reviewedBy\) \{\s*await db\.insert\(schema\.periodEvents\)\.values\(\{ periodId, userId: emp\.id, event: 'approved', actorId: reviewedBy/);
    expect(seed).toMatch(/submissionCount: status !== 'draft' \? 1 : 0/);
  });

  it('approvals follow C2: supervisors by their designated approver (admin), employees by a supervisor sharing a CLIN', () => {
    expect(seed).toMatch(/const reviewedBy = status === 'approved' \? reviewerFor\(emp\.id\) : null;/);
    expect(seed).toMatch(/if \(supervisorIds\.includes\(employeeId\)\) return userIds\.admin;/);
    expect(seed).toMatch(/preferred\.find\(\(s\) => \[\.\.\.clinsOf\(s\)\]\.some\(\(c\) => mine\.has\(c\)\)\)/);
    expect(seed.match(/role: 'supervisor', passwordHash: hash, isActive: true, flsaExempt: true, approverId: userIds\.admin/g)).toHaveLength(2);
    expect(seed).not.toMatch(/\? userIds\.mike : userIds\.sarah\)\s*: null/); // the old peer / self approval
  });

  it('sets a workweek for demos and pay types on the built-in leave codes', () => {
    expect(seed).toMatch(/historyImportClosedAt: new Date\(\), workweekStartDay: 1/);
    for (const [c, t] of [['LV-AL', 'pto'], ['LV-SL', 'sick'], ['LV-HOL', 'holiday'], ['LV-LWOP', 'unpaid']]) {
      expect(seed).toMatch(new RegExp(`code: '${c}'.*leavePayType: '${t}'`));
    }
    expect(seed).toMatch(/leavePayType: ic\.leavePayType \?\? null/);
  });
});
