# Blueprint: Indirect Code Null-Safety Fixes — Dashboard, Audit Trail, Offline Sync

> **This ticket contains THREE phases. Complete each phase fully before starting the next.**

## 1. Problem Statement

The indirect charge codes feature (`feature-plan-indirect-codes.md`) made `clinId` nullable on `timesheetEntries`. Three downstream consumers were not fully updated to handle `clinId = null`:

| Bug | File(s) | Issue |
|---|---|---|
| **Dashboard excludes indirect hours** | `src/server/actions/dashboard.ts` | Hours/cost queries use correlated subquery with `te2.clin_id = clinId` — NULL = NULL is never TRUE in SQL, so indirect entries are silently excluded from totals |
| **Audit Trail can't view indirect history** | `src/server/actions/audit.ts`, `src/app/(app)/admin/audit-trail/AuditTrailClient.tsx` | `getCellRevisionHistory(userId, clinId, entryDate)` requires `clinId: string` — fails for indirect entries where `clinId` is null |
| **Offline sync missing indirectCodeId** | `src/lib/offline/db.ts`, `src/lib/offline/offline-store.ts`, `src/lib/offline/sync-service.ts` | `OfflineSyncQueueItem` has no `indirectCodeId` field — indirect entries saved offline can't sync correctly |

---

## 2. File Topology

