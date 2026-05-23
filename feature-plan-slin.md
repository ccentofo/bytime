# Blueprint: Sub-Line Item Numbers (SLINs) — Completing the GovCon Data Hierarchy

## 1. Architectural Overview & DCAA Impact

### The Missing Layer

The CONTEXT.md defines the full GovCon data hierarchy:

```
Contracts → CLINs → SLINs → Labor Categories → Employees → Timesheet Entries
```

Currently the system implements:

```
Contracts → CLINs → Labor Categories → Employees → Timesheet Entries
```

**SLINs are absent.** In real government contracting, CLINs are frequently broken into Sub-Line Item Numbers (SLINs) for granular financial tracking. Examples:

| CLIN | SLIN | Purpose |
|---|---|---|
| 0001 | 0001AA | Base Year Labor |
| 0001 | 0001AB | Option Year 1 Labor |
| 0001 | 0001AC | Option Year 2 Labor |
| 0002 | 0002AA | ODC — Travel Base Year |
| 0002 | 0002AB | ODC — Travel Option Year 1 |

SLINs are individually funded and tracked. Each SLIN has its own funded amount, and labor categories can be assigned at the SLIN level for more precise cost allocation.

### Design Decisions

**Key principle: SLINs are optional.** Not every CLIN has SLINs. The system must support both:
- **CLIN-only mode:** Labor categories, assignments, and timesheet entries reference the CLIN directly (existing behavior, unchanged)
- **SLIN mode:** When a CLIN has SLINs, labor categories, assignments, and entries reference the SLIN instead

This is achieved by making `slinId` **nullable** on `laborCategories`, `userAssignments`, and `timesheetEntries`. When a CLIN has SLINs:
- Labor categories are created under SLINs (not the CLIN directly)
- User assignments point to SLINs
- Timesheet entries record the SLIN ID

When a CLIN has no SLINs, everything works exactly as it does today (CLIN-level).

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How This Feature Satisfies It |
|---|---|
| **FAR 4.1603 — SLIN Structure** | Proper sub-line item tracking per DFARS/FAR contract structure |
| **FAR 52.232-22 — Limitation of Funds** | SLIN-level funding tracking enables precise obligation monitoring per sub-task |
| **CAS 418 — Cost Accounting Standard** | SLIN-level labor category rates ensure costs are allocated to the correct work breakdown element |
| **DCAA Audit Granularity** | Audit trail includes SLIN context, enabling drill-down from contract → CLIN → SLIN → entry |

---

## 2. File Topology

```
Files to CREATE (new):
├── src/server/actions/slins.ts                          ← Server Actions: SLIN CRUD

Files to MODIFY:
├── src/db/schema.ts                                     ← Add slins table, add slinId FK to related tables
├── src/server/actions/contracts.ts                       ← No changes (contracts don't reference SLINs)
├── src/server/actions/clins.ts                           ← No changes (CLINs don't need modification)
├── src/server/actions/labor-categories.ts                ← Support optional slinId for LCAT creation
├── src/server/actions/assignments.ts                     ← Support optional slinId for assignments
├── src/server/actions/timesheet.ts                       ← Include slinId in charge codes and entry saves
├── src/server/actions/dashboard.ts                       ← SLIN-level cost breakdown
├── src/server/actions/audit.ts                           ← Include SLIN context in audit queries
├── src/types/timesheet.ts                                ← Add slinId to ChargeCode type
├── src/app/(app)/admin/contracts/ContractsClient.tsx     ← SLIN management UI in CLINs drawer
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx ← SLIN-aware assignment UI
├── src/app/(app)/admin/labor-categories/LaborCategoriesClient.tsx ← Show SLIN context
├── src/app/(app)/admin/dashboard/DashboardClient.tsx     ← SLIN-level detail in expanded rows
├── src/components/timesheet/cells/ChargeCodeCell.tsx     ← Display SLIN when present

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                          ← ❌ DO NOT MODIFY
├── src/middleware.ts                                    ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                      ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/*                    ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                          ← ❌ DO NOT MODIFY
├── src/components/shell/*                               ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx  ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx              ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx              ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetToolbar.tsx         ← ❌ DO NOT MODIFY
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
> - All monetary values stored as `varchar` strings (consistent with existing pattern) — parse to `parseFloat()` only for calculations.
> - SLINs are **optional** — all existing behavior without SLINs must continue to work identically.

---

### Phase A: Schema Updates (A1–A3)

#### A1. Add `slins` table to `src/db/schema.ts`

Add the new table AFTER the `clins` table definition and BEFORE the `userAssignments` table:

```typescript
// ---------------------------------------------------------------------------
// SLINs (Sub-Line Item Numbers) — optional subdivision of CLINs
// ---------------------------------------------------------------------------

