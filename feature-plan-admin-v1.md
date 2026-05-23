# Blueprint: Labor Category & Rate Management (Admin v1)

## 1. Architectural Overview & DCAA Impact

### The Missing Data Layer

The current system models: `Contracts → CLINs → Employee Assignments → Timesheet Entries`. However, per CONTEXT.md's domain hierarchy, there is a critical missing layer between CLINs and Employees:

```
Contracts → CLINs → **Labor Categories (LCATs)** → Employees → Timesheet Entries
```

Labor Categories define the **billing rates** associated with each position/role authorized under a CLIN. Without LCATs, the system cannot:
- Calculate the dollar value of hours worked (blocks invoicing)
- Track budget burn by contract/CLIN (blocks PM dashboards)
- Enforce CAS 418 rate consistency requirements

### New Relational Mapping

```
Contracts (existing)
  └── CLINs (existing)
       └── laborCategories (NEW)
            ├── lcat_code        ("SE-III", "PM-II", "BA-I")
            ├── title            ("Senior Engineer III")
            ├── hourly_rate      (decimal — billing rate)
            ├── ceiling_rate     (decimal — max contractual rate)
            └── status           (active/inactive)

Users (existing)
  └── userLaborCategories (NEW junction)
       ├── user_id           → users.id
       ├── labor_category_id → laborCategories.id
       ├── effective_date    (when this rate assignment starts)
       └── end_date          (nullable — for rate changes)
```

### How This Enforces DCAA Compliance

| DCAA Requirement | How LCATs Enforce It |
|---|---|
| **CAS 418 — Cost Accounting Standard** | `ceiling_rate` ensures no employee is billed above the contractually authorized maximum rate for their labor category |
| **Rate Traceability** | `effective_date` / `end_date` on user-LCAT assignments creates a full audit trail of rate changes over time |
| **Authorization Enforcement** | Extends existing RBAC: an employee must have both a CLIN assignment AND an LCAT assignment to generate a valid billable entry |
| **FAR 31.201-1 — Allowable Costs** | Rate data enables future validation that billed costs are reasonable and consistent with contract terms |

### What This Unlocks

Once LCATs + rates exist, subsequent blueprints become straightforward:
- **Invoicing** → `SUM(hours × hourly_rate)` grouped by CLIN/LCAT per period
- **PM Dashboard** → Hours burned, dollars spent, budget remaining per contract/CLIN
- **Cost Reporting** → DCAA-compliant cost reports with labor category breakdowns

---

## 2. File Topology

```
Files to CREATE (new):
├── src/server/actions/labor-categories.ts          ← Server Actions: CRUD for LCATs + user-LCAT assignments
├── src/app/(app)/admin/labor-categories/
│   ├── page.tsx                                    ← Server Component: Labor Categories page
│   └── LaborCategoriesClient.tsx                   ← Client Component: LCAT management UI
│   └── LaborCategories.module.css                  ← Module CSS for MRT table header styling

Files to MODIFY:
├── src/db/schema.ts                                ← Add laborCategories + userLaborCategories tables
├── src/components/shell/AppNavbar.tsx               ← Add "Labor Categories" nav link

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                        ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                           ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                      ← ❌ DO NOT MODIFY
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
> - For MRT table header styling, use a `.module.css` file with a `tableHeaderCell` class, following the pattern established in `Approvals.module.css`, `Contracts.module.css`, and `Users.module.css`.

---

### Step 1: Add Database Tables to Schema

**1a.** Modify `src/db/schema.ts` — Add the `laborCategories` and `userLaborCategories` table definitions.

Add these two new tables **after** the existing `userAssignments` table and **before** the `timesheetEntries` table.

**SEARCH/REPLACE in `src/db/schema.ts`:**

Find the line:
```typescript
// ---------------------------------------------------------------------------
// Timesheet Entries (DCAA append-only — NEVER update or delete rows)
// ---------------------------------------------------------------------------
```

Insert the following **BEFORE** that line:

```typescript
// ---------------------------------------------------------------------------
// Labor Categories (billing rates per CLIN)
// ---------------------------------------------------------------------------

export const laborCategories = pgTable('labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  clinId: uuid('clin_id').notNull().references(() => clins.id, { onDelete: 'cascade' }),
  lcatCode: varchar('lcat_code', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  hourlyRate: varchar('hourly_rate', { length: 20 }).notNull().default('0.00'),
  ceilingRate: varchar('ceiling_rate', { length: 20 }),
  status: statusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('clin_lcat_unique_idx').on(table.clinId, table.lcatCode),
]);

