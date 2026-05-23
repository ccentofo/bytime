# Blueprint: Contract Budget Tracking & Cost Dashboard (Admin v3)

## 1. Architectural Overview & DCAA Impact

### The Financial Data Loop

The system now has:
- **Hours** — append-only timesheet entries tracking hours worked per user per CLIN per day
- **Rates** — labor categories with hourly billing rates and ceiling rates per CLIN
- **User-LCAT Assignments** — mapping employees to their authorized billing rate with effective dates

What's missing: **Funded Values & Budget Tracking**. Contracts and CLINs have no financial fields — there's no way to know how much money is allocated, how much has been spent, or how much remains.

This feature adds funding fields to contracts and CLINs, builds a cost calculation engine, and creates a Contract Dashboard page for PMs and admins to monitor budget burn in real-time.

### Prime vs. Subcontractor Context

This feature supports both **Prime Contractors** and **Subcontractors**:
- **Prime Contractors** track their total contract value, funded CLINs, and hours burned across their workforce
- **Subcontractors** track their subcontract ceiling, funded task orders (CLINs), and their own labor costs against the sub-award

The `contracts` table already has `contractNumber` which can represent either a prime contract number (e.g., `W58RGZ-21-C-0001`) or a subcontract number. The new `contractType` field will distinguish between them.

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How This Feature Satisfies It |
|---|---|
| **FAR 31.201-1 — Allowable Costs** | Cost calculations use only authorized billing rates from labor categories, ensuring costs are reasonable and consistently applied |
| **FAR 52.232-22 — Limitation of Funds** | Budget tracking with visual alerts when spending approaches funded limits, preventing unauthorized obligation of funds |
| **CAS 418 — Cost Accounting Standard** | Costs are calculated using the same rates assigned via the user-LCAT system, ensuring consistent cost allocation |
| **DCAA Audit Readiness** | All cost data is derived from append-only timesheet entries and traceable labor category rates — no manual cost overrides |
| **Incurred Cost Submission (ICS)** | Period cost reports provide the data foundation for annual incurred cost submissions |

---

## 2. File Topology

```
Files to CREATE (new):
├── src/server/actions/dashboard.ts                  ← Server Actions: cost calculation queries
├── src/app/(app)/admin/dashboard/
│   ├── page.tsx                                     ← Server Component: Contract Dashboard page
│   ├── DashboardClient.tsx                          ← Client Component: budget cards + cost tables
│   └── Dashboard.module.css                         ← Module CSS for MRT table header styling

Files to MODIFY:
├── src/db/schema.ts                                 ← Add funding fields to contracts + clins, add contractType
├── src/server/actions/contracts.ts                   ← Update createContract/updateContract with new fields
├── src/server/actions/clins.ts                       ← Update createClin/updateClin with new fields
├── src/app/(app)/admin/contracts/ContractsClient.tsx ← Add funding fields to contract modal + CLIN drawer
├── src/components/shell/AppNavbar.tsx                ← Add "Contract Dashboard" nav link

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/*                        ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                            ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                  ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** touch, modify, or import from any file listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/dates`, `@mantine/notifications`).
> - Use **Mantine React Table v2** (`mantine-react-table`) for data grids.
> - Use **Drizzle ORM** for all database operations.
> - Do **NOT** search or read files inside `node_modules/`, `.next/`, or `dist/`.
> - Follow the step order exactly. Each step builds on the previous one.
> - For MRT table header styling, use a `.module.css` file with a `tableHeaderCell` class.
> - All monetary values stored as `varchar` strings (consistent with `hourlyRate` pattern) — parse to `parseFloat()` only for calculations.

---

### Phase A: Schema Updates (A1–A3)

#### A1. Add funding fields to `contracts` table

**SEARCH/REPLACE in `src/db/schema.ts`:**

Find the `contracts` table definition and add three new fields after `endDate`:

