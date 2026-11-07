/**
 * R3 (feature-plan-ux-people-codes.md): a late row is an app-recorded revision 1 that carries a reason — the same ROW rule
 * as Approvals (period-flags.ts / flagged-cells.ts) and the server's AUDIT_LATE_ROW. Client-safe.
 */
export const isLateEntry = (e: { revisionNumber: number; source: string; changeReasonCode: string | null }) =>
  e.revisionNumber === 1 && e.source === 'app' && !!e.changeReasonCode;
