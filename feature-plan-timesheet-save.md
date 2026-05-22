# Blueprint: Timesheet Save Button & DCAA Edit Reason Enforcement

## 1. Architectural Overview & DCAA Impact

### The Problem

The current timesheet implementation **auto-saves on every cell blur** (`HourCell.tsx` line 34 calls `saveHours()` immediately). This violates two requirements:

1. **No explicit Save action** — The user has no control over when data is persisted. There is no Save button.
2. **No reason required for edits** — When editing a previously-saved cell, the system auto-fills `'CORRECTION'` as the reason code. DCAA requires the **user to explicitly provide** a reason for any change to previously-saved data.

### What This Feature Does

1. **Removes auto-save** — Editing a cell updates local state only (no server call on blur)
2. **Adds a Save button** — A toolbar below the PayPeriodSelector with "Save" and "Discard Changes" buttons
3. **Tracks dirty state** — Cells that differ from their last-saved value get a visual indicator
4. **Enforces DCAA reason on edits** — When Save is clicked and any dirty cell has a prior saved value (revision ≥ 1), a modal appears requiring a reason code and comment before the batch save completes
5. **Batch saves** — All dirty cells are saved in a single server action call

### User Flow

```
User opens timesheet → sees previously-saved hours (or zeros)
  → Edits a cell → value updates locally, cell shows dirty indicator
  → Edits more cells → dirty count shown on Save button
  → Clicks "Save"
    → System checks: do any dirty cells have prior saved data?
      → YES → DCAA Reason Modal appears
        → User selects reason code + types comment
        → Clicks "Confirm Save"
        → All dirty cells batch-saved with the reason
      → NO (all are first-time entries) → batch-saved immediately (no reason needed)
  → Success notification appears
  → Dirty indicators clear, savedEntries snapshot updates
```

### DCAA Compliance Rules

| Scenario | Reason Required? | Behavior |
|---|---|---|
| Cell has never been saved (revision 0) | ❌ No | First save — `revision_number=1`, no `changeReasonCode` |
| Cell was previously saved (revision ≥ 1) and user changes the value | ✅ Yes | New revision — user MUST provide `changeReasonCode` + comment |
| Cell was previously saved but user didn't change the value | N/A | Cell is not dirty, not included in save batch |
| Cell changed from 0 to a value (never saved before) | ❌ No | This is a first-time entry, not an edit |

---

## 2. File Topology

