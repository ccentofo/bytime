# Blueprint: Audit Trail & Revision History Viewer (Admin v2)

## 1. Architectural Overview & DCAA Impact

### Why This Feature is Critical

DCAA auditors will ask: **"Show me every change ever made to this timesheet."** The system already stores this data — every cell change creates a new append-only row in `timesheetEntries` with an incremented `revisionNumber`, a `changeReasonCode`, a `comment`, a `createdAt` timestamp, and a `createdBy` reference. However, there is currently **no admin UI** to view this audit trail.

This feature builds a **read-only** admin page that surfaces the existing DCAA-compliant data in a way that satisfies audit requirements.

### What Already Exists (No Schema Changes Needed)

```sql
-- timesheetEntries (append-only)
id, user_id, clin_id, entry_date, hours, revision_number,
change_reason_code, comment, created_at, created_by

-- timesheetPeriods (period lifecycle)
id, user_id, period_start, status, submitted_at, submitted_comment,
reviewed_at, reviewed_by, review_comment, created_at, updated_at
```

Every cell in the timesheet grid maps to a `(user_id, clin_id, entry_date)` tuple. When an employee modifies a cell that already has a saved value, the system inserts a **new row** with `revision_number + 1`, preserving the old row forever. The `change_reason_code` and `comment` explain why the change was made.

### DCAA Audit Requirements This Satisfies

| DCAA Requirement | How This Feature Satisfies It |
|---|---|
| **FAR 31.201-1 — Allowable Costs** | Auditors can trace every hour charged, when it was entered, and by whom |
| **Append-Only Verification** | The UI proves no rows were ever deleted or overwritten — every revision is visible |
| **Change Justification** | Reason codes and comments are displayed for every correction/late entry |
| **Daily Time Entry Compliance** | `created_at` timestamps prove when entries were actually logged vs. the `entry_date` they're logged against |
| **CAS 418 — Consistent Accounting** | Full revision history enables verification that charges were applied consistently |

### Data Queries (All Read-Only)

This feature requires **zero schema changes**. It only needs new server actions that query existing tables with different filters/groupings than what currently exists.

---

## 2. File Topology

```
Files to CREATE (new):
├── src/server/actions/audit.ts                      ← Server Actions: read-only audit queries
├── src/app/(app)/admin/audit-trail/
│   ├── page.tsx                                     ← Server Component: Audit Trail page
│   ├── AuditTrailClient.tsx                         ← Client Component: filters + revision table
│   └── AuditTrail.module.css                        ← Module CSS for MRT table header styling

Files to MODIFY:
├── src/components/shell/AppNavbar.tsx                ← Add "Audit Trail" nav link

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/*                        ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                            ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                     ← ❌ DO NOT MODIFY
├── src/db/schema.ts                                  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/assignments/*                 ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/approvals/*                   ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/users/*                       ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/labor-categories/*             ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** touch, modify, or import from any file listed in the "DO NOT MODIFY" section above.
> - This feature is **100% read-only** — no INSERT, UPDATE, or DELETE operations. Only SELECT queries.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`, `@mantine/dates`, `@mantine/notifications`).
> - Use **Mantine React Table v2** (`mantine-react-table`) for the main audit table.
> - Use **Drizzle ORM** for all database queries.
> - Do **NOT** search or read files inside `node_modules/`, `.next/`, or `dist/`.
> - Follow the step order exactly. Each step builds on the previous one.
> - For MRT table header styling, use a `.module.css` file with a `tableHeaderCell` class, following the pattern in other admin pages.

---

### Step 1: Audit Server Actions

**1a.** Create `src/server/actions/audit.ts`:

