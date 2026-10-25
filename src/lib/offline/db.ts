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
  /** certified-outputs C4 — absent on rows stored before C4 (read as 'charge' / assignable). */
  kind?: 'charge' | 'clin' | 'indirect';
  assignable?: boolean;
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
  clinId?: string;                // the row's code id for direct entries (a charge-code id, or a CLIN id for kind 'clin')
  indirectCodeId?: string;        // set for indirect entries
  /** certified-outputs C4: which column the sync writes; items queued before C4 have none and are treated as 'charge'. */
  kind?: 'charge' | 'clin' | 'indirect';
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

    // Version 2: Original schema
    this.version(2).stores({
      entries: '++id, [clinId+entryDate], periodStartKey, syncStatus',
      chargeCodes: 'id',
      periodMeta: 'periodStartKey',
      syncQueue: '++id, clinId, entryDate',
    });

    // Version 3: Add 'attempts' index to syncQueue (required for .where('attempts') queries)
    this.version(3).stores({
      entries: '++id, [clinId+entryDate], periodStartKey, syncStatus',
      chargeCodes: 'id',
      periodMeta: 'periodStartKey',
      syncQueue: '++id, clinId, entryDate, attempts',
    });
  }
}

// Singleton instance
export const offlineDb = new ByTimeOfflineDB();
