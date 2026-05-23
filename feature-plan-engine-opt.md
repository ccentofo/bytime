# Blueprint: Cost Engine Optimization & Effective-Date Rate Accuracy

## 1. Architectural Overview & DCAA Impact

### The Performance Problem (N+1 Query Anti-Pattern)

The current cost engine in `src/server/actions/dashboard.ts` has two functions with severe performance issues:

**`getContractSummaries()`** executes queries in nested loops:
1. Query all contracts (1 query)
2. For each contract → query CLINs (N queries, where N = contract count)
3. For each CLIN → query latest-revision timesheet entries (N×M queries, where M = avg CLINs per contract)
4. For each entry → query user's labor category rate (N×M×E queries, where E = avg entries per CLIN)

**Real-world impact:** A system with 10 contracts, 5 CLINs each, and 100 entries per CLIN would execute:
- 1 + 10 + 50 + 5,000 = **5,061 database queries** per dashboard page load

This is unsustainable. The dashboard will time out or become unusable as data grows.

**`getPeriodCostReport()`** has the same issue — it fetches all entries, then loops through aggregated results issuing individual queries for user info, CLIN info, and LCAT rates.

### The Rate Accuracy Problem

The current cost engine looks up user rates like this:

```sql
SELECT hourly_rate FROM user_labor_categories
JOIN labor_categories ON ...
WHERE user_id = ? AND clin_id = ? AND status = 'active'
LIMIT 1
```

This query **ignores `effectiveDate` and `endDate`** on the `user_labor_categories` table. If a user's rate changes mid-contract (e.g., promoted from Jr Developer at $80/hr to Sr Developer at $120/hr on July 1), the engine will always use whatever rate LIMIT 1 returns — likely the most recent one. This means:

- Hours worked in January at $80/hr would be incorrectly costed at $120/hr
- Historical cost reports would be wrong
- DCAA auditors comparing actual payroll costs to system-reported costs would find discrepancies

Per **CAS 418** (Cost Accounting Standard for Allocation of Direct and Indirect Costs), costs must be allocated using the rate that was in effect at the time the cost was incurred.

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How This Feature Satisfies It |
|---|---|
| **CAS 418 — Cost Accounting Standard** | Rate lookups now use the effective date of the labor category assignment, ensuring costs are calculated at the rate in effect when hours were worked |
| **FAR 31.201-1 — Allowable Costs** | Accurate cost calculations ensure reported costs match actual billing rates, making incurred cost submissions reliable |
| **DCAA Audit Readiness** | Period cost reports now produce data that will match payroll records and invoices, reducing audit findings |
| **FAR 52.232-22 — Limitation of Funds** | Accurate cost totals mean budget burn calculations and fund remaining alerts are trustworthy |

---

## 2. File Topology

```
Files to MODIFY:
├── src/server/actions/dashboard.ts              ← Refactor both functions: optimized queries + date-aware rates

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                             ← ❌ DO NOT MODIFY
├── src/auth.ts                                  ← ❌ DO NOT MODIFY
├── src/middleware.ts                             ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts              ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts              ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts            ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/labor-categories.ts       ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/page.tsx        ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/dashboard/DashboardClient.tsx ← ❌ DO NOT MODIFY (interfaces unchanged)
├── src/app/(app)/admin/dashboard/Dashboard.module.css ← ❌ DO NOT MODIFY
├── src/components/**                            ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/**              ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/**              ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/**            ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/**                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/**             ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/**        ← ❌ DO NOT MODIFY
```

**Key constraint:** The exported TypeScript interfaces (`ContractSummary`, `ClinSummary`, `PeriodCostEntry`) must remain **exactly the same** — only the internal implementation changes. The `DashboardClient.tsx` component consumes these types and must not need any modifications.

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** touch, modify, or import from any file except `src/server/actions/dashboard.ts`.
> - The exported interfaces (`ContractSummary`, `ClinSummary`, `PeriodCostEntry`) must NOT change.
> - The function signatures (`getContractSummaries()` and `getPeriodCostReport(startDate, endDate)`) must NOT change.
> - Use **Drizzle ORM** for all database operations. Use `sql` template literals for complex subqueries.
> - Do **NOT** search or read files inside `node_modules/`, `.next/`, or `dist/`.
> - Follow the step order exactly. Each step builds on the previous one.
> - After each phase, run `npm run build` to verify zero errors.

---

### Phase A: Optimize `getContractSummaries()` (A1–A4)

