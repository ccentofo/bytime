import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C3 / §9 rows "Unpriced", "Cost basis", "Unpriced visibility": the resolution rule
 * (decideCostBasis and the SQL it mirrors), the import restriction (only cost-basis.ts reads labor categories for
 * reports/dashboards), the overlap report, the "how to fix" text, and the founder's before/after report.
 */

vi.mock('server-only', () => ({}));

import { COST_BASIS_LATERAL, decideCostBasis, findOverlaps, unpricedFixText, pricedCostSum, unpricedHoursSum } from '@/server/internal/cost-basis';
import { chargeCodeLaborCategoryOnSql, hourlyRateOnSql } from '@/server/internal/labor-rates';
import { sql } from 'drizzle-orm';
import { formatCostBasisChange, mergeCostRows } from '../../../scripts/lib/cost-basis-change';
import { unpricedHoursLabel, CURRENT_RATES_NOTE } from '@/lib/cost-labels';

const ROOT = path.resolve(__dirname, '../../..');

describe('decideCostBasis (CO-D10) — most specific first, never guess', () => {
  it('a charge code with a labor category uses it, whatever the assignments say', () => {
    expect(decideCostBasis({ chargeCodeCategory: 'cc-lc', slinCategories: ['a', 'b'], clinCategories: ['c'] }))
      .toEqual({ basis: 'priced', laborCategoryId: 'cc-lc', level: 'charge-code' });
  });

  it('a SLIN-matched assignment is used for a SLIN entry (before the CLIN level)', () => {
    expect(decideCostBasis({ chargeCodeCategory: null, slinCategories: ['slin-lc', 'slin-lc'], clinCategories: ['clin-lc'] }))
      .toEqual({ basis: 'priced', laborCategoryId: 'slin-lc', level: 'slin' });
  });

  it('CLIN level when there is nothing at the SLIN level', () => {
    expect(decideCostBasis({ chargeCodeCategory: null, slinCategories: [], clinCategories: ['clin-lc'] }))
      .toEqual({ basis: 'priced', laborCategoryId: 'clin-lc', level: 'clin' });
  });

  it('two different categories at the deciding level → unpriced "conflict" (never pick one)', () => {
    expect(decideCostBasis({ chargeCodeCategory: null, slinCategories: [], clinCategories: ['a', 'b'] }))
      .toEqual({ basis: 'conflict', laborCategoryId: null, level: 'clin' });
    expect(decideCostBasis({ chargeCodeCategory: null, slinCategories: ['a', 'b'], clinCategories: ['c'] }))
      .toEqual({ basis: 'conflict', laborCategoryId: null, level: 'slin' });
  });

  it('no candidates → unpriced "no-category"', () => {
    expect(decideCostBasis({ chargeCodeCategory: null, slinCategories: [], clinCategories: [] }))
      .toEqual({ basis: 'no-category', laborCategoryId: null, level: null });
  });
});