// ---------------------------------------------------------------------------
// User Labor Categories (maps employees to their authorized LCAT + rate)
// ---------------------------------------------------------------------------

export const userLaborCategories = pgTable('user_labor_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id, { onDelete: 'cascade' }),
  effectiveDate: timestamp('effective_date', { withTimezone: true }).notNull(),
  endDate: timestamp('end_date', { withTimezone: true }),
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_lcat_effective_unique_idx').on(table.userId, table.laborCategoryId, table.effectiveDate),
]);
```

**Important notes on field types:**
- `hourlyRate` and `ceilingRate` are stored as `varchar` (strings), consistent with how `timesheetEntries.hours` is stored. This preserves exact decimal input and avoids floating-point precision issues. Parse to `parseFloat()` only when performing calculations.
- The `clin_lcat_unique_idx` prevents duplicate LCAT codes within the same CLIN.
- The `user_lcat_effective_unique_idx` prevents duplicate effective dates for the same user+LCAT pair (supports rate change history).

**1b.** Push the schema changes to the database:

```bash
npx drizzle-kit push
```

Verify the two new tables exist:

```bash
npx drizzle-kit studio
```

Navigate to `https://local.drizzle.studio` and confirm `labor_categories` and `user_labor_categories` tables exist with correct columns and foreign key relationships.

---

### Step 2: Server Actions for Labor Categories

**2a.** Create `src/server/actions/labor-categories.ts`:

```typescript
'use server';

import { db } from '@/db';
import { laborCategories, userLaborCategories, users, clins, contracts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Labor Category CRUD
// ---------------------------------------------------------------------------

/**
 * Get all labor categories for a specific CLIN.
 */
export async function getLaborCategoriesByClin(clinId: string) {
  return db
    .select()
    .from(laborCategories)
    .where(eq(laborCategories.clinId, clinId))
    .orderBy(laborCategories.lcatCode);
}

/**
 * Get all labor categories across all CLINs, with contract/CLIN context.
 * Used for the main Labor Categories admin page.
 */
export async function getAllLaborCategories() {
  return db
    .select({
      id: laborCategories.id,
      clinId: laborCategories.clinId,
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
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .orderBy(contracts.name, clins.clinNumber, laborCategories.lcatCode);
}

/**
 * Create a new labor category under a CLIN.
 */
export async function createLaborCategory(data: {
  clinId: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate?: string;
}) {
  const rows = await db.insert(laborCategories).values(data).returning();
  return rows[0];
}

/**
 * Update an existing labor category.
 */
export async function updateLaborCategory(id: string, data: {
  lcatCode?: string;
  title?: string;
  hourlyRate?: string;
  ceilingRate?: string;
  status?: 'active' | 'inactive' | 'closed';
}) {
  const rows = await db.update(laborCategories)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(laborCategories.id, id))
    .returning();
  return rows[0];
}

// ---------------------------------------------------------------------------
// User Labor Category Assignments
// ---------------------------------------------------------------------------

/**
 * Get all user-LCAT assignments with user and LCAT context.
 */
export async function getUserLaborCategoryAssignments() {
  return db
    .select({
      id: userLaborCategories.id,
      userId: userLaborCategories.userId,
      laborCategoryId: userLaborCategories.laborCategoryId,
      effectiveDate: userLaborCategories.effectiveDate,
      endDate: userLaborCategories.endDate,
      createdAt: userLaborCategories.createdAt,
      userName: users.fullName,
      userEmail: users.email,
      lcatCode: laborCategories.lcatCode,
      lcatTitle: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(userLaborCategories)
    .innerJoin(users, eq(userLaborCategories.userId, users.id))
    .innerJoin(laborCategories, eq(userLaborCategories.laborCategoryId, laborCategories.id))
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .orderBy(users.fullName, contracts.name, clins.clinNumber);
}

/**
 * Assign a user to a labor category with an effective date.
 */
export async function assignUserToLaborCategory(data: {
  userId: string;
  laborCategoryId: string;
  effectiveDate: Date;
  endDate?: Date;
  assignedBy?: string;
}) {
  const rows = await db.insert(userLaborCategories).values(data).returning();
  return rows[0];
}

/**
 * End a user's labor category assignment by setting the end_date.
 */
export async function endUserLaborCategoryAssignment(id: string, endDate: Date) {
  const rows = await db.update(userLaborCategories)
    .set({ endDate, updatedAt: new Date() })
    .where(eq(userLaborCategories.id, id))
    .returning();
  return rows[0];
}

/**
 * Get labor categories available for assignment (active LCATs from active CLINs on active contracts).
 * Returns a flat list with contract/CLIN context for dropdown population.
 */
export async function getAssignableLaborCategories() {
  return db
    .select({
      id: laborCategories.id,
      lcatCode: laborCategories.lcatCode,
      title: laborCategories.title,
      hourlyRate: laborCategories.hourlyRate,
      clinId: laborCategories.clinId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(laborCategories)
    .innerJoin(clins, eq(laborCategories.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
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

---

### Step 3: Labor Categories Admin Page

**3a.** Create `src/app/(app)/admin/labor-categories/LaborCategories.module.css`:

```css
.tableHeaderCell button {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

**3b.** Create `src/app/(app)/admin/labor-categories/page.tsx` — Server Component:

```typescript
import { getAllLaborCategories, getUserLaborCategoryAssignments, getAssignableLaborCategories } from '@/server/actions/labor-categories';
import { getContracts } from '@/server/actions/contracts';
import { getUsers } from '@/server/actions/users';
import { LaborCategoriesClient } from './LaborCategoriesClient';

export default async function LaborCategoriesPage() {
  const [laborCats, assignments, contracts, users, assignableLcats] = await Promise.all([
    getAllLaborCategories(),
    getUserLaborCategoryAssignments(),
    getContracts(),
    getUsers(),
    getAssignableLaborCategories(),
  ]);

  return (
    <LaborCategoriesClient
      initialLaborCategories={laborCats}
      initialAssignments={assignments}
      contracts={contracts}
      users={users}
      assignableLcats={assignableLcats}
    />
  );
}
```

**3c.** Create `src/app/(app)/admin/labor-categories/LaborCategoriesClient.tsx` — the main Labor Categories management UI.

This is a `'use client'` component with **two sections**:

#### Section A — Labor Categories Table (top)

A **Mantine React Table** showing all labor categories with columns:

| Column | Source | Width |
|---|---|---|
| Contract | `contractName (contractNumber)` | 220 |
| CLIN | `clinNumber` | 100 |
| LCAT Code | `lcatCode` | 120 |
| Title | `title` | 200 |
| Hourly Rate | `hourlyRate` (formatted as `$XX.XX`) | 120 |
| Ceiling Rate | `ceilingRate` (formatted as `$XX.XX` or `—`) | 120 |
| Status | `status` (Mantine `Badge`: green=active, gray=inactive) | 110 |

**Table Features:**
- `renderTopToolbarCustomActions`: An **"Add Labor Category"** `Button` that opens a `Modal`.
- `enableRowActions: true` with row action buttons:
  - **Edit** (pencil icon) — opens the same `Modal` pre-filled for editing
  - **Toggle Status** — toggles between active/inactive via `updateLaborCategory`

**Add/Edit Labor Category Modal:**
- `Select` dropdown for **Contract** (populated from `contracts` prop, `data` mapped to `{ value: contract.id, label: contract.name + ' (' + contract.contractNumber + ')' }`)
- When a Contract is selected, fetch CLINs for that contract via `getClinsByContract` (import from `@/server/actions/clins`), then render a second `Select` showing available CLINs.
- `TextInput` for `lcatCode` (required, placeholder: "SE-III")
- `TextInput` for `title` (required, placeholder: "Senior Engineer III")
- `TextInput` for `hourlyRate` (required, placeholder: "125.00")
- `TextInput` for `ceilingRate` (optional, placeholder: "150.00")
- On submit: call `createLaborCategory` or `updateLaborCategory` server action, then refresh the table by re-fetching `getAllLaborCategories`.

#### Section B — User LCAT Assignments (below, separated by a `Divider`)

**Create Assignment Form** (inside a `Paper` with border):
- `Select` for **User** (from `users` prop)
- `Select` for **Labor Category** (from `assignableLcats` prop, formatted as `"contractName — CLIN clinNumber — lcatCode: title ($hourlyRate/hr)"`)
- `DateInput` (from `@mantine/dates`) for **Effective Date** (required)
- `DateInput` for **End Date** (optional)
- `Button` "Assign" — calls `assignUserToLaborCategory`

**Assignments Table** (Mantine React Table):

| Column | Source | Width |
|---|---|---|
| Employee | `userName` | 180 |
| Contract | `contractName (contractNumber)` | 200 |
| CLIN | `clinNumber` | 100 |
| LCAT | `lcatCode — lcatTitle` | 200 |
| Rate | `hourlyRate` (formatted as `$XX.XX/hr`) | 120 |
| Effective Date | `effectiveDate` (formatted `MMM D, YYYY`) | 140 |
| End Date | `endDate` (formatted `MMM D, YYYY` or `—` for ongoing) | 140 |

**Table Features:**
- `enableRowActions: true` with a **"End Assignment"** button for rows where `endDate` is null:
  - Sets `endDate` to today via `endUserLaborCategoryAssignment`
  - Button is disabled/hidden if `endDate` already set

**Full Component Implementation:**

```typescript
'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Modal,
  TextInput,
  Select,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  Divider,
  ActionIcon,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { IconEdit, IconPlus, IconToggleLeft } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import {
  createLaborCategory,
  updateLaborCategory,
  getAllLaborCategories,
  assignUserToLaborCategory,
  endUserLaborCategoryAssignment,
  getUserLaborCategoryAssignments,
} from '@/server/actions/labor-categories';
import { getClinsByContract } from '@/server/actions/clins';
import classes from './LaborCategories.module.css';

// ---------------------------------------------------------------------------
// Types (derived from server action return types)
// ---------------------------------------------------------------------------

type LaborCategory = {
  id: string;
  clinId: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  clinNumber: string;
  clinDescription: string | null;
  contractName: string;
  contractNumber: string;
};

type UserLcatAssignment = {
  id: string;
  userId: string;
  laborCategoryId: string;
  effectiveDate: Date;
  endDate: Date | null;
  createdAt: Date;
  userName: string;
  userEmail: string;
  lcatCode: string;
  lcatTitle: string;
  hourlyRate: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
};

type AssignableLcat = {
  id: string;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
};

type Contract = {
  id: string;
  contractNumber: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type User = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type Clin = {
  id: string;
  contractId: string;
  clinNumber: string;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  createdAt: Date;
  updatedAt: Date;
};

type LcatForm = {
  contractId: string | null;
  clinId: string | null;
  lcatCode: string;
  title: string;
  hourlyRate: string;
  ceilingRate: string;
};

type Props = {
  initialLaborCategories: LaborCategory[];
  initialAssignments: UserLcatAssignment[];
  contracts: Contract[];
  users: User[];
  assignableLcats: AssignableLcat[];
};

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  inactive: 'gray',
  closed: 'red',
};

const EMPTY_LCAT_FORM: LcatForm = {
  contractId: null,
  clinId: null,
  lcatCode: '',
  title: '',
  hourlyRate: '',
  ceilingRate: '',
};

function formatRate(rate: string | null): string {
  if (!rate) return '—';
  const num = parseFloat(rate);
  if (isNaN(num)) return '—';
  return `$${num.toFixed(2)}`;
}

export function LaborCategoriesClient({
  initialLaborCategories,
  initialAssignments,
  contracts,
  users,
  assignableLcats: initialAssignableLcats,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [laborCats, setLaborCats] = useState<LaborCategory[]>(initialLaborCategories);
  const [assignments, setAssignments] = useState<UserLcatAssignment[]>(initialAssignments);
  const [assignableLcats] = useState<AssignableLcat[]>(initialAssignableLcats);

  // LCAT Modal state
  const [lcatModalOpen, setLcatModalOpen] = useState(false);
  const [editingLcat, setEditingLcat] = useState<LaborCategory | null>(null);
  const [lcatForm, setLcatForm] = useState<LcatForm>(EMPTY_LCAT_FORM);
  const [clinOptions, setClinOptions] = useState<{ value: string; label: string }[]>([]);

  // Assignment form state
  const [assignUserId, setAssignUserId] = useState<string | null>(null);
  const [assignLcatId, setAssignLcatId] = useState<string | null>(null);
  const [assignEffectiveDate, setAssignEffectiveDate] = useState<string | null>(null);
  const [assignEndDate, setAssignEndDate] = useState<string | null>(null);

  // --- LCAT Modal handlers ---

  function openAddLcatModal() {
    setEditingLcat(null);
    setLcatForm(EMPTY_LCAT_FORM);
    setClinOptions([]);
    setLcatModalOpen(true);
  }

  function openEditLcatModal(lcat: LaborCategory) {
    setEditingLcat(lcat);
    setLcatForm({
      contractId: null, // Will be set after CLIN lookup; not needed for edit
      clinId: lcat.clinId,
      lcatCode: lcat.lcatCode,
      title: lcat.title,
      hourlyRate: lcat.hourlyRate,
      ceilingRate: lcat.ceilingRate ?? '',
    });
    setLcatModalOpen(true);
  }

  function handleContractChange(contractId: string | null) {
    setLcatForm((f) => ({ ...f, contractId, clinId: null }));
    setClinOptions([]);
    if (!contractId) return;
    startTransition(async () => {
      const fetchedClins = await getClinsByContract(contractId);
      setClinOptions(
        (fetchedClins as Clin[]).map((c) => ({
          value: c.id,
          label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
        }))
      );
    });
  }

  function handleLcatSubmit() {
    if (!lcatForm.lcatCode.trim() || !lcatForm.title.trim() || !lcatForm.hourlyRate.trim()) return;

    startTransition(async () => {
      try {
        if (editingLcat) {
          await updateLaborCategory(editingLcat.id, {
            lcatCode: lcatForm.lcatCode.trim(),
            title: lcatForm.title.trim(),
            hourlyRate: lcatForm.hourlyRate.trim(),
            ceilingRate: lcatForm.ceilingRate.trim() || undefined,
          });
          notifications.show({
            title: 'Labor Category Updated',
            message: `${lcatForm.lcatCode} has been updated.`,
            color: 'green',
          });
        } else {
          if (!lcatForm.clinId) return;
          await createLaborCategory({
            clinId: lcatForm.clinId,
            lcatCode: lcatForm.lcatCode.trim(),
            title: lcatForm.title.trim(),
            hourlyRate: lcatForm.hourlyRate.trim(),
            ceilingRate: lcatForm.ceilingRate.trim() || undefined,
          });
          notifications.show({
            title: 'Labor Category Created',
            message: `${lcatForm.lcatCode} has been created.`,
            color: 'green',
          });
        }

        const refreshed = await getAllLaborCategories();
        setLaborCats(refreshed as LaborCategory[]);
        setLcatModalOpen(false);
      } catch (error) {
        notifications.show({
          title: 'Error',
          message: String(error),
          color: 'red',
        });
      }
    });
  }

  function handleToggleStatus(lcat: LaborCategory) {
    const newStatus = lcat.status === 'active' ? 'inactive' : 'active';
    startTransition(async () => {
      try {
        await updateLaborCategory(lcat.id, { status: newStatus });
        const refreshed = await getAllLaborCategories();
        setLaborCats(refreshed as LaborCategory[]);
        notifications.show({
          title: 'Status Updated',
          message: `${lcat.lcatCode} is now ${newStatus}.`,
          color: newStatus === 'active' ? 'green' : 'gray',
        });
      } catch (error) {
        notifications.show({
          title: 'Error',
          message: String(error),
          color: 'red',
        });
      }
    });
  }

  // --- Assignment handlers ---

  function handleAssignSubmit() {
    if (!assignUserId || !assignLcatId || !assignEffectiveDate) return;
    startTransition(async () => {
      try {
        await assignUserToLaborCategory({
          userId: assignUserId,
          laborCategoryId: assignLcatId,
          effectiveDate: new Date(assignEffectiveDate),
          endDate: assignEndDate ? new Date(assignEndDate) : undefined,
        });
        const refreshed = await getUserLaborCategoryAssignments();
        setAssignments(refreshed as UserLcatAssignment[]);
        setAssignUserId(null);
        setAssignLcatId(null);
        setAssignEffectiveDate(null);
        setAssignEndDate(null);
        notifications.show({
          title: 'Assignment Created',
          message: 'User has been assigned to the labor category.',
          color: 'green',
        });
      } catch (error) {
        notifications.show({
          title: 'Assignment Failed',
          message: String(error),
          color: 'red',
        });
      }
    });
  }

  function handleEndAssignment(assignment: UserLcatAssignment) {
    startTransition(async () => {
      try {
        await endUserLaborCategoryAssignment(assignment.id, new Date());
        const refreshed = await getUserLaborCategoryAssignments();
        setAssignments(refreshed as UserLcatAssignment[]);
        notifications.show({
          title: 'Assignment Ended',
          message: `${assignment.userName}'s assignment to ${assignment.lcatCode} has been ended.`,
          color: 'orange',
        });
      } catch (error) {
        notifications.show({
          title: 'Error',
          message: String(error),
          color: 'red',
        });
      }
    });
  }

  // --- LCAT Table columns ---

  const lcatColumns: MRT_ColumnDef<LaborCategory>[] = [
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 220,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    { accessorKey: 'lcatCode', header: 'LCAT Code', size: 120 },
    { accessorKey: 'title', header: 'Title', size: 200 },
    {
      accessorKey: 'hourlyRate',
      header: 'Hourly Rate',
      Cell: ({ cell }) => formatRate(cell.getValue<string>()),
      size: 120,
    },
    {
      accessorKey: 'ceilingRate',
      header: 'Ceiling Rate',
      Cell: ({ cell }) => formatRate(cell.getValue<string | null>()),
      size: 120,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      Cell: ({ cell }) => (
        <Badge color={STATUS_COLORS[cell.getValue<string>()] ?? 'gray'}>
          {cell.getValue<string>()}
        </Badge>
      ),
      size: 110,
    },
  ];

  const lcatTable = useMantineReactTable({
    columns: lcatColumns,
    data: laborCats,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Group gap="xs" wrap="nowrap">
        <ActionIcon
          variant="subtle"
          onClick={() => openEditLcatModal(row.original)}
          title="Edit"
        >
          <IconEdit size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color={row.original.status === 'active' ? 'gray' : 'green'}
          onClick={() => handleToggleStatus(row.original)}
          title={row.original.status === 'active' ? 'Deactivate' : 'Activate'}
        >
          <IconToggleLeft size={16} />
        </ActionIcon>
      </Group>
    ),
    renderTopToolbarCustomActions: () => (
      <Button leftSection={<IconPlus size={16} />} onClick={openAddLcatModal}>
        Add Labor Category
      </Button>
    ),
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
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
  });

  // --- Assignment Table columns ---

  const assignmentColumns: MRT_ColumnDef<UserLcatAssignment>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 180 },
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
      Cell: ({ cell }) => `${formatRate(cell.getValue<string>())}/hr`,
      size: 120,
    },
    {
      accessorKey: 'effectiveDate',
      header: 'Effective Date',
      Cell: ({ cell }) => dayjs(cell.getValue<Date>()).format('MMM D, YYYY'),
      size: 140,
    },
    {
      accessorKey: 'endDate',
      header: 'End Date',
      Cell: ({ cell }) => {
        const val = cell.getValue<Date | null>();
        return val ? dayjs(val).format('MMM D, YYYY') : '—';
      },
      size: 140,
    },
  ];

  const assignmentTable = useMantineReactTable({
    columns: assignmentColumns,
    data: assignments,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        color="orange"
        onClick={() => handleEndAssignment(row.original)}
        disabled={row.original.endDate !== null}
        loading={isPending}
      >
        {row.original.endDate ? 'Ended' : 'End'}
      </Button>
    ),
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
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
  });

  return (
    <>
      {/* ---- Section A: Labor Categories ---- */}
      <Title order={2} mb="md">Labor Categories</Title>
      <MantineReactTable table={lcatTable} />

      {/* ---- Add/Edit LCAT Modal ---- */}
      <Modal
        opened={lcatModalOpen}
        onClose={() => setLcatModalOpen(false)}
        title={editingLcat ? 'Edit Labor Category' : 'Add Labor Category'}
        size="md"
      >
        <Stack>
          {!editingLcat && (
            <>
              <Select
                label="Contract"
                placeholder="Select contract"
                data={contracts.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.contractNumber})`,
                }))}
                value={lcatForm.contractId}
                onChange={handleContractChange}
                searchable
              />
              <Select
                label="CLIN"
                placeholder={lcatForm.contractId ? 'Select CLIN' : 'Select a contract first'}
                data={clinOptions}
                value={lcatForm.clinId}
                onChange={(val) => setLcatForm((f) => ({ ...f, clinId: val }))}
                disabled={!lcatForm.contractId || clinOptions.length === 0}
                searchable
              />
            </>
          )}
          {editingLcat && (
            <Text size="sm" c="dimmed">
              Editing LCAT for CLIN {editingLcat.clinNumber} on {editingLcat.contractName}
            </Text>
          )}
          <TextInput
            label="LCAT Code"
            required
            placeholder="SE-III"
            value={lcatForm.lcatCode}
            onChange={(e) => setLcatForm((f) => ({ ...f, lcatCode: e.target.value }))}
          />
          <TextInput
            label="Title"
            required
            placeholder="Senior Engineer III"
            value={lcatForm.title}
            onChange={(e) => setLcatForm((f) => ({ ...f, title: e.target.value }))}
          />
          <TextInput
            label="Hourly Rate ($)"
            required
            placeholder="125.00"
            value={lcatForm.hourlyRate}
            onChange={(e) => setLcatForm((f) => ({ ...f, hourlyRate: e.target.value }))}
          />
          <TextInput
            label="Ceiling Rate ($)"
            placeholder="150.00 (optional)"
            value={lcatForm.ceilingRate}
            onChange={(e) => setLcatForm((f) => ({ ...f, ceilingRate: e.target.value }))}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setLcatModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleLcatSubmit}
              loading={isPending}
              disabled={
                !lcatForm.lcatCode.trim() ||
                !lcatForm.title.trim() ||
                !lcatForm.hourlyRate.trim() ||
                (!editingLcat && !lcatForm.clinId)
              }
            >
              {editingLcat ? 'Save Changes' : 'Create'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* ---- Section B: User LCAT Assignments ---- */}
      <Divider my="xl" />
      <Title order={2} mb="md">User Labor Category Assignments</Title>

      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Create Assignment</Title>
        <Group align="flex-end" wrap="wrap">
          <Select
            label="User"
            placeholder="Select employee"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
            value={assignUserId}
            onChange={setAssignUserId}
            searchable
            style={{ minWidth: 200 }}
          />
          <Select
            label="Labor Category"
            placeholder="Select labor category"
            data={assignableLcats.map((lc) => ({
              value: lc.id,
              label: `${lc.contractName} — ${lc.clinNumber} — ${lc.lcatCode}: ${lc.title} (${formatRate(lc.hourlyRate)}/hr)`,
            }))}
            value={assignLcatId}
            onChange={setAssignLcatId}
            searchable
            style={{ minWidth: 400 }}
          />
          <DateInput
            label="Effective Date"
            value={assignEffectiveDate}
            onChange={setAssignEffectiveDate}
            required
            style={{ minWidth: 160 }}
          />
          <DateInput
            label="End Date"
            value={assignEndDate}
            onChange={setAssignEndDate}
            clearable
            style={{ minWidth: 160 }}
          />
          <Button
            onClick={handleAssignSubmit}
            loading={isPending}
            disabled={!assignUserId || !assignLcatId || !assignEffectiveDate}
          >
            Assign
          </Button>
        </Group>
      </Paper>

      <MantineReactTable table={assignmentTable} />
    </>
  );
}
```

---

### Step 4: Add Nav Link

**4a.** Modify `src/components/shell/AppNavbar.tsx` — Add a "Labor Categories" navigation link in the ADMINISTRATION section.

**SEARCH/REPLACE in `src/components/shell/AppNavbar.tsx`:**

Find this import line:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog } from '@tabler/icons-react';
```

Replace with:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory } from '@tabler/icons-react';
```

Then find this block:
```typescript
          <NavLink
            label="User Management"
            href="/admin/users"
            leftSection={<IconUserCog size={18} />}
            active={pathname === '/admin/users'}
          />
```

Insert **BEFORE** that `<NavLink>`:
```typescript
          <NavLink
            label="Labor Categories"
            href="/admin/labor-categories"
            leftSection={<IconCategory size={18} />}
            active={pathname === '/admin/labor-categories'}
          />
```

The final nav order in the ADMINISTRATION section should be:
1. Contracts & CLINs
2. User Assignments
3. Timesheet Approvals
4. **Labor Categories** ← NEW
5. User Management

---

### Step 5: Push Schema & Verify

**5a.** Push the schema changes:

```bash
npx drizzle-kit push
```

**5b.** Verify tables exist:

```bash
npx drizzle-kit studio
```

Confirm `labor_categories` and `user_labor_categories` tables are visible with correct columns.

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**. Pay special attention to:
- Server Action imports working correctly across the client/server boundary
- No client/server boundary violations
- Drizzle schema types resolving correctly
- `@mantine/dates` `DateInput` import resolving (already installed as a dependency)

### 4b. Dev Server Visual Checks

```bash
npm run dev
```

Navigate to `http://localhost:3000/admin/labor-categories` and verify:

| Check | Expected Result |
|---|---|
| **Nav link** | "Labor Categories" appears in the admin sidebar between "Timesheet Approvals" and "User Management" |
| **LCAT table renders** | Empty Mantine React Table with correct columns: Contract, CLIN, LCAT Code, Title, Hourly Rate, Ceiling Rate, Status |
| **Add Labor Category** | Button opens modal → Contract dropdown populates → selecting contract loads CLINs → form submits → new row appears |
| **Edit Labor Category** | Row action pencil icon opens modal pre-filled → saves update → table refreshes |
| **Toggle Status** | Row action toggle icon switches between active/inactive → badge color changes |
| **Rate formatting** | Hourly Rate shows as `$125.00`, Ceiling Rate shows as `$150.00` or `—` |
| **Assignment form** | User dropdown populates → LCAT dropdown shows formatted options → DateInput works → Assign button creates row |
| **Assignment table** | Shows all assignments with Employee, Contract, CLIN, LCAT, Rate, Effective Date, End Date |
| **End Assignment** | "End" button sets end date to today → button changes to "Ended" (disabled) |
| **No timesheet impact** | Navigate to `/timesheet` — existing timesheet still works identically |
| **No other admin impact** | Navigate to `/admin/contracts`, `/admin/assignments`, `/admin/approvals`, `/admin/users` — all still work identically |

### 4c. Guardrail Verification

Run a quick git diff to confirm:

```bash
git diff --name-only
```

The output must **NOT** include any files under:
- `src/components/timesheet/`
- `src/app/(app)/timesheet/`
- `src/types/timesheet.ts`
- `src/server/actions/timesheet.ts`
- `src/server/actions/periods.ts`
- `src/app/(app)/admin/contracts/`
- `src/app/(app)/admin/assignments/`
- `src/app/(app)/admin/approvals/`
- `src/app/(app)/admin/users/`

If any of these files appear in the diff, the agent has violated the guardrail and the changes must be reverted immediately.

### 4d. Seed Data Suggestions

After the feature is implemented, seed the following test data via Drizzle Studio or a seed script:

**Labor Categories (per existing CLINs):**
- CLIN 0001: `SE-III` "Senior Engineer III" @ $145.00/hr (ceiling: $160.00)
- CLIN 0001: `SE-II` "Engineer II" @ $115.00/hr (ceiling: $130.00)
- CLIN 0001: `PM-II` "Project Manager II" @ $155.00/hr (ceiling: $175.00)
- CLIN 0002: `BA-I` "Business Analyst I" @ $95.00/hr (ceiling: $110.00)
- CLIN 0002: `QA-II` "QA Engineer II" @ $105.00/hr (ceiling: $120.00)

**User LCAT Assignments:**
- Jane Smith → SE-III (effective 2024-01-01)
- John Doe → SE-II (effective 2024-01-01)
- Sarah Wilson → PM-II (effective 2024-01-01)

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `relation "labor_categories" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `uniqueIndex constraint violation` | Duplicate LCAT code in same CLIN | The `clin_lcat_unique_idx` prevents this — verify form validation |
| `DateInput is not exported from @mantine/core` | Wrong import path | `DateInput` comes from `@mantine/dates`, not `@mantine/core` — verify `@mantine/dates` is in `package.json` |
| `Cannot read properties of undefined` | Empty table joins | Ensure `innerJoin` is used (not `leftJoin`) so null rows don't appear |
| `"use server" functions cannot be imported in client components` | Importing `db` directly | Server actions must be in `'use server'` files; client calls them as async functions |
| Hydration mismatch on Date columns | Server renders date differently than client | Format dates to strings in `Cell` renderers using `dayjs` |
| `IconCategory is not exported` | Tabler icons version mismatch | Try `IconTags` or `IconBriefcase` as alternatives if `IconCategory` is not available |
