export interface ChargeCode {
  id: string;
  projectName: string;
  clin: string;
  description: string;
}

export interface TimesheetEntry {
  chargeCodeId: string;
  hours: number[]; // variable length — matches the number of days in the active semi-monthly period
}

export interface NoteData {
  comment: string;
  reasonCode: string;
}

export interface TimesheetState {
  chargeCodes: ChargeCode[];
  entries: TimesheetEntry[];
  notes: Record<string, NoteData>; // key = "chargeCodeId-dayIndex"
  periodStart: Date;
  activeNoteCell: { chargeCodeId: string; dayIndex: number } | null;
}

export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'NAVIGATE_PERIOD'; direction: 'prev' | 'next' };