```typescript
'use server';

import { db } from '@/db';
import { timesheetEntries, timesheetPeriods, users, clins, contracts } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  contractNumber: string;
  entryDate: Date;
  hours: string;
  revisionNumber: number;
  changeReasonCode: string | null;
  comment: string | null;
  createdAt: Date;
  createdById: string | null;
  createdByName: string | null;
}

export interface AuditFilters {
  userId?: string;
  contractId?: string;
  clinId?: string;
  startDate?: Date;
  endDate?: Date;
  reasonCode?: string;
  revisionsOnly?: boolean; // if true, only show entries where revision_number > 1
}

export interface CellRevisionHistory {
  userId: string;
  userName: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
  entryDate: Date;
  revisions: Array<{
    id: string;
    hours: string;
    revisionNumber: number;
    changeReasonCode: string | null;
    comment: string | null;
    createdAt: Date;
    createdByName: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Audit Queries
// ---------------------------------------------------------------------------

/**
 * Get audit entries with filters. Returns all timesheet entries matching
 * the provided filter criteria, ordered by most recent first.
 * Limits to 500 rows to prevent overwhelming the UI.
 */
export async function getAuditEntries(filters: AuditFilters): Promise<AuditEntry[]> {
  // We need to alias the 'users' table for the createdBy join
  // Drizzle doesn't support table aliases easily, so we'll do two queries
  // or use a raw subselect. For simplicity, we'll join to users for the
  // entry owner and do a subquery for createdBy name.

  const conditions = [];

  if (filters.userId) {
    conditions.push(eq(timesheetEntries.userId, filters.userId));
  }
  if (filters.clinId) {
    conditions.push(eq(timesheetEntries.clinId, filters.clinId));
  }
  if (filters.startDate) {
    conditions.push(gte(timesheetEntries.entryDate, filters.startDate));
  }
  if (filters.endDate) {
    // endDate is inclusive, so add 1 day for lt comparison
    conditions.push(lt(timesheetEntries.entryDate, dayjs(filters.endDate).add(1, 'day').toDate()));
  }
  if (filters.reasonCode) {
    conditions.push(eq(timesheetEntries.changeReasonCode, filters.reasonCode));
  }
  if (filters.revisionsOnly) {
    conditions.push(gte(timesheetEntries.revisionNumber, 2));
  }

  // Build the where clause
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // If contractId filter is set, we need to filter by CLIN's contract
  // We'll handle this in the join condition

  let query = db
    .select({
      id: timesheetEntries.id,
      userId: timesheetEntries.userId,
      userName: users.fullName,
      userEmail: users.email,
      clinId: timesheetEntries.clinId,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
      contractNumber: contracts.contractNumber,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      changeReasonCode: timesheetEntries.changeReasonCode,
      comment: timesheetEntries.comment,
      createdAt: timesheetEntries.createdAt,
      createdById: timesheetEntries.createdBy,
      createdByName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${timesheetEntries.createdBy})`,
    })
    .from(timesheetEntries)
    .innerJoin(users, eq(timesheetEntries.userId, users.id))
    .innerJoin(clins, eq(timesheetEntries.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id));

  // Add contract filter if provided
  if (filters.contractId) {
    conditions.push(eq(contracts.id, filters.contractId));
  }

  const finalWhere = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await query
    .where(finalWhere)
    .orderBy(desc(timesheetEntries.createdAt))
    .limit(500);

  return rows;
}

/**
 * Get the full revision history for a specific cell (user + CLIN + date).
 * Returns all revisions ordered from oldest to newest.
 */
