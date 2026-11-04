import { describe, it, expect } from 'vitest';
import { flaggedCells, type CellRevision } from '@/lib/approvals/flagged-cells';

/**
 * feature-plan-ux-approvals-payroll.md A4 / A-4, unit companion: the review's flagged cells from revision chains —
 * app revisions decide; rev 2 + rev 3 is one correction; late (rev 1 with a reason, never revised); a late cell later
 * corrected is a correction marked originallyLate; sinceReturned = the latest revision is after the last return;
 * previousHours; grid order.
 */
const rev = (revision: number, hours: number, o: Partial<CellRevision> = {}): CellRevision =>
  ({ revision, hours, reasonCode: null, comment: null, createdAt: '2026-03-10T12:00:00.000Z', source: 'app', ...o });

describe('flaggedCells (A-4 companion)', () => {
  it('corrections (one per cell), late entries, late-then-corrected, plain and imported cells', () => {
    const out = flaggedCells([
      { rowId: 'A', dayIndex: 1, revisions: [rev(3, 5, { reasonCode: 'CORRECTION' }), rev(1, 8), rev(2, 6, { reasonCode: 'CORRECTION' })] },
      { rowId: 'A', dayIndex: 2, revisions: [rev(1, 4, { reasonCode: 'LATE_ENTRY' })] },
      { rowId: 'A', dayIndex: 3, revisions: [rev(1, 2, { reasonCode: 'LATE_ENTRY' }), rev(2, 3, { reasonCode: 'CORRECTION' })] },
      { rowId: 'A', dayIndex: 4, revisions: [rev(1, 8)] },
      { rowId: 'A', dayIndex: 5, revisions: [rev(3, 8, { source: 'migration' })] },
      { rowId: 'A', dayIndex: 6, revisions: [rev(1, 8, { source: 'migration', reasonCode: 'LATE_ENTRY' })] },
    ], null);
    expect(out.map((f) => [f.dayIndex, f.kind, f.originallyLate, f.previousHours, f.current.hours, f.history.map((h) => h.revision)])).toEqual([
      [1, 'correction', false, 6, 5, [1, 2, 3]],
      [2, 'late', false, null, 4, [1]],
      [3, 'correction', true, 2, 3, [1, 2]],
    ]);
  });

  it('sinceReturned: only revisions recorded after the last return', () => {
    const out = flaggedCells([
      { rowId: 'A', dayIndex: 1, revisions: [rev(1, 8), rev(2, 6, { createdAt: '2026-03-16T11:59:59.000Z' })] },
      { rowId: 'A', dayIndex: 2, revisions: [rev(1, 8), rev(2, 7, { createdAt: '2026-03-16T12:00:01.000Z' })] },
    ], '2026-03-16T12:00:00.000Z');
    expect(out.map((f) => f.sinceReturned)).toEqual([false, true]);
    expect(flaggedCells([{ rowId: 'A', dayIndex: 2, revisions: [rev(1, 8), rev(2, 7, { createdAt: '2026-03-17T00:00:00.000Z' })] }], null)[0].sinceReturned).toBe(false);
  });

  it('grid order: day, then the row\'s position', () => {
    const c = (rowId: string, dayIndex: number) => ({ rowId, dayIndex, revisions: [rev(1, 1, { reasonCode: 'LATE_ENTRY' })] });
    expect(flaggedCells([c('B', 2), c('A', 2), c('B', 1)], null, ['B', 'A']).map((f) => `${f.rowId}${f.dayIndex}`)).toEqual(['B1', 'B2', 'A2']);
  });
});
