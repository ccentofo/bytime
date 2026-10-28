import type { PeriodConfig } from '@/lib/date-utils';
import type { CalendarDate } from '@/lib/calendar-date';
import type { CurrentPeriodSummary } from '@/server/internal/employee-dashboard';

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
  /** feature-plan-ux-timesheet-ui.md §4.14: the row's name — charge_codes.name, the indirect code's name, or the CLIN description. */
  name: string;
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
  // ── Page context (feature-plan-ux-timesheet-ui.md §4.4): set at mount and by SET_PAGE_CONTEXT, never by a period load.
  userId: string;
  today: CalendarDate; // workspace "today" (server-resolved, never the browser's clock)
  // feature-plan-terms-compliance.md §3.2: the workspace's access mode is read_only (trial ended
  // or subscription ended). UI-only — disables entry so the DCAA reason-code flow doesn't even
  // open for a save that getDbForWrite() would reject anyway; the server gate is the real control.
  readOnly: boolean;
  flsaExempt: boolean; // true if user is FLSA exempt (salaried)

  // ── Period data (SET_PERIOD_DATA sets every one of these).
  periodStart: CalendarDate;
  periodEnd: CalendarDate; // periodStart + numDays − 1
  numDays: number; // the period's length, resolved by the server (never computed client-side)
  periodConfig: PeriodConfig; // pay period configuration
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];           // current working values (includes unsaved edits)
  savedEntries: TimesheetEntry[];      // last-saved snapshot (from DB)
  savedCellRevisions: Record<string, number>; // key="rowId-dayIndex", value=max revision number
  periodStatus: PeriodStatus; // current period's approval status
  approvalBadge: string | null; // certified-outputs C2: "Self-approved" / "Self-rejected" (approvalLabel), else null
  notes: Record<string, string>;       // working copy of note BODIES, key = "rowId-dayIndex" (UX-3 A4.9)
  savedNotes: Record<string, SavedNote>; // the saved baseline; a cleared note stays as { body: '', revision: n }
  reviewComment: string | null;
  summary: CurrentPeriodSummary | null;
  submitOpensOn: CalendarDate;
  workweekStartDay: number | null;
  outsideWeekHours: Record<string, number>;
  userCreatedOn: CalendarDate;
  isCurrent: boolean; // the period on screen contains the workspace's today
  submittedOn: CalendarDate | null; // workspace calendar day (§4.14)
  reviewedOn: CalendarDate | null;

  // ── Transient.
  isSaving: boolean;
  isLoadingPeriod: boolean; // true while fetching data for a new period
  /** Bumped only by the render-time re-sync (a new initialData object). */
  syncGen: number;
  /** Bumped by BEGIN_PERIOD_LOAD; a load result carrying an older loadGen is ignored (latest load wins). */
  loadGen: number;
  activeNoteCell: { chargeCodeId: string; dayIndex: number; editable: boolean } | null;
}

/** A period load's generations: its result applies only if both still match (§4.4). */
export interface LoadGen { loadGen: number; syncGen: number }

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; body: string }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number; editable: boolean }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'BEGIN_PERIOD_LOAD' }
  | { type: 'PERIOD_LOAD_FAILED'; gen: LoadGen }
  | ({ type: 'SET_PERIOD_DATA'; resync?: boolean; gen?: LoadGen } & TimesheetPeriodData)
  | { type: 'SET_PAGE_CONTEXT'; today: CalendarDate; readOnly: boolean; flsaExempt?: boolean; gen?: LoadGen }
  | { type: 'SET_SAVING'; isSaving: boolean }
  | { type: 'MARK_SAVED'; periodStart: CalendarDate; syncGen: number; entries: TimesheetEntry[]; revisions: Record<string, number>; sentNotes?: Record<string, string>; noteRevisions?: Record<string, number> }
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

/**
 * One period as getTimesheetPeriod returns it (feature-plan-ux-timesheet-ui.md §4.4, §4.14). `today` and `readOnly` are
 * the server's view at load time; the client applies them through SET_PAGE_CONTEXT, never SET_PERIOD_DATA.
 */
export interface TimesheetPeriodData {
  periodStart: CalendarDate;
  isCurrent: boolean;
  numDays: number;
  periodConfig: PeriodConfig;
  entries: TimesheetEntry[];
  revisions: Record<string, number>;
  periodStatus: PeriodStatus;
  approvalBadge: string | null;
  chargeCodes: ChargeCode[];
  notes: Record<string, SavedNote>;
  reviewComment: string | null;
  summary: CurrentPeriodSummary;
  submitOpensOn: CalendarDate;
  workweekStartDay: number | null;
  outsideWeekHours: Record<string, number>;
  userCreatedOn: CalendarDate;
  submittedOn: CalendarDate | null;
  reviewedOn: CalendarDate | null;
  today: CalendarDate;
  readOnly: boolean;
}

/** Props passed from server to client: the page context plus the period (§4.4). */
export interface TimesheetPageData {
  userId: string;
  today: CalendarDate;
  readOnly: boolean;
  flsaExempt: boolean;
  period: TimesheetPeriodData;
}