export async function getCellRevisionHistory(
  userId: string,
  clinId: string,
  entryDate: Date
): Promise<CellRevisionHistory | null> {
  const entryStart = dayjs(entryDate).startOf('day').toDate();
  const entryEnd = dayjs(entryDate).add(1, 'day').startOf('day').toDate();

  const rows = await db
    .select({
      id: timesheetEntries.id,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
      changeReasonCode: timesheetEntries.changeReasonCode,
      comment: timesheetEntries.comment,
      createdAt: timesheetEntries.createdAt,
      createdByName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${timesheetEntries.createdBy})`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        eq(timesheetEntries.clinId, clinId),
        gte(timesheetEntries.entryDate, entryStart),
        lt(timesheetEntries.entryDate, entryEnd),
      )
    )
    .orderBy(timesheetEntries.revisionNumber);

  if (rows.length === 0) return null;

  // Get user and CLIN context
  const context = await db
    .select({
      userName: users.fullName,
      clinNumber: clins.clinNumber,
      contractName: contracts.name,
    })
    .from(users)
    .innerJoin(clins, eq(clins.id, clinId))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (context.length === 0) return null;

  return {
    userId,
    userName: context[0].userName,
    clinId,
    clinNumber: context[0].clinNumber,
    contractName: context[0].contractName,
    entryDate: entryStart,
    revisions: rows,
  };
}

/**
 * Get summary statistics for the audit trail.
 * Returns counts of total entries, corrections, late entries, etc.
 */
export async function getAuditSummary(): Promise<{
  totalEntries: number;
  totalCorrections: number;
  totalLateEntries: number;
  uniqueUsers: number;
}> {
  const [totalResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries);

  const [correctionsResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(eq(timesheetEntries.changeReasonCode, 'CORRECTION'));

  const [lateResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(timesheetEntries)
    .where(eq(timesheetEntries.changeReasonCode, 'LATE_ENTRY'));

  const [usersResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${timesheetEntries.userId})` })
    .from(timesheetEntries);

  return {
    totalEntries: totalResult.count,
    totalCorrections: correctionsResult.count,
    totalLateEntries: lateResult.count,
    uniqueUsers: usersResult.count,
  };
}

/**
 * Get all contracts (for filter dropdown).
 * Re-exported here to avoid importing from contracts.ts in the client.
 */
export async function getContractsForFilter() {
  return db
    .select({
      id: contracts.id,
      name: contracts.name,
      contractNumber: contracts.contractNumber,
    })
    .from(contracts)
    .orderBy(contracts.name);
}

/**
 * Get all CLINs for a specific contract (for filter dropdown cascade).
 */
export async function getClinsForFilter(contractId: string) {
  return db
    .select({
      id: clins.id,
      clinNumber: clins.clinNumber,
      description: clins.description,
    })
    .from(clins)
    .where(eq(clins.contractId, contractId))
    .orderBy(clins.clinNumber);
}

/**
 * Get all users (for filter dropdown).
 * Re-exported here to keep the audit page self-contained.
 */
