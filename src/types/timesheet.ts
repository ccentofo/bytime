export interface ChargeCode {
  id: string;             // maps to clins.id OR indirectChargeCodes.id (UUID)
  projectName: string;    // maps to contracts.name OR indirect category name
  clin: string;           // maps to clins.clinNumber OR indirect code
  description: string;    // maps to clins.description OR indirect description
  slinId?: string;        // maps to slins.id (UUID) — optional, only for direct
  slinNumber?: string;    // maps to slins.slinNumber — optional, only for direct
  isIndirect?: boolean;   // true if this is an indirect charge code
  indirectCategory?: string; // overhead | ga | irad | bp | leave | unallowable
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

export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

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
  isLoadingPeriod: boolean; // true while fetching data for a new period
  periodStatus: PeriodStatus; // current period's approval status
  flsaExempt: boolean; // true if user is FLSA exempt (salaried)
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'NAVIGATE_PERIOD'; direction: 'prev' | 'next' }
  | { type: 'SET_PERIOD_DATA'; periodStart: Date; entries: TimesheetEntry[]; revisions: Record<string, number>; periodStatus?: PeriodStatus }
  | { type: 'SET_SAVING'; isSaving: boolean }
  | { type: 'MARK_SAVED'; entries: TimesheetEntry[]; revisions: Record<string, number> }
  | { type: 'DISCARD_CHANGES' }
  | { type: 'SET_PERIOD_STATUS'; status: PeriodStatus };

// Represents a single dirty cell to save
export interface DirtyCell {
  chargeCodeId: string; // clinId
  dayIndex: number;
  hours: number;
  isEdit: boolean;      // true if this cell has a prior saved value (revision > 0)
  isLateEntry: boolean; // true if this is a first-time entry on a past date (revision = 0 AND date < today)
}

import type { EmployeeDashboardData } from '@/server/actions/employee-dashboard';

// Props passed from server to client
export interface TimesheetPageData {
  userId: string;
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  periodStart: Date;
  revisions?: Record<string, number>;
  periodStatus?: PeriodStatus;
  flsaExempt?: boolean;
  dashboardData?: EmployeeDashboardData;
}
