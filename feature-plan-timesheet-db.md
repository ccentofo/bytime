# Blueprint: Timesheet ↔ Database Integration

## 1. Architectural Overview & DCAA Impact

### The Problem

The timesheet page currently runs entirely on mock data. `TimesheetContext.tsx` imports hardcoded charge codes and generates fake hour entries from `src/data/mock-timesheet.ts`. There is no persistence — all data is lost on page refresh.

### What This Feature Does

1. **Adds database tables** for storing timesheet entries with DCAA-compliant append-only architecture
2. **Wires the timesheet page** to the authenticated user's assigned charge codes (from `user_assignments`)
3. **Persists hour entries** to the database with full audit trail
4. **Replaces all mock data imports** with real database queries

### DCAA Append-Only Architecture

Per CONTEXT.md: "Once a timesheet entry is saved, it can NEVER be directly UPDATE'd or DELETE'd." Every change creates a new row with an incremented `revision_number`.

```
Employee saves 8.0 hours on May 16 for CLIN 0001AA:
  → INSERT row: revision_number=1, hours=8.0

Employee corrects to 7.5 hours:
  → INSERT row: revision_number=2, hours=7.5, change_reason_code='CORRECTION'
  → Original row (revision_number=1) is preserved forever

Reading "current" hours:
  → SELECT DISTINCT ON (user_id, clin_id, entry_date) ... ORDER BY revision_number DESC
```

### Data Flow (After This Feature)

```
User visits /timesheet
  → Server Component reads session (userId)
  → Fetches user's assigned charge codes from user_assignments
  → Fetches existing timesheet entries for current period
  → Passes data as props to TimesheetProvider
  → BiWeeklyTable renders with real data
  → User edits a cell → Server Action inserts new revision row
  → Context state updates optimistically
```

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/date-utils.ts                           ← Extract getNumDaysInPeriod() from mock-timesheet.ts
├── src/server/actions/timesheet.ts                  ← Server Actions: fetch/save timesheet entries

Files to MODIFY:
├── src/db/schema.ts                                ← Add timesheetEntries table
├── src/types/timesheet.ts                          ← Add new types, keep ChargeCode compatible
├── src/app/(app)/timesheet/page.tsx                ← Server Component: fetch data, pass as props
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx  ← Accept initial data as props
├── src/components/timesheet/TimesheetContext.tsx    ← Accept props instead of mock imports; add SAVE action
├── src/components/timesheet/BiWeeklyTable.tsx       ← Import getNumDaysInPeriod from date-utils
├── src/components/timesheet/PayPeriodSelector.tsx   ← Import getNumDaysInPeriod from date-utils
├── src/components/timesheet/cells/HourCell.tsx      ← Trigger save action on blur

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/cells/ChargeCodeCell.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ColumnHeaderDate.tsx   ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx           ← ❌ DO NOT MODIFY
├── src/components/shell/*                                ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/*                                 ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                           ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                     ← ❌ DO NOT MODIFY
├── src/auth.ts                                           ← ❌ DO NOT MODIFY
├── src/middleware.ts                                     ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Drizzle ORM** for all database queries.
> - Use `bcryptjs` (NOT `bcrypt`) if any password operations are needed.
> - Follow the step order exactly. Each step builds on the previous one.
> - **DCAA Rule:** Never UPDATE or DELETE timesheet entry rows. Always INSERT new revisions.

---

### Step 0: Extract Date Utility

The `getNumDaysInPeriod()` function is pure date math — it doesn't belong in mock data. Extract it so non-mock files can import it.

**0a.** Create `src/lib/date-utils.ts`:

```typescript
import dayjs from 'dayjs';

/**
 * Returns the number of days in a semi-monthly pay period.
 * Period A: 1st–15th = always 15 days
 * Period B: 16th–end of month = varies (13–16 days)
 */
export function getNumDaysInPeriod(periodStart: Date): number {
  const d = dayjs(periodStart);
  if (d.date() === 1) {
    return 15; // 1st through 15th
  }
  // 16th through end of month
  return d.daysInMonth() - 15;
}

