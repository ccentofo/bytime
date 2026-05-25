# Blueprint: Indirect/Overhead & Leave Charge Codes — Complete Total Time Accounting

## 1. Architectural Overview & DCAA Impact

### The DCAA Requirement

**CAS 418 — Allocation of Direct and Indirect Costs:** All hours worked must be accounted for. Employees cannot have "missing" hours in a period. If an employee works 80 hours in a semi-monthly period but only has 60 hours of direct contract work, the remaining 20 hours must be charged to indirect accounts (overhead, G&A, IR&D, B&P) or leave codes.

**FAR 31.203 — Indirect Costs:** Indirect costs must be accumulated by logical cost groupings with a common allocation base. The timekeeping system must distinguish between direct costs (charged to specific contracts) and indirect costs (allocated across contracts).

### The Problem

The current system only supports **direct charge codes** — CLINs under contracts. There is no way to record:

- **Overhead / General & Administrative (G&A)** — Administrative work, training, company meetings
- **Independent Research & Development (IR&D)** — Internal R&D not funded by a specific contract
- **Bid & Proposal (B&P)** — Time spent writing proposals for new contracts
- **Leave** — Annual leave, sick leave, holiday, leave without pay (LWOP)
- **Unallowable** — Personal time, non-reimbursable activities (FAR 31.205 unallowable costs)

Without these, **total time accounting is impossible.** An employee with 32 hours of direct work and 8 hours of company meetings has no way to record a full 40-hour week.

### Design: Indirect Charge Codes Table

Rather than modifying the existing `clins` table (which is tightly coupled to contracts), we introduce a new `indirectChargeCodes` table:

```
indirectChargeCodes
├── id (UUID, PK)
├── code (varchar, unique) — e.g., "OH-001", "GA-001", "LEAVE-AL", "IR&D-001"
├── name (varchar) — "Overhead", "G&A", "Annual Leave", etc.
├── category (enum) — overhead | ga | irad | bp | leave | unallowable
├── description (text)
├── isActive (boolean)
├── availableToAll (boolean) — if true, all employees can charge to this code
├── createdAt, updatedAt
```

### Timesheet Integration

The timesheet currently stores entries with `clinId` referencing the `clins` table. For indirect codes, we add a nullable `indirectCodeId` to `timesheetEntries`:

```
timesheetEntries (modified)
├── ... existing fields ...
├── clinId (UUID, FK → clins) — nullable now (null for indirect entries)
├── indirectCodeId (UUID, FK → indirectChargeCodes) — nullable (null for direct entries)
├── CHECK: exactly one of clinId or indirectCodeId must be non-null
```

**Key constraint:** Every timesheet entry is either a direct charge (clinId set) OR an indirect charge (indirectCodeId set) — never both, never neither.

### ChargeCode Interface Extension

The existing `ChargeCode` interface is extended to support both types:

```typescript
export interface ChargeCode {
  id: string;
  projectName: string;
  clin: string;
  description: string;
  slinId?: string;
  slinNumber?: string;
  // New fields for indirect codes:
  isIndirect?: boolean;
  indirectCategory?: string;
}
```

When `isIndirect` is true, `id` maps to `indirectChargeCodes.id`, `projectName` is the category name, and `clin` is the code.

### DCAA Compliance Matrix

| Requirement | How Indirect Codes Satisfy It |
|---|---|
| **CAS 418 — Total Time** | Employees can account for ALL hours: direct + indirect + leave |
| **FAR 31.203 — Indirect Costs** | Indirect hours are tracked separately from direct charges |
| **FAR 31.205 — Unallowable Costs** | Unallowable category ensures non-reimbursable time is identified |
| **Daily Time Entry** | Indirect hours are recorded with the same daily entry mechanism |
| **Append-Only Audit Trail** | Indirect entries use the same append-only `timesheetEntries` table |

---

## 2. File Topology

