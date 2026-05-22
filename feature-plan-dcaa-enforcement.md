# Blueprint: DCAA Daily Compliance Enforcement & Submit Controls

> **This ticket contains FOUR phases. Complete each phase fully before starting the next.**

---

## Problem Statement

Two critical DCAA compliance gaps exist in the current timesheet system, plus two additional hardening requirements identified by the Lead Systems Architect:

1. **Late Entry Reason Gap (DCAA Violation):** When a user enters hours for a past date as a *first-time* entry (not an edit), no reason code is required. Per FAR 31.201-1 and CAS 418, late time entries (recorded after the work day has passed) must be documented with a reason code. Currently, the `ReasonModal` only triggers for cells with `revision > 0` (edits to previously-saved data), not for first-time entries on past dates.

2. **Premature Submit:** The Submit button is available at any time during the pay period as long as there are no unsaved changes and entries exist. Employees should only be able to submit on or after the **last day** of the pay period to ensure complete daily accounting per CAS 418 total time requirements.

3. **No Visual Late-Entry Indicators:** Users have no visual cue that entering hours on a past date will require a reason code, leading to a poor UX when the modal appears unexpectedly.

4. **Future-Date Entry Allowed (DCAA Violation):** Users can currently enter hours for future dates. Per FAR 31.201-1, only *actual* costs (time already worked) may be recorded — prospective time entry is not compliant.

### DCAA Compliance Mapping

| Requirement | FAR/CAS Reference | Phase |
|---|---|---|
| Late entries must document reason | FAR 31.201-1, CAS 418 | A |
| Time submitted after period completion | CAS 418 total time accounting | B |
| Visual audit indicators for compliance | Best practice for DCAA audit trail | C |
| No prospective time entry | FAR 31.201-1 actual costs only | D |

---

## File Topology

```
Files to MODIFY:
├── src/types/timesheet.ts                              ← Add isLateEntry to DirtyCell
├── src/lib/date-utils.ts                               ← Add getPeriodEndDate() helper
├── src/components/timesheet/TimesheetContext.tsx        ← Late-entry detection in dirtyCells, expose hasLateEntries
├── src/components/timesheet/TimesheetToolbar.tsx        ← Late-entry save flow, submit date restriction
├── src/components/timesheet/ReasonModal.tsx             ← Handle late entries + edits, dynamic title/description
├── src/components/timesheet/SubmitModal.tsx             ← Show earliest submit date info
├── src/components/timesheet/cells/HourCell.tsx          ← Visual late-entry indicator, future-date lock
├── src/components/timesheet/cells/ColumnHeaderDate.tsx  ← Past-date visual indicator
├── src/server/actions/timesheet.ts                     ← Apply reason for late entries, reject future dates
├── src/server/actions/periods.ts                       ← Server-side submit date validation

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                    ← ❌ DO NOT MODIFY
├── src/auth.ts                                         ← ❌ DO NOT MODIFY
├── src/middleware.ts                                   ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx           ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx          ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/ChargeCodeCell.tsx    ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/TotalHoursCell.tsx    ← ❌ DO NOT MODIFY
├── src/components/shell/*                              ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/*                               ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/clins.ts                         ← ❌ DO NOT MODIFY
├── src/server/actions/assignments.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                         ← ❌ DO NOT MODIFY
├── src/lib/reason-codes.ts                             ← ❌ DO NOT MODIFY (LATE_ENTRY already defined)
```

---

## Phase A: Late-Entry Reason Enforcement

### Problem

When a user enters hours on a date that has already passed (e.g., today is May 22 and they enter hours for May 20), and the cell has never been saved before (revision = 0), the system saves silently without requiring a reason code. This violates DCAA daily time entry requirements.

The `LATE_ENTRY` reason code already exists in `src/lib/reason-codes.ts`. The infrastructure is there — it just isn't triggered for first-time entries on past dates.

### Execution Steps

