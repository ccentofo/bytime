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
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}
