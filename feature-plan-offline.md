# Blueprint: Offline Support & Fault-Tolerant Time Entry

## 1. Architectural Overview & DCAA Impact

### The CONTEXT.md Requirement

> "Offline/Fault Tolerance: Client-side caching (IndexedDB/Dexie.js or WatermelonDB) to allow offline time logging, syncing automatically once the network connection returns."

This is a core architectural requirement that has not yet been addressed. Government contractors often work in environments with intermittent connectivity (SCIFs, field sites, classified networks with restricted access). If the application is unavailable, employees cannot log time daily — violating DCAA's daily time entry requirement (FAR 31.201-1).

### Design Philosophy

The offline system follows a **"local-first, sync-on-reconnect"** pattern:

1. **All timesheet reads come from IndexedDB first** (instant, works offline)
2. **All timesheet writes go to IndexedDB first** (never blocked by network)
3. **A background sync service** pushes pending changes to the server when online
4. **Conflict resolution** uses a "last-write-wins with server authority" strategy, enhanced by the existing append-only revision system

### Why Dexie.js

- **Dexie.js** is a lightweight IndexedDB wrapper (~15KB gzipped) with:
  - Promise-based API
  - Schema versioning with auto-migration
  - Live queries (observable)
  - Excellent TypeScript support
  - No native modules (works in all browsers)
- **WatermelonDB** is heavier and designed for React Native — overkill for a web-only app
- Dexie's simplicity maps well to our existing data model

### DCAA Compliance Requirements Addressed

| DCAA / FAR Requirement | How Offline Support Satisfies It |
|---|---|
| **FAR 31.201-1 — Daily Time Entry** | Employees can log time even without connectivity, ensuring daily compliance |
| **CAS 418 — Total Time Accounting** | No lost entries due to network outages; all hours captured |
| **Audit Trail Integrity** | Offline entries include `createdAt` timestamps from the client clock, showing exactly when entries were made |
| **Data Integrity** | Append-only architecture means sync conflicts never lose data — both client and server versions are preserved as revisions |

### Sync Architecture

```
┌─────────────────────────────────────────────┐
│                   CLIENT                     │
│                                              │
│  TimesheetContext ←→ OfflineStore (Dexie)    │
│       │                    │                 │
│       │              SyncService             │
│       │                    │                 │
│       ▼                    ▼                 │
│  UI Renders          Pending Queue           │
│  (always from        (unsaved changes)       │
│   local store)            │                  │
│                           │                  │
└───────────────────────────┼──────────────────┘
                            │
                    ┌───────▼───────┐
                    │   NETWORK     │
                    │  (when online) │
                    └───────┬───────┘
                            │
┌───────────────────────────▼──────────────────┐
│                   SERVER                      │
│                                               │
│  saveTimesheetBatch() ← receives pending      │
│  getTimesheetEntries() → returns latest       │
│                                               │
│  PostgreSQL (append-only timesheetEntries)     │
└───────────────────────────────────────────────┘
```

### Sync States

| State | Icon | Meaning |
|---|---|---|
| `synced` | ✅ Green | All local data matches server |
| `pending` | 🟡 Yellow | Local changes not yet synced |
| `syncing` | 🔄 Blue | Currently uploading to server |
| `conflict` | 🟠 Orange | Server has newer data (resolved automatically) |
| `offline` | ⚫ Gray | No network connection |
| `error` | 🔴 Red | Sync failed (will retry) |

---

## 2. File Topology

