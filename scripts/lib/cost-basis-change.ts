/**
 * The before/after comparison for `npm run report:cost-basis-change` (feature-plan-certified-outputs.md C3, CO-D17).
 * Pure, so it is unit-testable: the script supplies the old-resolution and new-resolution costs per CLIN and SLIN.
 */

export interface CostRow {
  contract: string;
  clin: string;
  slin: string | null;
  oldCost: number;
  newCost: number;
  unpricedHours: number;
}

export interface Keyed { key: string; contract: string; clin: string; slin: string | null }

/** Merge the old and new per-CLIN/SLIN costs (a line exists if either side has one). */
export function mergeCostRows(
  labels: Keyed[],
  oldCost: Map<string, number>,
  newCost: Map<string, { cost: number; unpricedHours: number }>,
): CostRow[] {
  const round = (n: number) => Math.round(n * 100) / 100;
  return labels
    .filter((l) => oldCost.has(l.key) || newCost.has(l.key))
    .map((l) => ({
      contract: l.contract, clin: l.clin, slin: l.slin,
      oldCost: round(oldCost.get(l.key) ?? 0),
      newCost: round(newCost.get(l.key)?.cost ?? 0),
      unpricedHours: round(newCost.get(l.key)?.unpricedHours ?? 0),
    }))
    .sort((a, b) => a.contract.localeCompare(b.contract) || a.clin.localeCompare(b.clin) || (a.slin ?? '').localeCompare(b.slin ?? ''));
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The printed table: per contract / CLIN / SLIN — old cost, new cost, difference, unpriced hours. */
export function formatCostBasisChange(rows: CostRow[]): string {
  if (rows.length === 0) return 'No costed hours in this workspace — nothing changes.';
  const lines = ['Contract | CLIN | SLIN | Old cost | New cost | Difference | Unpriced hours'];
  for (const r of rows) {
    const diff = Math.round((r.newCost - r.oldCost) * 100) / 100;
    lines.push(`${r.contract} | ${r.clin} | ${r.slin ?? '—'} | ${money(r.oldCost)} | ${money(r.newCost)} | ${diff >= 0 ? '+' : '-'}${money(Math.abs(diff))} | ${r.unpricedHours}`);
  }
  const clinRows = rows.filter((r) => r.slin === null);
  const total = (f: (r: CostRow) => number) => Math.round(clinRows.reduce((s, r) => s + f(r), 0) * 100) / 100;
  lines.push(`TOTAL (CLIN lines) | | | ${money(total((r) => r.oldCost))} | ${money(total((r) => r.newCost))} | | ${total((r) => r.unpricedHours)}`);
  return lines.join('\n');
}
