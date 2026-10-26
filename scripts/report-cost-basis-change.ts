/**
 * READ-ONLY founder report (feature-plan-certified-outputs.md C3, CO-D17): how contract / CLIN / SLIN costs move when
 * C3's cost-basis resolution replaces the old labor-category join. Run it BEFORE and AFTER deploying C3 and tell the
 * design partner what moved.
 *
 *   npm run report:cost-basis-change -- <slug>
 *
 * "Old" is the pre-C3 join, frozen here: the employee's labor categories effective on the date, matched on the entry's
 * CLIN, ACTIVE categories only (an employee with two matching categories counted the hours twice). "New" is
 * src/server/internal/cost-basis.ts (charge code → SLIN → CLIN; conflicts and gaps unpriced; no status filter).
 * Nothing is written. Needs CONTROL_PLANE_DATABASE_URL and ENCRYPTION_KEY (.env.local, then .env).
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import { withLockedPool } from '../src/db/control-plane/locked';
import { getDbForUrl } from '../src/db';
import { clins, contracts, laborCategories, slins, timesheetEntries, userLaborCategories } from '../src/db/schema';
import { decrypt } from '../src/lib/encryption';
import { COST_BASIS_LATERAL, COST_LC_ON, costLaborCategory, pricedCostSum, unpricedHoursSum } from '../src/server/internal/cost-basis';
import { printTargetBanner } from './lib/target';
import { formatCostBasisChange, mergeCostRows, type Keyed } from './lib/cost-basis-change';

const LATEST = sql`${timesheetEntries.revisionNumber} = (
  SELECT MAX(te2.revision_number) FROM timesheet_entries te2
  WHERE te2.user_id = ${timesheetEntries.userId}
    AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
    AND te2.entry_date = ${timesheetEntries.entryDate})`;

async function main() {
  printTargetBanner();
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: npm run report:cost-basis-change -- <slug>');
    process.exit(1);
  }
  const [t] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
  if (!t || !t.dbUrlEncrypted) {
    console.error(`No workspace "${slug}" with a database.`);
    process.exit(1);
  }
  const db = getDbForUrl(decrypt(t.dbUrlEncrypted));

  // OLD (frozen pre-C3 join), per CLIN and per SLIN.
  const oldJoin = (groupCol: typeof timesheetEntries.clinId | typeof timesheetEntries.slinId) => db
    .select({ id: groupCol, cost: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC) * CAST(${laborCategories.hourlyRate} AS NUMERIC)), 0)` })
    .from(timesheetEntries)
    .innerJoin(userLaborCategories, and(
      eq(userLaborCategories.userId, timesheetEntries.userId),
      sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
      sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} >= ${timesheetEntries.entryDate})`,
    ))
    .innerJoin(laborCategories, and(
      eq(laborCategories.id, userLaborCategories.laborCategoryId),
      eq(laborCategories.clinId, timesheetEntries.clinId),
      eq(laborCategories.status, 'active'),
    ))
    .where(and(isNotNull(groupCol), LATEST))
    .groupBy(groupCol);
  // NEW (cost-basis.ts), per CLIN and per SLIN.
  const newJoin = (groupCol: typeof timesheetEntries.clinId | typeof timesheetEntries.slinId) => db
    .select({ id: groupCol, cost: pricedCostSum, unpricedHours: unpricedHoursSum })
    .from(timesheetEntries)
    .leftJoinLateral(COST_BASIS_LATERAL, sql`true`)
    .leftJoin(costLaborCategory, COST_LC_ON)
    .where(and(isNotNull(groupCol), LATEST))
    .groupBy(groupCol);

  const [oldClin, oldSlin, newClin, newSlin, clinRows, slinRows] = await Promise.all([
    oldJoin(timesheetEntries.clinId), oldJoin(timesheetEntries.slinId),
    newJoin(timesheetEntries.clinId), newJoin(timesheetEntries.slinId),
    db.select({ id: clins.id, clin: clins.clinNumber, contract: contracts.name }).from(clins).innerJoin(contracts, eq(contracts.id, clins.contractId)),
    db.select({ id: slins.id, slin: slins.slinNumber, clin: clins.clinNumber, contract: contracts.name }).from(slins)
      .innerJoin(clins, eq(clins.id, slins.clinId)).innerJoin(contracts, eq(contracts.id, clins.contractId)),
  ]);

  const labels: Keyed[] = [
    ...clinRows.map((c) => ({ key: `clin:${c.id}`, contract: c.contract, clin: c.clin, slin: null })),
    ...slinRows.map((s) => ({ key: `slin:${s.id}`, contract: s.contract, clin: s.clin, slin: s.slin })),
  ];
  const oldCost = new Map<string, number>([
    ...oldClin.map((r) => [`clin:${r.id}`, Number(r.cost)] as const),
    ...oldSlin.map((r) => [`slin:${r.id}`, Number(r.cost)] as const),
  ]);
  const newCost = new Map<string, { cost: number; unpricedHours: number }>([
    ...newClin.map((r) => [`clin:${r.id}`, { cost: Number(r.cost), unpricedHours: Number(r.unpricedHours) }] as const),
    ...newSlin.map((r) => [`slin:${r.id}`, { cost: Number(r.cost), unpricedHours: Number(r.unpricedHours) }] as const),
  ]);

  console.log(`\nCost basis change for "${slug}" (read-only; current labor-category rates):\n`);
  console.log(formatCostBasisChange(mergeCostRows(labels, oldCost, newCost)));
  console.log('\nUnpriced hours have no applicable labor category (or two at the same level): see Labor Categories → Unpriced hours.');
  process.exit(0);
}

main().catch((err) => {
  console.error('report-cost-basis-change failed:', err?.message ?? err);
  process.exit(1);
});
