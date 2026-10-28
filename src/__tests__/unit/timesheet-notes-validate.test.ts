import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-timesheet.md A4.2: the note checks made BEFORE saveTimesheetBatch's transaction (pure) — day inside
 * the period, exactly one code reference, a trimmed string body of at most 1000 characters, no future dates, a
 * whole-number expectedRevision, each cell once. (The in-transaction rules are A-T1, against Postgres.)
 */

vi.mock('server-only', () => ({}));
import { validateNotes, NOTE_TOO_LONG, NOTE_FUTURE_DATE } from '@/server/internal/timesheet-notes';

const CODE = '22222222-2222-4222-8222-222222222222';
const IND = '44444444-4444-4444-8444-444444444444';
const START = '2026-10-01' as never;
const TODAY = '2026-10-10' as never;
const v = (notes: unknown) => validateNotes(notes, START, 15, TODAY);

describe('validateNotes', () => {
  it('no notes → none; a valid note is trimmed, dated and keyed like the client ({rowId}-{dayIndex})', () => {
    expect(v(undefined)).toEqual([]);
    expect(v([{ chargeCodeId: CODE, dayIndex: 2, body: '  Site visit \n', expectedRevision: 0 }])).toEqual([
      { kind: 'charge', codeId: CODE, dayIndex: 2, entryDate: '2026-10-03', body: 'Site visit', expectedRevision: 0, key: `${CODE}-2` },
    ]);
    expect(v([{ indirectCodeId: IND, dayIndex: 0, body: '', expectedRevision: 3 }])[0]).toMatchObject({ kind: 'indirect', body: '', expectedRevision: 3 });
  });

  it('1000 characters after trimming is fine; 1001 is refused', () => {
    expect(v([{ chargeCodeId: CODE, dayIndex: 0, body: ` ${'a'.repeat(1000)} `, expectedRevision: 0 }])[0].body).toHaveLength(1000);
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: 'a'.repeat(1001), expectedRevision: 0 }])).toThrow(NOTE_TOO_LONG);
  });

  it('no notes on future dates (today is fine)', () => {
    expect(v([{ chargeCodeId: CODE, dayIndex: 9, body: 'today', expectedRevision: 0 }])[0].entryDate).toBe('2026-10-10');
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 10, body: 'tomorrow', expectedRevision: 0 }])).toThrow(NOTE_FUTURE_DATE);
  });

  it('refuses a day outside the period, zero or two code references, a non-string body, a bad revision, the same cell twice', () => {
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 15, body: 'x', expectedRevision: 0 }])).toThrow(/Invalid day index/);
    expect(() => v([{ chargeCodeId: CODE, dayIndex: -1, body: 'x', expectedRevision: 0 }])).toThrow(/Invalid day index/);
    expect(() => v([{ dayIndex: 0, body: 'x', expectedRevision: 0 }])).toThrow(/exactly one/);
    expect(() => v([{ chargeCodeId: CODE, indirectCodeId: IND, dayIndex: 0, body: 'x', expectedRevision: 0 }])).toThrow(/exactly one/);
    expect(() => v([{ chargeCodeId: 'nope', dayIndex: 0, body: 'x', expectedRevision: 0 }])).toThrow();
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: 42, expectedRevision: 0 }])).toThrow(/must be text/);
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: 'x', expectedRevision: -1 }])).toThrow(/revision/);
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: 'x', expectedRevision: 1.5 }])).toThrow(/revision/);
    expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: 'a', expectedRevision: 0 }, { chargeCodeId: CODE, dayIndex: 0, body: 'b', expectedRevision: 0 }])).toThrow(/only once/);
    expect(() => v('nope')).toThrow(/list/);
  });
});