export async function getUsersForFilter() {
  return db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
    })
    .from(users)
    .orderBy(users.fullName);
}
```

---

### Step 2: Audit Trail Admin Page

**2a.** Create `src/app/(app)/admin/audit-trail/AuditTrail.module.css`:

```css
.tableHeaderCell button {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

**2b.** Create `src/app/(app)/admin/audit-trail/page.tsx` — Server Component:

```typescript
import { getAuditSummary, getContractsForFilter, getUsersForFilter } from '@/server/actions/audit';
import { AuditTrailClient } from './AuditTrailClient';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function AuditTrailPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin' && session.user.role !== 'supervisor') {
    redirect('/timesheet');
  }

  const [summary, contractsList, usersList] = await Promise.all([
    getAuditSummary(),
    getContractsForFilter(),
    getUsersForFilter(),
  ]);

  return (
    <AuditTrailClient
      initialSummary={summary}
      contracts={contractsList}
      users={usersList}
    />
  );
}
```

**2c.** Create `src/app/(app)/admin/audit-trail/AuditTrailClient.tsx` — the main Audit Trail UI.

This is a `'use client'` component with **three sections**:

#### Section A — Summary Cards (top)

Four Mantine `Paper` cards in a `SimpleGrid` showing:
- **Total Entries** — total append-only rows in `timesheetEntries`
- **Corrections** — entries with `changeReasonCode = 'CORRECTION'`
- **Late Entries** — entries with `changeReasonCode = 'LATE_ENTRY'`
- **Unique Users** — count of distinct users who have entries

#### Section B — Filters (below summary)

A `Paper` with border containing filter controls:
- `Select` for **User** (from `users` prop, optional — "All Users" default)
- `Select` for **Contract** (from `contracts` prop, optional)
- `Select` for **CLIN** (cascades from Contract selection via `getClinsForFilter`, optional)
- `DateInput` for **Start Date** (optional)
- `DateInput` for **End Date** (optional)
- `Select` for **Reason Code** (from `REASON_CODES` constant, optional — includes "All" option)
- `Switch` for **Corrections Only** (filters to `revision_number > 1`)
- `Button` "Search" — calls `getAuditEntries` with the assembled filters

#### Section C — Audit Entries Table (main content)

A **Mantine React Table** showing filtered audit entries with columns:

| Column | Source | Width |
|---|---|---|
| Employee | `userName` | 160 |
| Contract | `contractName (contractNumber)` | 200 |
| CLIN | `clinNumber` | 100 |
| Entry Date | `entryDate` (formatted `MMM D, YYYY`) | 130 |
| Hours | `hours` | 80 |
| Rev # | `revisionNumber` (Badge: green=1, orange=2+) | 80 |
| Reason | `changeReasonCode` (human-readable label from REASON_CODES, or `—`) | 160 |
| Comment | `comment` (truncated, or `—`) | 200 |
| Entered At | `createdAt` (formatted `MMM D, YYYY h:mm A`) | 180 |
| Entered By | `createdByName` (or `—`) | 140 |

**Table Features:**
- `enableRowActions: true` with a **"View History"** button that opens a `Drawer` showing all revisions for that cell
- Row coloring: Rows where `revisionNumber > 1` should have a subtle visual indicator (use `mantineTableBodyRowProps` to add a light yellow/orange background for corrections)
- Enable column sorting and global search

#### Revision History Drawer

When "View History" is clicked on any row, open a `Drawer` (`position="right"`, `size="lg"`) showing:
- Header: `"Revision History — {userName} — {clinNumber} — {entryDate}"`
- A Mantine `Timeline` (from `@mantine/core`) showing each revision as a timeline item:
  - **Title:** `"Revision {revisionNumber}"` with hours value
  - **Bullet color:** Green for rev 1 (original), orange for rev 2+ (corrections)
  - **Body:** Reason code label, comment, "Entered at {createdAt} by {createdByName}"
- The timeline shows the full history from revision 1 (original entry) through the latest revision

**Full Component Implementation:**

```typescript
'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  Drawer,
  Select,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Paper,
  SimpleGrid,
  Switch,
  Timeline,
  ThemeIcon,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconSearch,
  IconEye,
  IconEdit,
  IconClock,
  IconAlertTriangle,
  IconHistory,
} from '@tabler/icons-react';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import {
  getAuditEntries,
  getCellRevisionHistory,
  getClinsForFilter,
  type AuditEntry,
  type AuditFilters,
  type CellRevisionHistory,
} from '@/server/actions/audit';
import { REASON_CODES } from '@/lib/reason-codes';
import classes from './AuditTrail.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContractOption = {
  id: string;
  name: string;
  contractNumber: string;
};

type UserOption = {
  id: string;
  fullName: string;
  email: string;
};

type ClinOption = {
  id: string;
  clinNumber: string;
  description: string | null;
};

type AuditSummary = {
  totalEntries: number;
  totalCorrections: number;
  totalLateEntries: number;
  uniqueUsers: number;
};

type Props = {
  initialSummary: AuditSummary;
  contracts: ContractOption[];
  users: UserOption[];
};

// Map reason codes to human-readable labels
const REASON_LABEL_MAP: Record<string, string> = {};
for (const rc of REASON_CODES) {
  REASON_LABEL_MAP[rc.value] = rc.label;
}

export function AuditTrailClient({ initialSummary, contracts, users }: Props) {
  const [isPending, startTransition] = useTransition();
  const [summary] = useState<AuditSummary>(initialSummary);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // Filter state
  const [filterUserId, setFilterUserId] = useState<string | null>(null);
  const [filterContractId, setFilterContractId] = useState<string | null>(null);
  const [filterClinId, setFilterClinId] = useState<string | null>(null);
  const [filterStartDate, setFilterStartDate] = useState<string | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<string | null>(null);
  const [filterReasonCode, setFilterReasonCode] = useState<string | null>(null);
  const [filterRevisionsOnly, setFilterRevisionsOnly] = useState(false);
  const [clinOptions, setClinOptions] = useState<ClinOption[]>([]);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [revisionHistory, setRevisionHistory] = useState<CellRevisionHistory | null>(null);

  // --- Filter handlers ---

  function handleContractFilterChange(contractId: string | null) {
    setFilterContractId(contractId);
    setFilterClinId(null);
    setClinOptions([]);
    if (!contractId) return;
    startTransition(async () => {
      const fetchedClins = await getClinsForFilter(contractId);
      setClinOptions(fetchedClins);
    });
  }

  function handleSearch() {
    startTransition(async () => {
      const filters: AuditFilters = {};
      if (filterUserId) filters.userId = filterUserId;
      if (filterContractId) filters.contractId = filterContractId;
      if (filterClinId) filters.clinId = filterClinId;
      if (filterStartDate) filters.startDate = new Date(filterStartDate);
      if (filterEndDate) filters.endDate = new Date(filterEndDate);
      if (filterReasonCode) filters.reasonCode = filterReasonCode;
      if (filterRevisionsOnly) filters.revisionsOnly = true;

      const results = await getAuditEntries(filters);
      setEntries(results);
      setHasSearched(true);
    });
  }

  function handleViewHistory(entry: AuditEntry) {
    setDrawerOpen(true);
    setRevisionHistory(null);
    startTransition(async () => {
      const history = await getCellRevisionHistory(
        entry.userId,
        entry.clinId,
        entry.entryDate,
      );
      setRevisionHistory(history);
    });
  }

  // --- Table columns ---

  const columns: MRT_ColumnDef<AuditEntry>[] = [
    { accessorKey: 'userName', header: 'Employee', size: 160 },
    {
      id: 'contract',
      header: 'Contract',
      accessorFn: (row) => `${row.contractName} (${row.contractNumber})`,
      size: 200,
    },
    { accessorKey: 'clinNumber', header: 'CLIN', size: 100 },
    {
      accessorKey: 'entryDate',
      header: 'Entry Date',
      Cell: ({ cell }) => dayjs(cell.getValue<Date>()).format('MMM D, YYYY'),
      size: 130,
    },
    {
      accessorKey: 'hours',
      header: 'Hours',
      Cell: ({ cell }) => {
        const val = cell.getValue<string>();
        const num = parseFloat(val);
        return isNaN(num) ? val : num.toFixed(2);
      },
      size: 80,
    },
    {
      accessorKey: 'revisionNumber',
      header: 'Rev #',
      Cell: ({ cell }) => {
        const rev = cell.getValue<number>();
        return (
          <Badge color={rev === 1 ? 'green' : 'orange'} variant="light" size="sm">
            {rev}
          </Badge>
        );
      },
      size: 80,
    },
    {
      accessorKey: 'changeReasonCode',
      header: 'Reason',
      Cell: ({ cell }) => {
        const code = cell.getValue<string | null>();
        if (!code) return <Text size="sm" c="dimmed">—</Text>;
        return (
          <Badge variant="light" color="gray" size="sm">
            {REASON_LABEL_MAP[code] ?? code}
          </Badge>
        );
      },
      size: 160,
    },
    {
      accessorKey: 'comment',
      header: 'Comment',
      Cell: ({ cell }) => {
        const val = cell.getValue<string | null>();
        if (!val) return <Text size="sm" c="dimmed">—</Text>;
        return (
          <Text size="sm" lineClamp={1} title={val}>
            {val}
          </Text>
        );
      },
      size: 200,
    },
    {
      accessorKey: 'createdAt',
      header: 'Entered At',
      Cell: ({ cell }) => dayjs(cell.getValue<Date>()).format('MMM D, YYYY h:mm A'),
      size: 180,
    },
    {
      accessorKey: 'createdByName',
      header: 'Entered By',
      Cell: ({ cell }) => {
        const val = cell.getValue<string | null>();
        return val ?? <Text size="sm" c="dimmed">—</Text>;
      },
      size: 140,
    },
  ];

  const table = useMantineReactTable({
    columns,
    data: entries,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
      <Button
        size="xs"
        variant="subtle"
        leftSection={<IconEye size={14} />}
        onClick={() => handleViewHistory(row.original)}
      >
        History
      </Button>
    ),
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableGlobalFilter: true,
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
    mantineTableBodyRowProps: ({ row }) => ({
      style: row.original.revisionNumber > 1
        ? { backgroundColor: 'var(--mantine-color-orange-0)' }
        : undefined,
    }),
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Details',
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
    state: {
      isLoading: isPending && hasSearched,
    },
  });

  return (
    <>
      {/* ---- Section A: Summary Cards ---- */}
      <Title order={2} mb="md">Audit Trail</Title>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mb="xl">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total Entries</Text>
              <Text size="xl" fw={700}>{summary.totalEntries.toLocaleString()}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconClock size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Corrections</Text>
              <Text size="xl" fw={700}>{summary.totalCorrections.toLocaleString()}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="lg" radius="md">
              <IconEdit size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Late Entries</Text>
              <Text size="xl" fw={700}>{summary.totalLateEntries.toLocaleString()}</Text>
            </div>
            <ThemeIcon color="yellow" variant="light" size="lg" radius="md">
              <IconAlertTriangle size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Active Users</Text>
              <Text size="xl" fw={700}>{summary.uniqueUsers.toLocaleString()}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="lg" radius="md">
              <IconHistory size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* ---- Section B: Filters ---- */}
      <Paper withBorder p="md" mb="xl">
        <Title order={4} mb="sm">Search Filters</Title>
        <Group align="flex-end" wrap="wrap" gap="md">
          <Select
            label="Employee"
            placeholder="All employees"
            data={users.map((u) => ({ value: u.id, label: u.fullName }))}
            value={filterUserId}
            onChange={setFilterUserId}
            clearable
            searchable
            style={{ minWidth: 180 }}
          />
          <Select
            label="Contract"
            placeholder="All contracts"
            data={contracts.map((c) => ({
              value: c.id,
              label: `${c.name} (${c.contractNumber})`,
            }))}
            value={filterContractId}
            onChange={handleContractFilterChange}
            clearable
            searchable
            style={{ minWidth: 220 }}
          />
          <Select
            label="CLIN"
            placeholder={filterContractId ? 'All CLINs' : 'Select contract first'}
            data={clinOptions.map((c) => ({
              value: c.id,
              label: `${c.clinNumber}${c.description ? ' — ' + c.description : ''}`,
            }))}
            value={filterClinId}
            onChange={setFilterClinId}
            disabled={!filterContractId}
            clearable
            searchable
            style={{ minWidth: 180 }}
          />
          <DateInput
            label="Start Date"
            value={filterStartDate}
            onChange={setFilterStartDate}
            clearable
            style={{ minWidth: 150 }}
          />
          <DateInput
            label="End Date"
            value={filterEndDate}
            onChange={setFilterEndDate}
            clearable
            style={{ minWidth: 150 }}
          />
          <Select
            label="Reason Code"
            placeholder="All reasons"
            data={REASON_CODES.map((rc) => ({ value: rc.value, label: rc.label }))}
            value={filterReasonCode}
            onChange={setFilterReasonCode}
            clearable
            style={{ minWidth: 180 }}
          />
          <Switch
            label="Corrections only"
            checked={filterRevisionsOnly}
            onChange={(e) => setFilterRevisionsOnly(e.currentTarget.checked)}
            mt="xl"
          />
          <Button
            leftSection={<IconSearch size={16} />}
            onClick={handleSearch}
            loading={isPending}
          >
            Search
          </Button>
        </Group>
      </Paper>

      {/* ---- Section C: Results Table ---- */}
      {!hasSearched && (
        <Paper withBorder p="xl" ta="center">
          <Text c="dimmed" size="lg">
            Use the filters above and click "Search" to view audit entries.
          </Text>
        </Paper>
      )}

      {hasSearched && <MantineReactTable table={table} />}

      {hasSearched && entries.length === 500 && (
        <Text size="sm" c="dimmed" mt="xs" ta="center">
          Results limited to 500 entries. Narrow your filters for more specific results.
        </Text>
      )}

      {/* ---- Revision History Drawer ---- */}
      <Drawer
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        position="right"
        size="lg"
        title="Revision History"
      >
        <Stack>
          {revisionHistory === null && isPending && (
            <Text c="dimmed" size="sm">Loading revision history...</Text>
          )}

          {revisionHistory === null && !isPending && (
            <Text c="dimmed" size="sm">No revision data found.</Text>
          )}

          {revisionHistory && (
            <>
              <Paper withBorder p="sm">
                <Group>
                  <Text size="sm"><strong>Employee:</strong> {revisionHistory.userName}</Text>
                  <Text size="sm"><strong>CLIN:</strong> {revisionHistory.clinNumber}</Text>
                  <Text size="sm"><strong>Contract:</strong> {revisionHistory.contractName}</Text>
                  <Text size="sm"><strong>Date:</strong> {dayjs(revisionHistory.entryDate).format('MMM D, YYYY')}</Text>
                </Group>
              </Paper>

              <Title order={5} mt="md">
                {revisionHistory.revisions.length} Revision{revisionHistory.revisions.length !== 1 ? 's' : ''}
              </Title>

              <Timeline active={revisionHistory.revisions.length - 1} bulletSize={28} lineWidth={2}>
                {revisionHistory.revisions.map((rev) => (
                  <Timeline.Item
                    key={rev.id}
                    bullet={
                      <ThemeIcon
                        size={28}
                        radius="xl"
                        color={rev.revisionNumber === 1 ? 'green' : 'orange'}
                      >
                        {rev.revisionNumber === 1
                          ? <IconClock size={14} />
                          : <IconEdit size={14} />
                        }
                      </ThemeIcon>
                    }
                    title={
                      <Group gap="xs">
                        <Text fw={600} size="sm">Revision {rev.revisionNumber}</Text>
                        <Badge
                          color={rev.revisionNumber === 1 ? 'green' : 'orange'}
                          variant="light"
                          size="sm"
                        >
                          {rev.hours} hrs
                        </Badge>
                      </Group>
                    }
                  >
                    <Stack gap={4} mt={4}>
                      {rev.changeReasonCode && (
                        <Text size="xs" c="dimmed">
                          <strong>Reason:</strong> {REASON_LABEL_MAP[rev.changeReasonCode] ?? rev.changeReasonCode}
                        </Text>
                      )}
                      {rev.comment && (
                        <Text size="xs" c="dimmed">
                          <strong>Comment:</strong> {rev.comment}
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        Entered at {dayjs(rev.createdAt).format('MMM D, YYYY h:mm:ss A')}
                        {rev.createdByName ? ` by ${rev.createdByName}` : ''}
                      </Text>
                    </Stack>
                  </Timeline.Item>
                ))}
              </Timeline>
            </>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
```

---

### Step 3: Add Nav Link

**3a.** Modify `src/components/shell/AppNavbar.tsx` — Add an "Audit Trail" navigation link in the ADMINISTRATION section.

**SEARCH/REPLACE in `src/components/shell/AppNavbar.tsx`:**

Find this import line:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory } from '@tabler/icons-react';
```

Replace with:
```typescript
import { IconClock, IconFileText, IconUsers, IconChecklist, IconUserCog, IconCategory, IconHistory } from '@tabler/icons-react';
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
            label="Audit Trail"
            href="/admin/audit-trail"
            leftSection={<IconHistory size={18} />}
            active={pathname === '/admin/audit-trail'}
          />
