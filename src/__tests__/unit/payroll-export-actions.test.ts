import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C7 / §9 rows "FLSA" (refused without the workweek setting; only approved in-range
 * days output; a period that started before the range contributes its in-range days), "Leave columns" (leave code
 * without pay type → refused, codes listed), "Leave pre-set" (built-in codes pre-set), "Change log" (workweek change
 * logged), Gusto (refuses before a sync log; payload carries regular/OT/leave/uncompensated/flag). Scripted database.
 */

const h = vi.hoisted(() => ({ periodLength: 15 }));
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
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
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});
vi.mock('@/server/internal/pay-period-config', () => ({ existingPeriodLength: async (_db: unknown, _s: unknown, n: number | null) => n ?? h.periodLength }));

import * as dbModule from '@/db';
import {
  adminChangeLog, indirectChargeCodes, integrationConnections, integrationEntityMappings, integrationSyncLogs, integrationSyncRecords,
  timesheetEntries, timesheetPeriods, users, workspaceSettings,
} from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { loadPayrollData, PayrollNotReadyError, WORKWEEK_UNSET_MESSAGE } from '@/server/internal/payroll-data';
import { generatePayrollExportCSV, getPayrollExportPreview } from '@/server/actions/payroll-export';
import { updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import { createIndirectCode, updateIndirectCode, seedIndirectCodes } from '@/server/actions/indirect-codes';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import { gustoConnector } from '@/lib/integrations/connectors/gusto';
import type { CalendarDate } from '@/lib/calendar-date';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const d = (s: string) => s as CalendarDate;
beforeEach(() => { db.reset(); h.periodLength = 15; });

const entry = (o: Record<string, unknown>) => ({ userId: 'u1', entryDate: '2026-10-05', hours: '8.00', clinId: 'clin-1', indirectCode: null, indirectCategory: null, leavePayType: null, ...o });
const person = { id: 'u1', fullName: 'Pat Doe', email: 'pat@x', flsaExempt: false };

describe('payroll-data', () => {
  it('refuses while the workweek start day is unset (before reading any entry)', async () => {
    db.onSelect(workspaceSettings, [{ day: null }]);
    await expect(loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15'))).rejects.toMatchObject({ reason: 'workweek-unset', message: WORKWEEK_UNSET_MESSAGE });
  });

  it('refuses while a leave code with hours in the range has no pay type, listing the codes', async () => {
    db.onSelect(workspaceSettings, [{ day: 1 }]);
    db.onSelect(timesheetEntries, [
      entry({ clinId: null, indirectCode: 'LV-BEREAVE', indirectCategory: 'leave', leavePayType: null }),
      entry({ clinId: null, indirectCode: 'LV-JURY', indirectCategory: 'leave', leavePayType: null, entryDate: '2026-10-06' }),
      entry({ clinId: null, indirectCode: 'LV-AL', indirectCategory: 'leave', leavePayType: 'pto' }),
    ]);
    const err = await loadPayrollData(db as never, d('2026-10-01'), d('2026-10-15')).catch((x) => x);
    expect(err).toBeInstanceOf(PayrollNotReadyError);
    expect(err).toMatchObject({ reason: 'leave-pay-type', codes: ['LV-BEREAVE', 'LV-JURY'] });
    expect(err.message).toMatch(/Indirect Codes .*LV-BEREAVE, LV-JURY/);
  });

  it('outputs only in-range days whose containing period is approved; a period that started BEFORE the range contributes its in-range days', async () => {
    db.onSelect(workspaceSettings, [{ day: 1 }]);
    db.onSelect(timesheetEntries, [
      entry({ entryDate: '2026-10-14', hours: '8' }),  // in the 10-01 period (approved), in range
      entry({ entryDate: '2026-10-16', hours: '8' }),  // in the 10-16 period (submitted) — counted, not output
      entry({ entryDate: '2026-10-12', hours: '8' }),  // before the range, same workweek (Mon 12) — counted, not output
      entry({ clinId: null, indirectCode: 'LV-HOL', indirectCategory: 'leave', leavePayType: 'holiday', entryDate: '2026-10-15', hours: '8' }),
    ]);
    db.onSelect(users, [person]);
    db.onSelect(timesheetPeriods, [
      { userId: 'u1', periodStart: '2026-10-01', periodNumDays: 15, status: 'approved' },
      { userId: 'u1', periodStart: '2026-10-16', periodNumDays: 16, status: 'submitted' },
    ]);
    const data = await loadPayrollData(db as never, d('2026-10-14'), d('2026-10-20'));
    expect(data.days.map((x) => [x.date, x.regular, x.holiday])).toEqual([['2026-10-14', 800, 0], ['2026-10-15', 0, 800]]);
    expect(data.employees[0]).toMatchObject({ employeeName: 'Pat Doe', regular: 800, holiday: 800, totalPaid: 1600 });
  });
});

describe('actions (ActionResult)', () => {
  it('preview: a refusal comes back as data with its reason (the UI links to Settings / Indirect Codes)', async () => {
    db.onSelect(workspaceSettings, []);
    expect(await getPayrollExportPreview({ periodStart: d('2026-10-01'), periodEnd: d('2026-10-15') })).toEqual({
      ok: true, data: { status: 'refused', reason: 'workweek-unset', codes: [], message: WORKWEEK_UNSET_MESSAGE },
    });
  });

  it('CSV: a refusal is a failed result with the message (never a thrown, redacted error)', async () => {
    db.onSelect(workspaceSettings, []);
    expect(await generatePayrollExportCSV({ periodStart: d('2026-10-01'), periodEnd: d('2026-10-15'), format: 'adp' }))
      .toEqual({ ok: false, code: 'validation', error: WORKWEEK_UNSET_MESSAGE });
  });

  it('CSV: an approved 45 h week → 40 + 5 OT in the file; filename and flagged count reported', async () => {
    db.onSelect(workspaceSettings, [{ day: 1 }]);
    db.onSelect(timesheetEntries, ['05', '06', '07', '08', '09'].map((dd) => entry({ entryDate: `2026-10-${dd}`, hours: '9' })));
    db.onSelect(users, [person]);
    db.onSelect(timesheetPeriods, [{ userId: 'u1', periodStart: '2026-10-01', periodNumDays: 15, status: 'approved' }]);
    const r = await generatePayrollExportCSV({ periodStart: d('2026-10-01'), periodEnd: d('2026-10-15'), format: 'gusto' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.csvContent.split('\n')[1]).toBe('pat@x,Pat Doe,40.00,5.00,0.00,0.00,0.00,2026-10-01,2026-10-15');
    expect(r.data).toMatchObject({ filename: 'payroll-gusto-flsa-weekly-overtime-2026-10-01-to-2026-10-15.csv', employeeCount: 1, totalPaidHours: 45, flaggedCount: 0 });
  });

  it('static: the guard is the first await in each action; the old 80-hour aggregation is gone', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/payroll-export.ts'), 'utf8'));
    for (const fn of ['getPayrollExportPreview', 'generatePayrollExportCSV']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      expect(body.indexOf('await requireAdmin()'), fn).toBeLessThan(body.indexOf('await getDb()'));
      expect(body, fn).toMatch(/return userAction\(async \(\) => \{\s*await requireAdmin\(\);/);
    }
    const all = ['src/server/actions/payroll-export.ts', 'src/lib/integrations/connectors/payroll-export.ts', 'src/lib/integrations/connectors/gusto.ts']
      .map((rel) => readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
    expect(all).not.toMatch(/aggregateEntriesByEmployee|DEFAULT_REGULAR_HOURS_THRESHOLD|getApprovedEntriesForSync/);
  });
});

describe('Gusto payroll push', () => {
  const connection = { id: 'c1', provider: 'gusto', isActive: true, accessTokenEncrypted: null, externalCompanyId: 'co' };

  it('refuses BEFORE creating a sync log while the workweek start day is unset', async () => {
    db.onSelect(integrationConnections, [connection]);
    db.onSelect(workspaceSettings, []);
    await expect(executeSyncOperation('c1', 'timesheet_push', d('2026-10-01'), d('2026-10-15'), 'admin-1')).rejects.toThrow(WORKWEEK_UNSET_MESSAGE);
    expect(db.inserts.filter((i) => i.table === integrationSyncLogs)).toEqual([]);
  });

  it('routes Gusto to payroll-data and records regular / OT / leave / uncompensated / flag per employee', async () => {
    db.onSelect(integrationConnections, [connection]);
    db.onSelect(workspaceSettings, [{ day: 1 }]);
    db.onSelect(timesheetEntries, [
      ...['05', '06', '07', '08', '09'].map((dd) => entry({ entryDate: `2026-10-${dd}`, hours: '9' })),
      entry({ clinId: null, indirectCode: 'LV-AL', indirectCategory: 'leave', leavePayType: 'pto', entryDate: '2026-10-12', hours: '8' }),
    ]);
    db.onSelect(users, [person]);
    db.onSelect(timesheetPeriods, [{ userId: 'u1', periodStart: '2026-10-01', periodNumDays: 15, status: 'approved' }]);
    db.onReturning('insert', integrationSyncLogs, [{ id: 'log-1' }]);
    db.onSelect(integrationEntityMappings, [{ entityType: 'employee', bytimeEntityId: 'u1', externalEntityId: 'g-1' }]);
    const { result } = await executeSyncOperation('c1', 'timesheet_push', d('2026-10-01'), d('2026-10-15'), 'admin-1');
    expect(result).toMatchObject({ pushed: 1, failed: 0 });
    const record = db.inserts.find((i) => i.table === integrationSyncRecords)!.values as { requestPayload: string };
    expect(JSON.parse(record.requestPayload)).toEqual({
      method: 'FLSA weekly overtime', employeeName: 'Pat Doe', regularHours: 40, overtimeHours: 5, ptoHours: 8, sickHours: 0, holidayHours: 0,
      uncompensatedOvertimeHours: 0, flagged: false, periodStart: '2026-10-01', periodEnd: '2026-10-15',
    });
    expect(gustoConnector.pushTimesheetEntries).toBeUndefined();
  });
});

describe('workweek start day setting', () => {
  it('validates 0–6; a change writes one admin_change_log row (old → new); the same value writes nothing', async () => {
    expect(await updateWorkweekStartDay(7)).toMatchObject({ ok: false, code: 'validation' });
    db.onSelect(workspaceSettings, [{ day: null }]);
    expect(await updateWorkweekStartDay(1)).toEqual({ ok: true, data: 1 });
    expect(db.inserts.filter((i) => i.table === adminChangeLog).map((i) => i.values)).toEqual([{
      actorId: 'admin-1', entity: 'workspace_settings', entityId: '00000000-0000-0000-0000-000000000000', action: 'workweek_start_day_changed',
      oldValue: { workweekStartDay: null }, newValue: { workweekStartDay: 1 },
    }]);
    db.reset();
    db.onSelect(workspaceSettings, [{ day: 1 }]);
    expect(await updateWorkweekStartDay(1)).toEqual({ ok: true, data: 1 });
    expect(db.inserts).toEqual([]);
  });

  it('the Settings page warns (29 CFR 778.105) before changing a set value', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/settings/SettingsClient.tsx'), 'utf8');
    expect(src).toMatch(/savedWorkweekDay === null \? saveWorkweek\(\) : setConfirmWorkweek\(true\)/);
    expect(src).toMatch(/29 CFR 778\.105/);
  });
});

describe('leave pay types (CO-D11 / CO-D16)', () => {
  it('a leave code needs a pay type; other categories never get one', async () => {
    expect(await createIndirectCode({ code: 'LV-X', name: 'X', category: 'leave' })).toMatchObject({ ok: false, error: expect.stringMatching(/pay type/) });
    db.onReturning('insert', indirectChargeCodes, [{ id: 'i1' }]);
    expect((await createIndirectCode({ code: 'LV-X', name: 'X', category: 'leave', leavePayType: 'sick' })).ok).toBe(true);
    expect(db.inserts[0].values).toMatchObject({ category: 'leave', leavePayType: 'sick' });
    db.reset();
    db.onReturning('insert', indirectChargeCodes, [{ id: 'i2' }]);
    await createIndirectCode({ code: 'OH', name: 'O', category: 'overhead', leavePayType: 'pto' });
    expect(db.inserts[0].values).toMatchObject({ category: 'overhead', leavePayType: null });
  });

  it('changing a code to leave without a pay type is refused; away from leave clears it', async () => {
    db.onSelect(indirectChargeCodes, [{ category: 'overhead', leavePayType: null }]);
    expect(await updateIndirectCode('i1', { category: 'leave' })).toMatchObject({ ok: false, error: expect.stringMatching(/pay type/) });
    db.reset();
    db.onSelect(indirectChargeCodes, [{ category: 'leave', leavePayType: 'pto' }]);
    db.onReturning('update', indirectChargeCodes, [{ id: 'i1' }]);
    await updateIndirectCode('i1', { category: 'overhead' });
    expect(db.updates[0].set).toMatchObject({ category: 'overhead', leavePayType: null });
  });

  it('built-in leave codes ship pre-set (seedIndirectCodes and provision-customer-db)', async () => {
    db.onSelect(indirectChargeCodes, []);
    db.onReturning('insert', indirectChargeCodes, []);
    await seedIndirectCodes();
    const seeded = db.inserts[0].values as unknown as Array<{ code: string; leavePayType?: string }>;
    const pay = Object.fromEntries(seeded.filter((c) => c.code.startsWith('LV-')).map((c) => [c.code, c.leavePayType]));
    expect(pay).toEqual({ 'LV-AL': 'pto', 'LV-SL': 'sick', 'LV-HOL': 'holiday', 'LV-LWOP': 'unpaid' });
    const script = readFileSync(path.join(ROOT, 'scripts/provision-customer-db.ts'), 'utf8');
    for (const [c, t] of Object.entries(pay)) expect(script).toMatch(new RegExp(`code: '${c}'.*leavePayType: '${t}'`));
  });
});

describe('docs/payroll-overtime-method.md (required before production)', () => {
  it('states the method, leave exclusion, boundary-week rule, columns, the exempt deduction note and current-value limits', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/payroll-overtime-method.md'), 'utf8');
    for (const s of ['29 CFR 778.103', '29 CFR 778.218', '29 CFR 778.105', 'boundary week', 'PTO column', 'uncompensated overtime',
      'partial days of unpaid leave', 'flsa_exempt', 'not effective-dated', 'not been verified']) expect(doc, s).toContain(s);
  });
});