export const slins = pgTable('slins', {
  id: uuid('id').defaultRandom().primaryKey(),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  slinNumber: varchar('slin_number', { length: 50 }).notNull(),
  description: text('description'),
  fundedAmount: varchar('funded_amount', { length: 20 }), // funded amount for this SLIN
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('clin_slin_unique_idx').on(table.clinId, table.slinNumber),
]);
```

#### A2. Add `slinId` FK to existing tables

**A2a.** Add nullable `slinId` to `userAssignments`:

In the `userAssignments` table definition, add after the `clinId` field:

```typescript
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'cascade' }), // nullable — SLIN-level assignment
```

**A2b.** Add nullable `slinId` to `laborCategories`:

In the `laborCategories` table definition, add after the `clinId` field:

```typescript
  slinId: uuid('slin_id').references(() => slins.id, { onDelete: 'cascade' }), // nullable — SLIN-level LCAT
```

**A2c.** Add nullable `slinId` to `timesheetEntries`:

In the `timesheetEntries` table definition, add after the `clinId` field:

```typescript
  slinId: uuid('slin_id').references(() => slins.id), // nullable — SLIN-level entry
```

#### A3. Push schema changes

```bash
npx drizzle-kit push
```

---

### Phase B: Server Actions (B1–B5)

#### B1. Create `src/server/actions/slins.ts`

```typescript
'use server';

import { db } from '@/db';
import { slins } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getSlinsByClin(clinId: string) {
  return db.select().from(slins).where(eq(slins.clinId, clinId)).orderBy(slins.slinNumber);
}

export async function createSlin(data: {
  clinId: string;
  slinNumber: string;
  description?: string;
  fundedAmount?: string;
}) {
  const rows = await db.insert(slins).values(data).returning();
  return rows[0];
}

