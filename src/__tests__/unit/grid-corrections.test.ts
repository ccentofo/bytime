import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-certified-outputs.md C4 / §9 rows "Grid assignable", "Corrections (CO-D8)", "Grid/review", "Leave
 * pre-set" (0-hour correction on a deactivated code): the one cell rule (UI + server), saveTimesheetBatch's per-cell
 * decisions inside its transaction (new cell → full assignable rule, rulings Q1/Q4; prior revision → correctable; a
 * legacy CLIN correction keeps its prior SLIN), the save mapping by kind, and the offline queue mapping.
 */

const h = vi.hoisted(() => ({ locked: false }));
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
  assertEntryDatesEditable: async () => {
    if (h.locked) { const { UserFacingError } = await import('@/lib/errors'); throw new UserFacingError('Cannot modify a submitted timesheet. This period has been certified and is locked.'); }
  },
  getPeriodStatusFor: async () => ({ id: null, status: 'draft' }),
}));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceToday: async () => '2026-10-10', getWorkspaceTimezone: async () => 'UTC' }));
vi.mock('@/server/internal/pay-period-config', () => ({ configAt: async () => ({}), existingPeriodLength: async () => 15 }));

import * as dbModule from '@/db';
import { chargeCodes, indirectChargeCodes, timesheetEntries, userChargeCodes } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { saveTimesheetBatch } from '@/server/actions/timesheet';
import { isCellEditable, newCellRefusal } from '@/lib/timesheet/cell-rules';
import { cellRefForKind, timesheetReducer } from '@/components/timesheet/TimesheetContext';
import { queueItemCellRef } from '@/lib/offline/sync-service';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const CODE = '22222222-2222-4222-8222-222222222222';
const CLIN = '33333333-3333-4333-8333-333333333333';
const IND = '44444444-4444-4444-8444-444444444444';
const START = '2026-10-01';

beforeEach(() => { db.reset(); h.locked = false; });

/** Script the in-transaction reads for one charge-code cell, in the order the save makes them. */
function chargeCodeFacts(o: { assigned: boolean; codeActive: boolean; clinActive?: boolean; slinStatus?: string | null; contractActive?: boolean; priorRevision: number }) {
  db.onSelect(chargeCodes, [{ id: CODE, clinId: CLIN, slinId: null }]);                                   // FOR SHARE re-read
  db.onSelect(userChargeCodes, o.assigned ? [{ id: CODE }] : []);                                          // active assignment
  db.onSelect(chargeCodes, [{ id: CODE, codeActive: o.codeActive, clinStatus: o.clinActive === false ? 'inactive' : 'active', slinStatus: o.slinStatus ?? null, contractStatus: o.contractActive === false ? 'inactive' : 'active' }]);
  db.onSelect(timesheetEntries, [{ maxRevision: o.priorRevision }]);                                       // prior revision
}
const save = (cell: Record<string, unknown>, reason = true) => saveTimesheetBatch({
  periodStart: START as never,
  cells: [{ dayIndex: 2, hours: 6, isEdit: false, isLateEntry: true, ...cell }],
  ...(reason ? { changeReasonCode: 'CORRECTION', comment: 'fix' } : {}),
  skipConflictCheck: true,
});
const inserted = () => db.inserts.filter((i) => i.table === timesheetEntries).map((i) => i.values);