```
Files to MODIFY:
├── src/server/actions/dashboard.ts                   ← Fix hours/cost queries to filter clinId IS NOT NULL
├── src/server/actions/audit.ts                       ← Update getCellRevisionHistory to support indirect entries
├── src/app/(app)/admin/audit-trail/AuditTrailClient.tsx ← Pass indirectCodeId when viewing indirect entry history
├── src/lib/offline/db.ts                             ← Add indirectCodeId to OfflineSyncQueueItem
├── src/lib/offline/offline-store.ts                  ← Populate indirectCodeId when saving indirect entries
├── src/lib/offline/sync-service.ts                   ← Pass indirectCodeId through to saveTimesheetBatch

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                  ← ❌ DO NOT MODIFY
├── src/auth.ts                                       ← ❌ DO NOT MODIFY
├── src/middleware.ts                                 ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                        ← ❌ DO NOT MODIFY (except via audit trail client)
├── src/server/actions/timesheet.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                     ← ❌ DO NOT MODIFY
├── src/server/actions/contracts.ts                   ← ❌ DO NOT MODIFY
├── src/server/actions/users.ts                       ← ❌ DO NOT MODIFY
├── src/server/actions/reports.ts                     ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/audit-trail/page.tsx           ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                         ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/contracts/*                    ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - These are **surgical bug fixes** — change only the minimum necessary code.
> - **After each phase, run `npm run build` to verify zero errors.**

---

## Phase A: Fix Dashboard Queries (A1)

### Problem

`dashboard.ts` queries `hoursData` and `costData` with correlated subqueries that use `te2.clin_id = ${timesheetEntries.clinId}`. When `clinId` is null (indirect entries), SQL evaluates `NULL = NULL` as `NULL` (not TRUE), so indirect entries' MAX revision subquery fails to match, and their hours/costs are silently excluded.

For the **Contract Dashboard**, this is actually the correct behavior conceptually — the dashboard shows contract/CLIN budget burn, not indirect costs. However, the query is still broken because the correlated subquery doesn't correctly find the max revision for entries with `clinId IS NULL`. This means if an indirect entry has multiple revisions, the SUM could double-count.

### Fix

Add an explicit `WHERE clin_id IS NOT NULL` filter to both the hours and cost queries. This properly excludes indirect entries (which don't belong in a contract budget dashboard) AND fixes the correlated subquery issue.

---

**A1.** Modify `src/server/actions/dashboard.ts` — Fix hours query.

Find the `hoursData` query (around line 105):

```typescript
  // Query 4: Total hours per CLIN (latest revision only, no rate needed)
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
```

Replace with:

```typescript
  // Query 4: Total hours per CLIN (latest revision only, direct entries only)
  // Indirect entries (clinId IS NULL) are excluded — they don't belong in contract budget tracking
  const hoursData = await db
    .select({
      clinId: timesheetEntries.clinId,
      totalHours: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
    })
    .from(timesheetEntries)
    .where(
      and(
        sql`${timesheetEntries.clinId} IS NOT NULL`,
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
    .groupBy(timesheetEntries.clinId);
```

**A1b.** Apply the same fix to the `costData` query (around line 126). Find:

```typescript
  // Query 5: Total cost per CLIN (latest revision × effective rate)
  const costData = await db
    .select({
      clinId: timesheetEntries.clinId,
```

Add the same `sql\`${timesheetEntries.clinId} IS NOT NULL\`` condition to its `.where()` clause, wrapping the existing `eq()` in an `and()` just like the hours query above.

**A1c.** Ensure `and` is imported from `drizzle-orm`. Check the existing import line:

```typescript
import { eq, and, sql, gte, lt } from 'drizzle-orm';
```

`and` should already be imported. If not, add it.

### Phase A Verification

```bash
npm run build
```

| Check | Expected Result |
|---|---|
| Contract Dashboard loads | Shows contract/CLIN hours and costs for direct entries only |
| Indirect entries don't appear in contract dashboard | Correct — indirect costs belong in a separate indirect cost report, not per-contract |
| No SQL errors from NULL comparisons | Indirect entries cleanly excluded by `IS NOT NULL` filter |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: Fix Audit Trail for Indirect Entries (B1–B2)

### Problem

`getCellRevisionHistory(userId, clinId, entryDate)` requires `clinId: string` and queries with `eq(timesheetEntries.clinId, clinId)`. For indirect entries, `clinId` is null and the function can't be called.

### Fix

Update the function to accept either `clinId` or `indirectCodeId`, and query accordingly.

---

**B1.** Modify `src/server/actions/audit.ts` — Update `getCellRevisionHistory` signature and logic.

Find the function signature:

```typescript
export async function getCellRevisionHistory(
  userId: string,
  clinId: string,
  entryDate: Date
): Promise<CellRevisionHistory | null> {
```

Replace with:

```typescript
export async function getCellRevisionHistory(
  userId: string,
  clinId: string | null,
  entryDate: Date,
  indirectCodeId?: string | null
): Promise<CellRevisionHistory | null> {
```

Then update the WHERE clause in the entries query. Find:

```typescript
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        eq(timesheetEntries.clinId, clinId),
        gte(timesheetEntries.entryDate, entryStart),
        lt(timesheetEntries.entryDate, entryEnd),
      )
    )
```

Replace with:

```typescript
    .where(
      and(
        eq(timesheetEntries.userId, userId),
        clinId
          ? eq(timesheetEntries.clinId, clinId)
          : eq(timesheetEntries.indirectCodeId, indirectCodeId!),
        gte(timesheetEntries.entryDate, entryStart),
        lt(timesheetEntries.entryDate, entryEnd),
      )
    )
```

Also update the `CellRevisionHistory` type to support indirect entries. Find the interface:

```typescript
export interface CellRevisionHistory {
  userId: string;
  userName: string;
  clinId: string;
  clinNumber: string;
  contractName: string;
```

Replace with:

```typescript
export interface CellRevisionHistory {
  userId: string;
  userName: string;
  clinId: string | null;
  clinNumber: string;
  contractName: string;
  indirectCodeId?: string | null;
  indirectCode?: string | null;
```

Update the context query to handle both direct and indirect. Find the context query:

```typescript
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
```

Replace with:

```typescript
  // Get user context
  const [userRow] = await db
    .select({ userName: users.fullName })
    .from(users)
    .where(eq(users.id, userId));

  if (!userRow) return null;

  let clinNumber = '—';
  let contractName = '—';
  let indirectCode: string | null = null;

  if (clinId) {
    // Direct entry — get CLIN/contract context
    const clinContext = await db
      .select({
        clinNumber: clins.clinNumber,
        contractName: contracts.name,
      })
      .from(clins)
      .innerJoin(contracts, eq(clins.contractId, contracts.id))
      .where(eq(clins.id, clinId))
      .limit(1);

    if (clinContext.length > 0) {
      clinNumber = clinContext[0].clinNumber;
      contractName = clinContext[0].contractName;
    }
  } else if (indirectCodeId) {
    // Indirect entry — get indirect code context
    const { indirectChargeCodes } = await import('@/db/schema');
    const indirectContext = await db
      .select({
        code: indirectChargeCodes.code,
        name: indirectChargeCodes.name,
      })
      .from(indirectChargeCodes)
      .where(eq(indirectChargeCodes.id, indirectCodeId))
      .limit(1);

    if (indirectContext.length > 0) {
      clinNumber = indirectContext[0].code;
      contractName = indirectContext[0].name;
      indirectCode = indirectContext[0].code;
    }
  }

  return {
    userId,
    userName: userRow.userName,
    clinId,
    clinNumber,
    contractName,
    indirectCodeId: indirectCodeId ?? null,
    indirectCode,
    entryDate: entryStart,
    revisions: rows,
  };
```

Add `indirectChargeCodes` to the schema imports at the top of the file if using static import, OR use the dynamic import shown above to avoid modifying the import line (which is simpler and avoids potential circular dependency issues).

---

**B2.** Modify `src/app/(app)/admin/audit-trail/AuditTrailClient.tsx` — Pass `indirectCodeId` when viewing indirect entry history.

Find the `handleViewHistory` function. It currently calls:

```typescript
const history = await getCellRevisionHistory(
  entry.userId,
  entry.clinId,
  entry.entryDate,
);
```

Replace with:

```typescript
const history = await getCellRevisionHistory(
  entry.userId,
  entry.clinId,
  entry.entryDate,
  (entry as any).indirectCodeId ?? null,
);
```

**Note:** The `AuditEntry` type in `audit.ts` doesn't currently include `indirectCodeId`. To fix this properly, also add `indirectCodeId` to the `AuditEntry` interface:

In `src/server/actions/audit.ts`, find the `AuditEntry` interface and add after `clinId`:

```typescript
indirectCodeId: string | null;
```

Then in the `getAuditEntries` query's `.select()`, add:

```typescript
indirectCodeId: timesheetEntries.indirectCodeId,
```

This eliminates the need for the `(entry as any)` cast.

### Phase B Verification

```bash
npm run build
```

| Check | Expected Result |
|---|---|
| Audit Trail page loads | Shows all entries including indirect |
| Click "View History" on a direct entry | Shows revision timeline with CLIN/contract context |
| Click "View History" on an indirect entry | Shows revision timeline with indirect code/name context |
| No TypeScript errors | `clinId: string | null` properly handled throughout |

**⚠️ Do NOT proceed to Phase C until Phase B builds and verifies correctly.**

---

## Phase C: Fix Offline Sync for Indirect Entries (C1–C3)

### Problem

The `OfflineSyncQueueItem` in `db.ts` only has a `clinId` field. When saving indirect entries offline, the `indirectCodeId` is lost. The sync service then passes `clinId: undefined` and `indirectCodeId: undefined` to `saveTimesheetBatch`, creating entries with both fields null.

### Fix

Add `indirectCodeId` to the offline schema, populate it when saving, and pass it through during sync.

---

**C1.** Modify `src/lib/offline/db.ts` — Add `indirectCodeId` to `OfflineSyncQueueItem`.

Find the interface:

```typescript
export interface OfflineSyncQueueItem {
  id?: number;                    // auto-increment
  clinId: string;
  entryDate: string;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
  isEdit: boolean;
  isLateEntry: boolean;
  createdAt: string;              // when the local edit happened
  attempts: number;               // retry counter
  lastError?: string;
}
```

Replace with:

```typescript
export interface OfflineSyncQueueItem {
  id?: number;                    // auto-increment
  clinId?: string;                // set for direct entries (nullable for indirect)
  indirectCodeId?: string;        // set for indirect entries
  entryDate: string;
  hours: number;
  changeReasonCode?: string;
  comment?: string;
  isEdit: boolean;
  isLateEntry: boolean;
  createdAt: string;              // when the local edit happened
  attempts: number;               // retry counter
  lastError?: string;
}
```

**Important:** Also update the Dexie store index. The existing index is `'++id, clinId, entryDate'`. We don't need to index `indirectCodeId` for query purposes, but the field must be storable. Dexie doesn't require schema changes for non-indexed fields — they're stored automatically. So **no change needed to the Dexie `stores()` definition**.

**C1b.** Bump the Dexie version to trigger a schema upgrade. Find:

```typescript
this.version(1).stores({
```

Replace with:

```typescript
this.version(2).stores({
```

Keep the same store definitions — this just signals to Dexie that the schema has changed (even though we're only adding a non-indexed field, the version bump is best practice).

---

**C2.** Modify `src/lib/offline/offline-store.ts` — Populate `indirectCodeId` when saving indirect entries.

Find the `saveOfflineEntry` function. Its current `data` parameter should accept `indirectCodeId`. Find the function signature:

```typescript
export async function saveOfflineEntry(data: {
  clinId: string;
  dayIndex: number;
  hours: number;
  periodStart: Date;
  changeReasonCode?: string;
  comment?: string;
  isEdit: boolean;
  isLateEntry: boolean;
}) {
```

Replace with:

```typescript
export async function saveOfflineEntry(data: {
  clinId?: string;
  indirectCodeId?: string;
  dayIndex: number;
  hours: number;
  periodStart: Date;
  changeReasonCode?: string;
  comment?: string;
  isEdit: boolean;
  isLateEntry: boolean;
}) {
```

Then update the sync queue insert inside this function. Find:

```typescript
  // Add to sync queue
  await offlineDb.syncQueue.add({
    clinId: data.clinId,
    entryDate,
    hours: data.hours,
    changeReasonCode: data.changeReasonCode,
    comment: data.comment,
    isEdit: data.isEdit,
    isLateEntry: data.isLateEntry,
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
```

Replace with:

```typescript
  // Add to sync queue
  await offlineDb.syncQueue.add({
    clinId: data.clinId,
    indirectCodeId: data.indirectCodeId,
    entryDate,
    hours: data.hours,
    changeReasonCode: data.changeReasonCode,
    comment: data.comment,
    isEdit: data.isEdit,
    isLateEntry: data.isLateEntry,
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
```

Also update the local entry upsert to use `clinId ?? indirectCodeId` for the lookup key. Find the existing entry lookup:

```typescript
  const existing = await offlineDb.entries
    .where({ clinId: data.clinId, entryDate })
    .first();
```

Replace with:

```typescript
  const entryKey = data.clinId ?? data.indirectCodeId ?? '';
  const existing = await offlineDb.entries
    .where({ clinId: entryKey, entryDate })
    .first();
```

**Note:** The `OfflineTimesheetEntry` type uses `clinId` as its identifier field for both direct and indirect entries (it's the indexed compound key). For indirect entries, we store the `indirectCodeId` value in the `clinId` field of the offline entry table. This is a pragmatic choice — the offline entry `clinId` is just a local identifier, not a foreign key. The distinction between direct/indirect is resolved at sync time.

---

**C3.** Modify `src/lib/offline/sync-service.ts` — Pass `indirectCodeId` through to `saveTimesheetBatch`.

Find the cells mapping inside `syncPendingEntries`:

```typescript
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
```

Replace with:

```typescript
cells: items.map((item) => {
  const dayIndex = dayjs(item.entryDate).diff(dayjs(periodStartStr), 'day');
  return {
    clinId: item.indirectCodeId ? undefined : item.clinId,
    indirectCodeId: item.indirectCodeId,
    dayIndex,
    hours: item.hours,
    isEdit: item.isEdit,
    isLateEntry: item.isLateEntry,
    // No expectedRevision for offline sync — use last-write-wins
  };
}),
```

### Phase C Verification

```bash
npm run build
```

| Check | Expected Result |
|---|---|
| **Save indirect entry offline** | Entry stored in IndexedDB with `indirectCodeId` populated |
| **Sync service processes indirect entries** | `saveTimesheetBatch` receives `indirectCodeId` correctly |
| **Direct entries still work offline** | `clinId` passed through, `indirectCodeId` undefined |
| **Mixed batch (direct + indirect) syncs** | Both types handled correctly in same batch |
| **Dexie version upgrade** | No errors on first load after update (version 1 → 2) |

---

## 4. Full Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Regression Checks

| Check | Expected Result |
|---|---|
| Timesheet page loads | Dashboard + grid both render correctly |
| Save direct entries | Saves normally (no change in behavior) |
| Save indirect entries | Saves normally (no change in behavior) |
| Contract Dashboard | Shows only direct entry hours/costs (indirect correctly excluded) |
| Audit Trail — direct entry history | Works as before |
| Audit Trail — indirect entry history | Now works (was broken before) |
| Offline save + sync (direct) | Works as before |
| Offline save + sync (indirect) | Now works (was broken before) |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `Cannot read properties of null (reading 'clinNumber')` | Context query failed for indirect entry | Use the split query approach (separate user query + conditional CLIN/indirect query) |
| Dexie `VersionError` | Version not bumped | Ensure `this.version(2)` in `db.ts` |
| `indirectCodeId` undefined in sync | Not passed from `offline-store.ts` | Verify the `saveOfflineEntry` function populates it |
| Dashboard shows 0 hours after fix | `IS NOT NULL` filter too aggressive | Verify the filter only affects the hours/cost queries, not the contract/CLIN list queries |
| TypeScript error on `entry.indirectCodeId` | `AuditEntry` type missing the field | Add `indirectCodeId: string | null` to the interface |