```
Files to CREATE:
├── src/server/actions/indirect-codes.ts              ← Server Actions: CRUD for indirect charge codes
├── src/app/(app)/admin/indirect-codes/
│   ├── page.tsx                                      ← Server Component: Indirect Codes admin page
│   ├── IndirectCodesClient.tsx                        ← Client Component: code management UI
│   └── IndirectCodes.module.css                      ← Module CSS for MRT table header styling

Files to MODIFY:
├── src/db/schema.ts                                  ← Add indirectChargeCodes table + indirectCodeId on timesheetEntries
├── src/types/timesheet.ts                            ← Add isIndirect/indirectCategory to ChargeCode
├── src/server/actions/timesheet.ts                   ← Fetch indirect codes + handle indirect entries in save
├── src/app/(app)/timesheet/page.tsx                  ← Include indirect codes in charge code list
├── src/components/timesheet/cells/ChargeCodeCell.tsx  ← Visual distinction for indirect codes
├── src/components/shell/AppNavbar.tsx                ← Add "Indirect Codes" nav link
├── src/server/actions/reports.ts                     ← Include indirect codes in reports

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/auth.ts                                       ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx         ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetContext.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetToolbar.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx            ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx         ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx      ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/HourCell.tsx         ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ColumnHeaderDate.tsx  ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx    ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                        ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                      ← ❌ DO NOT MODIFY
├── src/server/actions/password.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                        ← ❌ DO NOT MODIFY
├── src/server/actions/dashboard.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/audit.ts                        ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                         ← ❌ DO NOT MODIFY
├── src/lib/offline/*                                  ← ❌ DO NOT MODIFY
├── src/lib/email/*                                    ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only.
> - Use **Drizzle ORM** for all database operations.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**
> - **Critical rule:** The `clinId` column on `timesheetEntries` must remain NOT NULL for now. Instead of making it nullable (which would break existing queries), indirect entries will use a sentinel/system CLIN. See Phase A for details.

---

### Phase A: Schema Updates (A1–A2)

#### A1. Modify `src/db/schema.ts` — Add `indirectChargeCodes` table and category enum

Add these AFTER the `notificationPreferences` table (at the end of the file):

```typescript
// ---------------------------------------------------------------------------
// Indirect Charge Code Categories
// ---------------------------------------------------------------------------

export const indirectCategoryEnum = pgEnum('indirect_category', [
  'overhead',      // Overhead / fringe
  'ga',            // General & Administrative
  'irad',          // Independent Research & Development
  'bp',            // Bid & Proposal
  'leave',         // Leave (annual, sick, holiday, LWOP)
  'unallowable',   // Unallowable costs (FAR 31.205)
]);

// ---------------------------------------------------------------------------
// Indirect Charge Codes (overhead, G&A, leave, etc.)
// ---------------------------------------------------------------------------