```

The final nav order in the ADMINISTRATION section should be:
1. Contracts & CLINs
2. User Assignments
3. Timesheet Approvals
4. Labor Categories
5. **Audit Trail** ← NEW
6. User Management

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**. Pay special attention to:
- Server Action imports working correctly across the client/server boundary
- No client/server boundary violations
- The `sql` template literal for the subquery in `getAuditEntries` and `getCellRevisionHistory` compiling correctly
- `Timeline` import from `@mantine/core` resolving (it's part of Mantine core, not a separate package)
- `REASON_CODES` import from `@/lib/reason-codes` resolving

### 4b. Dev Server Visual Checks

```bash
npm run dev
```

Navigate to `http://localhost:3000/admin/audit-trail` and verify:

| Check | Expected Result |
|---|---|
| **Nav link** | "Audit Trail" appears in the admin sidebar between "Labor Categories" and "User Management" |
| **Summary cards** | Four cards render showing Total Entries, Corrections, Late Entries, Active Users with correct counts |
| **Filter panel** | All dropdowns populate: Employee, Contract, CLIN (cascades from Contract), Reason Code. DateInputs work. Switch toggles. |
| **Search with no filters** | Returns up to 500 most recent entries |
| **Search with User filter** | Shows only entries for selected user |
| **Search with Contract + CLIN** | Contract dropdown cascades to CLIN; results filtered correctly |
| **Search with Date range** | Shows only entries within the specified date range |
| **Search with Reason Code** | Shows only entries with that specific reason code |
| **Corrections Only switch** | When ON, only shows entries where revision_number ≥ 2 |
| **Audit table renders** | MRT table with correct columns: Employee, Contract, CLIN, Entry Date, Hours, Rev #, Reason, Comment, Entered At, Entered By |
| **Rev # badge** | Green for revision 1, orange for revision 2+ |
| **Row highlighting** | Rows with revisionNumber > 1 have a subtle orange background |
| **Reason column** | Shows human-readable label (e.g., "Correction of Error") instead of raw code |
| **View History button** | Opens Drawer on the right with full revision timeline |
| **Revision Timeline** | Shows all revisions chronologically with green bullet for rev 1, orange for 2+. Displays hours, reason, comment, timestamp, and who made the change. |
| **500 limit message** | If exactly 500 results returned, shows "Results limited to 500 entries" message |
| **Empty state** | Before first search, shows "Use the filters above..." placeholder |
| **No timesheet impact** | Navigate to `/timesheet` — existing timesheet still works identically |
| **No other admin impact** | All other admin pages work identically |

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
- `src/db/schema.ts`
- `src/app/(app)/admin/contracts/`
- `src/app/(app)/admin/assignments/`
- `src/app/(app)/admin/approvals/`
- `src/app/(app)/admin/users/`
- `src/app/(app)/admin/labor-categories/`