```
Files to CREATE:
├── src/components/timesheet/TimesheetToolbar.tsx     ← Save/Discard buttons + dirty count
├── src/components/timesheet/ReasonModal.tsx          ← DCAA edit reason modal
├── src/lib/reason-codes.ts                          ← Extract REASON_CODES from mock data

Files to MODIFY:
├── src/types/timesheet.ts                           ← Add savedEntries, dirty tracking types, new actions
├── src/components/timesheet/TimesheetContext.tsx     ← Add dirty tracking, batch save, remove auto-save
├── src/components/timesheet/cells/HourCell.tsx       ← Remove saveHours on blur; add dirty indicator
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← Add TimesheetToolbar to layout
├── src/components/timesheet/DailyNoteModal.tsx       ← Import REASON_CODES from new location
├── src/server/actions/timesheet.ts                  ← Add saveTimesheetBatch() action

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/BiWeeklyTable.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ChargeCodeCell.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ColumnHeaderDate.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/*                            ← ❌ DO NOT MODIFY
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/page.tsx                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** read documentation files or search for library docs.
> - **DO NOT** modify any files listed in the "NOT TOUCHED" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use `@tabler/icons-react` for all icons.
> - **DCAA Rule:** Never UPDATE or DELETE timesheet entry rows. Always INSERT new revisions.
> - Follow the step order exactly. Each step builds on the previous one.

---

### Step 0: Extract Reason Codes

**0a.** Create `src/lib/reason-codes.ts`:

```typescript
export const REASON_CODES: { value: string; label: string }[] = [
  { value: 'CORRECTION', label: 'Correction of Error' },
  { value: 'LATE_ENTRY', label: 'Late Entry (>24hrs)' },
  { value: 'TRANSFER', label: 'Transfer Between Accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-Directed Change' },
  { value: 'OTHER', label: 'Other (explain in comments)' },
];
```

---

### Step 1: Update Types

**1a.** Modify `src/types/timesheet.ts` — add dirty tracking and new actions:

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

// Tracks which cells have been previously saved (for DCAA reason enforcement)
export interface SavedCellInfo {
  revisionNumber: number; // 0 = never saved, 1+ = has prior save
}

export interface TimesheetState {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];           // current working values (includes unsaved edits)
  savedEntries: TimesheetEntry[];      // last-saved snapshot (from DB)
  savedCellRevisions: Record<string, number>; // key="clinId-dayIndex", value=max revision number
  notes: Record<string, NoteData>;     // key = "chargeCodeId-dayIndex"
  periodStart: Date;
  activeNoteCell: { chargeCodeId: string; dayIndex: number } | null;
  userId: string;
  isSaving: boolean;
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'NAVIGATE_PERIOD'; direction: 'prev' | 'next' }
  | { type: 'SET_PERIOD_DATA'; periodStart: Date; entries: TimesheetEntry[]; revisions: Record<string, number> }
  | { type: 'SET_SAVING'; isSaving: boolean }
  | { type: 'MARK_SAVED'; entries: TimesheetEntry[]; revisions: Record<string, number> }
  | { type: 'DISCARD_CHANGES' };

// Represents a single dirty cell to save
export interface DirtyCell {
  chargeCodeId: string; // clinId
  dayIndex: number;
  hours: number;
  isEdit: boolean; // true if this cell has a prior saved value (revision > 0)
}

// Props passed from server to client
export interface TimesheetPageData {
  userId: string;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStart: Date;
  revisions?: Record<string, number>; // optional: revision map from server
}
```

**Key changes:**
- Added `savedEntries` — snapshot of last-saved values for dirty comparison
- Added `savedCellRevisions` — tracks which cells have been saved before (key=`clinId-dayIndex`, value=revision number)
- Added `MARK_SAVED` action — updates both `savedEntries` and `savedCellRevisions` after successful save
- Added `DISCARD_CHANGES` action — reverts `entries` to `savedEntries`
- Added `DirtyCell` interface for batch save payloads
- Updated `SET_PERIOD_DATA` to include `revisions` parameter
- Added optional `revisions` to `TimesheetPageData`

---

### Step 2: Update Server Actions

**2a.** Modify `src/server/actions/timesheet.ts` — add batch save and revision tracking:

Add these two new functions to the END of the file (do not modify existing functions):

```typescript
/**
 * Get revision numbers for all cells in a period.
 * Returns a map of "clinId-dayIndex" → maxRevisionNumber.
 */
export async function getRevisionMap(
  userId: string,
  periodStart: Date,
  numDays: number
): Promise<Record<string, number>> {
  const start = dayjs(periodStart);
  const endDate = start.add(numDays, 'day');

  const rows = await db
    .select({
      clinId: timesheetEntries.clinId,
      entryDate: timesheetEntries.entryDate,
      maxRevision: sql<number>`MAX(${timesheetEntries.revisionNumber})`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        gte(timesheetEntries.entryDate, start.toDate()),
        lt(timesheetEntries.entryDate, endDate.toDate()),
      )
    )
    .groupBy(timesheetEntries.clinId, timesheetEntries.entryDate);

  const revisionMap: Record<string, number> = {};
  for (const row of rows) {
    const dayIndex = dayjs(row.entryDate).diff(start, 'day');
    const key = `${row.clinId}-${dayIndex}`;
    revisionMap[key] = row.maxRevision;
  }
  return revisionMap;
}

/**
 * Batch save multiple timesheet entries in a single call.
 * All entries in the batch share the same changeReasonCode and comment
 * (if they are edits to previously-saved cells).
 */
export async function saveTimesheetBatch(data: {
  userId: string;
  periodStart: Date;
  cells: Array<{
    clinId: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
  }>;
  changeReasonCode?: string;
  comment?: string;
}): Promise<Record<string, number>> {
  const start = dayjs(data.periodStart);
  const newRevisions: Record<string, number> = {};

  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day').toDate();

    // Get current max revision
    const existing = await db
      .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
      .from(timesheetEntries)
      .where(
        and(
          eq(timesheetEntries.userId, data.userId),
          eq(timesheetEntries.clinId, cell.clinId),
          eq(timesheetEntries.entryDate, entryDate),
        )
      );

    const nextRevision = (existing[0]?.maxRevision ?? 0) + 1;

    await db.insert(timesheetEntries).values({
      userId: data.userId,
      clinId: cell.clinId,
      entryDate,
      hours: cell.hours.toString(),
      revisionNumber: nextRevision,
      changeReasonCode: cell.isEdit ? (data.changeReasonCode ?? undefined) : undefined,
      comment: cell.isEdit ? (data.comment ?? undefined) : undefined,
      createdBy: data.userId,
    });

    const key = `${cell.clinId}-${cell.dayIndex}`;
    newRevisions[key] = nextRevision;
  }

  return newRevisions;
}
```