/**
 * Returns the default period start date (1st or 16th of the current month).
 */
export function getCurrentPeriodStart(): Date {
  const now = dayjs();
  if (now.date() <= 15) {
    return now.date(1).startOf('day').toDate();
  }
  return now.date(16).startOf('day').toDate();
}

/**
 * Navigate to the next or previous semi-monthly period.
 */
export function navigatePeriod(periodStart: Date, direction: 'prev' | 'next'): Date {
  const current = dayjs(periodStart);

  if (direction === 'next') {
    if (current.date() === 1) {
      return current.date(16).toDate();
    }
    return current.add(1, 'month').date(1).toDate();
  } else {
    if (current.date() === 1) {
      return current.subtract(1, 'month').date(16).toDate();
    }
    return current.date(1).toDate();
  }
}
```

---

### Step 1: Add Timesheet Entries Table to Schema

**1a.** Modify `src/db/schema.ts` — add the `timesheetEntries` table AFTER the existing `userAssignments` table:

```typescript
// ---------------------------------------------------------------------------
// Timesheet Entries (DCAA append-only — NEVER update or delete rows)
// ---------------------------------------------------------------------------

export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  clinId: uuid('clin_id').notNull().references(() => clins.id),
  entryDate: timestamp('entry_date', { withTimezone: true }).notNull(),
  hours: varchar('hours', { length: 10 }).notNull().default('0'), // stored as string to preserve exact decimal input
  revisionNumber: integer('revision_number').notNull().default(1),
  changeReasonCode: varchar('change_reason_code', { length: 50 }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
});
```

**1b.** Add the `integer` import to the top of `src/db/schema.ts`. The existing import line is:

```typescript
import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
```

Add `integer` to this import:

```typescript
import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex, integer } from 'drizzle-orm/pg-core';
```

**1c.** Push the schema:

```bash
export DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
npx drizzle-kit push
```

---

### Step 2: Update Types

**2a.** Modify `src/types/timesheet.ts` — keep the existing types but add new ones for database integration:

Replace the entire file with:

```typescript
export interface ChargeCode {
  id: string;         // maps to clins.id (UUID)
  projectName: string; // maps to contracts.name
  clin: string;        // maps to clins.clinNumber
  description: string; // maps to clins.description
}

export interface TimesheetEntry {
  chargeCodeId: string;
  hours: number[]; // variable length — matches the number of days in the active semi-monthly period
}

export interface NoteData {
  comment: string;
  reasonCode: string;
}

export interface TimesheetState {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  notes: Record<string, NoteData>; // key = "chargeCodeId-dayIndex"
  periodStart: Date;
  activeNoteCell: { chargeCodeId: string; dayIndex: number } | null;
  userId: string; // authenticated user's ID
  isSaving: boolean; // true while a save is in progress
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'NAVIGATE_PERIOD'; direction: 'prev' | 'next' }
  | { type: 'SET_PERIOD_DATA'; periodStart: Date; entries: TimesheetEntry[] }
  | { type: 'SET_SAVING'; isSaving: boolean };

// Props passed from server to client
export interface TimesheetPageData {
  userId: string;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStart: Date;
}
```

**Key changes:**
- Added `userId` and `isSaving` to `TimesheetState`
- Added `SET_PERIOD_DATA` action (for loading data after navigation)
- Added `SET_SAVING` action
- Added `TimesheetPageData` interface for server → client prop passing
- `ChargeCode` type is unchanged (it already maps cleanly to the DB)

---

### Step 3: Create Timesheet Server Actions

**3a.** Create `src/server/actions/timesheet.ts`:

```typescript
'use server';

import { db } from '@/db';
import { timesheetEntries, userAssignments, clins, contracts } from '@/db/schema';
import { eq, and, gte, lt, desc, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { getNumDaysInPeriod } from '@/lib/date-utils';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

/**
 * Get the charge codes (CLINs) assigned to a specific user.
 * Returns data shaped to match the ChargeCode interface.
 */
export async function getChargeCodesForUser(userId: string): Promise<ChargeCode[]> {
  const rows = await db
    .select({
      id: clins.id,
      projectName: contracts.name,
      clin: clins.clinNumber,
      description: clins.description,
    })
    .from(userAssignments)
    .innerJoin(clins, eq(userAssignments.clinId, clins.id))
    .innerJoin(contracts, eq(clins.contractId, contracts.id))
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
  }));
}