> **⚠️ GUARDRAILS:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in "NOT TOUCHED".
> - Use **Mantine v9** imports only.
> - Install the `dayjs` plugins `isSameOrAfter` and `isSameOrBefore` if not already available — use `dayjs.extend()` locally where needed.

---

**A1.** Modify `src/types/timesheet.ts` — add `isLateEntry` boolean to the `DirtyCell` interface.

Find the existing `DirtyCell` interface:

```typescript
export interface DirtyCell {
  chargeCodeId: string; // clinId
  dayIndex: number;
  hours: number;
  isEdit: boolean; // true if this cell has a prior saved value (revision > 0)
}
```

Replace with:

```typescript
export interface DirtyCell {
  chargeCodeId: string; // clinId
  dayIndex: number;
  hours: number;
  isEdit: boolean;      // true if this cell has a prior saved value (revision > 0)
  isLateEntry: boolean; // true if this is a first-time entry on a past date (revision = 0 AND date < today)
}
```

---

**A2.** Modify `src/lib/date-utils.ts` — add a `getPeriodEndDate()` helper function at the END of the file. Do NOT modify existing functions:

```typescript
/**
 * Returns the last date of a semi-monthly pay period (inclusive).
 * Period A (starts 1st): ends on 15th
 * Period B (starts 16th): ends on last day of month
 */
export function getPeriodEndDate(periodStart: Date): Date {
  const numDays = getNumDaysInPeriod(periodStart);
  return dayjs(periodStart).add(numDays - 1, 'day').startOf('day').toDate();
}
```

---

**A3.** Modify `src/components/timesheet/TimesheetContext.tsx` — update the `dirtyCells` computation to detect late entries, and expose `hasLateEntries`.

**A3a.** In the `dirtyCells` `useMemo` block, update the computation. Find the current code that builds dirty cells:

```typescript
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
```

Replace with:

```typescript
  const dirtyCells = useMemo<DirtyCell[]>(() => {
    const dirty: DirtyCell[] = [];
    const today = dayjs().startOf('day');
    for (const entry of state.entries) {
      const savedEntry = state.savedEntries.find((se) => se.chargeCodeId === entry.chargeCodeId);
      if (!savedEntry) continue;
      for (let i = 0; i < entry.hours.length; i++) {
        const current = entry.hours[i] ?? 0;
        const saved = savedEntry.hours[i] ?? 0;
        if (current !== saved) {
          const key = `${entry.chargeCodeId}-${i}`;
          const revisionNumber = state.savedCellRevisions[key] ?? 0;
          const cellDate = dayjs(state.periodStart).add(i, 'day').startOf('day');
          const isEdit = revisionNumber > 0;
          // Late entry: first-time entry (no prior revision) on a date that has already passed
          const isLateEntry = !isEdit && saved === 0 && current > 0 && cellDate.isBefore(today, 'day');
          dirty.push({
            chargeCodeId: entry.chargeCodeId,
            dayIndex: i,
            hours: current,
            isEdit,
            isLateEntry,
          });
        }
      }
    }
    return dirty;
  }, [state.entries, state.savedEntries, state.savedCellRevisions, state.periodStart]);
```

**Key change:** Added `isLateEntry` detection — checks that `revisionNumber === 0` (never saved), `saved === 0` (was empty), `current > 0` (adding hours), and `cellDate < today`.

**A3b.** Add a `hasLateEntries` computed value alongside the existing `hasEdits`:

Find the line:

```typescript
  const hasEdits = useMemo(() => dirtyCells.some((c) => c.isEdit), [dirtyCells]);
```

Add AFTER it:

```typescript
  const hasLateEntries = useMemo(() => dirtyCells.some((c) => c.isLateEntry), [dirtyCells]);
```

**A3c.** Update the `TimesheetContextValue` interface to expose `hasLateEntries`:

Find:

```typescript
interface TimesheetContextValue {
  state: TimesheetState;
  dispatch: React.Dispatch<TimesheetAction>;
  dirtyCells: DirtyCell[];
  hasEdits: boolean;       // true if any dirty cell has a prior revision (isEdit=true)
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<void>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  discardChanges: () => void;
  submitTimesheet: (comment?: string) => Promise<void>;
}
```