```
Files to CREATE:
├── src/lib/offline/
│   ├── db.ts                                    ← Dexie database schema + singleton
│   ├── sync-service.ts                          ← Background sync engine
│   ├── offline-store.ts                         ← Read/write API for offline data
│   └── use-online-status.ts                     ← React hook for network status
│
├── src/components/shell/SyncStatusIndicator.tsx  ← Header sync status badge

Files to MODIFY:
├── src/components/timesheet/TimesheetContext.tsx  ← Read from offline store; write to offline store
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx ← Initialize offline store on mount
├── src/components/shell/AppHeader.tsx             ← Add SyncStatusIndicator
├── src/app/(app)/timesheet/page.tsx               ← Seed offline store with server data on load
├── package.json                                   ← Add dexie dependency

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                               ← ❌ DO NOT MODIFY
├── src/auth.ts                                    ← ❌ DO NOT MODIFY
├── src/middleware.ts                              ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                ← ❌ DO NOT MODIFY (existing API is sufficient)
├── src/server/actions/periods.ts                  ← ❌ DO NOT MODIFY
├── src/components/timesheet/BiWeeklyTable.tsx      ← ❌ DO NOT MODIFY
├── src/components/timesheet/cells/*                ← ❌ DO NOT MODIFY
├── src/components/timesheet/DailyNoteModal.tsx     ← ❌ DO NOT MODIFY
├── src/components/timesheet/ReasonModal.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/SubmitModal.tsx        ← ❌ DO NOT MODIFY
├── src/components/timesheet/TimesheetToolbar.tsx   ← ❌ DO NOT MODIFY
├── src/components/timesheet/PayPeriodSelector.tsx  ← ❌ DO NOT MODIFY
├── src/app/(app)/admin/*                          ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS FOR THE EXECUTION AGENT:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in the "DO NOT MODIFY" section above.
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Dexie.js v4** for IndexedDB operations.
> - The offline layer must be **transparent** to the existing timesheet components — they should not need to know whether data is coming from the server or the local store.
> - Follow the step order exactly. Each step builds on the previous one.
> - **After completing each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Install Dependencies & Create Dexie Schema (A1–A2)

#### A1. Install Dexie.js

```bash
npm install dexie
```

#### A2. Create `src/lib/offline/db.ts` — Dexie database schema

```typescript
import Dexie, { type Table } from 'dexie';

// ---------------------------------------------------------------------------
// Offline Database Schema
// ---------------------------------------------------------------------------

export interface OfflineTimesheetEntry {
  id?: number;                    // auto-increment local ID
  clinId: string;
  entryDate: string;              // ISO date string (YYYY-MM-DD)
  hours: number;
  changeReasonCode?: string;
  comment?: string;
  syncStatus: 'synced' | 'pending' | 'syncing' | 'error';
  serverRevision: number;         // last known server revision (0 = never saved to server)
  localUpdatedAt: string;         // ISO timestamp of local change
  periodStartKey: string;         // "YYYY-MM-DD" of the period start (for grouping)
}

export interface OfflineChargeCode {
  id: string;                     // clinId (UUID)
  projectName: string;
  clin: string;
  description: string;
  slinId?: string;
  slinNumber?: string;
  lastFetchedAt: string;          // ISO timestamp
}

export interface OfflinePeriodMeta {
  periodStartKey: string;         // "YYYY-MM-DD" — primary key
  userId: string;
  lastSyncedAt: string;           // ISO timestamp of last successful full sync
  periodStatus: string;           // draft | submitted | approved | rejected
}

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

class ByTimeOfflineDB extends Dexie {
  entries!: Table<OfflineTimesheetEntry>;
  chargeCodes!: Table<OfflineChargeCode>;
  periodMeta!: Table<OfflinePeriodMeta>;
  syncQueue!: Table<OfflineSyncQueueItem>;

  constructor() {
    super('bytime-offline');

    this.version(1).stores({
      entries: '++id, [clinId+entryDate], periodStartKey, syncStatus',
      chargeCodes: 'id',
      periodMeta: 'periodStartKey',
      syncQueue: '++id, clinId, entryDate',
    });
  }
}

// Singleton instance
export const offlineDb = new ByTimeOfflineDB();
```

---

### Phase B: Offline Store API (B1)

#### B1. Create `src/lib/offline/offline-store.ts`

```typescript
import { offlineDb, type OfflineTimesheetEntry, type OfflineChargeCode, type OfflinePeriodMeta } from './db';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Seed / Hydrate from Server Data
// ---------------------------------------------------------------------------