/**
 * Get timesheet entries for a user in a specific pay period.
 * Returns the LATEST revision for each (clinId, entryDate) pair.
 * Shapes data into TimesheetEntry[] (one per charge code, with hours array).
 */
export async function getTimesheetEntries(
  userId: string,
  periodStart: Date,
  chargeCodes: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const numDays = getNumDaysInPeriod(periodStart);
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  // Get all entries for this user in this period
  const rows = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      hours: timesheetEntries.hours,
      revisionNumber: timesheetEntries.revisionNumber,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, start.toDate()),
        lt(timesheetEntries.entryDate, endDate.toDate()),
      )
    )
    .orderBy(timesheetEntries.clinId, timesheetEntries.entryDate, desc(timesheetEntries.revisionNumber));

  // Build a map of latest revision per (clinId, dateIndex)
  // Key: "clinId-dayIndex", Value: hours
  const latestHours = new Map<string, number>();
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const key = `${row.clinId}-${dayIndex}`;
    // Since we ordered by revisionNumber DESC, the first occurrence is the latest
    if (!latestHours.has(key)) {
      latestHours.set(key, parseFloat(row.hours));
    }
  }

  // Build TimesheetEntry[] for each charge code
  return chargeCodes.map((cc) => {
    const hours: number[] = [];
    for (let i = 0; i < numDays; i++) {
      const key = `${cc.id}-${i}`;
      hours.push(latestHours.get(key) ?? 0);
    }
    return { chargeCodeId: cc.id, hours };
  });
}

/**
 * Save a single timesheet entry (append-only — creates a new revision).
 */
export async function saveTimesheetEntry(data: {
  userId: string;
  clinId: string;
  entryDate: Date;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
}): Promise<void> {
  // Find the current max revision for this (userId, clinId, entryDate)
  const existing = await db
    .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, data.userId),
        eq(timesheetEntries.clinId, data.clinId),
        eq(timesheetEntries.entryDate, data.entryDate),
      )
    );

  const nextRevision = (existing[0]?.maxRevision ?? 0) + 1;

  await db.insert(timesheetEntries).values({
    userId: data.userId,
    clinId: data.clinId,
    entryDate: data.entryDate,
    hours: data.hours.toString(),
    revisionNumber: nextRevision,
    changeReasonCode: nextRevision > 1 ? (data.changeReasonCode ?? 'CORRECTION') : undefined,
    comment: data.comment,
    createdBy: data.userId,
  });
}
```

**Key details:**
- `getChargeCodesForUser` replaces `MOCK_CHARGE_CODES` — queries `user_assignments` → `clins` → `contracts`
- `getTimesheetEntries` replaces `MOCK_ENTRIES` — queries `timesheet_entries` and returns latest revisions
- `saveTimesheetEntry` is append-only — always INSERTs, never UPDATEs
- First entry has no `changeReasonCode`; subsequent revisions default to `'CORRECTION'`

---

### Step 4: Refactor the Timesheet Page (Server Component)

**4a.** Modify `src/app/(app)/timesheet/page.tsx` to fetch data server-side:

Replace the entire file with:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetEntries } from '@/server/actions/timesheet';
import { getCurrentPeriodStart } from '@/lib/date-utils';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';

export const dynamic = 'force-dynamic';

export default async function TimesheetPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;
  const periodStart = getCurrentPeriodStart();
  const chargeCodes = await getChargeCodesForUser(userId);
  const entries = await getTimesheetEntries(userId, periodStart, chargeCodes);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries,
    periodStart,
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
```

---

### Step 5: Refactor BiWeeklyTimesheetClient to Accept Props

