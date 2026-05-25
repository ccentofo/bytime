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