---

### Step 3: Update TimesheetContext

**3a.** Modify `src/components/timesheet/TimesheetContext.tsx`:

Replace the entire file with:

```tsx
'use client';

import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import type { TimesheetState, TimesheetAction, TimesheetPageData, DirtyCell } from '@/types/timesheet';
import { navigatePeriod, getNumDaysInPeriod } from '@/lib/date-utils';
import { getTimesheetEntries, saveTimesheetBatch, getRevisionMap } from '@/server/actions/timesheet';

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
      const emptyEntries = state.chargeCodes.map((cc) => ({
        chargeCodeId: cc.id,
        hours: [] as number[],
      }));
      return {
        ...state,
        periodStart: newPeriodStart,
        entries: emptyEntries,
        savedEntries: emptyEntries,
        savedCellRevisions: {},
        notes: {},
      };
    }

    case 'SET_PERIOD_DATA': {
      return {
        ...state,
        periodStart: action.periodStart,
        entries: action.entries,
        savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
        savedCellRevisions: action.revisions,
      };
    }

    case 'SET_SAVING': {
      return { ...state, isSaving: action.isSaving };
    }

    case 'MARK_SAVED': {
      return {
        ...state,
        savedEntries: action.entries.map((e) => ({ ...e, hours: [...e.hours] })),
        savedCellRevisions: { ...state.savedCellRevisions, ...action.revisions },
        isSaving: false,
      };
    }

    case 'DISCARD_CHANGES': {
      return {
        ...state,
        entries: state.savedEntries.map((e) => ({ ...e, hours: [...e.hours] })),
      };
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
  dirtyCells: DirtyCell[];
  hasEdits: boolean;       // true if any dirty cell has a prior revision (isEdit=true)
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<void>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  discardChanges: () => void;
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
    savedEntries: initialData.entries.map((e) => ({ ...e, hours: [...e.hours] })),
    savedCellRevisions: initialData.revisions ?? {},
    notes: {},
    periodStart: new Date(initialData.periodStart),
    activeNoteCell: null,
    userId: initialData.userId,
    isSaving: false,
  };

  const [state, dispatch] = useReducer(timesheetReducer, initialState);

  // Compute dirty cells by comparing entries to savedEntries
  const dirtyCells = useMemo<DirtyCell[]>(() => {
    const dirty: DirtyCell[] = [];
    for (const entry of state.entries) {
      const savedEntry = state.savedEntries.find((se) => se.chargeCodeId === entry.chargeCodeId);
      if (!savedEntry) continue;
      for (let i = 0; i < entry.hours.length; i++) {
        const current = entry.hours[i] ?? 0;
        const saved = savedEntry.hours[i] ?? 0;
        if (current !== saved) {
          const key = `${entry.chargeCodeId}-${i}`;
          const revisionNumber = state.savedCellRevisions[key] ?? 0;
          dirty.push({
            chargeCodeId: entry.chargeCodeId,
            dayIndex: i,
            hours: current,
            isEdit: revisionNumber > 0,
          });
        }
      }
    }
    return dirty;
  }, [state.entries, state.savedEntries, state.savedCellRevisions]);

  // Are any dirty cells edits to previously-saved data?
  const hasEdits = useMemo(() => dirtyCells.some((c) => c.isEdit), [dirtyCells]);

  const saveAll = useCallback(
    async (changeReasonCode?: string, comment?: string) => {
      if (dirtyCells.length === 0) return;

      try {
        dispatch({ type: 'SET_SAVING', isSaving: true });

        const newRevisions = await saveTimesheetBatch({
          userId: state.userId,
          periodStart: state.periodStart,
          cells: dirtyCells.map((c) => ({
            clinId: c.chargeCodeId,
            dayIndex: c.dayIndex,
            hours: c.hours,
            isEdit: c.isEdit,
          })),
          changeReasonCode,
          comment,
        });

        // After successful save, update saved snapshot
        dispatch({
          type: 'MARK_SAVED',
          entries: state.entries,
          revisions: newRevisions,
        });
      } catch (error) {
        console.error('Failed to save timesheet:', error);
        dispatch({ type: 'SET_SAVING', isSaving: false });
        throw error; // Re-throw so the UI can show error notification
      }
    },
    [dirtyCells, state.userId, state.periodStart, state.entries]
  );

  const loadPeriod = useCallback(
    async (direction: 'prev' | 'next') => {
      dispatch({ type: 'NAVIGATE_PERIOD', direction });

      const newPeriodStart = navigatePeriod(state.periodStart, direction);
      const numDays = getNumDaysInPeriod(newPeriodStart);

      try {
        const entries = await getTimesheetEntries(state.userId, newPeriodStart, state.chargeCodes);
        const revisions = await getRevisionMap(state.userId, newPeriodStart, numDays);
        dispatch({ type: 'SET_PERIOD_DATA', periodStart: newPeriodStart, entries, revisions });
      } catch (error) {
        console.error('Failed to load period data:', error);
        const emptyEntries = state.chargeCodes.map((cc) => ({
          chargeCodeId: cc.id,
          hours: [] as number[],
        }));
        dispatch({ type: 'SET_PERIOD_DATA', periodStart: newPeriodStart, entries: emptyEntries, revisions: {} });
      }
    },
    [state.periodStart, state.userId, state.chargeCodes]
  );

  const discardChanges = useCallback(() => {
    dispatch({ type: 'DISCARD_CHANGES' });
  }, []);

  return (
    <TimesheetContext.Provider
      value={{ state, dispatch, dirtyCells, hasEdits, saveAll, loadPeriod, discardChanges }}
    >
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
- Removed `saveHours` (auto-save per cell) — replaced with `saveAll` (batch save on button click)
- Added `dirtyCells` computed via `useMemo` — compares `entries` to `savedEntries`
- Added `hasEdits` — true if any dirty cell has a prior revision
- Added `discardChanges` — reverts entries to savedEntries
- Context value now exposes `dirtyCells`, `hasEdits`, `saveAll`, `discardChanges`
- `SET_PERIOD_DATA` now includes `revisions` and sets `savedEntries`
- `MARK_SAVED` updates both `savedEntries` and `savedCellRevisions`

---

### Step 4: Update HourCell — Remove Auto-Save, Add Dirty Indicator

**4a.** Modify `src/components/timesheet/cells/HourCell.tsx`:

Replace the entire file with:

```tsx
'use client';

