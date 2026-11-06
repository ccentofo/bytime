/**
 * The review's "Worth a look" cells (feature-plan-ux-approvals-payroll.md A4, §3.1.5). Pure, shared by the server
 * (getTimesheetForReview) and its tests. App-recorded revisions decide the flag, so the counts match the list's:
 *  - correction: the cell's latest app revision is > 1;
 *  - late: revision 1 (app) carries a reason AND the cell was never revised (a late cell later corrected is a
 *    correction, marked `originallyLate`);
 *  - sinceReturned: the latest revision was recorded after the last return.
 */

export interface CellRevision {
  revision: number;
  hours: number;
  reasonCode: string | null;
  comment: string | null;
  /** ISO instant. */
  createdAt: string;
  source: string;
}

export interface CellChain {
  rowId: string;
  dayIndex: number;
  /** Every revision of the cell, ascending. */
  revisions: CellRevision[];
}

export interface FlaggedCell {
  rowId: string;
  dayIndex: number;
  kind: 'correction' | 'late';
  originallyLate: boolean;
  sinceReturned: boolean;
  current: CellRevision;
  /** The hours before the latest revision (corrections); null for a late entry. */
  previousHours: number | null;
  history: CellRevision[];
}

export interface LastReturn {
  comment: string | null;
  byName: string | null;
  /** ISO instant of the return. */
  at: string;
}

/** Flagged cells in grid order: day, then the row's position (`rowOrder`; unknown rows last). */
export function flaggedCells(chains: CellChain[], lastReturnAt: string | null, rowOrder: string[] = []): FlaggedCell[] {
  const out: FlaggedCell[] = [];
  for (const chain of chains) {
    const history = [...chain.revisions].sort((a, b) => a.revision - b.revision);
    const app = history.filter((r) => r.source === 'app');
    if (app.length === 0) continue;
    const maxAppRev = Math.max(...app.map((r) => r.revision));
    const late1 = app.some((r) => r.revision === 1 && r.reasonCode !== null);
    const kind = maxAppRev > 1 ? 'correction' : late1 ? 'late' : null;
    if (!kind) continue;
    const current = history[history.length - 1];
    out.push({
      rowId: chain.rowId,
      dayIndex: chain.dayIndex,
      kind,
      originallyLate: kind === 'correction' && late1,
      sinceReturned: lastReturnAt !== null && new Date(current.createdAt).getTime() > new Date(lastReturnAt).getTime(),
      current,
      previousHours: kind === 'correction' && history.length > 1 ? history[history.length - 2].hours : null,
      history,
    });
  }
  const pos = (id: string) => { const i = rowOrder.indexOf(id); return i < 0 ? rowOrder.length : i; };
  return out.sort((a, b) => a.dayIndex - b.dayIndex || pos(a.rowId) - pos(b.rowId) || a.rowId.localeCompare(b.rowId));
}
