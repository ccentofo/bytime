import type { PeriodConfig } from '@/lib/date-utils';
import type { CalendarDate } from '@/lib/calendar-date';

export interface ChargeCode {
  id: string;             // chargeCodeId for DIRECT codes; indirectChargeCodes.id for indirect
  projectName: string;    // contracts.name for direct; indirect category label for indirect
  clin: string;           // charge_codes.code for direct (the charge code string); indirect code for indirect
  description: string;    // charge_codes.name or description; indirect description
  slinId?: string;        // slins.id — optional, only for direct
  slinNumber?: string;    // slins.slinNumber — optional, only for direct
  isIndirect?: boolean;   // true if this is an indirect charge code
  indirectCategory?: string; // overhead | ga | irad | bp | leave | unallowable
  // Extended fields for direct charge codes (undefined for indirect):
  clinId?: string;        // the underlying clin_id (for denormalization on save + supervisor scope)
  clinNumber?: string;    // clins.clinNumber
  workLocation?: 'onsite' | 'telework' | 'other' | null;
  className?: string;     // cost_classes.name
  billable?: boolean;
}

export interface TimesheetEntry {
  chargeCodeId: string;
  hours: number[]; // variable length — matches the number of days in the active pay period
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
  periodStart: CalendarDate;
  numDays: number; // the period's length, resolved by the server (never computed client-side)
  activeNoteCell: { chargeCodeId: string; dayIndex: number } | null;
  userId: string;
  isSaving: boolean;
  isLoadingPeriod: boolean; // true while fetching data for a new period
  periodStatus: PeriodStatus; // current period's approval status
  flsaExempt: boolean; // true if user is FLSA exempt (salaried)
  periodConfig: PeriodConfig; // pay period configuration
  today: CalendarDate; // workspace "today" (server-resolved, never the browser's clock)
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'BEGIN_PERIOD_LOAD' }
  | { type: 'PERIOD_LOAD_FAILED' }
  | { type: 'SET_PERIOD_DATA'; periodStart: CalendarDate; numDays: number; entries: TimesheetEntry[]; revisions: Record<string, number>; periodStatus: PeriodStatus; periodConfig: PeriodConfig }
  | { type: 'SET_SAVING'; isSaving: boolean }
  | { type: 'MARK_SAVED'; periodStart: CalendarDate; entries: TimesheetEntry[]; revisions: Record<string, number> }
  | { type: 'DISCARD_CHANGES' }
  | { type: 'SET_PERIOD_STATUS'; status: PeriodStatus }
  | { type: 'SET_TODAY'; today: CalendarDate };

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
  periodStart: CalendarDate;
  numDays: number;
  today: CalendarDate;
  revisions?: Record<string, number>;
  periodStatus?: PeriodStatus;
  flsaExempt?: boolean;
  dashboardData?: EmployeeDashboardData;
  periodConfig: PeriodConfig;
}