import { useState } from 'react';
import { ActionIcon, NumberInput, Text } from '@mantine/core';
import { IconNote } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';

interface HourCellProps {
  chargeCodeId: string;
  dayIndex: number;
}

export function HourCell({ chargeCodeId, dayIndex }: HourCellProps) {
  const { state, dispatch } = useTimesheet();
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [localValue, setLocalValue] = useState<number | string>(0);

  const entry = state.entries.find((e) => e.chargeCodeId === chargeCodeId);
  const value = entry ? entry.hours[dayIndex] : 0;

  // Check if this cell is dirty (unsaved changes)
  const savedEntry = state.savedEntries.find((e) => e.chargeCodeId === chargeCodeId);
  const savedValue = savedEntry ? (savedEntry.hours[dayIndex] ?? 0) : 0;
  const isDirty = value !== savedValue;

  const noteKey = `${chargeCodeId}-${dayIndex}`;
  const hasNote = Boolean(state.notes[noteKey]);

  const handleClick = () => {
    setLocalValue(value);
    setIsEditing(true);
  };

  const handleBlur = () => {
    const numVal = typeof localValue === 'number' ? localValue : parseFloat(String(localValue)) || 0;
    dispatch({ type: 'SET_HOURS', chargeCodeId, dayIndex, value: numVal });
    setIsEditing(false);
    // NO auto-save — user must click the Save button
  };

  const handleNoteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'OPEN_NOTE_MODAL', chargeCodeId, dayIndex });
  };

  const showNoteIcon = isHovered || hasNote;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        minHeight: 32,
        backgroundColor: isDirty
          ? 'light-dark(var(--mantine-color-yellow-0), var(--mantine-color-yellow-9))'
          : undefined,
        borderRadius: isDirty ? 2 : undefined,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
    >
      {isEditing ? (
        <NumberInput
          value={localValue}
          min={0}
          max={24}
          step={0.25}
          decimalScale={2}
          fixedDecimalScale
          hideControls
          variant="unstyled"
          style={{ width: 60, textAlign: 'center' }}
          styles={{ input: { textAlign: 'center', padding: 0, color: 'var(--mantine-color-text)' } }}
          autoFocus
          onBlur={handleBlur}
          onChange={(val) => setLocalValue(val)}
        />
      ) : (
        <Text ta="center" size="sm" style={{ lineHeight: '32px' }}>
          {value === 0 ? '—' : value.toFixed(2)}
        </Text>
      )}

      {showNoteIcon && (
        <ActionIcon
          variant="subtle"
          size="xs"
          color={hasNote ? 'blue' : 'gray'}
          style={{ position: 'absolute', top: 0, right: 0 }}
          onClick={handleNoteClick}
          aria-label="Add note"
        >
          <IconNote size={12} />
        </ActionIcon>
      )}
    </div>
  );
}
```

**Key changes:**
- Removed `saveHours` from the `useTimesheet()` destructure
- Removed `saveHours(chargeCodeId, dayIndex, numVal)` call from `handleBlur`
- Added `isDirty` check comparing current value to saved value
- Added yellow background highlight for dirty cells using Mantine CSS variables

---

### Step 5: Create the Timesheet Toolbar

**5a.** Create `src/components/timesheet/TimesheetToolbar.tsx`:

```tsx
'use client';