describe('the SQL resolution (COST_BASIS_LATERAL) mirrors decideCostBasis', () => {
  const { sql: text } = new PgDialect().sqlToQuery(COST_BASIS_LATERAL);
  const flat = text.replace(/\s+/g, ' ');

  it('level 1: the entry\'s charge code\'s labor category ON THE ENTRY\'S DATE (dated rates D3: dated change, else starting)', () => {
    expect(flat).toContain('(SELECT dr_cc_change.labor_category_id FROM charge_code_labor_categories dr_cc_change WHERE dr_cc_change.charge_code_id = "timesheet_entries"."charge_code_id" AND dr_cc_change.effective_date <= "timesheet_entries"."entry_date" ORDER BY dr_cc_change.effective_date DESC LIMIT 1)');
    expect(flat).toContain('(SELECT dr_cc_start.labor_category_id FROM charge_codes dr_cc_start WHERE dr_cc_start.id = "timesheet_entries"."charge_code_id") ) AS l1');
  });

  it('H1 (dated-rates audit): no builder alias shadows a caller alias — no `x.labor_category_id = x.labor_category_id` (or charge_code_id) self-comparison', () => {
    expect(flat).not.toMatch(/(\w+)\.labor_category_id = \1\.labor_category_id/);
    expect(flat).not.toMatch(/(\w+)\.charge_code_id = \1\.charge_code_id/);
    // Same with drizzle's quoted column references (e.g. "timesheet_entries"."charge_code_id").
    const unquoted = flat.replace(/"/g, '');
    expect(unquoted).not.toMatch(/(\w+)\.labor_category_id = \1\.labor_category_id/);
    expect(unquoted).not.toMatch(/(\w+)\.charge_code_id = \1\.charge_code_id/);
    // The rate is applied to the lateral's resolved category, one level outside the resolution (derived tables
    // `resolved` / `counts`), and the builder's own table is `dr_rate`.
    expect(flat).toContain('WHERE dr_rate.labor_category_id = resolved.labor_category_id AND dr_rate.effective_date <= "timesheet_entries"."entry_date"');
    expect(flat).toMatch(/\) counts \) resolved \) cost_basis$/);
  });

  it('H1: the builders render only their prefixed internal aliases (plus whatever the caller passes)', () => {
    const qualifiers = (q: ReturnType<typeof sql>) => new Set([...new PgDialect().sqlToQuery(q).sql.matchAll(/\b([a-z_][a-z0-9_]*)\./gi)].map((m) => m[1]));
    expect(qualifiers(hourlyRateOnSql({ laborCategoryId: sql`caller.labor_category_id`, onDate: sql`caller.d` }))).toEqual(new Set(['dr_rate', 'dr_start', 'caller']));
    expect(qualifiers(chargeCodeLaborCategoryOnSql({ chargeCodeId: sql`caller.charge_code_id`, onDate: sql`caller.d` }))).toEqual(new Set(['dr_cc_change', 'dr_cc_start', 'caller']));
  });

  it('level 2 only on the entry\'s OWN SLIN; level 3 only CLIN-level categories (slin_id IS NULL) — a SLIN category on another SLIN never applies', () => {
    expect(flat).toContain('AND "timesheet_entries"."slin_id" IS NOT NULL AND lc2.slin_id = "timesheet_entries"."slin_id"');
    expect(flat).toContain('AND lc3.clin_id = "timesheet_entries"."clin_id" AND lc3.slin_id IS NULL');
  });

  it('assignments effective on the entry date (inclusive end), counted as DISTINCT categories', () => {
    for (const u of ['ulc2', 'ulc3']) {
      expect(flat).toContain(`${u}.user_id = "timesheet_entries"."user_id" AND ${u}.effective_date <= "timesheet_entries"."entry_date" AND (${u}.end_date IS NULL OR ${u}.end_date >= "timesheet_entries"."entry_date")`);
      expect(flat).toContain(`count(DISTINCT ${u}.labor_category_id)`);
    }
  });

  it('the decision CASE: l1, else exactly one at SLIN, else (none at SLIN and) exactly one at CLIN; >1 → conflict; else no-category', () => {
    expect(flat).toContain("CASE WHEN counts.l1 IS NOT NULL THEN counts.l1 WHEN counts.n2 = 1 THEN counts.sole2 WHEN counts.n2 = 0 AND counts.n3 = 1 THEN counts.sole3 END AS labor_category_id");
    expect(flat).toContain("CASE WHEN counts.l1 IS NOT NULL OR counts.n2 = 1 OR (counts.n2 = 0 AND counts.n3 = 1) THEN 'priced' WHEN counts.n2 > 1 OR (counts.n2 = 0 AND counts.n3 > 1) THEN 'conflict' ELSE 'no-category' END AS basis");
  });

  it('no status filter (a deactivated category still prices the hours it covered)', () => {
    expect(flat).not.toMatch(/status/i);
  });

  it('cost sums only PRICED entries; unpriced hours are summed separately', () => {
    const cost = new PgDialect().sqlToQuery(pricedCostSum).sql.replace(/\s+/g, ' ');
    const unpriced = new PgDialect().sqlToQuery(unpricedHoursSum).sql.replace(/\s+/g, ' ');
    // Dated rates D1.4: priced at the rate in effect on the entry's date (applied_rate from the lateral).
    expect(cost).toContain("CASE WHEN cost_basis.basis = 'priced' THEN CAST(\"timesheet_entries\".\"hours\" AS NUMERIC) * cost_basis.applied_rate ELSE 0 END");
    expect(unpriced).toContain("CASE WHEN cost_basis.basis <> 'priced' THEN CAST(\"timesheet_entries\".\"hours\" AS NUMERIC) ELSE 0 END");
  });
});

