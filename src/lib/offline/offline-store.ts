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
