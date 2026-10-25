/**
 * Which timesheet cells may change (feature-plan-certified-outputs.md C4, CO-D8/CO-D15, rulings Q1/Q4). Pure — the grid
 * uses `isCellEditable`, and saveTimesheetBatch applies the same rule per cell inside its transaction.
 *
 * One rule for every kind of row: a day WITH a prior revision is correctable (changed or zeroed out, reason code
 * required) whether or not the code is still assigned or active; a day WITHOUT a prior revision is editable only when
 * the row is assignable. Legacy CLIN rows are never assignable. Submitted/approved periods, future dates and read-only
 * workspaces stay locked.
 */
export function isCellEditable(c: {
  periodEditable: boolean;
  isFutureDate: boolean;
  assignable: boolean;
  priorRevision: number;
}): boolean {
  if (!c.periodEditable || c.isFutureDate) return false;
  return c.priorRevision > 0 || c.assignable;
}

export type NewCellRefusal = 'not-assigned' | 'code-inactive' | 'clin-only' | 'indirect-unavailable';

/** Server-side: may a cell with NO prior revision be created? (Cells with one skip these checks.) */
export function newCellRefusal(cell:
  | { kind: 'charge'; assigned: boolean; codeActive: boolean; clinActive: boolean; contractActive: boolean }
  | { kind: 'indirect'; active: boolean; availableToAll: boolean }
  | { kind: 'clin' }): NewCellRefusal | null {
  if (cell.kind === 'clin') return 'clin-only';
  if (cell.kind === 'indirect') return cell.active && cell.availableToAll ? null : 'indirect-unavailable';
  if (!cell.assigned) return 'not-assigned';
  return cell.codeActive && cell.clinActive && cell.contractActive ? null : 'code-inactive';
}
