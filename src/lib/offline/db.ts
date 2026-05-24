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