/**
 * Seed the offline store with server data for a given period.
 * Called after the server component fetches initial data.
 * Only updates entries that are 'synced' (doesn't overwrite pending local changes).
 */
export async function seedOfflineStore(data: {
  userId: string;
  periodStart: Date;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  revisions: Record<string, number>;
  periodStatus: string;
}) {
  const periodStartKey = dayjs(data.periodStart).format('YYYY-MM-DD');

  // Upsert charge codes
  await offlineDb.chargeCodes.bulkPut(
    data.chargeCodes.map((cc) => ({
      id: cc.id,
      projectName: cc.projectName,
      clin: cc.clin,
      description: cc.description,
      slinId: cc.slinId,
      slinNumber: cc.slinNumber,
      lastFetchedAt: new Date().toISOString(),
    }))
  );

  // Upsert period metadata
  await offlineDb.periodMeta.put({
    periodStartKey,
    userId: data.userId,
    lastSyncedAt: new Date().toISOString(),
    periodStatus: data.periodStatus,
  });

  // Upsert entries (only if not pending local changes)
  for (const entry of data.entries) {
    for (let dayIndex = 0; dayIndex < entry.hours.length; dayIndex++) {
      const entryDate = dayjs(data.periodStart).add(dayIndex, 'day').format('YYYY-MM-DD');
      const revisionKey = `${entry.chargeCodeId}-${dayIndex}`;
      const serverRevision = data.revisions[revisionKey] ?? 0;

      // Check if there's a pending local change for this cell
      const existing = await offlineDb.entries
        .where({ clinId: entry.chargeCodeId, entryDate })
        .first();

      if (existing && existing.syncStatus === 'pending') {
        // Don't overwrite pending local changes — they'll be synced later
        continue;
      }

      await offlineDb.entries.put({
        ...(existing ? { id: existing.id } : {}),
        clinId: entry.chargeCodeId,
        entryDate,
        hours: entry.hours[dayIndex] ?? 0,
        syncStatus: 'synced',
        serverRevision,
        localUpdatedAt: new Date().toISOString(),
        periodStartKey,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Read from Offline Store
// ---------------------------------------------------------------------------

/**
 * Get timesheet entries from the offline store for a given period.
 * Returns data shaped as TimesheetEntry[] to match the existing context interface.
 */
export async function getOfflineEntries(
  periodStart: Date,
  chargeCodes: ChargeCode[]
): Promise<TimesheetEntry[]> {
  const periodStartKey = dayjs(periodStart).format('YYYY-MM-DD');

  const allEntries = await offlineDb.entries
    .where('periodStartKey')
    .equals(periodStartKey)
    .toArray();

  // Group by clinId
  const entriesByClin = new Map<string, Map<string, OfflineTimesheetEntry>>();
  for (const entry of allEntries) {
    if (!entriesByClin.has(entry.clinId)) {
      entriesByClin.set(entry.clinId, new Map());
    }
    entriesByClin.get(entry.clinId)!.set(entry.entryDate, entry);
  }

  // Build TimesheetEntry[] matching the charge codes
  return chargeCodes.map((cc) => {
    const clinEntries = entriesByClin.get(cc.id);
    const numDays = getNumDaysForPeriod(periodStart);
    const hours: number[] = [];

    for (let i = 0; i < numDays; i++) {
      const dateKey = dayjs(periodStart).add(i, 'day').format('YYYY-MM-DD');
      const entry = clinEntries?.get(dateKey);
      hours.push(entry?.hours ?? 0);
    }

    return { chargeCodeId: cc.id, hours };
  });
}

/**
 * Get revision map from offline store.
 */
export async function getOfflineRevisions(
  periodStart: Date
): Promise<Record<string, number>> {
  const periodStartKey = dayjs(periodStart).format('YYYY-MM-DD');

  const allEntries = await offlineDb.entries
    .where('periodStartKey')
    .equals(periodStartKey)
    .toArray();

  const revisions: Record<string, number> = {};
  for (const entry of allEntries) {
    const dayIndex = dayjs(entry.entryDate).diff(dayjs(periodStart), 'day');
    const key = `${entry.clinId}-${dayIndex}`;
    revisions[key] = entry.serverRevision;
  }

  return revisions;
}

/**
 * Get charge codes from offline store.
 */
export async function getOfflineChargeCodes(): Promise<ChargeCode[]> {
  const codes = await offlineDb.chargeCodes.toArray();
  return codes.map((c) => ({
    id: c.id,
    projectName: c.projectName,
    clin: c.clin,
    description: c.description,
    slinId: c.slinId,
    slinNumber: c.slinNumber,
  }));
}

// ---------------------------------------------------------------------------
// Write to Offline Store (Local-First)
// ---------------------------------------------------------------------------

/**
 * Save a cell value to the offline store and add to sync queue.
 * This replaces the direct server call — data is persisted locally first.
 */
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
  const entryDate = dayjs(data.periodStart).add(data.dayIndex, 'day').format('YYYY-MM-DD');
  const periodStartKey = dayjs(data.periodStart).format('YYYY-MM-DD');

  // Update or create the local entry
  const existing = await offlineDb.entries
    .where({ clinId: data.clinId, entryDate })
    .first();

  if (existing) {
    await offlineDb.entries.update(existing.id!, {
      hours: data.hours,
      syncStatus: 'pending',
      localUpdatedAt: new Date().toISOString(),
      changeReasonCode: data.changeReasonCode,
      comment: data.comment,
    });
  } else {
    await offlineDb.entries.add({
      clinId: data.clinId,
      entryDate,
      hours: data.hours,
      syncStatus: 'pending',
      serverRevision: 0,
      localUpdatedAt: new Date().toISOString(),
      periodStartKey,
      changeReasonCode: data.changeReasonCode,
      comment: data.comment,
    });
  }

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
}

/**
 * Get the count of pending (unsynced) entries.
 */
export async function getPendingCount(): Promise<number> {
  return offlineDb.syncQueue.count();
}

/**
 * Check if offline store has data for a given period.
 */
export async function hasOfflineData(periodStart: Date): Promise<boolean> {
  const periodStartKey = dayjs(periodStart).format('YYYY-MM-DD');
  const meta = await offlineDb.periodMeta.get(periodStartKey);
  return meta !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNumDaysForPeriod(periodStart: Date): number {
  const d = dayjs(periodStart);
  if (d.date() === 1) return 15;
  return d.daysInMonth() - 15;
}
```

---

### Phase C: Sync Service (C1)

#### C1. Create `src/lib/offline/sync-service.ts`

```typescript
import { offlineDb } from './db';
import { saveTimesheetBatch } from '@/server/actions/timesheet';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Sync Configuration
// ---------------------------------------------------------------------------

const SYNC_INTERVAL_MS = 30_000;     // Check every 30 seconds
const MAX_RETRY_ATTEMPTS = 5;
const BATCH_SIZE = 50;               // Max entries per sync batch

// ---------------------------------------------------------------------------
// Sync Engine
// ---------------------------------------------------------------------------

let syncTimer: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

type SyncStatusCallback = (status: {
  pendingCount: number;
  isSyncing: boolean;
  lastError: string | null;
  isOnline: boolean;
}) => void;

let statusCallback: SyncStatusCallback | null = null;

/**
 * Register a callback to receive sync status updates.
 */
export function onSyncStatusChange(callback: SyncStatusCallback) {
  statusCallback = callback;
}

/**
 * Start the background sync service.
 * Checks for pending entries at regular intervals and syncs when online.
 */
export function startSyncService(userId: string) {
  if (syncTimer) return; // Already running

  syncTimer = setInterval(() => {
    if (navigator.onLine && !isSyncing) {
      syncPendingEntries(userId);
    }
  }, SYNC_INTERVAL_MS);

  // Also sync when coming back online
  window.addEventListener('online', () => {
    if (!isSyncing) {
      syncPendingEntries(userId);
    }
  });

  // Initial sync attempt
  if (navigator.onLine) {
    syncPendingEntries(userId);
  }

  // Update status on offline/online events
  window.addEventListener('online', notifyStatus);
  window.addEventListener('offline', notifyStatus);
}

/**
 * Stop the background sync service.
 */
export function stopSyncService() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Manually trigger a sync (e.g., when user clicks "Save").
 */
export async function triggerSync(userId: string): Promise<boolean> {
  if (!navigator.onLine) return false;
  return syncPendingEntries(userId);
}

// ---------------------------------------------------------------------------
// Core Sync Logic
// ---------------------------------------------------------------------------

async function syncPendingEntries(userId: string): Promise<boolean> {
  if (isSyncing) return false;
  isSyncing = true;
  notifyStatus();

  try {
    // Get pending queue items, oldest first
    const pending = await offlineDb.syncQueue
      .where('attempts')
      .below(MAX_RETRY_ATTEMPTS)
      .limit(BATCH_SIZE)
      .toArray();

    if (pending.length === 0) {
      isSyncing = false;
      notifyStatus();
      return true;
    }

    // Group by periodStart for batch saving
    const byPeriod = new Map<string, typeof pending>();
    for (const item of pending) {
      // Determine period start from entry date
      const entryDate = dayjs(item.entryDate);
      const periodStart = entryDate.date() <= 15
        ? entryDate.date(1).format('YYYY-MM-DD')
        : entryDate.date(16).format('YYYY-MM-DD');

      if (!byPeriod.has(periodStart)) {
        byPeriod.set(periodStart, []);
      }
      byPeriod.get(periodStart)!.push(item);
    }

    // Sync each period batch
    for (const [periodStartStr, items] of byPeriod.entries()) {
      const periodStart = dayjs(periodStartStr).toDate();

      // Determine if we need a reason code (any edits or late entries?)
      const hasEditsOrLate = items.some((i) => i.isEdit || i.isLateEntry);
      const firstReason = items.find((i) => i.changeReasonCode);

      try {
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

        // On success: remove from queue, update local entries to synced
        const itemIds = items.map((i) => i.id!).filter(Boolean);
        await offlineDb.syncQueue.bulkDelete(itemIds);

        // Update local entries with new revision numbers
        for (const item of items) {
          const revKey = `${item.clinId}-${dayjs(item.entryDate).diff(dayjs(periodStartStr), 'day')}`;
          const newRev = newRevisions[revKey];

          await offlineDb.entries
            .where({ clinId: item.clinId, entryDate: item.entryDate })
            .modify({
              syncStatus: 'synced',
              serverRevision: newRev ?? 0,
            });
        }
      } catch (error) {
        // On failure: increment attempt counter
        for (const item of items) {
          if (item.id) {
            await offlineDb.syncQueue.update(item.id, {
              attempts: (item.attempts ?? 0) + 1,
              lastError: String(error),
            });
          }
        }

        // Update entries to error status
        for (const item of items) {
          await offlineDb.entries
            .where({ clinId: item.clinId, entryDate: item.entryDate })
            .modify({ syncStatus: 'error' });
        }
      }
    }

    isSyncing = false;
    notifyStatus();
    return true;
  } catch (error) {
    console.error('Sync service error:', error);
    isSyncing = false;
    notifyStatus();
    return false;
  }
}

async function notifyStatus() {
  if (!statusCallback) return;

  const pendingCount = await offlineDb.syncQueue.count();
  const errorItems = await offlineDb.syncQueue
    .where('attempts')
    .aboveOrEqual(MAX_RETRY_ATTEMPTS)
    .count();

  statusCallback({
    pendingCount,
    isSyncing,
    lastError: errorItems > 0 ? `${errorItems} entries failed to sync` : null,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  });
}
```

---

### Phase D: Network Status Hook & UI Indicator (D1–D2)

#### D1. Create `src/lib/offline/use-online-status.ts`

```typescript
'use client';

import { useState, useEffect } from 'react';

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    function handleOnline() { setIsOnline(true); }
    function handleOffline() { setIsOnline(false); }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
```

#### D2. Create `src/components/shell/SyncStatusIndicator.tsx`

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Badge, Tooltip, Group, Text } from '@mantine/core';
import { IconCloud, IconCloudOff, IconRefresh, IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { onSyncStatusChange } from '@/lib/offline/sync-service';

type SyncStatus = {
  pendingCount: number;
  isSyncing: boolean;
  lastError: string | null;
  isOnline: boolean;
};

export function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus>({
    pendingCount: 0,
    isSyncing: false,
    lastError: null,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  });

  useEffect(() => {
    onSyncStatusChange(setStatus);

    function handleOnline() {
      setStatus((s) => ({ ...s, isOnline: true }));
    }
    function handleOffline() {
      setStatus((s) => ({ ...s, isOnline: false }));
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Determine display state
  let icon = <IconCheck size={14} />;
  let color = 'green';
  let label = 'Synced';
  let tooltip = 'All data is saved to the server';

  if (!status.isOnline) {
    icon = <IconCloudOff size={14} />;
    color = 'gray';
    label = 'Offline';
    tooltip = 'You are working offline. Changes will sync when connection returns.';
  } else if (status.lastError) {
    icon = <IconAlertTriangle size={14} />;
    color = 'red';
    label = 'Sync Error';
    tooltip = status.lastError;
  } else if (status.isSyncing) {
    icon = <IconRefresh size={14} />;
    color = 'blue';
    label = 'Syncing...';
    tooltip = `Uploading ${status.pendingCount} pending entries`;
  } else if (status.pendingCount > 0) {
    icon = <IconCloud size={14} />;
    color = 'yellow';
    label = `${status.pendingCount} pending`;
    tooltip = `${status.pendingCount} entries waiting to sync`;
  }

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        variant="light"
        color={color}
        size="sm"
        leftSection={icon}
        style={{ cursor: 'default' }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
```

---

### Phase E: Integration with Existing Components (E1–E3)

#### E1. Modify `src/components/shell/AppHeader.tsx` — Add sync status indicator

Add the `SyncStatusIndicator` component to the header, next to the color scheme toggle:

```tsx
import { SyncStatusIndicator } from '@/components/shell/SyncStatusIndicator';
```

In the JSX, add before the color scheme toggle ActionIcon:

```tsx
<SyncStatusIndicator />
```

#### E2. Modify `src/app/(app)/timesheet/page.tsx` — Seed offline store on server data load

After the existing data fetching, add a client-side seed call. Since the page is a Server Component, pass a flag or data to `BiWeeklyTimesheetClient` that triggers the seed on mount:

The `pageData` already includes all needed fields. The `BiWeeklyTimesheetClient` component will call `seedOfflineStore()` on mount (see E3).

#### E3. Modify `src/components/timesheet/BiWeeklyTimesheetClient.tsx` — Initialize offline store and sync service

Add an `useEffect` that:
1. Seeds the offline store with the initial server data
2. Starts the background sync service
3. Cleans up on unmount

```tsx
import { useEffect } from 'react';
import { seedOfflineStore } from '@/lib/offline/offline-store';
import { startSyncService, stopSyncService } from '@/lib/offline/sync-service';
```

Inside the `BiWeeklyTimesheetClient` component:

```tsx
useEffect(() => {
  // Seed offline store with server-provided data
  seedOfflineStore({
    userId: initialData.userId,
    periodStart: initialData.periodStart,
    chargeCodes: initialData.chargeCodes,
    entries: initialData.entries,
    revisions: initialData.revisions ?? {},
    periodStatus: initialData.periodStatus ?? 'draft',
  });

  // Start background sync
  startSyncService(initialData.userId);

  return () => {
    stopSyncService();
  };
}, [initialData.userId]);
```

#### E4. Modify `src/components/timesheet/TimesheetContext.tsx` — Use offline store for period navigation

When `loadPeriod` is called and the network is unavailable, fall back to the offline store:

In the `loadPeriod` callback, wrap the server fetch in a try/catch that falls back to offline data:

```typescript
const loadPeriod = useCallback(
  async (direction: 'prev' | 'next') => {
    dispatch({ type: 'NAVIGATE_PERIOD', direction });
    const newPeriodStart = navigatePeriod(state.periodStart, direction);
    const numDays = getNumDaysInPeriod(newPeriodStart);

    try {
      // Try server first
      const entries = await getTimesheetEntries(state.userId, newPeriodStart, state.chargeCodes);
      const revisions = await getRevisionMap(state.userId, newPeriodStart, numDays);
      const periodInfo = await getPeriodStatus(state.userId, newPeriodStart);

      // Seed offline store with fresh data
      await seedOfflineStore({
        userId: state.userId,
        periodStart: newPeriodStart,
        chargeCodes: state.chargeCodes,
        entries,
        revisions,
        periodStatus: periodInfo.status,
      });

      dispatch({ type: 'SET_PERIOD_DATA', periodStart: newPeriodStart, entries, revisions, periodStatus: periodInfo.status });
    } catch (error) {
      console.warn('Server unavailable, loading from offline store:', error);

      // Fall back to offline store
      const offlineEntries = await getOfflineEntries(newPeriodStart, state.chargeCodes);
      const offlineRevisions = await getOfflineRevisions(newPeriodStart);

      dispatch({
        type: 'SET_PERIOD_DATA',
        periodStart: newPeriodStart,
        entries: offlineEntries,
        revisions: offlineRevisions,
      });
    }
  },
  [state.periodStart, state.userId, state.chargeCodes]
);
```

---

## 4. Verification

### 4a. Build Check

```bash
npm run build
```

Must complete with **zero errors**.

### 4b. Online Behavior Checks

| Check | Expected Result |
|---|---|
| **Load timesheet page** | Data loads from server; offline store seeded in background |
| **Edit and save entries** | Saves to server normally; offline store updated |
| **Navigate periods** | Server data fetched; offline store updated |
| **Sync status badge** | Shows "Synced" (green) when all data is saved |

### 4c. Offline Behavior Checks

| Check | Expected Result |
|---|---|
| **Disconnect network** | Sync badge changes to "Offline" (gray) |
| **Edit cells while offline** | Values update locally; cells show dirty indicator |
| **Save while offline** | Data saved to IndexedDB; badge shows pending count |
| **Navigate periods while offline** | Loads from offline store if previously visited |
| **Reconnect network** | Badge shows "Syncing..."; pending entries uploaded to server |
| **After sync completes** | Badge returns to "Synced" (green); server has all entries |

### 4d. Conflict Resolution Checks

| Check | Expected Result |
|---|---|
| **Edit same cell on two devices** | Last sync wins; both versions preserved as revisions in append-only table |
| **Server has newer revision than offline** | Offline store updated with server data on next full sync |

### 4e. Edge Cases

| Edge Case | Expected Behavior |
|---|---|
| **Clear browser data** | Offline store recreated on next page load from server data |
| **Exceed IndexedDB quota** | Graceful degradation — old synced entries can be pruned |
| **Sync queue grows very large** | Batched in groups of 50; oldest first |
| **Entry fails after 5 retries** | Marked as error; user notified via badge |

### 4f. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `Dexie is not defined` | Import issue in SSR context | Ensure all Dexie imports are in client components / `'use client'` files |
| `indexedDB is not available` | Server-side rendering | Guard with `typeof window !== 'undefined'` checks |
| `navigator is not defined` | SSR | Use fallback value: `typeof navigator !== 'undefined' ? navigator.onLine : true` |
| Duplicate entries after sync | Sync queue not cleared | Ensure `bulkDelete` runs after successful batch save |
| Entries lost on page refresh | Not seeded from server | Verify `seedOfflineStore` runs in `useEffect` on mount |
