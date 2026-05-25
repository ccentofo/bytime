# Blueprint: Concurrent Edit Detection — Optimistic Concurrency Control

## 1. Architectural Overview

### The Problem

When two browser tabs (or two devices) edit the same timesheet cell simultaneously, the last `saveTimesheetBatch` call wins. The append-only architecture means data is never lost (both revisions exist), but the "current" value displayed may not reflect the user's most recent intent. A user could edit a cell in Tab A, then save from Tab B (with stale data), effectively overwriting Tab A's changes without knowing.

### The Solution: Expected Revision Check

Before inserting a new revision, verify that the cell's current `revisionNumber` matches what the client expects. If someone else has saved a newer revision since the client last loaded, reject the save with a descriptive error.

**Flow:**
```
Client has cell at revision 3 → edits to 8.0 hrs → saves with expectedRevision=3
Server checks: current DB revision = 3 → matches → INSERT revision 4 ✅

Client A has cell at revision 3 → edits to 8.0 hrs
Client B has cell at revision 3 → edits to 6.0 hrs → saves → revision 4 created
Client A saves with expectedRevision=3 → Server checks: DB has revision 4 now → MISMATCH → reject ❌
Client A gets error: "This cell was modified. Refresh and re-enter your changes."
```

### Design Decisions

1. **Check happens per-cell** — Each cell in the batch is individually validated. If one cell has a conflict, the ENTIRE batch is rejected (atomic save). This prevents partial saves which would be confusing.

2. **Error is user-facing** — The conflict error is caught by the existing notification system. The user sees a clear message to refresh and re-enter.

3. **Refresh resolves conflicts** — Since `loadPeriod()` fetches the latest data from the server, a refresh always shows the current state.

4. **Offline sync special case** — Offline entries synced via the sync service should use a softer conflict policy. Since the user may have been offline for hours, we use "last-write-wins" for offline sync (no expected revision check). The sync already uses the existing `saveTimesheetBatch()`, so we add an `skipConflictCheck` flag.

---

## 2. File Topology

```
Files to MODIFY:
├── src/server/actions/timesheet.ts                  ← Add expected revision check to saveTimesheetBatch
├── src/components/timesheet/TimesheetContext.tsx     ← Pass savedCellRevisions in save calls
├── src/lib/offline/sync-service.ts                  ← Pass skipConflictCheck flag for offline syncs

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetToolbar.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                  ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx          ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx          ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx       ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx    ← ❌ DO NOT MODIFY
├── src/components/shell/*                           ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                      ← ❌ DO NOT MODIFY
├── src/app/**                                       ← ❌ DO NOT MODIFY
├── src/types/timesheet.ts                           ← ❌ DO NOT MODIFY
├── src/lib/offline/db.ts                            ← ❌ DO NOT MODIFY
├── src/lib/offline/offline-store.ts                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - The conflict check must be **atomic per batch** — if any cell conflicts, reject the entire batch.
> - Offline sync must bypass the conflict check (pass `skipConflictCheck: true`).
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Server-Side Conflict Detection (A1)

#### A1. Modify `src/server/actions/timesheet.ts` — Add expected revision validation

**A1a.** Update the `saveTimesheetBatch` cell type to accept `expectedRevision`:

Find the cells type definition:

```typescript
  cells: Array<{
    clinId?: string;
    slinId?: string;
    indirectCodeId?: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
  }>;
```

Replace with:

```typescript
  cells: Array<{
    clinId?: string;
    slinId?: string;
    indirectCodeId?: string;
    dayIndex: number;
    hours: number;
    isEdit: boolean;
    isLateEntry: boolean;
    expectedRevision?: number; // Client's last known revision for this cell (0 = never saved)
  }>;
  skipConflictCheck?: boolean; // Set to true for offline sync (last-write-wins)
```

**A1b.** Add the conflict check AFTER the CLIN validation block and BEFORE the per-cell save loop. Find:

```typescript
  // Server-side guard: validate CLIN assignments for direct entries only
  const directCells = data.cells.filter((c) => !c.indirectCodeId);
  const uniqueClinIds = [...new Set(directCells.map((c) => c.clinId).filter(Boolean))];
  for (const clinId of uniqueClinIds) {
    await validateClinAssignment(data.userId, clinId!);
  }

  for (const cell of data.cells) {
```

Insert BETWEEN the CLIN validation and the per-cell loop:

```typescript
  // Optimistic concurrency control: check expected revisions
  if (!data.skipConflictCheck) {
    for (const cell of data.cells) {
      if (cell.expectedRevision === undefined) continue; // Skip if not provided (backward compatible)

      const entryDate = start.add(cell.dayIndex, 'day').toDate();
      const entryId = cell.clinId ?? cell.indirectCodeId;

      if (!entryId) continue;

      const currentRevision = await db
        .select({ maxRevision: sql<number>`COALESCE(MAX(${timesheetEntries.revisionNumber}), 0)` })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, data.userId),
            cell.clinId
              ? eq(timesheetEntries.clinId, cell.clinId)
              : eq(timesheetEntries.indirectCodeId, cell.indirectCodeId!),
            eq(timesheetEntries.entryDate, entryDate),
          )
        );

      const dbRevision = currentRevision[0]?.maxRevision ?? 0;

      if (dbRevision !== cell.expectedRevision) {
        const dateLabel = dayjs(entryDate).format('MMM D, YYYY');
        throw new Error(
          `Conflict detected: The entry for ${dateLabel} was modified by another session (expected revision ${cell.expectedRevision}, but server has revision ${dbRevision}). Please refresh your timesheet and re-enter your changes.`
        );
      }
    }
  }

