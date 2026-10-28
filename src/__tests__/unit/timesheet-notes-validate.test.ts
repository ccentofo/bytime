import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-timesheet.md A4.2: the note checks made BEFORE saveTimesheetBatch's transaction (pure) — day inside
 * the period, exactly one code reference, a trimmed string body of at most 1000 characters, no future dates, a
 * whole-number expectedRevision, each cell once. (The in-transaction rules are A-T1, against Postgres.)
 */

vi.mock('server-only', () => ({}));
import { readFileSync } from 'fs';
import path from 'path';
import { validateNotes, NOTE_TOO_LONG, NOTE_FUTURE_DATE, NOTE_CONTROL, NOTE_CONFLICT } from '@/server/internal/timesheet-notes';
import { commentPreview } from '@/server/internal/past-periods';

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

  it('L1: tab and newline are fine; NUL and other control characters are refused with a message', () => {
    expect(v([{ chargeCodeId: CODE, dayIndex: 0, body: 'Line one\n\tLine two', expectedRevision: 0 }])[0].body).toBe('Line one\n\tLine two');
    for (const c of ['\u0000', '\u0007', '\r', '\u001b', '\u007f']) {
      expect(() => v([{ chargeCodeId: CODE, dayIndex: 0, body: `a${c}b`, expectedRevision: 0 }]), JSON.stringify(c)).toThrow(NOTE_CONTROL);
    }
    expect(NOTE_CONTROL).toBe('A note can\'t contain control characters.');
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

describe('UX-3 fix round 1', () => {
  it('L6: a lost note-revision race says the timesheet changed (not "entries"), in the save and in writeNotes', () => {
    expect(NOTE_CONFLICT).toBe('This timesheet changed in another tab or session. Reload to see the latest, then try again.');
    const save = readFileSync(path.resolve(__dirname, '../../server/actions/timesheet.ts'), 'utf8');
    expect(save).toMatch(/isUniqueViolation\(err, 'timesheet_notes_cell_rev_unique_idx'\)\) throw new ConflictError\(NOTE_CONFLICT\);/);
    const notes = readFileSync(path.resolve(__dirname, '../../server/internal/timesheet-notes.ts'), 'utf8');
    expect(notes).toMatch(/isUniqueViolation\(err, 'timesheet_notes_cell_rev_unique_idx'\)\) throw new ConflictError\(NOTE_CONFLICT\);/);
  });

  it('L10: the past-periods comment preview counts code points (an emoji is never split)', () => {
    expect(commentPreview(null)).toBeNull();
    expect(commentPreview('short')).toBe('short');
    const emoji = '😀'.repeat(141);
    expect(commentPreview(emoji)).toBe(`${'😀'.repeat(140)}…`);
    expect(commentPreview('😀'.repeat(140))).toBe('😀'.repeat(140)); // exactly 140 code points: unchanged
    expect(commentPreview(`${'a'.repeat(139)}😀b`)).toBe(`${'a'.repeat(139)}😀…`);
  });
});