import { Button, Group, Badge, Text } from '@mantine/core';
import { IconDeviceFloppy, IconArrowBack } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { useState } from 'react';
import { ReasonModal } from '@/components/timesheet/ReasonModal';

export function TimesheetToolbar() {
  const { dirtyCells, hasEdits, saveAll, discardChanges, state } = useTimesheet();
  const [reasonModalOpen, setReasonModalOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirtyCount = dirtyCells.length;

  async function handleSave() {
    if (dirtyCount === 0) return;

    // If any dirty cells are edits to previously-saved data, require a reason
    if (hasEdits) {
      setReasonModalOpen(true);
      return;
    }

    // No edits to prior data — save directly (first-time entries)
    try {
      setSaveError(null);
      await saveAll();
    } catch (error) {
      setSaveError('Failed to save. Please try again.');
    }
  }

  async function handleReasonConfirm(reasonCode: string, comment: string) {
    try {
      setSaveError(null);
      await saveAll(reasonCode, comment);
      setReasonModalOpen(false);
    } catch (error) {
      setSaveError('Failed to save. Please try again.');
    }
  }

  function handleDiscard() {
    discardChanges();
    setSaveError(null);
  }

  return (
    <>
      <Group justify="flex-end" mb="sm" gap="sm">
        {saveError && (
          <Text c="red" size="sm">
            {saveError}
          </Text>
        )}
        {dirtyCount > 0 && (
          <Badge variant="light" color="yellow" size="lg">
            {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
          </Badge>
        )}
        <Button
          variant="default"
          leftSection={<IconArrowBack size={16} />}
          onClick={handleDiscard}
          disabled={dirtyCount === 0}
        >
          Discard Changes
        </Button>
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          disabled={dirtyCount === 0}
          loading={state.isSaving}
        >
          Save
        </Button>
      </Group>

      <ReasonModal
        opened={reasonModalOpen}
        onClose={() => setReasonModalOpen(false)}
        onConfirm={handleReasonConfirm}
        editedCells={dirtyCells.filter((c) => c.isEdit)}
        chargeCodes={state.chargeCodes}
        periodStart={state.periodStart}
        isSaving={state.isSaving}
      />
    </>
  );
}
```

---

### Step 6: Create the DCAA Reason Modal

**6a.** Create `src/components/timesheet/ReasonModal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Modal, Select, Textarea, Button, Group, Stack, Text, Table, Badge } from '@mantine/core';
import dayjs from 'dayjs';
import { REASON_CODES } from '@/lib/reason-codes';
import type { DirtyCell, ChargeCode } from '@/types/timesheet';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (reasonCode: string, comment: string) => Promise<void>;
  editedCells: DirtyCell[];
  chargeCodes: ChargeCode[];
  periodStart: Date;
  isSaving: boolean;
};