**5a.** Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx`:

Replace the entire file with:

```tsx
'use client';

import { Container, Paper } from '@mantine/core';
import { TimesheetProvider } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import type { TimesheetPageData } from '@/types/timesheet';

function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        <BiWeeklyTable />
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

type Props = {
  initialData: TimesheetPageData;
};

export function BiWeeklyTimesheetClient({ initialData }: Props) {
  return (
    <TimesheetProvider initialData={initialData}>
      <TimesheetContent />
    </TimesheetProvider>
  );
}
```

---

### Step 6: Refactor TimesheetContext to Use Database Data

**6a.** Modify `src/components/timesheet/TimesheetContext.tsx`:

Replace the entire file with:

```tsx
'use client';

import React, { createContext, useContext, useReducer, useCallback } from 'react';
import dayjs from 'dayjs';
import type { TimesheetState, TimesheetAction, TimesheetPageData } from '@/types/timesheet';
import { navigatePeriod } from '@/lib/date-utils';
import { getChargeCodesForUser, getTimesheetEntries, saveTimesheetEntry } from '@/server/actions/timesheet';

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function timesheetReducer(
  state: TimesheetState,
  action: TimesheetAction
): TimesheetState {
  switch (action.type) {
    case 'SET_HOURS': {
      const updatedEntries = state.entries.map((entry) => {
        if (entry.chargeCodeId !== action.chargeCodeId) return entry;
        const newHours = [...entry.hours];
        newHours[action.dayIndex] = action.value;
        return { ...entry, hours: newHours };
      });
      return { ...state, entries: updatedEntries };
    }

    case 'SET_NOTE': {
      const key = `${action.chargeCodeId}-${action.dayIndex}`;
      return {
        ...state,
        notes: { ...state.notes, [key]: action.note },
      };
    }

    case 'OPEN_NOTE_MODAL': {
      return {
        ...state,
        activeNoteCell: {
          chargeCodeId: action.chargeCodeId,
          dayIndex: action.dayIndex,
        },
      };
    }

    case 'CLOSE_NOTE_MODAL': {
      return { ...state, activeNoteCell: null };
    }

    case 'NAVIGATE_PERIOD': {
      const newPeriodStart = navigatePeriod(state.periodStart, action.direction);
      return {
        ...state,
        periodStart: newPeriodStart,
        // Entries will be empty until SET_PERIOD_DATA fires after async fetch
        entries: state.entries.map((e) => ({ ...e, hours: [] })),
        notes: {},
      };
    }

    case 'SET_PERIOD_DATA': {
      return {
        ...state,
        periodStart: action.periodStart,
        entries: action.entries,
      };
    }

    case 'SET_SAVING': {
      return { ...state, isSaving: action.isSaving };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface TimesheetContextValue {
  state: TimesheetState;
  dispatch: React.Dispatch<TimesheetAction>;
  saveHours: (chargeCodeId: string, dayIndex: number, value: number) => Promise<void>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
}

const TimesheetContext = createContext<TimesheetContextValue | undefined>(
  undefined
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderProps = {
  initialData: TimesheetPageData;
  children: React.ReactNode;
};

export function TimesheetProvider({ initialData, children }: ProviderProps) {
  const initialState: TimesheetState = {
    chargeCodes: initialData.chargeCodes,
    entries: initialData.entries,
    notes: {},
    periodStart: new Date(initialData.periodStart),
    activeNoteCell: null,
    userId: initialData.userId,
    isSaving: false,
  };

  const [state, dispatch] = useReducer(timesheetReducer, initialState);

  const saveHours = useCallback(
    async (chargeCodeId: string, dayIndex: number, value: number) => {
      // Optimistic update already happened via SET_HOURS dispatch
      const entryDate = dayjs(state.periodStart).add(dayIndex, 'day').toDate();

      try {
        dispatch({ type: 'SET_SAVING', isSaving: true });
        await saveTimesheetEntry({
          userId: state.userId,
          clinId: chargeCodeId,
          entryDate,
          hours: value,
        });
      } catch (error) {
        console.error('Failed to save timesheet entry:', error);
        // TODO: Show error notification to user
      } finally {
        dispatch({ type: 'SET_SAVING', isSaving: false });
      }
    },
    [state.periodStart, state.userId]
  );

  const loadPeriod = useCallback(
    async (direction: 'prev' | 'next') => {
      dispatch({ type: 'NAVIGATE_PERIOD', direction });

      const newPeriodStart = navigatePeriod(state.periodStart, direction);

      try {
        const entries = await getTimesheetEntries(state.userId, newPeriodStart, state.chargeCodes);
        dispatch({ type: 'SET_PERIOD_DATA', periodStart: newPeriodStart, entries });
      } catch (error) {
        console.error('Failed to load period data:', error);
        // Set empty entries on error
        const emptyEntries = state.chargeCodes.map((cc) => ({
          chargeCodeId: cc.id,
          hours: [] as number[],
        }));
        dispatch({ type: 'SET_PERIOD_DATA', periodStart: newPeriodStart, entries: emptyEntries });
      }
    },
    [state.periodStart, state.userId, state.chargeCodes]
  );

  return (
    <TimesheetContext.Provider value={{ state, dispatch, saveHours, loadPeriod }}>
      {children}
    </TimesheetContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Custom hook
// ---------------------------------------------------------------------------

export function useTimesheet(): TimesheetContextValue {
  const ctx = useContext(TimesheetContext);
  if (!ctx) {
    throw new Error('useTimesheet must be used within a <TimesheetProvider>');
  }
  return ctx;
}
```

**Key changes:**
- `TimesheetProvider` now accepts `initialData` prop instead of using mock imports
- Added `saveHours` function — dispatches `SET_HOURS` optimistically, then persists via server action
- Added `loadPeriod` function — dispatches `NAVIGATE_PERIOD`, then fetches data from DB
- Context value now includes `saveHours` and `loadPeriod` alongside `state` and `dispatch`
- Removed ALL imports from `mock-timesheet.ts`

---

### Step 7: Update BiWeeklyTable Import

**7a.** Modify `src/components/timesheet/BiWeeklyTable.tsx` — change the import of `getNumDaysInPeriod`:

Change this line:
```typescript
import { getNumDaysInPeriod } from '@/data/mock-timesheet';
```

To:
```typescript
import { getNumDaysInPeriod } from '@/lib/date-utils';
```

No other changes to this file.

---

### Step 8: Update PayPeriodSelector for Database Navigation

**8a.** Modify `src/components/timesheet/PayPeriodSelector.tsx` — update imports and use `loadPeriod`:

Change the import:
```typescript
import { getNumDaysInPeriod } from '@/data/mock-timesheet';
```

To:
```typescript
import { getNumDaysInPeriod } from '@/lib/date-utils';
```

Then update the navigation handlers to use `loadPeriod` instead of dispatching `NAVIGATE_PERIOD` directly:

The current navigation dispatches:
```typescript
dispatch({ type: 'NAVIGATE_PERIOD', direction: 'prev' })
```

Change to:
```typescript
loadPeriod('prev')
```

And similarly for 'next'. The `loadPeriod` function is available from `useTimesheet()`:

```typescript
const { state, loadPeriod } = useTimesheet();
```

Instead of:
```typescript
const { state, dispatch } = useTimesheet();
```

---

### Step 9: Update HourCell to Save on Blur

**9a.** Modify `src/components/timesheet/cells/HourCell.tsx` — add auto-save when the user finishes editing a cell.

The current `HourCell` dispatches `SET_HOURS` when the value changes. After this refactor, it should also call `saveHours` to persist to the database.

Find the place where `SET_HOURS` is dispatched (likely in an `onChange` or `onBlur` handler). After the dispatch, add:

```typescript
saveHours(chargeCodeId, dayIndex, newValue);
```

The `saveHours` function is available from `useTimesheet()`:

```typescript
const { state, dispatch, saveHours } = useTimesheet();
```

**Important:** The `SET_HOURS` dispatch provides the optimistic update (instant UI feedback). The `saveHours` call handles the async database persistence. If the save fails, the UI still shows the entered value — error handling/retry can be added in a future phase.

Read the current `HourCell.tsx` to determine the exact edit pattern (is it `onChange`, `onBlur`, or a submit action?), then wire `saveHours` at the appropriate point — typically `onBlur` (when the user finishes editing the cell).

---

## 4. Verification

### 4a. Schema Push

```bash
export DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime
npx drizzle-kit push
```

Verify the `timesheet_entries` table exists:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "\d timesheet_entries"
```

### 4b. Build Check

```bash
npm run build
```

Must complete with **zero errors**. Watch for:
- No remaining imports from `@/data/mock-timesheet` in any modified file
- `getNumDaysInPeriod` imported from `@/lib/date-utils` everywhere
- `TimesheetProvider` accepting `initialData` prop

### 4c. Dev Server Checks

```bash
npm run dev
```

**Prerequisites:** You must be logged in as a user who has charge code assignments. Use `admin@bytime.dev` (or any user with `user_assignments` rows).

| Check | Expected Result |
|---|---|
| **Login and visit `/timesheet`** | Timesheet loads with real charge codes from user_assignments (not mock data) |
| **Charge codes match assignments** | Only CLINs assigned to the logged-in user appear as rows |
| **Empty timesheet** | All hours show 0.00 initially (no entries in DB yet) |
| **Edit a cell** | Type a number, tab/click away — value persists in the cell |
| **Refresh the page** | The entered hours are still there (saved to DB) |
| **Navigate to next period** | Columns change to the next semi-monthly period; hours reset to 0 (no entries yet) |
| **Navigate back** | Previously entered hours reappear (loaded from DB) |
| **Login as different user** | Different charge codes appear (based on their assignments) |
| **User with no assignments** | Timesheet shows no rows (empty table, no errors) |

### 4d. Database Verification

After entering some hours, verify the append-only behavior:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "
SELECT te.entry_date, cl.clin_number, te.hours, te.revision_number, te.change_reason_code
FROM timesheet_entries te
JOIN clins cl ON te.clin_id = cl.id
ORDER BY te.entry_date, cl.clin_number, te.revision_number;
"
```

Edit the same cell again and re-run the query — you should see TWO rows for the same (clin, date) pair with `revision_number` 1 and 2.

### 4e. Guardrail Verification

```bash
git diff --name-only
```

Must **NOT** include:
- `src/components/timesheet/cells/ChargeCodeCell.tsx`
- `src/components/timesheet/cells/ColumnHeaderDate.tsx`
- `src/components/timesheet/cells/TotalHoursCell.tsx`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/shell/*`
- `src/app/(app)/admin/*`
- `src/server/actions/contracts.ts`
- `src/server/actions/clins.ts`
- `src/server/actions/assignments.ts`
- `src/auth.ts`
- `src/middleware.ts`

### 4f. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `getNumDaysInPeriod is not a function` | Still importing from mock-timesheet | Update import to `@/lib/date-utils` |
| `Cannot find module '@/data/mock-timesheet'` | File import not updated | Search for remaining mock-timesheet imports and replace |
| `relation "timesheet_entries" does not exist` | Schema not pushed | Run `npx drizzle-kit push` |
| `Property 'userId' does not exist on type 'TimesheetState'` | Types not updated | Verify `src/types/timesheet.ts` has `userId` and `isSaving` |
| `saveHours is not a function` | Context value not updated | Verify `TimesheetContextValue` includes `saveHours` and `loadPeriod` |
| `No charge codes found` | User has no assignments | Assign CLINs to the user via `/admin/assignments` first |
| Empty hours array after navigation | `SET_PERIOD_DATA` not dispatched | Verify `loadPeriod` dispatches `SET_PERIOD_DATA` after fetch |
| `initialData` prop type error | `TimesheetProvider` not updated | Verify it accepts `initialData: TimesheetPageData` |
| `integer is not exported from drizzle-orm/pg-core` | Missing import | Add `integer` to the import in `schema.ts` |