describe('the one cell rule (UI and server)', () => {
  it('isCellEditable: a day with a prior revision is correctable on any row; an empty day only on an assignable row', () => {
    const base = { periodEditable: true, isFutureDate: false };
    expect(isCellEditable({ ...base, assignable: false, priorRevision: 2 })).toBe(true);
    expect(isCellEditable({ ...base, assignable: false, priorRevision: 0 })).toBe(false);   // read-only (deactivated / legacy CLIN)
    expect(isCellEditable({ ...base, assignable: true, priorRevision: 0 })).toBe(true);
    expect(isCellEditable({ periodEditable: false, isFutureDate: false, assignable: true, priorRevision: 1 })).toBe(false); // submitted/approved
    expect(isCellEditable({ periodEditable: true, isFutureDate: true, assignable: true, priorRevision: 0 })).toBe(false);
  });

  it('newCellRefusal: CLIN-only always refused (Q1); charge code needs assignment + active code/CLIN/contract (Q4)', () => {
    expect(newCellRefusal({ kind: 'clin' })).toBe('clin-only');
    expect(newCellRefusal({ kind: 'charge', assigned: false, codeActive: true, clinActive: true, slinActive: true, contractActive: true })).toBe('not-assigned');
    expect(newCellRefusal({ kind: 'charge', assigned: true, codeActive: false, clinActive: true, slinActive: true, contractActive: true })).toBe('code-inactive');
    expect(newCellRefusal({ kind: 'charge', assigned: true, codeActive: true, clinActive: false, slinActive: true, contractActive: true })).toBe('code-inactive');
    expect(newCellRefusal({ kind: 'charge', assigned: true, codeActive: true, clinActive: true, slinActive: true, contractActive: true })).toBeNull();
    expect(newCellRefusal({ kind: 'indirect', active: false, availableToAll: true })).toBe('indirect-unavailable');
  });

  it('T18 (B5): a deactivated SLIN refuses new hours; an active SLIN (or none) allows them', () => {
    expect(newCellRefusal({ kind: 'charge', assigned: true, codeActive: true, clinActive: true, slinActive: false, contractActive: true })).toBe('code-inactive');
    expect(newCellRefusal({ kind: 'charge', assigned: true, codeActive: true, clinActive: true, slinActive: true, contractActive: true })).toBeNull();
  });
});