// ── static: only cost-basis.ts resolves labor categories for reports/dashboards ──────────────────────────────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Files allowed to import userLaborCategories / laborCategories from the schema (CRUD, import, export, cleanup). */
const LCAT_IMPORT_ALLOWLIST = new Set([
  'src/server/internal/cost-basis.ts',          // the one resolution
  'src/db/schema.ts',
  'src/lib/export/allowlists.ts',                // workspace export
  'src/server/actions/labor-categories.ts',      // CRUD + the report actions (which call cost-basis.ts)
  'src/server/actions/charge-codes.ts',          // CRUD
  'src/server/actions/import.ts',                // bulk import
  'src/server/internal/setup.ts',                // setup checklist counts
  'src/db/clear-tenant-data.ts',                 // test / seed cleanup (namespace import)
  'src/server/internal/labor-rates.ts',          // dated rates D1.3: the one SQL rate rule + schedule readers
  'src/server/actions/labor-category-rates.ts',  // dated rates D1.5: the rate actions
]);

export function lcatImporters(src: string): boolean {
  const code = stripComments(src);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*db\/schema['"]/g)) {
    if (m[1].split(',').map((s) => s.trim()).some((n) => n === 'userLaborCategories' || n === 'laborCategories')) return true;
  }
  // Fix round 1 (T5): a namespace import used as schema.laborCategories, or the raw table names inside a sql template.
  if (/\bschema\.(userLaborCategories|laborCategories)\b/.test(code)) return true;
  for (const m of code.matchAll(/\bsql(?:<[^>`]*>)?`((?:[^`\\]|\\.)*)`/g)) {
    if (/\b(user_)?labor_categories\b/.test(m[1])) return true;
  }
  return false;
}

describe('static: labor categories are resolved for costs only through cost-basis.ts', () => {
  it('no other src module imports userLaborCategories / laborCategories', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !LCAT_IMPORT_ALLOWLIST.has(rel) && lcatImporters(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every allowlisted importer still imports them (no stale entries), except the schema', () => {
    for (const rel of LCAT_IMPORT_ALLOWLIST) {
      if (rel === 'src/db/schema.ts') continue;
      expect(lcatImporters(readFileSync(path.join(ROOT, rel), 'utf8')), rel).toBe(true);
    }
  });

  it('fixture: a report importing laborCategories directly is flagged', () => {
    expect(lcatImporters("import { users, laborCategories } from '@/db/schema';")).toBe(true);
    expect(lcatImporters("import { users } from '@/db/schema';")).toBe(false);
  });

  it('T5 fixture: schema.laborCategories via a namespace import, and raw table names in sql, are flagged', () => {
    expect(lcatImporters("import * as schema from '@/db/schema'; db.select().from(schema.userLaborCategories);")).toBe(true);
    expect(lcatImporters("import * as schema from '@/db/schema'; db.select().from(schema.users);")).toBe(false);
    expect(lcatImporters('const q = sql`SELECT hourly_rate FROM labor_categories WHERE id = ${x.id}`;')).toBe(true);
    expect(lcatImporters('const q = sql<number>`(SELECT 1 FROM user_labor_categories ulc)`;')).toBe(true);
    expect(lcatImporters("const label = 'labor_categories.csv id';")).toBe(false); // a plain string is not a query
  });

  it('all five former join sites use the lateral resolution (detailed, summary, CLIN, SLIN, period report)', () => {
    const count = (rel: string) => (readFileSync(path.join(ROOT, rel), 'utf8').match(/\.leftJoinLateral\(COST_BASIS_LATERAL, sql`true`\)/g) ?? []).length;
    expect(count('src/server/internal/reports.ts')).toBe(1);
    expect(count('src/server/actions/reports.ts')).toBe(1);
    expect(count('src/server/actions/dashboard.ts')).toBe(2); // summary, SLIN
    expect(count('src/server/internal/dashboard.ts')).toBe(1); // CLIN — the shared clinCostTotals (UX-2 §4.5, also Home)
  });
});

describe('Overlapping assignments report', () => {
  const row = (o: Record<string, unknown>) => ({
    assignmentId: 'x', userId: 'u1', employeeName: 'Pat', effectiveDate: '2026-01-01', endDate: null as string | null,
    lcId: 'lc-a', lcatCode: 'A', title: 'Analyst', clinId: 'clin1', clinNumber: '0001', slinId: null as string | null, slinNumber: null as string | null, ...o,
  });

  it('lists different categories at the same level whose dates overlap; a promotion (end yesterday, start today) does not overlap', () => {
    const overlaps = findOverlaps([
      row({ assignmentId: 'a1', lcId: 'lc-a', lcatCode: 'A', endDate: '2026-06-30' }),
      row({ assignmentId: 'a2', lcId: 'lc-b', lcatCode: 'B', effectiveDate: '2026-06-30' }),          // overlaps on 06-30
      row({ assignmentId: 'p1', userId: 'u2', employeeName: 'Jo', lcId: 'lc-a', endDate: '2026-05-31' }),
      row({ assignmentId: 'p2', userId: 'u2', employeeName: 'Jo', lcId: 'lc-b', effectiveDate: '2026-06-01' }), // promotion: no overlap
      row({ assignmentId: 's1', userId: 'u3', lcId: 'lc-a', slinId: 's1', slinNumber: '0001AA' }),
      row({ assignmentId: 's2', userId: 'u3', lcId: 'lc-b' }),                                          // different level → no overlap
    ]);
    expect(overlaps.map((o) => [o.employeeName, o.a.assignmentId, o.b.assignmentId, o.level])).toEqual([['Pat', 'a1', 'a2', 'clin']]);
  });
});

describe('Unpriced hours "how to fix"', () => {
  const base = { employeeName: 'Pat Doe', clinNumber: '0001', slinNumber: null as string | null, entryDate: '2026-09-02', conflicting: [] as Array<{ id: string; lcatCode: string; title: string }>, level: null as 'slin' | 'clin' | 'charge-code' | null };
  it('no-category: set the charge code\'s category, or give the employee one on the SLIN/CLIN effective that date', () => {
    expect(unpricedFixText({ ...base, reason: 'no-category', chargeCode: 'NAV-0001' }))
      .toBe('Set a labor category on charge code NAV-0001, or give Pat Doe a labor category on CLIN 0001 effective 2026-09-02.');
    expect(unpricedFixText({ ...base, reason: 'no-category', chargeCode: null, slinNumber: '0001AA' }))
      .toBe('Give Pat Doe a labor category on SLIN 0001AA effective 2026-09-02.');
  });
  it('conflict: names the competing categories and says to end one', () => {
    expect(unpricedFixText({ ...base, reason: 'conflict', chargeCode: 'NAV-0001', level: 'clin', conflicting: [{ id: '1', lcatCode: 'SE2', title: '' }, { id: '2', lcatCode: 'SE3', title: '' }] }))
      .toBe('Pat Doe has SE2 and SE3 on CLIN 0001 effective 2026-09-02 — end one.');
  });
});

describe('totals never quietly shrink (CO-D17)', () => {
  it('"X hours unpriced" label (none when 0)', () => {
    expect(unpricedHoursLabel(0)).toBeNull();
    expect(unpricedHoursLabel(1)).toBe('1 hour unpriced');
    expect(unpricedHoursLabel(12.345)).toBe('12.35 hours unpriced');
  });

  it('the dashboard shows the note beside every cost total (contract, CLIN, SLIN, overview, period report) and labels funding "priced cost"', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/admin/dashboard/DashboardClient.tsx'), 'utf8');
    expect(src).toMatch(/<UnpricedNote hours=\{row\.original\.unpricedHours\} scope=\{\{ contractId: row\.original\.contractId \}\}/);
    expect(src).toMatch(/<UnpricedNote hours=\{clin\.unpricedHours\} scope=\{\{ clinId: clin\.clinId \}\}/);
    expect(src).toMatch(/<UnpricedNote hours=\{slin\.unpricedHours\} scope=\{\{ slinId: slin\.slinId \}\}/);
    expect(src).toMatch(/<UnpricedNote hours=\{totalUnpriced\}/);
    expect(src).toMatch(/<UnpricedNote hours=\{reportUnpriced\}/);
    expect(src).toMatch(/row\.original\.unpricedHours > 0 && <Text size="xs" c="dimmed">priced cost<\/Text>/);
  });

  it('Home (UX-2 §4.5): the Contracts card says "priced cost" (never "spent"), shows unpriced hours per contract and the note', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/(app)/home/HomeClient.tsx'), 'utf8');
    expect(src).toContain('priced cost of');
    expect(src).not.toMatch(/\bspent\b/i);
    expect(src).toMatch(/unpricedHoursLabel\(c\.unpricedHours\)/);
    expect(src).toContain('{CURRENT_RATES_NOTE}');
  });

  it('the CO-D7 note appears on every cost view: dashboard, reports screen, CSV, XLSX, the Unpriced report', () => {
    for (const rel of [
      'src/app/(app)/admin/dashboard/DashboardClient.tsx', 'src/app/(app)/admin/reports/ReportsClient.tsx',
      'src/app/api/reports/cost-report-csv/route.ts', 'src/lib/reports/cost-report-excel.ts', 'src/app/(app)/admin/labor-categories/CostBasisReports.tsx',
      'src/app/(app)/home/HomeClient.tsx', // UX-2 §4.5: Home's Contracts card
    ]) expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toContain('CURRENT_RATES_NOTE');
    expect(CURRENT_RATES_NOTE).toBe('Costs use the labor-category rate in effect on each day worked.'); // dated rates D2
  });
});

describe('report:cost-basis-change (founder before/after, read-only)', () => {
  it('prints old vs new cost, the difference and unpriced hours per contract / CLIN / SLIN', () => {
    const rows = mergeCostRows(
      [
        { key: 'clin:1', contract: 'NAVAIR', clin: '0001', slin: null },
        { key: 'slin:9', contract: 'NAVAIR', clin: '0001', slin: '0001AA' },
        { key: 'clin:2', contract: 'DISA', clin: '0002', slin: null },
      ],
      new Map([['clin:1', 1000], ['slin:9', 400]]),
      new Map([['clin:1', { cost: 800, unpricedHours: 4 }], ['clin:2', { cost: 50, unpricedHours: 0 }]]),
    );
    expect(rows).toEqual([
      { contract: 'DISA', clin: '0002', slin: null, oldCost: 0, newCost: 50, unpricedHours: 0 },
      { contract: 'NAVAIR', clin: '0001', slin: null, oldCost: 1000, newCost: 800, unpricedHours: 4 },
      { contract: 'NAVAIR', clin: '0001', slin: '0001AA', oldCost: 400, newCost: 0, unpricedHours: 0 },
    ]);
    const out = formatCostBasisChange(rows);
    expect(out).toContain('NAVAIR | 0001 | — | $1,000.00 | $800.00 | -$200.00 | 4');
    expect(out).toContain('DISA | 0002 | — | $0.00 | $50.00 | +$50.00 | 0');
    expect(out).toContain('TOTAL (CLIN lines) | | | $1,000.00 | $850.00 | | 4');
  });

  it('the script is read-only, prints the target banner, freezes the old join and is wired as an npm script', () => {
    const script = stripComments(readFileSync(path.join(ROOT, 'scripts/report-cost-basis-change.ts'), 'utf8'));
    expect(script).not.toMatch(/\.(insert|update|delete)\(/);
    expect(script).toMatch(/printTargetBanner\(\)/);
    expect(script).toMatch(/eq\(laborCategories\.status, 'active'\)/); // the frozen pre-C3 join
    expect(script).toMatch(/\.leftJoinLateral\(COST_BASIS_LATERAL, sql`true`\)/);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['report:cost-basis-change']).toBe('node --conditions=react-server --import tsx scripts/report-cost-basis-change.ts');
  });
});