If any of these files appear in the diff, the agent has violated the guardrail and the changes must be reverted immediately.

### 4d. Test Data Scenarios

To fully test the audit trail, ensure the database has:

1. **Entries with revisions:** Make several timesheet entries, then edit them (which creates revision 2+ with reason codes and comments). The audit trail should show both the original and the corrected entries.
2. **Late entries:** Enter time for a date that has passed (>24hrs ago). These should have `LATE_ENTRY` reason codes.
3. **Multiple users:** Entries from at least 2-3 different users to test the User filter.
4. **Multiple contracts/CLINs:** Entries across different contracts to test the Contract/CLIN filter cascade.

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `sql is not defined` | Missing import | Ensure `sql` is imported from `drizzle-orm` in `audit.ts` |
| `Timeline is not exported from @mantine/core` | Mantine v9 may have moved Timeline | Check if `Timeline` is in `@mantine/core` or needs a separate import. If not available, fall back to a simple `Stack` with revision `Paper` cards |
| `SimpleGrid is not exported from @mantine/core` | Wrong import | `SimpleGrid` is in `@mantine/core` in Mantine v9 — verify the import |
| `ThemeIcon is not exported` | Import path issue | `ThemeIcon` is in `@mantine/core` |
| `Cannot read properties of undefined` | Empty audit results | The table handles empty arrays correctly via MRT; verify the `hasSearched` guard |
| Hydration mismatch on Date columns | Server/client date formatting | All dates are formatted client-side in `Cell` renderers using `dayjs` |
| `IconHistory is not exported` | Tabler icons version | Try `IconClockHistory` or `IconReportSearch` as alternatives |
| SQL subquery error in `createdByName` | The `(SELECT full_name FROM users WHERE id = ...)` subquery syntax | Ensure the `sql` template literal is correctly escaped. If it fails, remove the subquery and do a second query or use `null` as placeholder |
| `auth is not a function` | Missing auth import | Ensure `auth` is imported from `@/auth` in `page.tsx` |