export async function updateSlin(id: string, data: {
  slinNumber?: string;
  description?: string;
  fundedAmount?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(slins)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(slins.id, id))
    .returning();
  return rows[0];
}
```

#### B2. Update `src/server/actions/labor-categories.ts`

**B2a.** Add `slins` import at the top:

```typescript
import { laborCategories, userLaborCategories, users, clins, contracts, slins } from '@/db/schema';
```

**B2b.** Update `getAllLaborCategories()` to include SLIN context. Add a LEFT JOIN to `slins` and include `slinNumber` in the select:

```typescript
export async function getAllLaborCategories() {
  return db
    .select({
      id: laborCategories.id,
      clinId: laborCategories.clinId,
      slinId: laborCategories.slinId,
      lcatCode: laborCategories.lcatCode,
      title: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      ceilingRate: laborCategories.ceilingRate,
      status: laborCategories.status,
      createdAt: laborCategories.createdAt,
      updatedAt: laborCategories.updatedAt,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(laborCategories.slinId, slins.id))
    .orderBy(contracts.name, clins.clinNumber, laborCategories.lcatCode);
}
```

**B2c.** Update `createLaborCategory()` to accept optional `slinId`:

```typescript
export async function createLaborCategory(data: {
  clinId: string;
  slinId?: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate?: string;
}) {
  const rows = await db.insert(laborCategories).values(data).returning();
  return rows[0];
}
```

**B2d.** Update `getAssignableLaborCategories()` to include SLIN context:

```typescript
export async function getAssignableLaborCategories() {
  return db
    .select({
      id: laborCategories.id,
      lcatCode: laborCategories.lcatCode,
      title: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      clinId: laborCategories.clinId,
      slinId: laborCategories.slinId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(laborCategories.slinId, slins.id))
    .where(
      and(
        eq(laborCategories.status, 'active'),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber, laborCategories.lcatCode);
}
```

#### B3. Update `src/server/actions/assignments.ts`

**B3a.** Add `slins` import:

```typescript
import { userAssignments, users, clins, contracts, slins } from '@/db/schema';
```

**B3b.** Update `getAssignments()` to include SLIN context:

```typescript
export async function getAssignments() {
  return db
    .select({
      id: userAssignments.id,
      userId: userAssignments.userId,
      clinId: userAssignments.clinId,
      slinId: userAssignments.slinId,
      isActive: userAssignments.isActive,
      assignedAt: userAssignments.assignedAt,
      userName: users.fullName,
      userEmail: users.email,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
      slinDescription: slins.description,
    })
    .from(userAssignments)
    .innerJoin(users, eq(userAssignments.userId, users.id))
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .orderBy(users.fullName, contracts.name);
}
```

**B3c.** Update `assignUserToClin()` to accept optional `slinId`:

```typescript
export async function assignUserToClin(data: {
  userId: string;
  clinId: string;
  slinId?: string;
  assignedBy?: string;
}) {
  const rows = await db
    .insert(userAssignments)
    .values(data)
    .onConflictDoUpdate({
      target: [userAssignments.userId, userAssignments.clinId],
      set: { isActive: true, assignedAt: new Date(), slinId: data.slinId ?? null },
    })
    .returning();
  return rows[0];
}
```

**B3d.** Update `getAssignmentsForUser()` to include SLIN context:

```typescript
export async function getAssignmentsForUser(userId: string) {
  return db
    .select({
      id: userAssignments.id,
      clinId: userAssignments.clinId,
      slinId: userAssignments.slinId,
      isActive: userAssignments.isActive,
      clinNumber: clins.clinNumber,
      clinDescription: clins.description,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(eq(userAssignments.userId, userId))
    .orderBy(contracts.name);
}
```

#### B4. Update `src/server/actions/timesheet.ts`

**B4a.** Add `slins` import:

```typescript
import { timesheetEntries, userAssignments, clins, contracts, slins } from '@/db/schema';
```

**B4b.** Update the `ChargeCode` query in `getChargeCodesForUser()` to include SLIN info:

```typescript
export async function getChargeCodesForUser(userId: string): Promise<ChargeCode[]> {
  const rows = await db
    .select({
      id: clins.id,
      projectName: contracts.name,
      clin: clins.clinNumber,
      description: clins.description,
      slinId: userAssignments.slinId,
      slinNumber: slins.slinNumber,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .leftJoin(slins, eq(userAssignments.slinId, slins.id))
    .where(
      and(
        eq(userAssignments.userId, userId),
        eq(userAssignments.isActive, true),
        eq(clins.status, 'active'),
        eq(contracts.status, 'active'),
      )
    )
    .orderBy(contracts.name, clins.clinNumber);

  return rows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    clin: r.clin,
    description: r.description ?? '',
    slinId: r.slinId ?? undefined,
    slinNumber: r.slinNumber ?? undefined,
  }));
}
```

**B4c.** Update `saveTimesheetBatch()` cell interface to accept optional `slinId`:

In the `cells` array type, add:

```typescript
    slinId?: string;
```

And in the INSERT:

```typescript
    await db.insert(timesheetEntries).values({
      userId: data.userId,
      clinId: cell.clinId,
      slinId: cell.slinId ?? null,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: (cell.isEdit || cell.isLateEntry) ? (data.changeReasonCode ?? undefined) : undefined,
      comment: (cell.isEdit || cell.isLateEntry) ? (data.comment ?? undefined) : undefined,
      createdBy: data.userId,
    });
```

**B4d.** Similarly update `saveTimesheetEntry()` to accept optional `slinId` in its `data` parameter and pass it to the INSERT.

#### B5. Update `src/types/timesheet.ts`

Add optional SLIN fields to the `ChargeCode` interface:

```typescript
export interface ChargeCode {
  id: string;             // maps to clins.id (UUID)
  projectName: string;    // maps to contracts.name
  clin: string;           // maps to clins.clinNumber
  description: string;    // maps to clins.description
  slinId?: string;        // maps to slins.id (UUID) — optional
  slinNumber?: string;    // maps to slins.slinNumber — optional
}
```

---

### Phase C: Contracts UI — SLIN Management (C1–C3)

#### C1. Add SLIN management to `ContractsClient.tsx`

Add a `Slin` type:

```typescript
type Slin = {
  id: string;
  clinId: string;
  slinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};
```

#### C2. Add SLIN sub-section within the CLINs drawer

Inside the CLINs drawer, after each CLIN row in the CLINs table, add an expandable section showing SLINs for that CLIN. Use Mantine's `Accordion` component:

- Each CLIN row has an expand button (Accordion.Item)
- Expanding shows the SLINs table for that CLIN
- An "Add SLIN" form at the top of each expanded CLIN section
- SLIN table columns: SLIN #, Description, Funded, Status, Toggle

**Add state for SLINs:**

```typescript
const [slinsByCliln, setSlinsByClin] = useState<Record<string, Slin[]>>({});
const [slinForm, setSlinForm] = useState({ slinNumber: '', description: '', fundedAmount: '' });
const [expandedClinId, setExpandedClinId] = useState<string | null>(null);
```

**On CLIN expand**, load SLINs:

```typescript
async function handleExpandClin(clinId: string) {
  if (expandedClinId === clinId) {
    setExpandedClinId(null);
    return;
  }
  setExpandedClinId(clinId);
  if (!slinsByClin[clinId]) {
    startTransition(async () => {
      const data = await getSlinsByClin(clinId);
      setSlinsByClin((prev) => ({ ...prev, [clinId]: data as Slin[] }));
    });
  }
}
```

**Add SLIN form/submit handler:**

```typescript
function handleSlinSubmit(clinId: string) {
  startTransition(async () => {
    const created = await createSlin({
      clinId,
      slinNumber: slinForm.slinNumber,
      description: slinForm.description || undefined,
      fundedAmount: slinForm.fundedAmount || undefined,
    });
    if (created) {
      setSlinsByClin((prev) => ({
        ...prev,
        [clinId]: [...(prev[clinId] ?? []), created as Slin],
      }));
      setSlinForm({ slinNumber: '', description: '', fundedAmount: '' });
    }
  });
}
```

Import `getSlinsByClin`, `createSlin`, `updateSlin` from `@/server/actions/slins`.

#### C3. Update CLINs table to show SLIN expand indicator

Add an `ActionIcon` with `IconChevronDown`/`IconChevronRight` to each CLIN row that toggles expansion. When expanded, render a nested section below the row with:

1. "Add SLIN" form (SLIN Number, Description, Funded Amount, Add button)
2. SLINs table showing existing SLINs with status toggle

---

### Phase D: Charge Code Cell Update (D1)

#### D1. Update `src/components/timesheet/cells/ChargeCodeCell.tsx`

Modify the cell to display SLIN information when present:

```typescript
// If the charge code has a SLIN, show it
<Text size="sm" fw={600}>
  {chargeCode.clin}{chargeCode.slinNumber ? ` / ${chargeCode.slinNumber}` : ''} — {chargeCode.projectName}
</Text>
{chargeCode.slinNumber && (
  <Text size="xs" c="dimmed">SLIN: {chargeCode.slinNumber}</Text>
)}
```

---

### Phase E: Dashboard SLIN Breakdown (E1–E2)

#### E1. Update `src/server/actions/dashboard.ts`

**E1a.** Add `slins` import:

```typescript
import {
  contracts,
  clins,
  slins,
  timesheetEntries,
  laborCategories,
  userLaborCategories,
  users,
} from '@/db/schema';
```

**E1b.** Add `SlinSummary` interface:

```typescript
export interface SlinSummary {
  slinId: string;
  slinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  totalCost: number;
}
```

**E1c.** Add `slinSummaries` to `ClinSummary`:

```typescript
export interface ClinSummary {
  clinId: string;
  clinNumber: string;
  description: string | null;
  fundedAmount: string | null;
  status: string;
  totalHours: number;
  totalCost: number;
  slinSummaries: SlinSummary[];
}
```

**E1d.** Inside `getContractSummaries()`, for each CLIN, query SLINs and compute SLIN-level costs. If a CLIN has SLINs, break down costs by SLIN. If it has no SLINs, costs remain at the CLIN level as they do today.

**E1e.** Update `getPeriodCostReport()` to include `slinNumber` in the report entry:

```typescript
export interface PeriodCostEntry {
  userName: string;
  contractName: string;
  contractNumber: string;
  clinNumber: string;
  slinNumber: string | null;  // NEW
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: string;
  totalHours: number;
  totalCost: number;
}
```

#### E2. Update `src/app/(app)/admin/dashboard/DashboardClient.tsx`

**E2a.** In the CLIN detail panel (the expandable row), when a CLIN has `slinSummaries.length > 0`, render a sub-table showing SLINs:

```tsx
{clin.slinSummaries.length > 0 && (
  <Table striped highlightOnHover size="xs" style={{ marginLeft: 24, marginTop: 8 }}>
    <Table.Thead>
      <Table.Tr>
        <Table.Th>SLIN</Table.Th>
        <Table.Th>Description</Table.Th>
        <Table.Th>Funded</Table.Th>
        <Table.Th>Hours</Table.Th>
        <Table.Th>Cost</Table.Th>
        <Table.Th>Remaining</Table.Th>
      </Table.Tr>
    </Table.Thead>
    <Table.Tbody>
      {clin.slinSummaries.map((slin) => {
        const funded = parseFloat(slin.fundedAmount ?? '0') || 0;
        const remaining = funded - slin.totalCost;
        return (
          <Table.Tr key={slin.slinId}>
            <Table.Td>{slin.slinNumber}</Table.Td>
            <Table.Td>{slin.description ?? '—'}</Table.Td>
            <Table.Td>{formatCurrencyString(slin.fundedAmount)}</Table.Td>
            <Table.Td>{slin.totalHours.toFixed(2)}</Table.Td>
            <Table.Td>{formatCurrency(slin.totalCost)}</Table.Td>
            <Table.Td>
              <Text size="sm" c={remaining < 0 ? 'red' : 'green'} fw={600}>
                {slin.fundedAmount ? formatCurrency(remaining) : '—'}
              </Text>
            </Table.Td>
          </Table.Tr>
        );
      })}
    </Table.Tbody>
  </Table>
)}
```

**E2b.** Add `slinNumber` column to the period cost report table:

```typescript
{ accessorKey: 'slinNumber', header: 'SLIN', size: 100,
  Cell: ({ cell }) => cell.getValue<string | null>() ?? '—' },
```

---

### Phase F: Audit Trail SLIN Context (F1)

#### F1. Update `src/server/actions/audit.ts`

**F1a.** Add `slins` import and LEFT JOIN to `slins` in the `getAuditEntries()` query:

```typescript
import { timesheetEntries, users, clins, contracts, slins } from '@/db/schema';
```

**F1b.** Add `slinNumber` to the select and `AuditEntry` interface:

```typescript
export interface AuditEntry {
  // ... existing fields ...
  slinNumber: string | null;  // NEW
}
```

**F1c.** Add `.leftJoin(slins, eq(timesheetEntries.slinId, slins.id))` to the query chain and `slinNumber: slins.slinNumber` to the select.

---

## 4. Verification

### 4a. Build Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Backward Compatibility Checks

| Check | Expected Result |
|---|---|
| **Existing CLINs without SLINs** | All existing functionality works identically — timesheet, approvals, audit trail |
| **Timesheet page** | Charge codes display correctly; SLIN info shown only when present |
| **Dashboard** | Contract/CLIN summaries still calculate correctly for CLINs without SLINs |
| **Audit trail** | SLIN column shows `—` for entries without SLINs |

### 4c. New SLIN Functionality Checks

| Check | Expected Result |
|---|---|
| **CLINs drawer → expand CLIN** | Shows "Add SLIN" form and SLINs table |
| **Add SLIN** | Creates SLIN under the CLIN with number, description, funded amount |
| **SLIN status toggle** | Can activate/deactivate SLINs |
| **Labor category with SLIN** | Can create an LCAT under a specific SLIN |
| **Assignment with SLIN** | Can assign a user to a specific SLIN |
| **Timesheet with SLIN** | SLIN-level charge codes appear with SLIN number displayed |
| **Dashboard SLIN breakdown** | Expanding a CLIN with SLINs shows SLIN-level cost breakdown |
| **Period cost report** | SLIN column populated for SLIN-level entries |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "slin_id" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| Existing queries break | Missing LEFT JOIN for nullable slinId | Ensure all slin joins are LEFT JOINs |
| Unique constraint conflict on SLIN insert | Duplicate slinNumber under same CLIN | The unique index prevents this — show user-friendly error |
| Charge code duplication | User assigned to CLIN AND SLIN under same CLIN | Assignment logic should prefer SLIN-level when SLINs exist |

### 4e. Guardrail Verification

```bash
git diff --name-only
```

Must NOT include files from the DO NOT MODIFY list.