export function ReasonModal({
  opened,
  onClose,
  onConfirm,
  editedCells,
  chargeCodes,
  periodStart,
  isSaving,
}: Props) {
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const canSubmit = reasonCode !== null && comment.trim().length > 0;

  function handleClose() {
    if (!isSaving) {
      setReasonCode(null);
      setComment('');
      onClose();
    }
  }

  async function handleConfirm() {
    if (!canSubmit) return;
    await onConfirm(reasonCode!, comment.trim());
    setReasonCode(null);
    setComment('');
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="DCAA Compliance — Reason for Edit"
      size="lg"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!isSaving}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          You are modifying previously-saved timesheet data. Per DCAA requirements,
          you must provide a reason for this change. The reason will be recorded
          in the audit trail.
        </Text>

        {/* Show which cells are being edited */}
        <Text fw={600} size="sm">Affected Entries:</Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              <Table.Th>Date</Table.Th>
              <Table.Th>New Hours</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {editedCells.map((cell, idx) => {
              const cc = chargeCodes.find((c) => c.id === cell.chargeCodeId);
              const date = dayjs(periodStart).add(cell.dayIndex, 'day');
              return (
                <Table.Tr key={idx}>
                  <Table.Td>{cc?.clin ?? cell.chargeCodeId} — {cc?.projectName ?? ''}</Table.Td>
                  <Table.Td>{date.format('MMM D, YYYY')}</Table.Td>
                  <Table.Td>
                    <Badge color="yellow" variant="light">{cell.hours.toFixed(2)}</Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>

        <Select
          label="Reason for Change"
          placeholder="Select a reason code..."
          data={REASON_CODES}
          value={reasonCode}
          onChange={setReasonCode}
          required
          withAsterisk
        />

        <Textarea
          label="Comments"
          placeholder="Describe the reason for this correction..."
          minRows={3}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          required
          withAsterisk
        />

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canSubmit}
            loading={isSaving}
            color="blue"
          >
            Confirm Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
```

**Key details:**
- Shows a table of the specific cells being edited (charge code, date, new hours)
- Requires both a reason code (Select) and a comment (Textarea)
- Cannot be dismissed while saving (closeOnClickOutside=false)
- Both fields are required — Confirm button is disabled until both are filled

---

### Step 7: Update BiWeeklyTimesheetClient Layout

**7a.** Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx` — add the TimesheetToolbar:

Replace the entire file with:

```tsx
'use client';

import { Container, Paper } from '@mantine/core';
import { TimesheetProvider } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';

function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <TimesheetToolbar />
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

### Step 8: Update DailyNoteModal Import

**8a.** Modify `src/components/timesheet/DailyNoteModal.tsx` — change the REASON_CODES import:

Change this line:
```typescript
import { REASON_CODES } from '@/data/mock-timesheet';
```

To:
```typescript
import { REASON_CODES } from '@/lib/reason-codes';
```

No other changes to this file.

---

### Step 9: Update Timesheet Page to Pass Revisions

**9a.** Modify `src/app/(app)/timesheet/page.tsx` — add revision map to page data:

Replace the entire file with:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetEntries, getRevisionMap } from '@/server/actions/timesheet';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';
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
  const numDays = getNumDaysInPeriod(periodStart);
  const chargeCodes = await getChargeCodesForUser(userId);
  const [entries, revisions] = await Promise.all([
    getTimesheetEntries(userId, periodStart, chargeCodes),
    getRevisionMap(userId, periodStart, numDays),
  ]);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries,
    periodStart,
    revisions,
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Dev Server Checks

```bash
npm run dev
```

| Check | Expected Result |
|---|---|
| **Timesheet loads** | Shows charge codes and hours from DB; Save button is disabled (no dirty cells) |
| **Edit a cell** | Cell background turns yellow; badge shows "1 unsaved change"; Save button enables |
| **Edit multiple cells** | Badge count increases; all dirty cells have yellow background |
| **Click Discard Changes** | All cells revert to their saved values; yellow indicators disappear |
| **Click Save (first-time entries only)** | Saves immediately; yellow indicators clear; success |
| **Click Save (editing previously-saved cells)** | DCAA Reason Modal appears with list of affected cells |
| **Modal: submit without reason** | Confirm button is disabled |
| **Modal: select reason + type comment** | Confirm button enables |
| **Modal: click Confirm Save** | All dirty cells saved with reason; modal closes; yellow indicators clear |
| **Refresh page after save** | Previously saved values persist; no dirty indicators |
| **Edit saved cell again** | Cell turns yellow; clicking Save triggers Reason Modal again |
| **Navigate to different period** | Dirty indicators clear; new period data loads |

### 4c. Database Verification

After saving some entries, then editing and re-saving with a reason:

```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c "
SELECT te.entry_date, cl.clin_number, te.hours, te.revision_number, te.change_reason_code, te.comment
FROM timesheet_entries te
JOIN clins cl ON te.clin_id = cl.id
ORDER BY te.entry_date, cl.clin_number, te.revision_number;
"
```

Expected: Multiple rows per (clin, date) pair with incrementing revision_number. Revision 1 has NULL reason. Revision 2+ has the user-provided reason code and comment.

### 4d. Guardrail Verification

```bash
git diff --name-only
```

Must **NOT** include:
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/cells/ChargeCodeCell.tsx`
- `src/components/timesheet/cells/ColumnHeaderDate.tsx`
- `src/components/timesheet/cells/TotalHoursCell.tsx`
- `src/components/shell/*`
- `src/app/(app)/admin/*`
- `src/db/schema.ts`
- `src/auth.ts`
- `src/middleware.ts`

### 4e. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `saveHours is not a function` | Old context interface | Verify `TimesheetContextValue` no longer has `saveHours`, now has `saveAll` |
| `Property 'savedEntries' does not exist` | Types not updated | Verify `TimesheetState` has `savedEntries` and `savedCellRevisions` |
| `Cannot find module '@/lib/reason-codes'` | File not created | Create `src/lib/reason-codes.ts` |
| `getRevisionMap is not exported` | Server action not added | Add function to `src/server/actions/timesheet.ts` |
| Yellow background not showing | CSS variable mismatch | Use `light-dark()` function for dark mode compatibility |
| Dirty count wrong | Comparison logic issue | Ensure `savedEntries` is deep-copied (spread array) in MARK_SAVED |
| Modal won't close while saving | Intentional | `closeOnClickOutside={false}` prevents dismissal during save |
| `revisions` undefined in initial state | Page not passing revisions | Verify `page.tsx` calls `getRevisionMap` and includes in `pageData` |