export const indirectChargeCodes = pgTable('indirect_charge_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  category: indirectCategoryEnum('category').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  availableToAll: boolean('available_to_all').notNull().default(true), // if true, all employees can charge to this
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

#### A2. Modify `src/db/schema.ts` — Add `indirectCodeId` to `timesheetEntries`

Add a nullable `indirectCodeId` column to the `timesheetEntries` table. Find the `timesheetEntries` definition and add after the `slinId` field:

```typescript
indirectCodeId: uuid('indirect_code_id').references(() => indirectChargeCodes.id), // nullable — set for indirect entries
```

The `timesheetEntries` table should now have both `clinId` (for direct charges) and `indirectCodeId` (for indirect charges). For indirect entries, `clinId` will still be required at the database level — we'll handle this by using a system-level "INDIRECT" CLIN or by making `clinId` nullable.

**IMPORTANT DECISION:** To avoid breaking all existing queries that depend on `clinId` being NOT NULL, we take the **nullable approach**:

Change the `clinId` line from:

```typescript
clinId: uuid('clin_id').notNull().references(() => clins.id),
```

To:

```typescript
clinId: uuid('clin_id').references(() => clins.id), // nullable — null for indirect charge entries
```

This means indirect entries have `clinId = null` and `indirectCodeId = <uuid>`. Direct entries have `clinId = <uuid>` and `indirectCodeId = null`.

Push the schema:

```bash
npx drizzle-kit push
```

---

### Phase B: Indirect Code Server Actions (B1)

#### B1. Create `src/server/actions/indirect-codes.ts`

```typescript
'use server';

import { db } from '@/db';
import { indirectChargeCodes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/session';

/**
 * Get all indirect charge codes.
 */
export async function getIndirectChargeCodes() {
  return db.select().from(indirectChargeCodes).orderBy(indirectChargeCodes.category, indirectChargeCodes.code);
}

/**
 * Get active indirect charge codes available to all employees.
 */
export async function getActiveIndirectCodes() {
  return db
    .select()
    .from(indirectChargeCodes)
    .where(eq(indirectChargeCodes.isActive, true))
    .orderBy(indirectChargeCodes.category, indirectChargeCodes.code);
}

/**
 * Create a new indirect charge code (admin only).
 */
export async function createIndirectCode(data: {
  code: string;
  name: string;
  category: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description?: string;
  availableToAll?: boolean;
}) {
  await requireAdmin();
  const rows = await db.insert(indirectChargeCodes).values(data).returning();
  return rows[0];
}

/**
 * Update an indirect charge code (admin only).
 */
export async function updateIndirectCode(id: string, data: {
  code?: string;
  name?: string;
  category?: 'overhead' | 'ga' | 'irad' | 'bp' | 'leave' | 'unallowable';
  description?: string;
  isActive?: boolean;
  availableToAll?: boolean;
}) {
  await requireAdmin();
  const rows = await db.update(indirectChargeCodes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(indirectChargeCodes.id, id))
    .returning();
  return rows[0];
}

/**
 * Seed default indirect charge codes (admin only).
 * Creates standard codes if they don't exist.
 */
export async function seedIndirectCodes() {
  await requireAdmin();

  const defaults = [
    { code: 'OH-001', name: 'Overhead', category: 'overhead' as const, description: 'General overhead — admin, training, company meetings' },
    { code: 'GA-001', name: 'General & Administrative', category: 'ga' as const, description: 'G&A expenses — management, accounting, HR' },
    { code: 'IRAD-001', name: 'IR&D', category: 'irad' as const, description: 'Independent Research & Development' },
    { code: 'BP-001', name: 'Bid & Proposal', category: 'bp' as const, description: 'Proposal preparation and bid activities' },
    { code: 'LV-AL', name: 'Annual Leave', category: 'leave' as const, description: 'Paid annual leave / vacation' },
    { code: 'LV-SL', name: 'Sick Leave', category: 'leave' as const, description: 'Paid sick leave' },
    { code: 'LV-HOL', name: 'Holiday', category: 'leave' as const, description: 'Company-observed holiday' },
    { code: 'LV-LWOP', name: 'Leave Without Pay', category: 'leave' as const, description: 'Unpaid leave of absence' },
    { code: 'UA-001', name: 'Unallowable', category: 'unallowable' as const, description: 'Non-reimbursable activities (FAR 31.205)' },
  ];

  const existing = await db.select().from(indirectChargeCodes);
  if (existing.length > 0) return existing;

  return db.insert(indirectChargeCodes).values(defaults).returning();
}
```

---

### Phase C: Extend Timesheet to Include Indirect Codes (C1–C3)

#### C1. Modify `src/types/timesheet.ts` — Add indirect fields to ChargeCode

Update the `ChargeCode` interface:

Find:

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

Replace with:

```typescript
export interface ChargeCode {
  id: string;             // maps to clins.id OR indirectChargeCodes.id (UUID)
  projectName: string;    // maps to contracts.name OR indirect category name
  clin: string;           // maps to clins.clinNumber OR indirect code
  description: string;    // maps to clins.description OR indirect description
  slinId?: string;        // maps to slins.id (UUID) — optional, only for direct
  slinNumber?: string;    // maps to slins.slinNumber — optional, only for direct
  isIndirect?: boolean;   // true if this is an indirect charge code
  indirectCategory?: string; // overhead | ga | irad | bp | leave | unallowable
}
```

#### C2. Modify `src/server/actions/timesheet.ts` — Include indirect codes in charge code queries

**C2a.** Add the `indirectChargeCodes` import:

Find:

```typescript
import { timesheetEntries, userAssignments, clins, contracts, slins } from '@/db/schema';
```

Replace with:

```typescript
import { timesheetEntries, userAssignments, clins, contracts, slins, indirectChargeCodes } from '@/db/schema';
```

**C2b.** Update `getChargeCodesForUser()` to also return indirect codes. After the existing function body, add the indirect code fetch and merge:

Find the end of the function (the `return rows.map(...)` statement). Replace the entire function with:

```typescript
export async function getChargeCodesForUser(userId: string): Promise<ChargeCode[]> {
  // Get direct charge codes (CLINs from user assignments)
  const directRows = await db
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

  const directCodes: ChargeCode[] = directRows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    clin: r.clin,
    description: r.description ?? '',
    slinId: r.slinId ?? undefined,
    slinNumber: r.slinNumber ?? undefined,
    isIndirect: false,
  }));

  // Get indirect charge codes (available to all active employees)
  const indirectRows = await db
    .select()
    .from(indirectChargeCodes)
    .where(
      and(
        eq(indirectChargeCodes.isActive, true),
        eq(indirectChargeCodes.availableToAll, true),
      )
    )
    .orderBy(indirectChargeCodes.category, indirectChargeCodes.code);

  const CATEGORY_LABELS: Record<string, string> = {
    overhead: 'Overhead',
    ga: 'G&A',
    irad: 'IR&D',
    bp: 'Bid & Proposal',
    leave: 'Leave',
    unallowable: 'Unallowable',
  };

  const indirectCodes: ChargeCode[] = indirectRows.map((r) => ({
    id: r.id,
    projectName: CATEGORY_LABELS[r.category] ?? r.category,
    clin: r.code,
    description: r.description ?? r.name,
    isIndirect: true,
    indirectCategory: r.category,
  }));

  // Return direct codes first, then indirect codes
  return [...directCodes, ...indirectCodes];
}
```

**C2c.** Update `saveTimesheetBatch()` to handle indirect entries. The `validateClinAssignment()` function (from the server-rbac blueprint) must skip validation for indirect entries. Update the CLIN validation block:

Find the CLIN validation block (added by the server-rbac blueprint):

```typescript
  // Server-side guard: validate CLIN assignments for all cells
  const uniqueClinIds = [...new Set(data.cells.map((c) => c.clinId))];
  for (const clinId of uniqueClinIds) {
    await validateClinAssignment(data.userId, clinId);
  }
```

Replace with:

```typescript
  // Server-side guard: validate CLIN assignments for direct entries only
  const directCells = data.cells.filter((c) => !c.indirectCodeId);
  const uniqueClinIds = [...new Set(directCells.map((c) => c.clinId).filter(Boolean))];
  for (const clinId of uniqueClinIds) {
    await validateClinAssignment(data.userId, clinId!);
  }
```

**C2d.** Update the cell type in `saveTimesheetBatch()` to accept `indirectCodeId`:

Find the cells type:

```typescript
  cells: Array<{
    clinId: string;
    slinId?: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
  }>;
```

Replace with:

```typescript
  cells: Array<{
    clinId?: string;          // set for direct entries
    slinId?: string;
    indirectCodeId?: string;  // set for indirect entries
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
  }>;
```

**C2e.** Update the INSERT inside the per-cell loop to handle indirect entries:

Find:

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

Replace with:

```typescript
    await db.insert(timesheetEntries).values({
      userId: data.userId,
      clinId: cell.clinId ?? null,
      slinId: cell.slinId ?? null,
      indirectCodeId: cell.indirectCodeId ?? null,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: (cell.isEdit || cell.isLateEntry) ? (data.changeReasonCode ?? undefined) : undefined,
      comment: (cell.isEdit || cell.isLateEntry) ? (data.comment ?? undefined) : undefined,
      createdBy: data.userId,
    });
```

**C2f.** Update `getTimesheetEntries()` to handle entries with `indirectCodeId` instead of `clinId`. The current query groups entries by `clinId`. Since indirect entries have `clinId = null`, we need to also match on `indirectCodeId`.

Update the hours map building logic to use the charge code's `id` (which is either a clinId or indirectCodeId) as the key. The existing code already uses `cc.id` from the `chargeCodes` array:

```typescript
const key = `${cc.id}-${i}`;
hours.push(latestHours.get(key) ?? 0);
```

The `latestHours` map is built from `row.clinId`. For indirect entries, `clinId` will be null. We need to also check `indirectCodeId`. Update the query to select both:

In the `getTimesheetEntries` function, update the select to include `indirectCodeId`:

```typescript
    .select({
      clinId: timesheetEntries.clinId,
      indirectCodeId: timesheetEntries.indirectCodeId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
    })
```

And update the map building:

```typescript
  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const entryId = row.clinId ?? row.indirectCodeId ?? '';
    const key = `${entryId}-${dayIndex}`;
    if (!latestHours.has(key)) {
      latestHours.set(key, parseFloat(row.hours));
    }
  }
```

Similarly update `getRevisionMap()` to use `clinId ?? indirectCodeId`.

#### C3. Modify `src/components/timesheet/cells/ChargeCodeCell.tsx` — Visual distinction for indirect codes

Read the current file first, then add visual differentiation. Indirect codes should show with a colored badge indicating their category:

Add a small `Badge` next to the charge code name when `isIndirect` is true:

```tsx
{chargeCode.isIndirect && (
  <Badge size="xs" variant="light" color={getCategoryColor(chargeCode.indirectCategory)}>
    {chargeCode.indirectCategory?.toUpperCase()}
  </Badge>
)}
```

Where `getCategoryColor` maps:
- `overhead` → `'blue'`
- `ga` → `'grape'`
- `irad` → `'cyan'`
- `bp` → `'orange'`
- `leave` → `'green'`
- `unallowable` → `'red'`

---

### Phase D: Admin Page for Indirect Codes (D1–D3)

#### D1–D3. Create the admin page

Follow the same pattern as other admin pages:
- Server component with role check and data fetch
- Client component with MRT table, add/edit modal
- Columns: Code, Name, Category (Badge), Description, Active (Switch), Available to All (Switch)
- "Add Indirect Code" button + "Seed Defaults" button
- Row actions: Edit, Toggle Active

Add "Indirect Codes" nav link to `AppNavbar.tsx`.

---

### Phase E: Update Context to Handle Indirect Saves (E1)

#### E1. Modify `src/components/timesheet/TimesheetContext.tsx` — Pass indirectCodeId in save calls

In the `saveAll` function, when building the cells array for `saveTimesheetBatch`, check if the charge code is indirect and pass `indirectCodeId` instead of `clinId`:

```typescript
cells: dirtyCells.map((c) => {
  const chargeCode = state.chargeCodes.find((cc) => cc.id === c.chargeCodeId);
  return {
    clinId: chargeCode?.isIndirect ? undefined : c.chargeCodeId,
    indirectCodeId: chargeCode?.isIndirect ? c.chargeCodeId : undefined,
    dayIndex: c.dayIndex,
    hours: c.hours,
    isEdit: c.isEdit,
    isLateEntry: c.isLateEntry,
  };
}),
```

---

## 4. Verification

### 4a. Build & Schema Check

```bash
npx drizzle-kit push
npm run build
```

Must complete with **zero errors**.

### 4b. Functional Checks

| Check | Expected Result |
|---|---|
| **Seed indirect codes** | Creates 9 default codes (OH, G&A, IR&D, B&P, 4 leave types, Unallowable) |
| **Timesheet shows indirect codes** | Direct codes listed first, then indirect codes with category badges |
| **Enter hours on indirect code** | Saves to `timesheetEntries` with `indirectCodeId` set, `clinId` null |
| **Enter hours on direct code** | Still saves with `clinId` set, `indirectCodeId` null (unchanged) |
| **Leave code entry** | Employee can charge 8 hours to "Annual Leave" code |
| **Full week accounting** | Employee with 32 hrs direct + 8 hrs overhead = 40 hrs total |
| **Indirect codes in reports** | Cost reports show indirect entries (with $0 cost — no rate) |
| **Admin manages indirect codes** | CRUD operations work from admin page |

### 4c. DCAA Compliance Verification

| Requirement | How Verified |
|---|---|
| CAS 418 — Total Time | Employees can now account for ALL hours (direct + indirect + leave) |
| FAR 31.203 — Indirect Costs | Indirect hours tracked separately with category classification |
| FAR 31.205 — Unallowable | "Unallowable" category explicitly identifies non-reimbursable time |
| Daily Time Entry | Indirect entries use the same daily entry mechanism as direct |
| Append-Only | Indirect entries in the same `timesheetEntries` table — same audit trail |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `column "indirect_code_id" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| Existing queries break with nullable `clinId` | Queries assumed `clinId` NOT NULL | Add null checks or filter for direct entries only |
| Indirect entries don't appear in timesheet | `getTimesheetEntries` doesn't match on `indirectCodeId` | Update the hours map to use `clinId ?? indirectCodeId` |
| Offline store doesn't handle indirect codes | `offline-store.ts` uses `clinId` | Indirect codes should be included in the charge code seeding |
| CLIN validation rejects indirect entries | `validateClinAssignment` called for indirect entries | Skip validation when `indirectCodeId` is set |
| Cost reports show wrong totals | Indirect entries have no labor rate | Indirect entries should show hours only, cost = $0 |