describe('saveTimesheetBatch — per cell, inside the transaction, after the prior revision is read', () => {
  it('deactivated charge code: a NEW day is refused; an existing day is corrected with a reason (and can be zeroed out)', async () => {
    chargeCodeFacts({ assigned: true, codeActive: false, priorRevision: 0 });
    expect(await save({ chargeCodeId: CODE })).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/no longer active/) });
    expect(inserted()).toEqual([]);

    db.reset();
    chargeCodeFacts({ assigned: true, codeActive: false, priorRevision: 2 });
    expect((await save({ chargeCodeId: CODE, hours: 0, isEdit: true })).ok).toBe(true);
    expect(inserted()).toEqual([expect.objectContaining({ chargeCodeId: CODE, clinId: CLIN, hours: '0', revisionNumber: 3, changeReasonCode: 'CORRECTION' })]);
  });

  it('unassigned charge code: a NEW day is refused (forbidden); an existing day is corrected', async () => {
    chargeCodeFacts({ assigned: false, codeActive: true, priorRevision: 0 });
    expect(await save({ chargeCodeId: CODE })).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringMatching(/not assigned to charge code/) });
    db.reset();
    chargeCodeFacts({ assigned: false, codeActive: true, priorRevision: 1 });
    expect((await save({ chargeCodeId: CODE, isEdit: true })).ok).toBe(true);
  });

  it('T1: assigned, active code, but its CLIN — or its contract — inactive: a NEW day is refused, an existing day is correctable', async () => {
    for (const facts of [{ clinActive: false }, { contractActive: false }]) {
      db.reset();
      chargeCodeFacts({ assigned: true, codeActive: true, ...facts, priorRevision: 0 });
      expect(await save({ chargeCodeId: CODE }), JSON.stringify(facts)).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/no longer active \(or its CLIN, SLIN or contract isn't\)/) });
      expect(inserted()).toEqual([]);
      db.reset();
      chargeCodeFacts({ assigned: true, codeActive: true, ...facts, priorRevision: 1 });
      expect((await save({ chargeCodeId: CODE, isEdit: true })).ok, JSON.stringify(facts)).toBe(true);
      expect(inserted()).toEqual([expect.objectContaining({ chargeCodeId: CODE, revisionNumber: 2 })]);
    }
  });

  it('T18 (B5): the code SLIN inactive or closed → a NEW day is refused (message names the SLIN); a correction succeeds', async () => {
    for (const slinStatus of ['inactive', 'closed']) {
      db.reset();
      chargeCodeFacts({ assigned: true, codeActive: true, slinStatus, priorRevision: 0 });
      expect(await save({ chargeCodeId: CODE }), slinStatus).toMatchObject({ ok: false, code: 'validation', error: expect.stringMatching(/no longer active \(or its CLIN, SLIN or contract isn't\)/) });
      expect(inserted()).toEqual([]);
      db.reset();
      chargeCodeFacts({ assigned: true, codeActive: true, slinStatus, priorRevision: 1 });
      expect((await save({ chargeCodeId: CODE, isEdit: true })).ok, slinStatus).toBe(true);
    }
    db.reset();
    chargeCodeFacts({ assigned: true, codeActive: true, slinStatus: 'active', priorRevision: 0 });
    expect((await save({ chargeCodeId: CODE })).ok).toBe(true);
  });

  it('a correction still needs a reason code', async () => {
    chargeCodeFacts({ assigned: false, codeActive: false, priorRevision: 1 });
    expect(await save({ chargeCodeId: CODE, isEdit: true }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/reason code is required/) });
  });

  it('a correction in a submitted/approved period is refused (period lock unchanged)', async () => {
    h.locked = true;
    chargeCodeFacts({ assigned: true, codeActive: false, priorRevision: 1 });
    expect(await save({ chargeCodeId: CODE, isEdit: true })).toMatchObject({ ok: false, error: expect.stringMatching(/certified and is locked/) });
  });

  it('legacy CLIN: a new CLIN-only cell is refused; an existing one is corrected keeping the prior SLIN; a different client SLIN is refused', async () => {
    db.onSelect(timesheetEntries, [{ maxRevision: 0 }]);
    expect(await save({ clinId: CLIN })).toMatchObject({ ok: false, error: expect.stringMatching(/CLIN-only row/) });

    db.reset();
    const PRIOR_SLIN = '55555555-5555-4555-8555-555555555555';
    db.onSelect(timesheetEntries, [{ maxRevision: 1 }]);
    db.onSelect(timesheetEntries, [{ slinId: PRIOR_SLIN }]);
    expect((await save({ clinId: CLIN, isEdit: true })).ok).toBe(true);
    expect(inserted()).toEqual([expect.objectContaining({ clinId: CLIN, slinId: PRIOR_SLIN, chargeCodeId: null, revisionNumber: 2 })]);

    db.reset();
    db.onSelect(timesheetEntries, [{ maxRevision: 1 }]);
    db.onSelect(timesheetEntries, [{ slinId: PRIOR_SLIN }]);
    expect(await save({ clinId: CLIN, slinId: '66666666-6666-4666-8666-666666666666', isEdit: true }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/keeps the SLIN/) });
  });

  it('inactive indirect code: a correction is allowed; a new day is refused', async () => {
    db.onSelect(indirectChargeCodes, [{ id: IND, isActive: false, availableToAll: true }]);
    db.onSelect(timesheetEntries, [{ maxRevision: 1 }]);
    expect((await save({ indirectCodeId: IND, isEdit: true })).ok).toBe(true);
    db.reset();
    db.onSelect(indirectChargeCodes, [{ id: IND, isActive: false, availableToAll: true }]);
    db.onSelect(timesheetEntries, [{ maxRevision: 0 }]);
    expect(await save({ indirectCodeId: IND })).toMatchObject({ ok: false, error: expect.stringMatching(/is not available/) });
  });
});

describe('F8 — navigation replaces the code list', () => {
  it('SET_PERIOD_DATA replaces chargeCodes with the new period\'s list (no fallback to the old one)', () => {
    const old = [{ id: 'a', projectName: 'P', clin: 'A', description: 'A', kind: 'charge', assignable: true }];
    const next = [{ id: 'b', projectName: 'P', clin: 'B', description: 'B', kind: 'charge', assignable: false }];
    const state = { chargeCodes: old, entries: [], savedEntries: [], savedCellRevisions: {}, notes: {} } as never;
    const out = timesheetReducer(state, {
      type: 'SET_PERIOD_DATA', periodStart: '2026-10-16' as never, numDays: 16, entries: [], revisions: {}, periodStatus: 'draft',
      periodConfig: { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 } as never, chargeCodes: next as never,
    }) as unknown as { chargeCodes: unknown };
    expect(out.chargeCodes).toBe(next);
    const empty = timesheetReducer(state, {
      type: 'SET_PERIOD_DATA', periodStart: '2026-10-16' as never, numDays: 16, entries: [], revisions: {}, periodStatus: 'draft',
      periodConfig: { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 } as never, chargeCodes: [],
    }) as unknown as { chargeCodes: unknown[] };
    expect(empty.chargeCodes).toEqual([]);
  });
});

describe('save mapping by kind (client and offline queue)', () => {
  it('charge → chargeCodeId, clin → clinId, indirect → indirectCodeId', () => {
    expect(cellRefForKind('charge', 'x')).toEqual({ chargeCodeId: 'x' });
    expect(cellRefForKind('clin', 'x')).toEqual({ clinId: 'x' });
    expect(cellRefForKind('indirect', 'x')).toEqual({ indirectCodeId: 'x' });
  });

  it('offline queue items map by kind; items queued before C4 (no kind) are treated as charge', () => {
    expect(queueItemCellRef({ clinId: 'cc', kind: 'charge' })).toEqual({ chargeCodeId: 'cc' });
    expect(queueItemCellRef({ clinId: 'clin', kind: 'clin' })).toEqual({ clinId: 'clin' });
    expect(queueItemCellRef({ indirectCodeId: 'ind' })).toEqual({ indirectCodeId: 'ind' });
    expect(queueItemCellRef({ clinId: 'cc' })).toEqual({ chargeCodeId: 'cc' });
  });

  it('wiring (static): the grid uses the rule, the label, the per-period code list; the save maps by kind', () => {
    const cell = readFileSync(path.join(ROOT, 'src/components/timesheet/cells/HourCell.tsx'), 'utf8');
    expect(cell).toMatch(/isCellEditable\(\{ periodEditable, isFutureDate, assignable: row\?\.assignable \?\? true, priorRevision \}\)/);
    expect(readFileSync(path.join(ROOT, 'src/components/timesheet/cells/ChargeCodeCell.tsx'), 'utf8'))
      .toContain('Closed to new hours — you can correct existing hours');
    const ctx = readFileSync(path.join(ROOT, 'src/components/timesheet/TimesheetContext.tsx'), 'utf8');
    expect(ctx).toMatch(/chargeCodes: action\.chargeCodes,/);
    // F8: offline seeding uses the NEW period's list.
    expect(ctx).toMatch(/seedOfflineStore\(\{[\s\S]*?chargeCodes: period\.chargeCodes,/);
    expect(ctx).not.toMatch(/chargeCodes: state\.chargeCodes/);
    expect(ctx).toMatch(/\.\.\.cellRefForKind\(chargeCode\?\.kind/);
    expect(readFileSync(path.join(ROOT, 'src/app/(app)/timesheet/page.tsx'), 'utf8')).toMatch(/chargeCodes: period\.chargeCodes,/);
    const ts = readFileSync(path.join(ROOT, 'src/server/actions/timesheet.ts'), 'utf8');
    const save = ts.slice(ts.indexOf('export async function saveTimesheetBatch'));
    const tx = save.slice(save.indexOf('await db.transaction(async (tx) => {'));
    expect(tx.indexOf('if (priorRevision === 0) {')).toBeGreaterThan(tx.indexOf('const priorRevision = existing[0]?.maxRevision ?? 0;'));
    expect(save.slice(0, save.indexOf('await db.transaction(async (tx) => {'))).not.toMatch(/userChargeCodes|validateChargeCodeAssignment|validateClinAssignment/);
  });
});
