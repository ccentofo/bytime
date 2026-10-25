/** Legacy-data migration shapes (shared by the migration action, its internal validator, and the client). */
export interface MigrationEntryRow {
  employeeEmail: string;
  entryDate: string;
  contractNumber: string;
  clinNumber: string;
  indirectCode: string;
  hours: string;
  changeReason: string;
  comment: string;
  createdAt: string;
  /** Optional "Entered By" column (feature-plan-certified-outputs.md C1): the original author, kept as data only. */
  enteredBy?: string;
}

/** A period-status migration row (CSV columns: Employee Email, Period Start, Status, Submitted At, Reviewed At,
 * Reviewed By Email, Review Comment). */
export interface MigrationPeriodRow {
  employeeEmail: string;
  periodStart: string;
  status: string;
  submittedAt: string;
  reviewedAt: string;
  reviewedByEmail: string;
  reviewComment: string;
}

export interface MigrationPeriodValidationResult {
  rowIndex: number;
  data: MigrationPeriodRow;
  errors: string[];
  isValid: boolean;
  userId?: string;
}

export interface MigrationValidationResult {
  rowIndex: number;
  data: MigrationEntryRow;
  errors: string[];
  isValid: boolean;
  // Resolved IDs (populated during validation)
  userId?: string;
  clinId?: string;
  indirectCodeId?: string;
}

export interface MigrationResult {
  imported: number;
  /** Rows not imported because they were already imported (periods); entries never skip silently. */
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  /** The import_batches row written for this batch (null when nothing was inserted). */
  batchId: string | null;
}
