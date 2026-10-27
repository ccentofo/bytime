import 'server-only';
import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbTx, ReadDb } from '@/db';
import type { CalendarDate } from '@/lib/calendar-date';
import { chargeCodeLaborCategoryOnSql, hourlyRateOnSql } from './labor-rates';
import { chargeCodes, clins, laborCategories, slins, timesheetEntries, userLaborCategories, users } from '@/db/schema';

/**
 * THE labor-category resolution for costing (feature-plan-certified-outputs.md C3, CO-D10). The only module that may
 * read `user_labor_categories` / `labor_categories` for report and dashboard costs (a static test enforces it).
 *
 * Per latest-revision entry, the applicable labor category is, most specific first:
 *   1. the entry's charge code's labor category on the entry's date (dated rates D3: its dated changes, else
 *      `charge_codes.labor_category_id`), when it has one; else
 *   2. the employee's assignments effective on the entry date whose category is on the entry's SLIN; else
 *   3. the employee's assignments effective on the date whose category is on the entry's CLIN with NO SLIN.
 * At the first level with candidates: exactly one distinct category → priced with it; two or more → UNPRICED
 * ('conflict' — never pick one). No candidates at any level → UNPRICED ('no-category'; a SLIN-level category on a
 * different SLIN never applies). Unpriced entries count in hours totals and contribute no cost. No `status` filter: a
 * deactivated category still prices the hours it covered. The RATE is the one in effect on the entry's date
 * (feature-plan-dated-rates.md D1.4): `applied_rate`, computed inside the lateral by hourlyRateOnSql — the only SQL
 * rate rule. This module never reads a rate column itself.
 *
 * Use in a query over `timesheet_entries`:
 *   .leftJoinLateral(COST_BASIS_LATERAL, sql`true`).leftJoin(costLaborCategory, COST_LC_ON)
 * then select costBasisFields / pricedCostSum / unpricedHoursSum.
 */

export type CostBasis = 'priced' | 'conflict' | 'no-category';
export type CostBasisLevel = 'charge-code' | 'slin' | 'clin' | null;

/** Pure mirror of the SQL CASE below — for unit tests and in-memory callers. Keep the two in step. */
export function decideCostBasis(c: {
  chargeCodeCategory: string | null;
  slinCategories: string[];
  clinCategories: string[];
}): { basis: CostBasis; laborCategoryId: string | null; level: CostBasisLevel } {
  if (c.chargeCodeCategory) return { basis: 'priced', laborCategoryId: c.chargeCodeCategory, level: 'charge-code' };
  const slin = [...new Set(c.slinCategories)];
  if (slin.length === 1) return { basis: 'priced', laborCategoryId: slin[0], level: 'slin' };
  if (slin.length > 1) return { basis: 'conflict', laborCategoryId: null, level: 'slin' };
  const clin = [...new Set(c.clinCategories)];
  if (clin.length === 1) return { basis: 'priced', laborCategoryId: clin[0], level: 'clin' };
  if (clin.length > 1) return { basis: 'conflict', laborCategoryId: null, level: 'clin' };
  return { basis: 'no-category', laborCategoryId: null, level: null };
}

/** Level 1 (dated rates D3): the entry's charge code's category ON THE ENTRY'S DATE (starting category, else dated). */
const CHARGE_CODE_CATEGORY = chargeCodeLaborCategoryOnSql({ chargeCodeId: sql`${timesheetEntries.chargeCodeId}`, onDate: sql`${timesheetEntries.entryDate}` });

/**
 * The resolved category's rate on the entry's date (dated rates D1.4). Applied one level OUTSIDE the resolution, to its
 * `resolved.labor_category_id`, so the CASE that picks the category is never repeated. NULL when unpriced.
 */
const APPLIED_RATE = hourlyRateOnSql({ laborCategoryId: sql`resolved.labor_category_id`, onDate: sql`${timesheetEntries.entryDate}` });