```

---

### Phase B: Client-Side — Pass Expected Revisions (B1)

#### B1. Modify `src/components/timesheet/TimesheetContext.tsx` — Include expectedRevision in save calls

In the `saveAll` callback, update the cells mapping to include `expectedRevision` from `savedCellRevisions`. Find the cells mapping inside `saveAll`:

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

Replace with:

```typescript
cells: dirtyCells.map((c) => {
  const chargeCode = state.chargeCodes.find((cc) => cc.id === c.chargeCodeId);
  const revisionKey = `${c.chargeCodeId}-${c.dayIndex}`;
  return {
    clinId: chargeCode?.isIndirect ? undefined : c.chargeCodeId,
    indirectCodeId: chargeCode?.isIndirect ? c.chargeCodeId : undefined,
    dayIndex: c.dayIndex,
    hours: c.hours,
    isEdit: c.isEdit,
    isLateEntry: c.isLateEntry,
    expectedRevision: state.savedCellRevisions[revisionKey] ?? 0,
  };
}),
```

---

### Phase C: Offline Sync — Skip Conflict Check (C1)

#### C1. Modify `src/lib/offline/sync-service.ts` — Add skipConflictCheck flag

Find the `saveTimesheetBatch` call inside `syncPendingEntries`:

```typescript
const newRevisions = await saveTimesheetBatch({
  userId,
  periodStart,
  cells: items.map((item) => {
    const dayIndex = dayjs(item.entryDate).diff(dayjs(periodStartStr), 'day');
    return {
      clinId: item.clinId,
      dayIndex,
      hours: item.hours,
      isEdit: item.isEdit,
      isLateEntry: item.isLateEntry,
    };
  }),
  changeReasonCode: hasEditsOrLate ? (firstReason?.changeReasonCode ?? 'OFFLINE_SYNC') : undefined,
  comment: hasEditsOrLate ? (firstReason?.comment ?? 'Synced from offline entry') : undefined,
});
```

Replace with:

```typescript
const newRevisions = await saveTimesheetBatch({
  userId,
  periodStart,
  cells: items.map((item) => {
    const dayIndex = dayjs(item.entryDate).diff(dayjs(periodStartStr), 'day');
    return {
      clinId: item.clinId,
      dayIndex,
      hours: item.hours,
      isEdit: item.isEdit,
      isLateEntry: item.isLateEntry,
      // No expectedRevision for offline sync — use last-write-wins
    };
  }),
  changeReasonCode: hasEditsOrLate ? (firstReason?.changeReasonCode ?? 'OFFLINE_SYNC') : undefined,
  comment: hasEditsOrLate ? (firstReason?.comment ?? 'Synced from offline entry') : undefined,
  skipConflictCheck: true, // Offline entries use last-write-wins policy
});
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

### 4b. Conflict Detection Checks

| Check | Expected Result |
|---|---|
| **Normal save (single tab)** | Saves normally — expectedRevision matches |
| **Two tabs, same cell, Tab B saves first** | Tab A's save fails: "Conflict detected: The entry for {date} was modified by another session" |
| **Refresh after conflict** | Loads latest data; user can re-edit and save |
| **New cell (never saved, revision 0)** | First save succeeds; second save from stale tab fails if first save happened |
| **Offline sync** | Bypasses conflict check (skipConflictCheck=true) — last-write-wins |
| **Batch with one conflicted cell** | Entire batch rejected — no partial saves |
| **Cell without expectedRevision** | Skipped (backward compatible) — saves normally |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| All saves fail after implementation | `expectedRevision` not passed from client | Verify `savedCellRevisions` is populated in `TimesheetContext` |
| `expectedRevision` always 0 | Revision map not loaded on page load | Verify `getRevisionMap` is called in `timesheet/page.tsx` |
| Offline sync fails | `skipConflictCheck` not passed | Verify the flag is set in `sync-service.ts` |
| False conflicts on first save | `expectedRevision = 0` but DB has revision 1 | This means the client didn't load revisions. Check `SET_PERIOD_DATA` includes `revisions`. |
| Conflict error not shown to user | Error not caught in TimesheetToolbar | Existing try/catch in `handleSave`/`handleReasonConfirm` shows notifications — conflict errors will appear as "Save Failed" toasts |