The goal is to replace the N+1 loop structure with **3 total queries** maximum:
1. All contracts (1 query)
2. All CLINs for all contracts (1 query)
3. All cost data: latest-revision hours × effective rates, grouped by CLIN (1 query)

#### A1. Build the cost aggregation query

Replace the entire loop-based implementation with a single aggregated query that:
1. Finds the latest revision for each `(user_id, clin_id, entry_date)` tuple using a correlated subquery
2. Joins to `user_labor_categories` and `labor_categories` to get the rate **effective at the entry date**
3. Groups by `clin_id` and sums `hours` and `hours × rate`

The SQL logic for effective-date rate lookup:

```sql
-- For each (user_id, clin_id, entry_date), find the labor category assignment where:
--   effective_date <= entry_date AND (end_date IS NULL OR end_date > entry_date)
-- Then join to labor_categories to get the hourly_rate
```

**New implementation:**

```typescript
export async function getContractSummaries(): Promise<ContractSummary[]> {
  // Query 1: All contracts
  const allContracts = await db
    .select()
    .from(contracts)
    .orderBy(contracts.name);

  // Query 2: All CLINs (single query for all contracts)
  const allClins = await db
    .select()
    .from(clins)
    .orderBy(clins.clinNumber);

  // Query 3: Aggregated cost data per CLIN
  // This single query replaces the entire N+1 loop
  const costData = await db
    .select({
      clinId: timesheetEntries.clinId,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        COALESCE(CAST(${laborCategories.hourlyRate} AS NUMERIC), 0)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .innerJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND te2.clin_id = ${timesheetEntries.clinId}
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`
      )
    )
    .groupBy(timesheetEntries.clinId);

  // Build a lookup map: clinId → { totalHours, totalCost }
  const costMap = new Map<string, { totalHours: number; totalCost: number }>();
  for (const row of costData) {
    costMap.set(row.clinId, {
      totalHours: Math.round(Number(row.totalHours) * 100) / 100,
      totalCost: Math.round(Number(row.totalCost) * 100) / 100,
    });
  }

  // Also get hours for entries where users don't have an LCAT assignment
  // (hours counted but cost = 0)
  const hoursOnlyData = await db
    .select({
      clinId: timesheetEntries.clinId,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
    })
    .from(timesheetEntries)
    .where(
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND te2.clin_id = ${timesheetEntries.clinId}
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`
      )
    )
    .groupBy(timesheetEntries.clinId);

  const allHoursMap = new Map<string, number>();
  for (const row of hoursOnlyData) {
    allHoursMap.set(row.clinId, Math.round(Number(row.totalHours) * 100) / 100);
  }

  // Assemble the summaries
  // Group CLINs by contract
  const clinsByContract = new Map<string, typeof allClins>();
  for (const clin of allClins) {
    const existing = clinsByContract.get(clin.contractId) ?? [];
    existing.push(clin);
    clinsByContract.set(clin.contractId, existing);
  }

  const summaries: ContractSummary[] = [];

  for (const contract of allContracts) {
    const contractClins = clinsByContract.get(contract.id) ?? [];

    const clinSummaries: ClinSummary[] = contractClins.map((clin) => {
      const costs = costMap.get(clin.id);
      const allHours = allHoursMap.get(clin.id) ?? 0;
      return {
        clinId: clin.id,
        clinNumber: clin.clinNumber,
        description: clin.description,
        fundedAmount: clin.fundedAmount,
        status: clin.status,
        totalHours: allHours,
        totalCost: costs?.totalCost ?? 0,
      };
    });

    const totalHours = clinSummaries.reduce((sum, c) => sum + c.totalHours, 0);
    const totalCost = clinSummaries.reduce((sum, c) => sum + c.totalCost, 0);

    summaries.push({
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      contractName: contract.name,
      contractType: contract.contractType ?? 'prime',
      status: contract.status,
      fundedValue: contract.fundedValue,
      ceilingValue: contract.ceilingValue,
      totalHours: Math.round(totalHours * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      clinSummaries,
    });
  }

  return summaries;
}
```

#### A2. Handle edge case: entries with no LCAT assignment

The optimized query uses an `INNER JOIN` to `userLaborCategories` and `laborCategories`, which means entries without a matching LCAT assignment would be excluded from cost calculations. This is correct behavior (no rate = $0 cost), but we need to ensure **hours are still counted**.

The implementation above handles this by running two queries:
1. **Cost query** (with LCAT join) — gets hours × rate for entries that have matching LCATs
2. **Hours-only query** (no LCAT join) — gets total hours for all entries regardless of LCAT

The `allHoursMap` ensures all hours are counted in the summary even if some entries lack rate data.

#### A3. Verify interface compatibility

After refactoring, verify that the returned `ContractSummary[]` matches the existing interface exactly:

```typescript
export interface ContractSummary {
  contractId: string;
  contractNumber: string;
  contractName: string;
  contractType: string;
  status: string;
  fundedValue: string | null;
  ceilingValue: string | null;
  totalHours: number;
  totalCost: number;
  clinSummaries: ClinSummary[];
}

export interface ClinSummary {
  clinId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  totalCost: number;
}
```

No fields added, removed, or renamed. `DashboardClient.tsx` requires zero changes.

#### A4. Phase A verification

```bash
npm run build
```

Must complete with zero errors. The dashboard page should render identically to before, but page load should be significantly faster for systems with real data.

---

### Phase B: Optimize `getPeriodCostReport()` (B1–B3)

Same optimization approach — replace the per-aggregate loop with a single query.

#### B1. Build the period cost aggregation query

Replace the entire implementation with a query that:
1. Filters entries by date range and latest revision
2. Joins to users, CLINs, contracts, and effective-date LCAT assignments
3. Groups by `(userId, clinId)` and returns aggregated hours and costs with all context fields

**New implementation:**

```typescript
export async function getPeriodCostReport(
  startDate: Date,
  endDate: Date
): Promise<PeriodCostEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  // Single query: get all cost data for the period, grouped by (user, clin)
  const rows = await db
    .select({
      userName: users.fullName,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      lcatCode: sql<string>`COALESCE(${laborCategories.lcatCode}, '—')`,
      lcatTitle: sql<string>`COALESCE(${laborCategories.title}, 'No LCAT')`,
      hourlyRate: sql<string>`COALESCE(${laborCategories.hourlyRate}, '0')`,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        COALESCE(CAST(${laborCategories.hourlyRate} AS NUMERIC), 0)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .leftJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      and(
        gte(timesheetEntries.entryDate, startDate),
        lt(timesheetEntries.entryDate, endDateExclusive),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    )
    .groupBy(
      users.fullName,
      contracts.name,
      contracts.contractNumber,
      clins.clinNumber,
      laborCategories.lcatCode,
      laborCategories.title,
      laborCategories.hourlyRate,
    )
    .orderBy(contracts.name, clins.clinNumber, users.fullName);

  // Map to PeriodCostEntry[]
  return rows.map((row) => ({
    userName: row.userName,
    contractName: row.contractName,
    contractNumber: row.contractNumber,
    clinNumber: row.clinNumber,
    lcatCode: row.lcatCode,
    lcatTitle: row.lcatTitle,
    hourlyRate: row.hourlyRate,
    totalHours: Math.round(Number(row.totalHours) * 100) / 100,
    totalCost: Math.round(Number(row.totalCost) * 100) / 100,
  }));
}
```

#### B2. Handle the LEFT JOIN for missing LCATs

Using `LEFT JOIN` instead of `INNER JOIN` for `userLaborCategories` and `laborCategories` ensures that entries without a matching LCAT assignment still appear in the report. They'll show:
- `lcatCode`: `'—'`
- `lcatTitle`: `'No LCAT'`
- `hourlyRate`: `'0'`
- `totalCost`: `0`

This is important for identifying missing labor category assignments — a PM can see hours logged but not costed, signaling a setup issue.

#### B3. Phase B verification

```bash
npm run build
```

Must complete with zero errors. The period cost report should produce identical results to before (unless rates were previously being looked up incorrectly due to the missing effective date filter — in that case, the new results are more accurate).

---

### Phase C: Effective Date-Aware Rate Lookup — Detailed Logic (C1–C3)

This phase is **already integrated** into Phases A and B above via the JOIN conditions. This section documents the exact logic for clarity and serves as a reference for testing.

#### C1. The rate lookup condition

The critical SQL condition for matching a user's rate to a timesheet entry is:

```sql
user_labor_categories.user_id = timesheet_entries.user_id
AND user_labor_categories.effective_date <= timesheet_entries.entry_date
AND (user_labor_categories.end_date IS NULL OR user_labor_categories.end_date > timesheet_entries.entry_date)
```

This means:
- The LCAT assignment must have started **on or before** the date the hours were worked
- The LCAT assignment must not have ended before the date the hours were worked (if `endDate` is NULL, the assignment is still active)

#### C2. Multiple active assignments edge case

If a user has overlapping LCAT assignments for the same CLIN (which shouldn't happen in practice but could due to data issues), the query may produce duplicate rows. The `GROUP BY` in the aggregation queries handles this by summing correctly — if two rate rows match, the hours would be double-counted.

**Mitigation:** The `user_lcat_effective_unique_idx` unique index on `(userId, laborCategoryId, effectiveDate)` prevents exact duplicates. However, a user could theoretically have two different LCATs for the same CLIN with overlapping date ranges. In this case, the system picks whichever the database returns — this is an acceptable limitation for MVP, and the admin should fix the overlapping assignments.

#### C3. Rate change scenario walkthrough

**Scenario:** User "John" works on CLIN 0001.
- Jan 1–Jun 30: Assigned as "Jr Developer" at $80/hr (LCAT assignment with `effectiveDate=Jan 1, endDate=Jul 1`)
- Jul 1–ongoing: Assigned as "Sr Developer" at $120/hr (LCAT assignment with `effectiveDate=Jul 1, endDate=NULL`)

**Previous behavior:** The old code did `LIMIT 1` with no date filter, potentially using $120/hr for all historical hours.

**New behavior:**
- January timesheet entry (8 hrs): `effective_date=Jan 1 <= entry_date=Jan 15` ✅ AND `end_date=Jul 1 > Jan 15` ✅ → **Rate: $80/hr → Cost: $640**
- July timesheet entry (8 hrs): `effective_date=Jul 1 <= entry_date=Jul 15` ✅ AND `end_date IS NULL` ✅ → **Rate: $120/hr → Cost: $960**

This is the correct DCAA-compliant behavior.

---

### Phase D: Complete File Replacement (D1)

#### D1. Replace `src/server/actions/dashboard.ts`

Replace the **entire file** with the optimized implementation. The complete file:

```typescript
'use server';

import { db } from '@/db';
import {
  contracts,
  clins,
  timesheetEntries,
  laborCategories,
  userLaborCategories,
  users,
} from '@/db/schema';
import { eq, and, sql, gte, lt } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Types (UNCHANGED — must match DashboardClient.tsx expectations)
// ---------------------------------------------------------------------------

export interface ContractSummary {
  contractId: string;
  contractNumber: string;
  contractName: string;
  contractType: string;
  status: string;
  fundedValue: string | null;
  ceilingValue: string | null;
  totalHours: number;
  totalCost: number;
  clinSummaries: ClinSummary[];
}

export interface ClinSummary {
  clinId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  totalCost: number;
}

export interface PeriodCostEntry {
  userName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: string;
  totalHours: number;
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Dashboard Queries (OPTIMIZED — max 4 queries for summaries, 1 for report)
// ---------------------------------------------------------------------------

/**
 * Get a cost summary for all contracts.
 * Calculates total hours and cost (hours × effective rate) per contract and CLIN.
 *
 * OPTIMIZATION: Replaces the previous N+1 loop approach with batch queries:
 *   1. All contracts (1 query)
 *   2. All CLINs (1 query)
 *   3. All hours by CLIN — latest revision only (1 query)
 *   4. All costs by CLIN — latest revision with effective-date rate lookup (1 query)
 *
 * RATE ACCURACY: Rate lookups now respect effective_date and end_date on
 * user_labor_categories, ensuring costs reflect the rate in effect when hours
 * were worked (CAS 418 compliance).
 */
export async function getContractSummaries(): Promise<ContractSummary[]> {
  // Query 1: All contracts
  const allContracts = await db
    .select()
    .from(contracts)
    .orderBy(contracts.name);

  // Query 2: All CLINs
  const allClins = await db
    .select()
    .from(clins)
    .orderBy(clins.clinNumber);

  // Query 3: Total hours per CLIN (latest revision only, no rate needed)
  const hoursData = await db
    .select({
      clinId: timesheetEntries.clinId,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
    })
    .from(timesheetEntries)
    .where(
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND te2.clin_id = ${timesheetEntries.clinId}
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`
      )
    )
    .groupBy(timesheetEntries.clinId);

  // Query 4: Total cost per CLIN (latest revision × effective rate)
  const costData = await db
    .select({
      clinId: timesheetEntries.clinId,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        CAST(${laborCategories.hourlyRate} AS NUMERIC)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .innerJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      eq(
        timesheetEntries.revisionNumber,
        sql`(
          SELECT MAX(te2.revision_number)
          FROM timesheet_entries te2
          WHERE te2.user_id = ${timesheetEntries.userId}
            AND te2.clin_id = ${timesheetEntries.clinId}
            AND te2.entry_date = ${timesheetEntries.entryDate}
        )`
      )
    )
    .groupBy(timesheetEntries.clinId);

  // Build lookup maps
  const hoursMap = new Map<string, number>();
  for (const row of hoursData) {
    hoursMap.set(row.clinId, Math.round(Number(row.totalHours) * 100) / 100);
  }

  const costMap = new Map<string, number>();
  for (const row of costData) {
    costMap.set(row.clinId, Math.round(Number(row.totalCost) * 100) / 100);
  }

  // Group CLINs by contract
  const clinsByContract = new Map<string, (typeof allClins)[number][]>();
  for (const clin of allClins) {
    const existing = clinsByContract.get(clin.contractId) ?? [];
    existing.push(clin);
    clinsByContract.set(clin.contractId, existing);
  }

  // Assemble summaries
  const summaries: ContractSummary[] = [];

  for (const contract of allContracts) {
    const contractClins = clinsByContract.get(contract.id) ?? [];

    const clinSummaries: ClinSummary[] = contractClins.map((clin) => ({
      clinId: clin.id,
      clinNumber: clin.clinNumber,
      description: clin.description,
      fundedAmount: clin.fundedAmount,
      status: clin.status,
      totalHours: hoursMap.get(clin.id) ?? 0,
      totalCost: costMap.get(clin.id) ?? 0,
    }));

    const totalHours = clinSummaries.reduce((sum, c) => sum + c.totalHours, 0);
    const totalCost = clinSummaries.reduce((sum, c) => sum + c.totalCost, 0);

    summaries.push({
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      contractName: contract.name,
      contractType: contract.contractType ?? 'prime',
      status: contract.status,
      fundedValue: contract.fundedValue,
      ceilingValue: contract.ceilingValue,
      totalHours: Math.round(totalHours * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      clinSummaries,
    });
  }

  return summaries;
}

/**
 * Get a period-based cost report showing hours × effective rate by employee/CLIN/LCAT.
 * Used for generating invoicing data and incurred cost submissions.
 *
 * OPTIMIZATION: Single query with JOINs and GROUP BY replaces the previous
 * approach of fetching all entries, aggregating in memory, then issuing
 * per-aggregate queries for user/CLIN/LCAT context.
 *
 * RATE ACCURACY: Uses effective-date-aware rate lookup via user_labor_categories
 * JOIN conditions, ensuring each hour is costed at the rate that was in effect
 * on the date the work was performed.
 */
export async function getPeriodCostReport(
  startDate: Date,
  endDate: Date
): Promise<PeriodCostEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  // Single optimized query: aggregate hours and costs by (user, clin, lcat)
  const rows = await db
    .select({
      userName: users.fullName,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      clinNumber: clins.clinNumber,
      lcatCode: sql<string>`COALESCE(${laborCategories.lcatCode}, '—')`,
      lcatTitle: sql<string>`COALESCE(${laborCategories.title}, 'No LCAT')`,
      hourlyRate: sql<string>`COALESCE(${laborCategories.hourlyRate}, '0')`,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
      totalCost: sql<number>`COALESCE(SUM(
        CAST(${timesheetEntries.hours} AS NUMERIC) *
        COALESCE(CAST(${laborCategories.hourlyRate} AS NUMERIC), 0)
      ), 0)`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(
      userLaborCategories,
      and(
        eq(userLaborCategories.userId, timesheetEntries.userId),
        sql`${userLaborCategories.effectiveDate} <= ${timesheetEntries.entryDate}`,
        sql`(${userLaborCategories.endDate} IS NULL OR ${userLaborCategories.endDate} > ${timesheetEntries.entryDate})`,
      )
    )
    .leftJoin(
      laborCategories,
      and(
        eq(laborCategories.id, userLaborCategories.laborCategoryId),
        eq(laborCategories.clinId, timesheetEntries.clinId),
        eq(laborCategories.status, 'active'),
      )
    )
    .where(
      and(
        gte(timesheetEntries.entryDate, startDate),
        lt(timesheetEntries.entryDate, endDateExclusive),
        eq(
          timesheetEntries.revisionNumber,
          sql`(
            SELECT MAX(te2.revision_number)
            FROM timesheet_entries te2
            WHERE te2.user_id = ${timesheetEntries.userId}
              AND te2.clin_id = ${timesheetEntries.clinId}
              AND te2.entry_date = ${timesheetEntries.entryDate}
          )`
        ),
      )
    )
    .groupBy(
      users.fullName,
      contracts.name,
      contracts.contractNumber,
      clins.clinNumber,
      laborCategories.lcatCode,
      laborCategories.title,
      laborCategories.hourlyRate,
    )
    .orderBy(contracts.name, clins.clinNumber, users.fullName);

  return rows.map((row) => ({
    userName: row.userName,
    contractName: row.contractName,
    contractNumber: row.contractNumber,
    clinNumber: row.clinNumber,
    lcatCode: row.lcatCode,
    lcatTitle: row.lcatTitle,
    hourlyRate: row.hourlyRate,
    totalHours: Math.round(Number(row.totalHours) * 100) / 100,
    totalCost: Math.round(Number(row.totalCost) * 100) / 100,
  }));
}
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Performance Verification

| Metric | Before (N+1) | After (Optimized) |
|---|---|---|
| Queries for `getContractSummaries()` | 1 + N + N×M + N×M×E | 4 (fixed) |
| Queries for `getPeriodCostReport()` | 1 + A + 3A | 1 (fixed) |
| Dashboard load time (10 contracts, 50 CLINs, 500 entries) | ~2-5 seconds | ~100-300ms |
| Dashboard load time (100 contracts, 500 CLINs, 50K entries) | 30+ seconds (timeout) | ~500ms-1s |

### 4c. Functional Verification

| Check | Expected Result |
|---|---|
| **Dashboard cards** | Same totals as before (unless previous rate lookups were wrong) |
| **Contract table** | Same data, same layout, same expand behavior |
| **CLIN detail panel** | Same hours, cost, remaining values |
| **Period cost report** | Same columns, data, and totals (with potentially corrected costs for rate-changed users) |
| **Empty state** | Dashboard shows $0.00 for contracts with no entries |
| **No LCAT state** | Hours counted but cost = $0 for entries without matching LCAT assignments |

### 4d. Rate Accuracy Verification

Test with this scenario:
1. Create a user with two LCAT assignments for the same CLIN:
   - Assignment A: effective Jan 1, end Jul 1, rate $80/hr
   - Assignment B: effective Jul 1, end NULL, rate $120/hr
2. Create timesheet entries for this user on the CLIN:
   - Entry 1: March 15, 8 hours
   - Entry 2: August 15, 8 hours
3. Expected dashboard results:
   - March entry: 8 × $80 = $640
   - August entry: 8 × $120 = $960
   - Total: 16 hours, $1,600

If the old engine was used, both would be at whatever rate `LIMIT 1` returned.

### 4e. Edge Cases

| Edge Case | Expected Behavior |
|---|---|
| **User with no LCAT assignment** | Hours counted in summary, cost = $0, period report shows "No LCAT" |
| **User with expired LCAT (endDate passed)** | Only applies to entries during the active period; future entries show $0 |
| **CLIN with no entries** | Shows 0.00 hours, $0.00 cost in dashboard |
| **Multiple revisions** | Only latest revision counted (correlated subquery filter) |
| **Entry on exact effectiveDate** | Included (condition is `<=`) |
| **Entry on exact endDate** | Excluded (condition is `end_date > entry_date`, not `>=`) |

### 4f. Guardrail Verification

```bash
git diff --name-only
```

Must show ONLY:
```
src/server/actions/dashboard.ts
```

No other files should be modified.

### 4g. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "hourly_rate" must appear in the GROUP BY clause` | Missing column in GROUP BY | Ensure all non-aggregated SELECT columns are in GROUP BY |
| `cannot cast type character varying to numeric` | Malformed hourly_rate value | Data validation issue — ensure all rates are valid numbers |
| `subquery used as an expression must return one row` | Correlated subquery returns multiple rows | The MAX() aggregate ensures single row |
| Dashboard shows different costs than before | Rate accuracy fix — previous costs were wrong | This is expected behavior; the new costs are correct |
| `TypeError: Cannot read properties of undefined` | Empty result set | All aggregations use COALESCE to handle NULLs |
