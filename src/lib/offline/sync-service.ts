import { offlineDb } from './db';
import { saveTimesheetBatch } from '@/server/actions/timesheet';
import dayjs from 'dayjs';
import type { CalendarDate } from '@/lib/calendar-date';

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
/**
 * Set when the server refuses for a reason retrying can't fix (read_only / forbidden / unauthenticated):
 * the loop stops until the next app load (module state resets), and the queued hours stay queued.
 */
let syncPaused = false;
let lastSyncError: string | null = null;
const PAUSE_CODES = new Set(['read_only', 'forbidden', 'unauthenticated']);

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
export function startSyncService() {
  if (syncTimer) return; // Already running

  syncTimer = setInterval(() => {
    if (navigator.onLine && !isSyncing) {
      syncPendingEntries();
    }
  }, SYNC_INTERVAL_MS);

  // Also sync when coming back online
  window.addEventListener('online', () => {
    if (!isSyncing) {
      syncPendingEntries();
    }
  });

  // Initial sync attempt
  if (navigator.onLine) {
    syncPendingEntries();
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
export async function triggerSync(): Promise<boolean> {
  if (!navigator.onLine) return false;
  return syncPendingEntries();
}

// ---------------------------------------------------------------------------
// Core Sync Logic
// ---------------------------------------------------------------------------

async function syncPendingEntries(): Promise<boolean> {
  if (isSyncing || syncPaused) return false;
  isSyncing = true;
  notifyStatus();

  try {
    // Get pending queue items, oldest first
    let pending;
    try {
      pending = await offlineDb.syncQueue
        .where('attempts')
        .below(MAX_RETRY_ATTEMPTS)
        .limit(BATCH_SIZE)
        .toArray();
    } catch (indexError) {
      // Fallback: if 'attempts' index doesn't exist, get all items and filter in memory
      console.warn('Sync queue index query failed, falling back to full scan:', indexError);
      try {
        const all = await offlineDb.syncQueue.toArray();
        pending = all.filter((item) => (item.attempts ?? 0) < MAX_RETRY_ATTEMPTS).slice(0, BATCH_SIZE);
      } catch {
        // IndexedDB completely unavailable — skip sync silently
        isSyncing = false;
        notifyStatus();
        return false;
      }
    }

    if (pending.length === 0) {
      isSyncing = false;
      notifyStatus();
      return true;
    }

    // Group by periodStart for batch saving.
    // This hardcodes semi-monthly period math and doesn't account for other period types
    // (weekly/biweekly/monthly) configured via pay-period-config.ts — but nothing ever queues
    // offline entries today (saveOfflineEntry has no callers), so this path is dormant. If it's
    // ever built out, saveTimesheetBatch's server-side period-start/dayIndex validation (R2-2)
    // now rejects a mismatched or out-of-range batch rather than silently writing into the
    // wrong period, so getting this grouping wrong here would fail loudly, not corrupt data.
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
    // TODO(D4): periodStart above is still derived from a hard-coded semimonthly (1st/16th)
    // assumption (§0.6) — the offline store is dormant until D4 wires it to the server's real
    // period boundaries (getPeriodOptions), so this stays a known gap rather than a live bug.
    for (const [periodStartStr, items] of byPeriod.entries()) {
      const periodStart = periodStartStr as CalendarDate;

      // Determine if we need a reason code (any edits or late entries?)
      const hasEditsOrLate = items.some((i) => i.isEdit || i.isLateEntry);
      const firstReason = items.find((i) => i.changeReasonCode);

      // A rejection (network failure, server error) keeps the existing retry path below. A RETURNED failure
      // never deletes anything (feature-plan-launch-blockers.md P4 §3): offline sync must never drop unsynced hours.
      let result: Awaited<ReturnType<typeof saveTimesheetBatch>> | null = null;
      let failure: string | null = null;
      try {
        result = await saveTimesheetBatch({
          periodStart,
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
          changeReasonCode: hasEditsOrLate ? (firstReason?.changeReasonCode ?? 'OFFLINE_SYNC') : undefined,
          comment: hasEditsOrLate ? (firstReason?.comment ?? 'Synced from offline entry') : undefined,
          skipConflictCheck: true, // Offline entries use last-write-wins policy
        });
      } catch (error) {
        failure = String(error);
      }

      if (result?.ok) {
        // On success: remove from queue, update local entries to synced
        const newRevisions = result.data;
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
        continue;
      }

      if (result && !result.ok && PAUSE_CODES.has(result.code)) {
        // Retrying can't fix this (read-only workspace, lost permission, signed out): keep every item queued
        // untouched and stop syncing until the next app load.
        syncPaused = true;
        lastSyncError = result.error;
        break;
      }

      // conflict / validation / not_found (the user must resolve) or a network failure: keep the items, count the
      // attempt (the MAX_RETRY_ATTEMPTS cap stops endless 30 s retries), and flag the local entries.
      const message = result && !result.ok ? result.error : failure ?? 'Sync failed';
      for (const item of items) {
        if (item.id) {
          await offlineDb.syncQueue.update(item.id, {
            attempts: (item.attempts ?? 0) + 1,
            lastError: message,
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

  try {
    const pendingCount = await offlineDb.syncQueue.count();
    let errorItems = 0;
    try {
      errorItems = await offlineDb.syncQueue
        .where('attempts')
        .aboveOrEqual(MAX_RETRY_ATTEMPTS)
        .count();
    } catch {
      // Index not available — skip error count
    }

    statusCallback({
      pendingCount,
      isSyncing,
      lastError: errorItems > 0 ? `${errorItems} entries failed to sync` : null,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });
  } catch {
    // IndexedDB unavailable — report safe defaults
    statusCallback({
      pendingCount: 0,
      isSyncing: false,
      lastError: null,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });
  }
}

/** Unit tests only: whether the loop is paused, and reset module state between tests. */
export function getSyncStateForTests(): { paused: boolean; lastError: string | null } {
  return { paused: syncPaused, lastError: lastSyncError };
}
export function resetSyncStateForTests(): void {
  syncPaused = false;
  lastSyncError = null;
  isSyncing = false;
}