Replace with:

```typescript
interface TimesheetContextValue {
  state: TimesheetState;
  dispatch: React.Dispatch<TimesheetAction>;
  dirtyCells: DirtyCell[];
  hasEdits: boolean;        // true if any dirty cell has a prior revision (isEdit=true)
  hasLateEntries: boolean;  // true if any dirty cell is a late first-time entry
  saveAll: (changeReasonCode?: string, comment?: string) => Promise<void>;
  loadPeriod: (direction: 'prev' | 'next') => Promise<void>;
  discardChanges: () => void;
  submitTimesheet: (comment?: string) => Promise<void>;
}
```

**A3d.** Update the `saveAll` function to apply reason codes for late entries in addition to edits.

Find the `saveAll` `useCallback`. Inside the `cells` mapping, find:

```typescript
          cells: dirtyCells.map((c) => ({
            clinId: c.chargeCodeId,
            dayIndex: c.dayIndex,
            hours: c.hours,
            isEdit: c.isEdit,
          })),
```

Replace with:

```typescript
          cells: dirtyCells.map((c) => ({
            clinId: c.chargeCodeId,
            dayIndex: c.dayIndex,
            hours: c.hours,
            isEdit: c.isEdit,
            isLateEntry: c.isLateEntry,
          })),
```

**A3e.** Update the Provider value to include `hasLateEntries`:

Find:

```typescript
      value={{ state, dispatch, dirtyCells, hasEdits, saveAll, loadPeriod, discardChanges, submitTimesheet }}
```

Replace with:

```typescript
      value={{ state, dispatch, dirtyCells, hasEdits, hasLateEntries, saveAll, loadPeriod, discardChanges, submitTimesheet }}
```

---

**A4.** Modify `src/components/timesheet/TimesheetToolbar.tsx` — update save flow to trigger ReasonModal for late entries.

**A4a.** Update the destructured values from `useTimesheet()`:

Find:

```typescript
  const { dirtyCells, hasEdits, saveAll, discardChanges, submitTimesheet, state } = useTimesheet();
```

Replace with:

```typescript
  const { dirtyCells, hasEdits, hasLateEntries, saveAll, discardChanges, submitTimesheet, state } = useTimesheet();
```

**A4b.** Update the `handleSave()` function to also check for late entries:

Find:

```typescript
  async function handleSave() {
    if (dirtyCount === 0) return;

    if (hasEdits) {
      setReasonModalOpen(true);
      return;
    }
```

Replace with:

```typescript
  async function handleSave() {
    if (dirtyCount === 0) return;

    if (hasEdits || hasLateEntries) {
      setReasonModalOpen(true);
      return;
    }
```

**A4c.** Update the `ReasonModal` props to pass both edit AND late-entry cells:

Find:

```typescript
      <ReasonModal
        opened={reasonModalOpen}
        onClose={() => setReasonModalOpen(false)}
        onConfirm={handleReasonConfirm}
        editedCells={dirtyCells.filter((c) => c.isEdit)}
        chargeCodes={state.chargeCodes}
        periodStart={state.periodStart}
        isSaving={state.isSaving}
      />
```

Replace with:

```typescript
      <ReasonModal
        opened={reasonModalOpen}
        onClose={() => setReasonModalOpen(false)}
        onConfirm={handleReasonConfirm}
        editedCells={dirtyCells.filter((c) => c.isEdit)}
        lateEntryCells={dirtyCells.filter((c) => c.isLateEntry)}
        chargeCodes={state.chargeCodes}
        periodStart={state.periodStart}
        isSaving={state.isSaving}
      />
```

---

**A5.** Modify `src/components/timesheet/ReasonModal.tsx` — handle late entries alongside edits. Show both sections, default reason to `LATE_ENTRY` when only late entries are present.

