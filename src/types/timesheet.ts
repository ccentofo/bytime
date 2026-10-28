import type { PeriodConfig } from '@/lib/date-utils';
import type { CalendarDate } from '@/lib/calendar-date';

export interface ChargeCode {
  id: string;             // chargeCodeId for DIRECT codes; clins.id for a legacy CLIN row; indirectChargeCodes.id for indirect
  /**
   * feature-plan-certified-outputs.md C4: which column a save writes — `charge` → chargeCodeId, `clin` (a legacy
   * CLIN-only row) → clinId, `indirect` → indirectCodeId.
   */
  kind: 'charge' | 'clin' | 'indirect';
  /**
   * New hours may be added (empty days editable). False for a code no longer assigned or no longer active, and always for
   * a legacy CLIN row (ruling Q1): such rows are correction-only — days with a prior revision stay correctable (CO-D8).
   */
  assignable: boolean;
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
  /** C1 display: per day, the label of an imported (or legacy-imported) latest revision, else null. */
  provenance?: Array<string | null>;
}

/** A saved note (feature-plan-ux-timesheet.md A4.3): its latest body ('' = cleared) and revision. */
export interface SavedNote {
  body: string;
  revision: number;
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
  notes: Record<string, string>;       // working copy of note BODIES, key = "rowId-dayIndex" (UX-3 A4.9)
  savedNotes: Record<string, SavedNote>; // the saved baseline; a cleared note stays as { body: '', revision: n }
  periodStart: CalendarDate;
  numDays: number; // the period's length, resolved by the server (never computed client-side)
  activeNoteCell: { chargeCodeId: string; dayIndex: number; editable: boolean } | null;
  userId: string;
  isSaving: boolean;
  isLoadingPeriod: boolean; // true while fetching data for a new period
  periodStatus: PeriodStatus; // current period's approval status
  isCurrent: boolean; // UX-3 A4.6: the period on screen contains the workspace's today (Next is disabled)
  approvalBadge: string | null; // certified-outputs C2: "Self-approved" / "Self-rejected" (approvalLabel), else null
  flsaExempt: boolean; // true if user is FLSA exempt (salaried)
  periodConfig: PeriodConfig; // pay period configuration
  today: CalendarDate; // workspace "today" (server-resolved, never the browser's clock)
  // feature-plan-terms-compliance.md §3.2: the workspace's access mode is read_only (trial ended
  // or subscription ended). UI-only — disables entry so the DCAA reason-code flow doesn't even
  // open for a save that getDbForWrite() would reject anyway; the server gate is the real control.
  readOnly: boolean;
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; body: string }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number; editable: boolean }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'BEGIN_PERIOD_LOAD' }
  | { type: 'PERIOD_LOAD_FAILED' }
  | { type: 'SET_PERIOD_DATA'; periodStart: CalendarDate; numDays: number; entries: TimesheetEntry[]; revisions: Record<string, number>; periodStatus: PeriodStatus; periodConfig: PeriodConfig; approvalBadge?: string | null; chargeCodes: ChargeCode[]; notes?: Record<string, SavedNote>; isCurrent?: boolean }
  | { type: 'SET_SAVING'; isSaving: boolean }
  | { type: 'MARK_SAVED'; periodStart: CalendarDate; entries: TimesheetEntry[]; revisions: Record<string, number>; sentNotes?: Record<string, string>; noteRevisions?: Record<string, number> }
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
  approvalBadge?: string | null;
  flsaExempt?: boolean;
  dashboardData?: EmployeeDashboardData;
  periodConfig: PeriodConfig;
  readOnly: boolean;
  /** UX-3 A4.9: the period's saved notes, so they show on first load (not only after navigating). */
  notes?: Record<string, SavedNote>;
  /** UX-3 A4.6: the period contains the workspace's today. */
  isCurrent?: boolean;
}