/**
 * LEFT JOIN LATERAL … AS cost_basis(labor_category_id, basis, level, applied_rate): exactly one row per entry.
 * Correlated to the outer `timesheet_entries` row by its real table name (callers must not alias timesheet_entries).
 */
export const COST_BASIS_LATERAL: SQL = sql`(
  SELECT resolved.labor_category_id, resolved.basis, resolved.level, ${APPLIED_RATE} AS applied_rate
  FROM (
  SELECT
    CASE WHEN counts.l1 IS NOT NULL THEN counts.l1
         WHEN counts.n2 = 1 THEN counts.sole2
         WHEN counts.n2 = 0 AND counts.n3 = 1 THEN counts.sole3 END AS labor_category_id,
    CASE WHEN counts.l1 IS NOT NULL OR counts.n2 = 1 OR (counts.n2 = 0 AND counts.n3 = 1) THEN 'priced'
         WHEN counts.n2 > 1 OR (counts.n2 = 0 AND counts.n3 > 1) THEN 'conflict'
         ELSE 'no-category' END AS basis,
    CASE WHEN counts.l1 IS NOT NULL THEN 'charge-code' WHEN counts.n2 > 0 THEN 'slin' WHEN counts.n3 > 0 THEN 'clin' END AS level
  FROM (
    SELECT
      ${CHARGE_CODE_CATEGORY} AS l1,
      s2.n AS n2, s2.sole AS sole2, s3.n AS n3, s3.sole AS sole3
    FROM
      (SELECT count(DISTINCT ulc2.labor_category_id)::int AS n, min(ulc2.labor_category_id::text)::uuid AS sole
        FROM user_labor_categories ulc2 JOIN labor_categories lc2 ON lc2.id = ulc2.labor_category_id
        WHERE ulc2.user_id = ${timesheetEntries.userId}
          AND ulc2.effective_date <= ${timesheetEntries.entryDate}
          AND (ulc2.end_date IS NULL OR ulc2.end_date >= ${timesheetEntries.entryDate})
          AND ${timesheetEntries.slinId} IS NOT NULL AND lc2.slin_id = ${timesheetEntries.slinId}) s2,
      (SELECT count(DISTINCT ulc3.labor_category_id)::int AS n, min(ulc3.labor_category_id::text)::uuid AS sole
        FROM user_labor_categories ulc3 JOIN labor_categories lc3 ON lc3.id = ulc3.labor_category_id
        WHERE ulc3.user_id = ${timesheetEntries.userId}
          AND ulc3.effective_date <= ${timesheetEntries.entryDate}
          AND (ulc3.end_date IS NULL OR ulc3.end_date >= ${timesheetEntries.entryDate})
          AND lc3.clin_id = ${timesheetEntries.clinId} AND lc3.slin_id IS NULL) s3
  ) counts
  ) resolved
) cost_basis`;

/** The resolved category (code, title — never its rate; use cost_basis.applied_rate) — join with COST_LC_ON. */
export const costLaborCategory = alias(laborCategories, 'cost_lc');
export const COST_LC_ON = eq(costLaborCategory.id, sql`cost_basis.labor_category_id`);

/** Per-entry fields. `hourlyRate` / `appliedRate` = the rate in effect on the entry's date; null when unpriced. */
export const costBasisFields = {
  basis: sql<CostBasis>`cost_basis.basis`,
  level: sql<CostBasisLevel>`cost_basis.level`,
  laborCategoryId: sql<string | null>`cost_basis.labor_category_id`,
  lcatCode: costLaborCategory.lcatCode,
  lcatTitle: costLaborCategory.title,
  hourlyRate: sql<string | null>`cost_basis.applied_rate`,
  appliedRate: sql<string | null>`cost_basis.applied_rate`,
};

