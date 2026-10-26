import { indirectCategoryLabel } from '@/lib/indirect-categories';

/**
 * A timesheet cell's true code (feature-plan-certified-outputs.md C4–C6): the cell identity is
 * COALESCE(charge_code_id, indirect_code_id, clin_id) — a charge code, an indirect code, or a legacy CLIN-only row.
 */
export type CellKind = 'charge' | 'clin' | 'indirect';

export function cellKind(e: { chargeCodeId: string | null; indirectCodeId: string | null }): CellKind {
  return e.chargeCodeId ? 'charge' : e.indirectCodeId ? 'indirect' : 'clin';
}

/** "NAV-0001", "CLIN 0001", or "LV-PTO (Leave)". */
export function cellCodeLabel(e: {
  kind: CellKind; chargeCode: string | null; clinNumber: string | null; indirectCode: string | null; indirectCategory: string | null;
}): string {
  if (e.kind === 'charge') return e.chargeCode ?? '—';
  if (e.kind === 'indirect') return `${e.indirectCode ?? '—'}${e.indirectCategory ? ` (${indirectCategoryLabel(e.indirectCategory)})` : ''}`;
  return `CLIN ${e.clinNumber ?? '—'}`;
}