```typescript
export const contracts = pgTable('contracts', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractNumber: varchar('contract_number', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  contractType: varchar('contract_type', { length: 20 }).notNull().default('prime'), // 'prime' or 'sub'
  status: statusEnum('status').notNull().default('active'),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  fundedValue: varchar('funded_value', { length: 20 }),     // currently obligated/funded amount
  ceilingValue: varchar('ceiling_value', { length: 20 }),   // maximum contract ceiling
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

New fields:
- `contractType` — `varchar` defaulting to `'prime'`, values: `'prime'` or `'sub'`
- `fundedValue` — nullable `varchar` for the currently funded/obligated amount
- `ceilingValue` — nullable `varchar` for the maximum contract ceiling value

#### A2. Add funding field to `clins` table

**SEARCH/REPLACE in `src/db/schema.ts`:**

Add `fundedAmount` field to the `clins` table after `description`:

```typescript
export const clins = pgTable('clins', {
  id: uuid('id').defaultRandom().primaryKey(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  clinNumber: varchar('clin_number', { length: 50 }).notNull(),
  description: text('description'),
  fundedAmount: varchar('funded_amount', { length: 20 }), // funded amount for this CLIN
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

#### A3. Push schema changes

```bash
npx drizzle-kit push
```

---

### Phase B: Update Existing Server Actions (B1–B2)

#### B1. Update `src/server/actions/contracts.ts`

Add `contractType`, `fundedValue`, and `ceilingValue` to `createContract` and `updateContract` signatures:

```typescript
'use server';

import { db } from '@/db';
import { contracts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getContracts() {
  return db.select().from(contracts).orderBy(contracts.name);
}

export async function getContractById(id: string) {
  const rows = await db.select().from(contracts).where(eq(contracts.id, id));
  return rows[0] ?? null;
}

export async function createContract(data: {
  contractNumber: string;
  name: string;
  description?: string;
  contractType?: string;
  startDate?: Date;
  endDate?: Date;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  const rows = await db.insert(contracts).values(data).returning();
  return rows[0];
}

export async function updateContract(id: string, data: {
  contractNumber?: string;
  name?: string;
  description?: string;
  contractType?: string;
  status?: 'active' | 'inactive' | 'closed';
  startDate?: Date;
  endDate?: Date;
  fundedValue?: string;
  ceilingValue?: string;
}) {
  const rows = await db.update(contracts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(contracts.id, id))
    .returning();
  return rows[0];
}
```

#### B2. Update `src/server/actions/clins.ts`

Add `fundedAmount` to `createClin` and `updateClin`:

```typescript
'use server';

import { db } from '@/db';
import { clins } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getClinsByContract(contractId: string) {
  return db.select().from(clins).where(eq(clins.contractId, contractId)).orderBy(clins.clinNumber);
}

export async function createClin(data: {
  contractId: string;
  clinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  const rows = await db.insert(clins).values(data).returning();
  return rows[0];
}

export async function updateClin(id: string, data: {
  clinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(clins)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(clins.id, id))
    .returning();
  return rows[0];
}
```

---

### Phase C: Update Contracts UI (C1–C2)

#### C1. Update ContractsClient.tsx — Contract types and form fields

Add to the `Contract` type:
```typescript
type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  description: string | null;
  contractType: string;           // NEW
  status: 'active' | 'inactive' | 'closed';
  startDate: Date | null;
  endDate: Date | null;
  fundedValue: string | null;     // NEW
  ceilingValue: string | null;    // NEW
  createdAt: Date;
  updatedAt: Date;
};
```

Add to the `Clin` type:
```typescript
type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;    // NEW
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};
```

Add to `ContractForm` type:
```typescript
type ContractForm = {
  contractNumber: string;
  name: string;
  description: string;
  contractType: string;           // NEW — default 'prime'
  startDate: string | null;
  endDate: string | null;
  fundedValue: string;            // NEW
  ceilingValue: string;           // NEW
};
```

Update `EMPTY_FORM`:
```typescript
const EMPTY_FORM: ContractForm = {
  contractNumber: '',
  name: '',
  description: '',
  contractType: 'prime',
  startDate: null,
  endDate: null,
  fundedValue: '',
  ceilingValue: '',
};
```

**Add to the Contract Modal form** (after the `description` Textarea, before the DateInputs):

```tsx
<Select
  label="Contract Type"
  data={[
    { value: 'prime', label: 'Prime Contract' },
    { value: 'sub', label: 'Subcontract' },
  ]}
  value={contractForm.contractType}
  onChange={(val) => setContractForm((f) => ({ ...f, contractType: val ?? 'prime' }))}
/>
<TextInput
  label="Funded Value ($)"
  placeholder="500000.00"
  value={contractForm.fundedValue}
  onChange={(e) => setContractForm((f) => ({ ...f, fundedValue: e.target.value }))}
/>
<TextInput
  label="Ceiling Value ($)"
  placeholder="750000.00"
  value={contractForm.ceilingValue}
  onChange={(e) => setContractForm((f) => ({ ...f, ceilingValue: e.target.value }))}
/>
```

Import `Select` from `@mantine/core` (it's likely already imported — verify).

**Add to the Contracts MRT table columns** — add a "Type" column and a "Funded" column after Status:

```typescript
{
  accessorKey: 'contractType',
  header: 'Type',
  Cell: ({ cell }) => (
    <Badge color={cell.getValue<string>() === 'prime' ? 'blue' : 'grape'} variant="light" size="sm">
      {cell.getValue<string>() === 'prime' ? 'Prime' : 'Sub'}
    </Badge>
  ),
  size: 90,
},
{
  accessorKey: 'fundedValue',
  header: 'Funded',
  Cell: ({ cell }) => {
    const val = cell.getValue<string | null>();
    if (!val) return <Text size="sm" c="dimmed">—</Text>;
    const num = parseFloat(val);
    return isNaN(num) ? '—' : `$${num.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  },
  size: 130,
},
```

**Update `openEditModal`** to populate the new fields:
```typescript
contractType: contract.contractType ?? 'prime',
fundedValue: contract.fundedValue ?? '',
ceilingValue: contract.ceilingValue ?? '',
```

**Update `handleContractSubmit`** to include the new fields in the payload sent to `createContract`/`updateContract`.

#### C2. Update CLINs Drawer — Add funded amount field

In the CLINs drawer form (the "Add CLIN" section), add a `TextInput` for funded amount:

```tsx
<TextInput
  label="Funded Amount ($)"
  placeholder="100000.00"
  value={clinForm.fundedAmount}
  onChange={(e) => setClinForm((f) => ({ ...f, fundedAmount: e.target.value }))}
  style={{ minWidth: 150 }}
/>
```

Update the `clinForm` state to include `fundedAmount`:
```typescript
const [clinForm, setClinForm] = useState({ clinNumber: '', description: '', fundedAmount: '' });
```

Update the CLINs table in the drawer to show funded amount:
```tsx
<Table.Th>Funded</Table.Th>
// ... in the row:
<Table.Td>
  {clin.fundedAmount ? `$${parseFloat(clin.fundedAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
</Table.Td>
```

---

### Phase D: Cost Calculation Engine (D1)

#### D1. Create `src/server/actions/dashboard.ts`

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
import { eq, and, sql, gte, lt, desc } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Types
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
// Dashboard Queries
// ---------------------------------------------------------------------------

/**
 * Get a cost summary for all active contracts.
 * Calculates total hours and cost (hours × rate) per contract and CLIN.
 *
 * Cost calculation logic:
 * 1. For each timesheet entry, find the LATEST revision (highest revision_number)
 * 2. Look up the user's labor category assignment for that CLIN
 * 3. Multiply hours × hourly_rate
 * 4. Sum by CLIN and contract
 */
export async function getContractSummaries(): Promise<ContractSummary[]> {
  // Get all contracts
  const allContracts = await db
    .select()
    .from(contracts)
    .orderBy(contracts.name);

  const summaries: ContractSummary[] = [];

  for (const contract of allContracts) {
    // Get CLINs for this contract
    const contractClins = await db
      .select()
      .from(clins)
      .where(eq(clins.contractId, contract.id))
      .orderBy(clins.clinNumber);

    const clinSummaries: ClinSummary[] = [];

    for (const clin of contractClins) {
      // Get the latest revision hours for each (user, clin, date) tuple
      // Using a subquery approach: get max revision per (userId, clinId, entryDate)
      const latestEntries = await db
        .select({
          userId: timesheetEntries.userId,
          hours: timesheetEntries.hours,
        })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.clinId, clin.id),
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
        );

      let clinHours = 0;
      let clinCost = 0;

      for (const entry of latestEntries) {
        const hours = parseFloat(entry.hours) || 0;
        clinHours += hours;

        // Look up the user's rate for this CLIN via labor categories
        const userRate = await db
          .select({
            hourlyRate: laborCategories.hourlyRate,
          })
          .from(userLaborCategories)
          .innerJoin(laborCategories, eq(userLaborCategories.laborCategoryId, laborCategories.id))
          .where(
            and(
              eq(userLaborCategories.userId, entry.userId),
              eq(laborCategories.clinId, clin.id),
              eq(laborCategories.status, 'active'),
            )
          )
          .limit(1);

        if (userRate.length > 0) {
          const rate = parseFloat(userRate[0].hourlyRate) || 0;
          clinCost += hours * rate;
        }
      }

      clinSummaries.push({
        clinId: clin.id,
        clinNumber: clin.clinNumber,
        description: clin.description,
        fundedAmount: clin.fundedAmount,
        status: clin.status,
        totalHours: Math.round(clinHours * 100) / 100,
        totalCost: Math.round(clinCost * 100) / 100,
      });
    }

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
 * Get a period-based cost report showing hours × rate by employee/CLIN/LCAT.
 * Used for generating invoicing data and cost summaries.
 */
export async function getPeriodCostReport(
  startDate: Date,
  endDate: Date
): Promise<PeriodCostEntry[]> {
  const endDateExclusive = dayjs(endDate).add(1, 'day').toDate();

  // Get all latest-revision entries in the date range
  const entries = await db
    .select({
      userId: timesheetEntries.userId,
      clinId: timesheetEntries.clinId,
      hours: timesheetEntries.hours,
    })
    .from(timesheetEntries)
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
    );

  // Aggregate: group by (userId, clinId)
  const aggregated = new Map<string, { userId: string; clinId: string; totalHours: number }>();
  for (const entry of entries) {
    const key = `${entry.userId}-${entry.clinId}`;
    const existing = aggregated.get(key);
    const hours = parseFloat(entry.hours) || 0;
    if (existing) {
      existing.totalHours += hours;
    } else {
      aggregated.set(key, { userId: entry.userId, clinId: entry.clinId, totalHours: hours });
    }
  }

  // Build the report entries with user/CLIN/LCAT context
  const report: PeriodCostEntry[] = [];

  for (const agg of aggregated.values()) {
    // Get user info
    const [user] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, agg.userId));

    // Get CLIN + contract info
    const [clinInfo] = await db
      .select({
        clinNumber: clins.clinNumber,
        contractName: contracts.name,
        contractNumber: contracts.contractNumber,
      })
      .from(clins)
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .where(eq(clins.id, agg.clinId));

    // Get user's LCAT for this CLIN
    const userLcat = await db
      .select({
        lcatCode: laborCategories.lcatCode,
        lcatTitle: laborCategories.title,
        hourlyRate: laborCategories.hourlyRate,
      })
      .from(userLaborCategories)
      .innerJoin(laborCategories, eq(userLaborCategories.laborCategoryId, laborCategories.id))
      .where(
        and(
          eq(userLaborCategories.userId, agg.userId),
          eq(laborCategories.clinId, agg.clinId),
          eq(laborCategories.status, 'active'),
        )
      )
      .limit(1);

    const rate = userLcat.length > 0 ? parseFloat(userLcat[0].hourlyRate) || 0 : 0;
    const totalHours = Math.round(agg.totalHours * 100) / 100;
    const totalCost = Math.round(totalHours * rate * 100) / 100;

    report.push({
      userName: user?.fullName ?? 'Unknown',
      contractName: clinInfo?.contractName ?? 'Unknown',
      contractNumber: clinInfo?.contractNumber ?? '',
      clinNumber: clinInfo?.clinNumber ?? '',
      lcatCode: userLcat[0]?.lcatCode ?? '—',
      lcatTitle: userLcat[0]?.lcatTitle ?? 'No LCAT',
      hourlyRate: userLcat[0]?.hourlyRate ?? '0',
      totalHours,
      totalCost,
    });
  }

  // Sort by contract, CLIN, employee
  report.sort((a, b) =>
    a.contractName.localeCompare(b.contractName) ||
    a.clinNumber.localeCompare(b.clinNumber) ||
    a.userName.localeCompare(b.userName)
  );

  return report;
}
```

---

### Phase E: Contract Dashboard Page (E1–E3)

#### E1. Create `src/app/(app)/admin/dashboard/Dashboard.module.css`

```css
.tableHeaderCell button {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

#### E2. Create `src/app/(app)/admin/dashboard/page.tsx`

```typescript
import { getContractSummaries } from '@/server/actions/dashboard';
import { DashboardClient } from './DashboardClient';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin' && session.user.role !== 'supervisor') {
    redirect('/timesheet');
  }

  const summaries = await getContractSummaries();

  return <DashboardClient initialSummaries={summaries} />;
}
```

#### E3. Create `src/app/(app)/admin/dashboard/DashboardClient.tsx`

This is a `'use client'` component with **three sections**:

**Section A — Overview Cards:**
- Total Contracts (count)
- Total Funded Value (sum of all contract funded values)
- Total Spent (sum of all calculated costs)
- Budget Remaining (funded - spent)

**Section B — Contract Summary Table (MRT):**

| Column | Source | Width |
|---|---|---|
| Contract | `contractName (contractNumber)` | 240 |
| Type | `contractType` (Badge: blue=Prime, grape=Sub) | 90 |
| Funded | `fundedValue` ($-formatted or `—`) | 130 |
| Ceiling | `ceilingValue` ($-formatted or `—`) | 130 |
| Hours Burned | `totalHours` | 110 |
| Cost Incurred | `totalCost` ($-formatted) | 130 |
| Remaining | `fundedValue - totalCost` (color-coded) | 130 |
| Burn % | Progress bar with % | 130 |
| Status | status (Badge) | 100 |

**Table Features:**
- `enableExpandedRows: true` — expanding a contract row shows its CLIN-level breakdown
- Row detail panel shows a sub-table with CLIN Number, Description, Funded, Hours, Cost, Remaining
- Burn % column uses Mantine `Progress` component with color coding:
  - Green: < 75%
  - Yellow: 75% - 90%
  - Red: > 90%

**Section C — Period Cost Report:**
- Date range selector (two `DateInput` fields + "Generate" button)
- Calls `getPeriodCostReport(startDate, endDate)`
- Renders a second MRT table with: Employee, Contract, CLIN, LCAT, Rate, Hours, Cost
- Grand total row at the bottom

**Full Component Implementation:**

```typescript
'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  SimpleGrid,
  ThemeIcon,
  Progress,
  Divider,
  Table,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconReportMoney,
  IconCash,
  IconReceipt,
  IconChartBar,
} from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import {
  getPeriodCostReport,
  type ContractSummary,
  type PeriodCostEntry,
} from '@/server/actions/dashboard';
import classes from './Dashboard.module.css';

type Props = {
  initialSummaries: ContractSummary[];
};

function formatCurrency(val: number): string {
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCurrencyString(val: string | null): string {
  if (!val) return '—';
  const num = parseFloat(val);
  return isNaN(num) ? '—' : formatCurrency(num);
}

function getBurnColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'green';
}

export function DashboardClient({ initialSummaries }: Props) {
  const [isPending, startTransition] = useTransition();
  const [summaries] = useState<ContractSummary[]>(initialSummaries);

  // Period cost report state
  const [reportStartDate, setReportStartDate] = useState<string | null>(null);
  const [reportEndDate, setReportEndDate] = useState<string | null>(null);
  const [costReport, setCostReport] = useState<PeriodCostEntry[]>([]);
  const [hasGeneratedReport, setHasGeneratedReport] = useState(false);

  // Overview calculations
  const totalContracts = summaries.length;
  const totalFunded = summaries.reduce((sum, s) => sum + (parseFloat(s.fundedValue ?? '0') || 0), 0);
  const totalSpent = summaries.reduce((sum, s) => sum + s.totalCost, 0);
  const totalRemaining = totalFunded - totalSpent;

  function handleGenerateReport() {
    if (!reportStartDate || !reportEndDate) return;
    startTransition(async () => {
      const report = await getPeriodCostReport(
        new Date(reportStartDate),
        new Date(reportEndDate),
      );
      setCostReport(report);
      setHasGeneratedReport(true);
    });
  }

  // --- Contract Summary columns ---

  const contractColumns: MRT_ColumnDef<ContractSummary>[] = [
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 240,
    },
    {
      accessorKey: 'contractType',
      header: 'Type',
      Cell: ({ cell }) => (
        <Badge color={cell.getValue<string>() === 'prime' ? 'blue' : 'grape'} variant="light" size="sm">
          {cell.getValue<string>() === 'prime' ? 'Prime' : 'Sub'}
        </Badge>
      ),
      size: 90,
    },
    {
      accessorKey: 'fundedValue',
      header: 'Funded',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string | null>()),
      size: 130,
    },
    {
      accessorKey: 'ceilingValue',
      header: 'Ceiling',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string | null>()),
      size: 130,
    },
    {
      accessorKey: 'totalHours',
      header: 'Hours Burned',
      Cell: ({ cell }) => cell.getValue<number>().toFixed(2),
      size: 110,
    },
    {
      accessorKey: 'totalCost',
      header: 'Cost Incurred',
      Cell: ({ cell }) => formatCurrency(cell.getValue<number>()),
      size: 130,
    },
    {
      id: 'remaining',
      header: 'Remaining',
      accessorFn: (row) => {
        const funded = parseFloat(row.fundedValue ?? '0') || 0;
        return funded - row.totalCost;
      },
      Cell: ({ cell }) => {
        const remaining = cell.getValue<number>();
        const color = remaining < 0 ? 'red' : remaining < 10000 ? 'orange' : 'green';
        return <Text size="sm" c={color} fw={600}>{formatCurrency(remaining)}</Text>;
      },
      size: 130,
    },
    {
      id: 'burnPct',
      header: 'Burn %',
      accessorFn: (row) => {
        const funded = parseFloat(row.fundedValue ?? '0') || 0;
        if (funded === 0) return 0;
        return Math.round((row.totalCost / funded) * 100);
      },
      Cell: ({ cell }) => {
        const pct = cell.getValue<number>();
        return (
          <Group gap="xs" wrap="nowrap">
            <Progress value={Math.min(pct, 100)} color={getBurnColor(pct)} size="lg" style={{ flex: 1, minWidth: 60 }} />
            <Text size="xs" fw={600} style={{ minWidth: 35 }}>{pct}%</Text>
          </Group>
        );
      },
      size: 150,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => {
        const status = cell.getValue<string>();
        const colors: Record<string, string> = { active: 'green', inactive: 'gray', closed: 'red' };
        return <Badge color={colors[status] ?? 'gray'} variant="light" size="sm">{status}</Badge>;
      },
      size: 100,
    },
  ];

  const contractTable = useMantineReactTable({
    columns: contractColumns,
    data: summaries,
    enableExpanding: true,
    renderDetailPanel: ({ row }) => {
      const contract = row.original;
      if (contract.clinSummaries.length === 0) {
        return <Text size="sm" c="dimmed" p="md">No CLINs for this contract.</Text>;
      }
      return (
        <Table striped highlightOnHover withColumnBorders={false} style={{ margin: '8px 16px' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>CLIN</Table.Th>
              <Table.Th>Description</Table.Th>
              <Table.Th>Funded</Table.Th>
              <Table.Th>Hours</Table.Th>
              <Table.Th>Cost</Table.Th>
              <Table.Th>Remaining</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {contract.clinSummaries.map((clin) => {
              const funded = parseFloat(clin.fundedAmount ?? '0') || 0;
              const remaining = funded - clin.totalCost;
              return (
                <Table.Tr key={clin.clinId}>
                  <Table.Td>{clin.clinNumber}</Table.Td>
                  <Table.Td>{clin.description ?? '—'}</Table.Td>
                  <Table.Td>{formatCurrencyString(clin.fundedAmount)}</Table.Td>
                  <Table.Td>{clin.totalHours.toFixed(2)}</Table.Td>
                  <Table.Td>{formatCurrency(clin.totalCost)}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c={remaining < 0 ? 'red' : 'green'} fw={600}>
                      {clin.fundedAmount ? formatCurrency(remaining) : '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={clin.status === 'active' ? 'green' : 'gray'} variant="light" size="sm">
                      {clin.status}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      );
    },
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
  });

  // --- Period Cost Report columns ---

  const costColumns: MRT_ColumnDef<PeriodCostEntry>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 160 },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 200,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      id: 'lcat',
      header: 'LCAT',
      accessorFn: (row) => `${row.lcatCode} — ${row.lcatTitle}`,
      size: 200,
    },
    {
      accessorKey: 'hourlyRate',
      header: 'Rate',
      Cell: ({ cell }) => formatCurrencyString(cell.getValue<string>()) + '/hr',
      size: 120,
    },
    {
      accessorKey: 'totalHours',
      header: 'Hours',
      Cell: ({ cell }) => cell.getValue<number>().toFixed(2),
      size: 100,
    },
    {
      accessorKey: 'totalCost',
      header: 'Cost',
      Cell: ({ cell }) => formatCurrency(cell.getValue<number>()),
      size: 130,
    },
  ];

  const costTable = useMantineReactTable({
    columns: costColumns,
    data: costReport,
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      className: classes.tableHeaderCell,
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
  });

  const reportTotal = costReport.reduce((sum, r) => sum + r.totalCost, 0);
  const reportHours = costReport.reduce((sum, r) => sum + r.totalHours, 0);

  return (
    <>
      {/* ---- Section A: Overview Cards ---- */}
      <Title order={2} mb="md">Contract Dashboard</Title>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="xl">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Contracts</Text>
              <Text size="xl" fw={700}>{totalContracts}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconReportMoney size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Funded</Text>
              <Text size="xl" fw={700}>{formatCurrency(totalFunded)}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="lg" radius="md">
              <IconCash size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Spent</Text>
              <Text size="xl" fw={700}>{formatCurrency(totalSpent)}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="lg" radius="md">
              <IconReceipt size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Remaining</Text>
              <Text size="xl" fw={700} c={totalRemaining < 0 ? 'red' : undefined}>
                {formatCurrency(totalRemaining)}
              </Text>
            </div>
            <ThemeIcon color={totalRemaining < 0 ? 'red' : 'teal'} variant="light" size="lg" radius="md">
              <IconChartBar size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* ---- Section B: Contract Summary Table ---- */}
      <Title order={3} mb="sm">Contract Budget Overview</Title>
      <MantineReactTable table={contractTable} />

      {/* ---- Section C: Period Cost Report ---- */}
      <Divider my="xl" />
      <Title order={3} mb="sm">Period Cost Report</Title>

      <Paper withBorder p="md" mb="xl">
        <Group align="flex-end" wrap="wrap" gap="md">
          <DateInput
            label="Start Date"
            value={reportStartDate}
            onChange={setReportStartDate}
            required
            style={{ minWidth: 160 }}
          />
          <DateInput
            label="End Date"
            value={reportEndDate}
            onChange={setReportEndDate}
            required
            style={{ minWidth: 160 }}
          />
          <Button
            onClick={handleGenerateReport}
            loading={isPending}
            disabled={!reportStartDate || !reportEndDate}
          >
            Generate Report
          </Button>
        </Group>
      </Paper>

      {!hasGeneratedReport && (
        <Paper withBorder p="xl" ta="center">
          <Text c="dimmed" size="lg">
            Select a date range and click &quot;Generate Report&quot; to view period costs.
          </Text>
        </Paper>
      )}

      {hasGeneratedReport && (
        <>
          <MantineReactTable table={costTable} />
          {costReport.length > 0 && (
            <Paper withBorder p="md" mt="sm">
              <Group justify="space-between">
                <Text fw={700}>Totals</Text>
                <Group gap="xl">
                  <Text fw={600}>{reportHours.toFixed(2)} hrs</Text>
                  <Text fw={700} size="lg">{formatCurrency(reportTotal)}</Text>
                </Group>
              </Group>
            </Paper>
          )}
        </>
      )}
    </>
  );
}
```

---

### Phase F: Add Nav Link (F1)

#### F1. Modify `src/components/shell/AppNavbar.tsx`

**SEARCH/REPLACE:**

Find this import line:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory, IconHistory } from '@tabler/icons-react';
```

Replace with:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory, IconHistory, IconChartBar } from '@tabler/icons-react';
```

Then find:
```typescript
          <NavLink
            label="Contracts & CLINs"
            href="/admin/contracts"
            leftSection={<IconFileText size={18} />}
            active={pathname === '/admin/contracts'}
          />
```

Insert **BEFORE** that NavLink:
```typescript
          <NavLink
            label="Contract Dashboard"
            href="/admin/dashboard"
            leftSection={<IconChartBar size={18} />}
            active={pathname === '/admin/dashboard'}
          />
```

The final nav order in the ADMINISTRATION section should be:
1. **Contract Dashboard** ← NEW (first, as the PM overview)
2. Contracts & CLINs
3. User Assignments
4. Timesheet Approvals
5. Labor Categories
6. Audit Trail
7. User Management

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Dev Server Visual Checks

| Check | Expected Result |
|---|---|
| **Nav link** | "Contract Dashboard" appears first in the ADMINISTRATION section |
| **Dashboard cards** | Four summary cards showing Contracts, Total Funded, Total Spent, Remaining |
| **Contract table** | MRT with Type (Prime/Sub badges), Funded, Ceiling, Hours, Cost, Remaining, Burn % (Progress bars) |
| **Expand rows** | Clicking expand chevron shows CLIN-level breakdown sub-table |
| **Burn % colors** | Green < 75%, Yellow 75-90%, Red > 90% |
| **Remaining colors** | Green for positive, red for negative (over-budget) |
| **Contract modal** | New fields: Contract Type (Select), Funded Value, Ceiling Value |
| **CLIN drawer** | New field: Funded Amount for each CLIN |
| **Period cost report** | Date range → Generate → Table with Employee, Contract, CLIN, LCAT, Rate, Hours, Cost + totals |
| **No timesheet impact** | `/timesheet` still works identically |

### 4c. Guardrail Verification

```bash
git diff --name-only
```

Must NOT include files from the DO NOT MODIFY list.

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "contract_type" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `column "funded_value" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `enableExpanding is not a valid option` | MRT v2 API difference | Try `enableExpandedRows` or check MRT v2 docs |
| `Progress is not exported` | Mantine import | `Progress` is in `@mantine/core` |
| `IconChartBar is not exported` | Tabler icons | Try `IconChartLine` or `IconGraph` |
| SQL subquery error | The correlated subquery for max revision | Ensure the `sql` template literal properly references `timesheetEntries` columns |
| Hydration mismatch | Date formatting differences | All dates formatted client-side in Cell renderers |