/** SUM of hours × rate over PRICED entries only (unpriced contribute no cost). */
export const pricedCostSum = sql<number>`COALESCE(SUM(CASE WHEN cost_basis.basis = 'priced'
  THEN CAST(${timesheetEntries.hours} AS NUMERIC) * cost_basis.applied_rate ELSE 0 END), 0)`;

/**
 * The latest revision of each cell (identity COALESCE(charge_code_id, indirect_code_id, clin_id) + date) — one shared
 * fragment for this module (dated rates D1.4 (3)).
 */
export const LATEST_REVISION: SQL = sql`${timesheetEntries.revisionNumber} = (
    SELECT MAX(te2.revision_number) FROM timesheet_entries te2
    WHERE te2.user_id = ${timesheetEntries.userId}
      AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
      AND te2.entry_date = ${timesheetEntries.entryDate})`;

/**
 * Latest-revision hours priced at labor category `laborCategoryId` in [from, toExclusive) — the hours a rate change
 * over that period re-prices (dated rates D1.4, DR-2). Always two decimals ('12.00'). Values only via operators (T1).
 */
export async function pricedHoursFor(
  db: Pick<ReadDb, 'select'> | DbTx,
  laborCategoryId: string,
  from: CalendarDate | null,
  toExclusive: CalendarDate | null,
): Promise<string> {
  const [row] = await db
    .select({ hours: sql<string>`CAST(ROUND(COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0), 2) AS NUMERIC(12,2))::text` })
    .from(timesheetEntries)
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .where(and(
      LATEST_REVISION,
      eq(sql`cost_basis.labor_category_id`, laborCategoryId),
      from ? gte(timesheetEntries.entryDate, from) : undefined,
      toExclusive ? lt(timesheetEntries.entryDate, toExclusive) : undefined,
    ));
  return row?.hours ?? '0.00';
}

/**
 * Latest-revision hours recorded on charge code `chargeCodeId` in [from, toExclusive) — the hours a change of that code's
 * labor category over the period re-prices (dated rates D3, DR-2). Same rounding as pricedHoursFor.
 */
export async function pricedHoursForChargeCode(
  db: Pick<ReadDb, 'select'> | DbTx,
  chargeCodeId: string,
  from: CalendarDate | null,
  toExclusive: CalendarDate | null,
): Promise<string> {
  const [row] = await db
    .select({ hours: sql<string>`CAST(ROUND(COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0), 2) AS NUMERIC(12,2))::text` })
    .from(timesheetEntries)
    .where(and(
      LATEST_REVISION,
      eq(timesheetEntries.chargeCodeId, chargeCodeId),
      from ? gte(timesheetEntries.entryDate, from) : undefined,
      toExclusive ? lt(timesheetEntries.entryDate, toExclusive) : undefined,
    ));
  return row?.hours ?? '0.00';
}

/** SUM of hours over UNPRICED entries — shown as "X hours unpriced" next to every cost total (CO-D17). */
export const unpricedHoursSum = sql<number>`COALESCE(SUM(CASE WHEN cost_basis.basis <> 'priced'
  THEN CAST(${timesheetEntries.hours} AS NUMERIC) ELSE 0 END), 0)`;

// ── Reports (Labor Categories page): Unpriced hours, Overlapping assignments ─────────────────────────────────────

export interface UnpricedFilters {
  startDate?: string;
  endDate?: string;
  contractId?: string;
  clinId?: string;
  slinId?: string;
}

export interface UnpricedEntryRow {
  userId: string;
  employeeName: string;
  entryDate: string;
  hours: number;
  chargeCodeId: string | null;
  chargeCode: string | null;
  clinId: string;
  clinNumber: string;
  slinId: string | null;
  slinNumber: string | null;
  contractId: string;
  reason: Exclude<CostBasis, 'priced'>;
  level: CostBasisLevel;
  /** For a conflict: the competing categories at the level that decided it. */
  conflicting: Array<{ id: string; lcatCode: string; title: string }>;
}