Replace the **entire file** with:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Modal, Select, Textarea, Button, Group, Stack, Text, Table, Badge } from '@mantine/core';
import dayjs from 'dayjs';
import { REASON_CODES } from '@/lib/reason-codes';
import type { DirtyCell, ChargeCode } from '@/types/timesheet';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (reasonCode: string, comment: string) => Promise<void>;
  editedCells: DirtyCell[];
  lateEntryCells: DirtyCell[];
  chargeCodes: ChargeCode[];
  periodStart: Date;
  isSaving: boolean;
};

export function ReasonModal({
  opened,
  onClose,
  onConfirm,
  editedCells,
  lateEntryCells,
  chargeCodes,
  periodStart,
  isSaving,
}: Props) {
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const hasEdits = editedCells.length > 0;
  const hasLateEntries = lateEntryCells.length > 0;
  const onlyLateEntries = hasLateEntries && !hasEdits;

  // Auto-select LATE_ENTRY when only late entries are present
  useEffect(() => {
    if (opened && onlyLateEntries) {
      setReasonCode('LATE_ENTRY');
    }
  }, [opened, onlyLateEntries]);

  const canSubmit = reasonCode !== null && comment.trim().length > 0;

  // Dynamic title based on what types of cells are in the batch
  let modalTitle = 'DCAA Compliance — Reason Required';
  if (onlyLateEntries) {
    modalTitle = 'DCAA Compliance — Late Entry Reason';
  } else if (hasEdits && !hasLateEntries) {
    modalTitle = 'DCAA Compliance — Reason for Edit';
  } else if (hasEdits && hasLateEntries) {
    modalTitle = 'DCAA Compliance — Reason for Changes';
  }

  // Dynamic description
  let description = 'Per DCAA requirements, you must provide a reason for these changes. The reason will be recorded in the audit trail.';
  if (onlyLateEntries) {
    description = 'You are entering time for dates that have already passed. Per DCAA daily time entry requirements (FAR 31.201-1), late entries must be documented with a reason code.';
  } else if (hasEdits && hasLateEntries) {
    description = 'This save includes edits to previously-saved data and late entries for past dates. Per DCAA requirements, you must provide a reason. The reason will be recorded in the audit trail.';
  }

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

  function renderCellTable(cells: DirtyCell[], label: string, badgeColor: string) {
    if (cells.length === 0) return null;
    return (
      <>
        <Text fw={600} size="sm">{label}:</Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              <Table.Th>Date</Table.Th>
              <Table.Th>New Hours</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {cells.map((cell, idx) => {
              const cc = chargeCodes.find((c) => c.id === cell.chargeCodeId);
              const date = dayjs(periodStart).add(cell.dayIndex, 'day');
              return (
                <Table.Tr key={idx}>
                  <Table.Td>{cc?.clin ?? cell.chargeCodeId} — {cc?.projectName ?? ''}</Table.Td>
                  <Table.Td>{date.format('MMM D, YYYY')}</Table.Td>
                  <Table.Td>
                    <Badge color={badgeColor} variant="light">{cell.hours.toFixed(2)}</Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </>
    );
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={modalTitle}
      size="lg"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!isSaving}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {description}
        </Text>

        {/* Late entry cells (orange badges) */}
        {renderCellTable(lateEntryCells, 'Late Entries (past dates)', 'orange')}

        {/* Edited cells (yellow badges) */}
        {renderCellTable(editedCells, 'Edited Entries (corrections)', 'yellow')}

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
          placeholder={onlyLateEntries
            ? 'Explain why time was not entered on the day work was performed...'
            : 'Describe the reason for this correction...'
          }
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

---

**A6.** Modify `src/server/actions/timesheet.ts` — update `saveTimesheetBatch()` to handle late entries.

**A6a.** Update the cell interface in the `saveTimesheetBatch` function signature. Find:

```typescript
  cells: Array<{
    clinId: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
  }>;
```

Replace with:

```typescript
  cells: Array<{
    clinId: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
  }>;
```

**A6b.** Update the INSERT logic inside `saveTimesheetBatch()` to apply reason codes for late entries. Find the line:

```typescript
      changeReasonCode: cell.isEdit ? (data.changeReasonCode ?? undefined) : undefined,
      comment: cell.isEdit ? (data.comment ?? undefined) : undefined,
```

Replace with:

```typescript
      changeReasonCode: (cell.isEdit || cell.isLateEntry) ? (data.changeReasonCode ?? undefined) : undefined,
      comment: (cell.isEdit || cell.isLateEntry) ? (data.comment ?? undefined) : undefined,
```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| Enter hours on **today's date** (first time) | Saves directly — no ReasonModal |
| Enter hours on a **past date** (first time, was 0) | ReasonModal opens with "Late Entry Reason" title |
| ReasonModal auto-selects `LATE_ENTRY` reason | Pre-selected when only late entries |
| Enter hours on a past date that **already has saved hours** | ReasonModal opens with "Reason for Edit" (correction flow) |
| Mixed batch: late entry + edit in same save | Both sections shown in ReasonModal |
| DB audit: check `change_reason_code` column | Late entries have the selected reason code stored |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: Submit Date Restriction

### Problem

The Submit button is currently available as soon as there are no unsaved changes and entries have hours > 0. This allows employees to submit before the pay period is complete, violating CAS 418 total time accounting requirements.

### Execution Steps

---

**B1.** Modify `src/components/timesheet/TimesheetToolbar.tsx` — add date restriction to `canSubmit`.

**B1a.** Add the `isSameOrAfter` dayjs plugin. Add these lines at the TOP of the file (after existing imports):

```typescript
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
dayjs.extend(isSameOrAfter);
```

**B1b.** Update the `canSubmit` calculation. Find:

```typescript
  const canSubmit = isEditable && dirtyCount === 0 && state.entries.some((e) => e.hours.some((h) => h > 0));
```

Replace with:

```typescript
  // Submit only available on or after the last day of the pay period
  const periodEndDate = dayjs(periodStart).add(numDays - 1, 'day');
  const isPeriodComplete = dayjs().isSameOrAfter(periodEndDate, 'day');
  const canSubmit = isEditable && dirtyCount === 0 && isPeriodComplete
    && state.entries.some((e) => e.hours.some((h) => h > 0));
```

**B1c.** Add a tooltip/message explaining why submit is disabled when the period isn't complete. Find the Submit button:

```tsx
              <Button
                color="green"
                leftSection={<IconSend size={16} />}
                onClick={() => setSubmitModalOpen(true)}
                disabled={!canSubmit}
              >
                Submit
              </Button>
```

Replace with:

```tsx
              <div>
                <Button
                  color="green"
                  leftSection={<IconSend size={16} />}
                  onClick={() => setSubmitModalOpen(true)}
                  disabled={!canSubmit}
                  title={!isPeriodComplete ? `Submit available on ${periodEndDate.format('MMM D, YYYY')}` : undefined}
                >
                  Submit
                </Button>
                {!isPeriodComplete && isEditable && dirtyCount === 0 && (
                  <Text size="xs" c="dimmed" ta="center" mt={4}>
                    Available {periodEndDate.format('MMM D')}
                  </Text>
                )}
              </div>
```

---

**B2.** Modify `src/server/actions/periods.ts` — add server-side date validation in `submitPeriod()`.

Add at the TOP of the file (after existing imports):

```typescript
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { getNumDaysInPeriod } from '@/lib/date-utils';

dayjs.extend(isSameOrAfter);
```

Then in the `submitPeriod()` function, add date validation BEFORE any existing logic (after the function signature opening brace):

```typescript
  // Server-side validation: cannot submit before the last day of the period
  const numDays = getNumDaysInPeriod(data.periodStart);
  const periodEndDate = dayjs(data.periodStart).add(numDays - 1, 'day');
  if (!dayjs().isSameOrAfter(periodEndDate, 'day')) {
    throw new Error(`Cannot submit before the last day of the pay period (${periodEndDate.format('MMM D, YYYY')}).`);
  }
```

---

**B3.** Modify `src/components/timesheet/SubmitModal.tsx` — add informational text about the submission timing.

Find the `Alert` component inside the modal:

```tsx
        <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
          <Text size="sm" fw={600}>
            You are submitting your timesheet for {periodLabel}.
          </Text>
          <Text size="sm" mt={4}>
            Once submitted, you will not be able to edit this timesheet unless your supervisor returns it for corrections.
          </Text>
        </Alert>
```

Replace with:

```tsx
        <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
          <Text size="sm" fw={600}>
            You are submitting your timesheet for {periodLabel}.
          </Text>
          <Text size="sm" mt={4}>
            By submitting, you certify that all hours for this pay period have been recorded daily as required by DCAA regulations.
            Once submitted, you will not be able to edit this timesheet unless your supervisor returns it for corrections.
          </Text>
        </Alert>
```

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| View timesheet for a **current** period (not last day yet) | Submit button is disabled |
| Submit button shows helper text | "Available {end date}" shown below the button |
| Hover over disabled Submit button | Tooltip shows "Submit available on {date}" |
| View timesheet for a **past** completed period | Submit button is enabled (if no unsaved changes + has hours) |
| Navigate to last day of current period (if today is the last day) | Submit button is enabled |
| Attempt server-side submit for incomplete period (manual API call) | Error: "Cannot submit before the last day of the pay period" |

**⚠️ Do NOT proceed to Phase C until Phase B builds and verifies correctly.**

---

## Phase C: Visual Late-Entry Indicators

### Problem

Users have no visual feedback that a cell represents a past date with no saved hours — meaning any entry will require a late-entry reason. The amber indicator helps set expectations before the user starts typing.

### Execution Steps

---

**C1.** Modify `src/components/timesheet/cells/HourCell.tsx` — add visual indicator for cells that would trigger a late-entry reason.

**C1a.** Add `dayjs` import if not already present:

```typescript
import dayjs from 'dayjs';
```

**C1b.** Inside the component, after the existing `isDirty` calculation, add late-entry detection logic:

Find these lines:

```typescript
  const savedValue = savedEntry ? (savedEntry.hours[dayIndex] ?? 0) : 0;
  const isDirty = value !== savedValue;
```

Add AFTER them:

```typescript
  // Check if this cell is a candidate for late entry (past date, never saved)
  const revisionKey = `${chargeCodeId}-${dayIndex}`;
  const revisionNumber = state.savedCellRevisions[revisionKey] ?? 0;
  const cellDate = dayjs(state.periodStart).add(dayIndex, 'day');
  const isPastDate = cellDate.isBefore(dayjs(), 'day');
  const isLateEntryCandidate = isPastDate && revisionNumber === 0 && savedValue === 0;
```

**C1c.** Update the cell's background color to show the late-entry indicator. Find the `backgroundColor` in the style:

```typescript
        backgroundColor: isDirty
          ? 'light-dark(var(--mantine-color-yellow-0), var(--mantine-color-yellow-9))'
          : undefined,
```

Replace with:

```typescript
        backgroundColor: isDirty
          ? 'light-dark(var(--mantine-color-yellow-0), var(--mantine-color-yellow-9))'
          : isLateEntryCandidate
            ? 'light-dark(var(--mantine-color-orange-0), var(--mantine-color-orange-9))'
            : undefined,
```

**C1d.** Update the `borderRadius` to also apply for late-entry candidates:

Find:

```typescript
        borderRadius: isDirty ? 2 : undefined,
```

Replace with:

```typescript
        borderRadius: (isDirty || isLateEntryCandidate) ? 2 : undefined,
```

**C1e.** Add a subtle left border for late-entry candidates. Add this to the style object after `borderRadius`:

```typescript
        borderLeft: isLateEntryCandidate ? '3px solid var(--mantine-color-orange-5)' : undefined,
```

---

**C2.** Modify `src/components/timesheet/cells/ColumnHeaderDate.tsx` — add visual indicator for past dates.

Replace the entire file with:

```tsx
'use client';

import { Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';

interface ColumnHeaderDateProps {
  date: Date;
  dayIndex: number; // kept for potential future use
}

export function ColumnHeaderDate({ date, dayIndex: _dayIndex }: ColumnHeaderDateProps) {
  const d = dayjs(date);
  const isWeekend = d.day() === 0 || d.day() === 6;
  const isPast = d.isBefore(dayjs(), 'day');
  const isToday = d.isSame(dayjs(), 'day');

  return (
    <Stack align="center" gap={0}>
      <Text
        fw={isToday ? 900 : 700}
        size="sm"
        c={isToday ? 'blue' : isWeekend ? 'dimmed' : undefined}
        td={isToday ? 'underline' : undefined}
      >
        {d.format('ddd')}
      </Text>
      <Text
        size="xs"
        c={isToday ? 'blue' : 'dimmed'}
        fs={isPast && !isToday ? 'italic' : undefined}
      >
        {d.format('MMM D')}
      </Text>
    </Stack>
  );
}
```

**Key changes:**
- Today's date is highlighted in blue with bold + underline for quick identification
- Past dates show the date in italic to subtly distinguish them from current/future dates

### Phase C Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| View timesheet for current period | Past dates with no saved hours show faint orange background + left border |
| Today's column header | Shows blue, bold, underlined day name |
| Past date column headers | Date shown in italic |
| Enter hours in an orange cell | Orange indicator remains while editing; turns yellow (dirty) after value entered |
| Cell with **existing saved hours** on a past date | NO orange indicator (not a late-entry candidate) |
| Future date cells | No special indicator (handled in Phase D) |

**⚠️ Do NOT proceed to Phase D until Phase C builds and verifies correctly.**

---

## Phase D: Future-Date Entry Prevention

### Problem

Users can currently enter hours for future dates. Per FAR 31.201-1, only actual costs (time already worked) may be recorded. Prospective time entry is not DCAA-compliant.

### Execution Steps

---

**D1.** Modify `src/components/timesheet/cells/HourCell.tsx` — prevent editing future-date cells.

**D1a.** Add future-date detection. After the `isLateEntryCandidate` line added in Phase C, add:

```typescript
  const isFutureDate = cellDate.isAfter(dayjs(), 'day');
```

**D1b.** Update the `handleClick` function to block future dates. Find:

```typescript
  const handleClick = () => {
    if (!isEditable) return; // Period is locked (submitted/approved)
    setLocalValue(value);
    setIsEditing(true);
  };
```

Replace with:

```typescript
  const handleClick = () => {
    if (!isEditable) return; // Period is locked (submitted/approved)
    if (isFutureDate) return; // Cannot enter hours for future dates
    setLocalValue(value);
    setIsEditing(true);
  };
```

**D1c.** Update the cell styling to gray out future dates. Update the `style` object on the outer `div`. Find the `cursor` line:

```typescript
        cursor: isEditable ? 'pointer' : 'default',
```

Replace with:

```typescript
        cursor: isEditable && !isFutureDate ? 'pointer' : 'default',
```

Find the `opacity` line:

```typescript
        opacity: isEditable ? 1 : undefined,
```

Replace with:

```typescript
        opacity: isFutureDate ? 0.4 : isEditable ? 1 : undefined,
```

**D1d.** Add a title/tooltip for future-date cells. Add this prop to the outer `div`:

```typescript
      title={isFutureDate ? 'Cannot enter hours for future dates' : undefined}
```

---

**D2.** Modify `src/server/actions/timesheet.ts` — add server-side guard against future-date entries.

In the `saveTimesheetBatch()` function, add validation at the TOP of the function body (after the `const start = dayjs(data.periodStart);` line):

Find:

```typescript
  const start = dayjs(data.periodStart);
  const newRevisions: Record<string, number> = {};
```

Replace with:

```typescript
  const start = dayjs(data.periodStart);
  const today = dayjs().startOf('day');
  const newRevisions: Record<string, number> = {};

  // Server-side guard: reject any entries for future dates
  for (const cell of data.cells) {
    const entryDate = start.add(cell.dayIndex, 'day');
    if (entryDate.isAfter(today, 'day')) {
      throw new Error(`Cannot save hours for future date: ${entryDate.format('MMM D, YYYY')}`);
    }
  }
```

### Phase D Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| View timesheet for current period | Future dates appear grayed out (opacity 0.4) |
| Click on a future-date cell | Nothing happens — cell does not enter edit mode |
| Hover over future-date cell | Tooltip: "Cannot enter hours for future dates" |
| Today's date cell | Fully editable, normal styling |
| Past date cell | Editable (with late-entry indicator if applicable) |
| Server-side: attempt to save future-date entry | Error: "Cannot save hours for future date: {date}" |

---

## Guardrail Verification (All Phases)

```bash
npm run build
```

Must pass with zero errors.

```bash
git diff --name-only
```

Must **NOT** include:
- `src/db/schema.ts`
- `src/auth.ts`
- `src/middleware.ts`
- `src/components/timesheet/BiWeeklyTable.tsx`
- `src/components/timesheet/BiWeeklyTimesheetClient.tsx`
- `src/components/timesheet/PayPeriodSelector.tsx`
- `src/components/timesheet/DailyNoteModal.tsx`
- `src/components/timesheet/cells/ChargeCodeCell.tsx`
- `src/components/timesheet/cells/TotalHoursCell.tsx`
- `src/components/shell/*`
- `src/app/(app)/admin/*`
- `src/server/actions/contracts.ts`
- `src/server/actions/clins.ts`
- `src/server/actions/assignments.ts`
- `src/server/actions/users.ts`
- `src/lib/reason-codes.ts`

**SHOULD** include:
- `src/types/timesheet.ts` (Phase A — added `isLateEntry`)
- `src/lib/date-utils.ts` (Phase A — added `getPeriodEndDate`)
- `src/components/timesheet/TimesheetContext.tsx` (Phase A — late entry detection)
- `src/components/timesheet/TimesheetToolbar.tsx` (Phase A + B — save flow + submit restriction)
- `src/components/timesheet/ReasonModal.tsx` (Phase A — late entry handling)
- `src/components/timesheet/SubmitModal.tsx` (Phase B — submit messaging)
- `src/components/timesheet/cells/HourCell.tsx` (Phase C + D — indicators + future lock)
- `src/components/timesheet/cells/ColumnHeaderDate.tsx` (Phase C — date indicators)
- `src/server/actions/timesheet.ts` (Phase A + D — reason codes + future guard)
- `src/server/actions/periods.ts` (Phase B — server-side submit validation)

## Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `Property 'isLateEntry' does not exist on type 'DirtyCell'` | Phase A1 not applied | Add `isLateEntry` to DirtyCell in `types/timesheet.ts` |
| `Property 'hasLateEntries' does not exist` | Phase A3b/A3c not applied | Add to context value interface and provider |
| `Property 'lateEntryCells' does not exist on type 'Props'` | Phase A5 not applied | Update ReasonModal Props type |
| `dayjs(...).isSameOrAfter is not a function` | Plugin not extended | Add `import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'; dayjs.extend(isSameOrAfter);` |
| `Property 'savedCellRevisions' does not exist on HourCell` | Destructuring wrong | Access via `state.savedCellRevisions` from `useTimesheet()` |
| `Cannot submit before the last day` error on valid submit | Date comparison issue | Ensure `dayjs().isSameOrAfter(periodEndDate, 'day')` uses `'day'` granularity |
| Orange background too strong in dark mode | Color variable issue | Use `light-dark()` function as shown in code |
