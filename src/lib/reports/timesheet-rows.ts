import { indirectCategoryLabel } from '@/lib/indirect-categories';
import { provenanceText, type ProvenanceInput } from '@/lib/provenance';

/**
 * The timesheet PDF's rows (feature-plan-certified-outputs.md C5): built from the period's LATEST-revision entries,
 * one row per true cell code — a charge code, a legacy CLIN, or an indirect code (with its category) — matching the
 * cell identity COALESCE(charge_code_id, indirect_code_id, clin_id). Never from assignments: indirect/leave hours,
 * two codes on one CLIN, and codes no longer assigned all appear. Pure and deterministic (ruling Q7: rows and totals
 * are identical on every reprint): fixed sort order, sums in integer hundredths.
 */

export type TimesheetRowKind = 'charge' | 'clin' | 'indirect';

/** One latest-revision entry, with its code's display facts (left-joined; null where not applicable). */
export interface TimesheetRowEntry extends ProvenanceInput {
  chargeCodeId: string | null;
  clinId: string | null;
  indirectCodeId: string | null;
  dayIndex: number;
  hours: string;
  chargeCode: string | null;
  chargeCodeName: string | null;
  clinNumber: string | null;
  clinDescription: string | null;
  contractName: string | null;
  contractNumber: string | null;
  slinNumber: string | null;
  indirectCode: string | null;
  indirectName: string | null;
  indirectCategory: string | null;
}

export interface TimesheetRow {
  kind: TimesheetRowKind;
  /** The charge code, "CLIN 0001", or the indirect code. */
  code: string;
  description: string;
  contractName: string | null;
  contractNumber: string | null;
  clinNumber: string | null;
  /** The row's SLIN when all its entries share one, else null. */
  slinNumber: string | null;
  /** Indirect rows: the category's display name ("Leave", "G&A", …). */
  category: string | null;
  dailyHours: number[];
  totalHours: number;
  /** Distinct provenance labels of the row's imported cells (C1 "Display"), sorted; empty for app-recorded rows. */
  provenance: string[];
}

export interface TimesheetRowsResult {
  rows: TimesheetRow[];
  dailyTotals: number[];
  grandTotal: number;
}

const KIND_ORDER: Record<TimesheetRowKind, number> = { charge: 0, clin: 1, indirect: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hundredths = (hours: string) => Math.round((parseFloat(hours) || 0) * 100);

export function buildTimesheetRows(entries: TimesheetRowEntry[], numDays: number): TimesheetRowsResult {
  const groups = new Map<string, { id: string; kind: TimesheetRowKind; first: TimesheetRowEntry; cents: number[]; slins: Set<string | null>; provenance: Set<string> }>();
  const dayCents = new Array<number>(numDays).fill(0);

  for (const e of entries) {
    if (e.dayIndex < 0 || e.dayIndex >= numDays) continue;
    const kind: TimesheetRowKind = e.chargeCodeId ? 'charge' : e.indirectCodeId ? 'indirect' : 'clin';
    const id = (e.chargeCodeId ?? e.indirectCodeId ?? e.clinId)!;
    const key = `${kind}:${id}`;
    let g = groups.get(key);
    if (!g) {
      g = { id, kind, first: e, cents: new Array<number>(numDays).fill(0), slins: new Set(), provenance: new Set() };
      groups.set(key, g);
    }
    const c = hundredths(e.hours);
    g.cents[e.dayIndex] += c;
    dayCents[e.dayIndex] += c;
    g.slins.add(e.slinNumber);
    const label = provenanceText(e);
    if (label) g.provenance.add(label);
  }

  const rows = [...groups.values()].map((g) => {
    const e = g.first;
    const slin = g.slins.size === 1 ? [...g.slins][0] : null;
    const base = {
      kind: g.kind,
      contractName: g.kind === 'indirect' ? null : e.contractName,
      contractNumber: g.kind === 'indirect' ? null : e.contractNumber,
      clinNumber: g.kind === 'indirect' ? null : e.clinNumber,
      slinNumber: g.kind === 'indirect' ? null : slin,
      dailyHours: g.cents.map((c) => c / 100),
      totalHours: g.cents.reduce((s, c) => s + c, 0) / 100,
      provenance: [...g.provenance].sort(cmp),
    };
    const sortKey = [String(KIND_ORDER[g.kind])];
    let row: TimesheetRow;
    if (g.kind === 'charge') {
      row = { ...base, code: e.chargeCode ?? '', description: e.chargeCodeName ?? '', category: null };
      sortKey.push(e.contractName ?? '', e.clinNumber ?? '', row.code);
    } else if (g.kind === 'clin') {
      row = { ...base, code: `CLIN ${e.clinNumber ?? ''}`, description: e.clinDescription ?? '', category: null };
      sortKey.push(e.contractName ?? '', e.clinNumber ?? '');
    } else {
      const category = e.indirectCategory ? indirectCategoryLabel(e.indirectCategory) : null;
      row = { ...base, code: e.indirectCode ?? '', description: e.indirectName ?? '', category };
      sortKey.push(category ?? '', row.code);
    }
    sortKey.push(g.id);
    return { row, sortKey };
  });

  rows.sort((a, b) => {
    for (let i = 0; i < Math.max(a.sortKey.length, b.sortKey.length); i++) {
      const d = cmp(a.sortKey[i] ?? '', b.sortKey[i] ?? '');
      if (d !== 0) return d;
    }
    return 0;
  });

  return {
    rows: rows.map((r) => r.row),
    dailyTotals: dayCents.map((c) => c / 100),
    grandTotal: dayCents.reduce((s, c) => s + c, 0) / 100,
  };
}

/** The row's label on the PDF. */
export function timesheetRowLabel(r: TimesheetRow): string {
  if (r.kind === 'indirect') return `${r.code} — ${r.description}${r.category ? ` (${r.category})` : ''}`;
  const where = `${r.contractName ?? ''} CLIN ${r.clinNumber ?? ''}${r.slinNumber ? ` SLIN ${r.slinNumber}` : ''}`.trim();
  return r.kind === 'clin' ? `${r.code} — ${r.contractName ?? ''}${r.slinNumber ? ` SLIN ${r.slinNumber}` : ''}` : `${r.code} — ${where}`;
}