/** Latest-revision direct entries the resolution leaves UNPRICED (capped; `truncated` tells the UI). */
export async function unpricedEntries(
  db: Pick<ReadDb, 'select'>,
  filters: UnpricedFilters,
  limit = 500,
): Promise<{ rows: UnpricedEntryRow[]; truncated: boolean }> {
  const latest = LATEST_REVISION;
  const rows = await db
    .select({
      userId: timesheetEntries.userId,
      employeeName: users.fullName,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      chargeCodeId: timesheetEntries.chargeCodeId,
      chargeCode: chargeCodes.code,
      clinId: clins.id,
      clinNumber: clins.clinNumber,
      contractId: clins.contractId,
      slinId: timesheetEntries.slinId,
      slinNumber: slins.slinNumber,
      basis: costBasisFields.basis,
      level: costBasisFields.level,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .leftJoin(slins, eq(timesheetEntries.slinId, slins.id))
    .leftJoin(chargeCodes, eq(timesheetEntries.chargeCodeId, chargeCodes.id))
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .where(and(
      latest,
      sql`cost_basis.basis <> 'priced'`,
      sql`CAST(${timesheetEntries.hours} AS NUMERIC) > 0`,
      filters.startDate ? gte(timesheetEntries.entryDate, filters.startDate) : undefined,
      filters.endDate ? lte(timesheetEntries.entryDate, filters.endDate) : undefined,
      filters.contractId ? eq(clins.contractId, filters.contractId) : undefined,
      filters.clinId ? eq(timesheetEntries.clinId, filters.clinId) : undefined,
      filters.slinId ? eq(timesheetEntries.slinId, filters.slinId) : undefined,
    ))
    .orderBy(desc(timesheetEntries.entryDate), users.fullName)
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit);
  // The competing categories for each conflict (same rule as the lateral: effective on the date, at the deciding level).
  const conflictUsers = [...new Set(kept.filter((r) => r.basis === 'conflict').map((r) => r.userId))];
  const assignments = conflictUsers.length === 0 ? [] : await db
    .select({
      userId: userLaborCategories.userId, effectiveDate: userLaborCategories.effectiveDate, endDate: userLaborCategories.endDate,
      id: laborCategories.id, lcatCode: laborCategories.lcatCode, title: laborCategories.title, clinId: laborCategories.clinId, slinId: laborCategories.slinId,
    })
    .from(userLaborCategories)
    .innerJoin(laborCategories, eq(laborCategories.id, userLaborCategories.laborCategoryId))
    .where(inArray(userLaborCategories.userId, conflictUsers));

  return {
    truncated,
    rows: kept.map((r) => {
      const conflicting = r.basis !== 'conflict' ? [] : [...new Map(assignments
        .filter((a) => a.userId === r.userId && a.effectiveDate <= r.entryDate && (a.endDate === null || a.endDate >= r.entryDate))
        .filter((a) => (r.level === 'slin' ? a.slinId === r.slinId : a.clinId === r.clinId && a.slinId === null))
        .map((a) => [a.id, { id: a.id, lcatCode: a.lcatCode, title: a.title }])).values()];
      return {
        userId: r.userId, employeeName: r.employeeName, entryDate: r.entryDate, hours: parseFloat(r.hours) || 0,
        chargeCodeId: r.chargeCodeId, chargeCode: r.chargeCode, clinId: r.clinId, clinNumber: r.clinNumber,
        slinId: r.slinId, slinNumber: r.slinNumber, contractId: r.contractId,
        reason: r.basis === 'conflict' ? 'conflict' : 'no-category', level: r.level, conflicting,
      };
    }),
  };
}

export interface OverlapRow {
  userId: string;
  employeeName: string;
  level: 'slin' | 'clin';
  clinNumber: string;
  slinNumber: string | null;
  a: { assignmentId: string; lcatCode: string; title: string; effectiveDate: string; endDate: string | null };
  b: { assignmentId: string; lcatCode: string; title: string; effectiveDate: string; endDate: string | null };
}

/**
 * Pairs of an employee's assignments to DIFFERENT categories at the same level (same SLIN, or same CLIN with no SLIN)
 * whose date ranges overlap — each makes the overlapped days' entries unpriced ('conflict').
 */
export async function overlappingAssignments(db: Pick<ReadDb, 'select'>): Promise<OverlapRow[]> {
  const rows = await db
    .select({
      assignmentId: userLaborCategories.id, userId: userLaborCategories.userId, employeeName: users.fullName,
      effectiveDate: userLaborCategories.effectiveDate, endDate: userLaborCategories.endDate,
      lcId: laborCategories.id, lcatCode: laborCategories.lcatCode, title: laborCategories.title,
      clinId: laborCategories.clinId, clinNumber: clins.clinNumber, slinId: laborCategories.slinId, slinNumber: slins.slinNumber,
    })
    .from(userLaborCategories)
    .innerJoin(laborCategories, eq(laborCategories.id, userLaborCategories.laborCategoryId))
    .innerJoin(users, eq(users.id, userLaborCategories.userId))
    .innerJoin(clins, eq(clins.id, laborCategories.clinId))
    .leftJoin(slins, eq(slins.id, laborCategories.slinId));
  return findOverlaps(rows);
}

/** Pure: the overlap rule over assignment rows (exported for unit tests). */
export function findOverlaps(rows: Array<{
  assignmentId: string; userId: string; employeeName: string; effectiveDate: string; endDate: string | null;
  lcId: string; lcatCode: string; title: string; clinId: string; clinNumber: string; slinId: string | null; slinNumber: string | null;
}>): OverlapRow[] {
  const out: OverlapRow[] = [];
  const key = (r: (typeof rows)[number]) => `${r.userId}|${r.slinId ? `slin:${r.slinId}` : `clin:${r.clinId}`}`;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = [group[i], group[j]];
        if (x.lcId === y.lcId) continue;
        const overlap = x.effectiveDate <= (y.endDate ?? '9999-12-31') && y.effectiveDate <= (x.endDate ?? '9999-12-31');
        if (!overlap) continue;
        const side = (r: typeof x) => ({ assignmentId: r.assignmentId, lcatCode: r.lcatCode, title: r.title, effectiveDate: r.effectiveDate, endDate: r.endDate });
        out.push({ userId: x.userId, employeeName: x.employeeName, level: x.slinId ? 'slin' : 'clin', clinNumber: x.clinNumber, slinNumber: x.slinNumber, a: side(x), b: side(y) });
      }
    }
  }
  return out.sort((p, q) => p.employeeName.localeCompare(q.employeeName) || p.a.effectiveDate.localeCompare(q.a.effectiveDate));
}

/** "How to fix" for an unpriced entry (the Unpriced hours report). Pure. */
export function unpricedFixText(r: Pick<UnpricedEntryRow, 'reason' | 'employeeName' | 'chargeCode' | 'clinNumber' | 'slinNumber' | 'entryDate' | 'conflicting' | 'level'>): string {
  const where = r.slinNumber ? `SLIN ${r.slinNumber}` : `CLIN ${r.clinNumber}`;
  if (r.reason === 'conflict') {
    const names = r.conflicting.map((c) => c.lcatCode);
    const listed = names.length >= 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('') || 'more than one labor category';
    const at = r.level === 'slin' ? `SLIN ${r.slinNumber}` : `CLIN ${r.clinNumber}`;
    return `${r.employeeName} has ${listed} on ${at} effective ${r.entryDate} — end one.`;
  }
  return r.chargeCode
    ? `Set a labor category on charge code ${r.chargeCode}, or give ${r.employeeName} a labor category on ${where} effective ${r.entryDate}.`
    : `Give ${r.employeeName} a labor category on ${where} effective ${r.entryDate}.`;
}
