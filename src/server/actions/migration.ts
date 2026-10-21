'use server';

import { getDb } from '@/db';
import { timesheetEntries, timesheetPeriods, users, contracts, clins, indirectChargeCodes } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { parseCalendarDate } from '@/lib/calendar-date';

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

/**
 * Validate migration rows against existing data.
 * Returns validation results without importing.
 */
export async function validateMigrationData(
  rows: MigrationEntryRow[]
): Promise<MigrationValidationResult[]> {
  const db = await getDb();
  await requireAdmin();

  // Pre-fetch all lookups
  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const allContracts = await db.select({ id: contracts.id, contractNumber: contracts.contractNumber }).from(contracts);
  const allClins = await db.select({ id: clins.id, clinNumber: clins.clinNumber, contractId: clins.contractId }).from(clins);
  const allIndirect = await db.select({ id: indirectChargeCodes.id, code: indirectChargeCodes.code }).from(indirectChargeCodes);

  const userMap = new Map(allUsers.map((u) => [u.email.toLowerCase(), u.id]));
  const contractMap = new Map(allContracts.map((c) => [c.contractNumber, c.id]));
  const indirectMap = new Map(allIndirect.map((ic) => [ic.code, ic.id]));

  return rows.map((row, index) => {
    const errors: string[] = [];
    let userId: string | undefined;
    let clinId: string | undefined;
    let indirectCodeId: string | undefined;

    // Validate employee
    if (!row.employeeEmail?.trim()) {
      errors.push('Employee Email is required');
    } else {
      userId = userMap.get(row.employeeEmail.toLowerCase().trim());
      if (!userId) errors.push(`Employee "${row.employeeEmail}" not found in CadenzPoint`);
    }

    // Validate date
    if (!row.entryDate?.trim()) {
      errors.push('Entry Date is required');
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.entryDate.trim())) {
      errors.push('Entry Date must be YYYY-MM-DD format');
    }

    // Validate hours
    const hours = parseFloat(row.hours);
    if (isNaN(hours) || hours < 0 || hours > 24) {
      errors.push('Hours must be between 0 and 24');
    }

    // Validate charge code (either direct or indirect, not both)
    const hasDirect = row.contractNumber?.trim() && row.clinNumber?.trim();
    const hasIndirect = row.indirectCode?.trim();

    if (!hasDirect && !hasIndirect) {
      errors.push('Either Contract/CLIN or Indirect Code is required');
    }
    if (hasDirect && hasIndirect) {
      errors.push('Cannot have both Contract/CLIN and Indirect Code');
    }

    if (hasDirect) {
      const contractId = contractMap.get(row.contractNumber.trim());
      if (!contractId) {
        errors.push(`Contract "${row.contractNumber}" not found`);
      } else {
        const clin = allClins.find(
          (c) => c.contractId === contractId && c.clinNumber === row.clinNumber.trim()
        );
        if (!clin) {
          errors.push(`CLIN "${row.clinNumber}" not found under contract "${row.contractNumber}"`);
        } else {
          clinId = clin.id;
        }
      }
    }

    if (hasIndirect) {
      indirectCodeId = indirectMap.get(row.indirectCode.trim());
      if (!indirectCodeId) {
        errors.push(`Indirect code "${row.indirectCode}" not found`);
      }
    }

    return {
      rowIndex: index + 1,
      data: row,
      errors,
      isValid: errors.length === 0,
      userId,
      clinId,
      indirectCodeId,
    };
  });
}

/**
 * Import validated migration data into the database.
 * Only imports valid rows. Skips duplicates.
 */
export async function importMigrationData(
  rows: MigrationEntryRow[]
): Promise<MigrationResult> {
  const db = await getDb();
  await requireAdminFresh();

  // Re-validate to get resolved IDs
  const validated = await validateMigrationData(rows);
  const validRows = validated.filter((v) => v.isValid);

  const result: MigrationResult = { imported: 0, skipped: 0, errors: [] };

  for (const row of validRows) {
    try {
      const entryDate = parseCalendarDate(row.data.entryDate.trim());
      const hours = parseFloat(row.data.hours);
      const createdAt = row.data.createdAt?.trim()
        ? new Date(row.data.createdAt.trim())
        : new Date(`${row.data.entryDate}T17:00:00Z`);

      await db.insert(timesheetEntries).values({
        userId: row.userId!,
        clinId: row.clinId ?? null,
        indirectCodeId: row.indirectCodeId ?? null,
        entryDate,
        hours: hours.toString(),
        revisionNumber: 1,
        changeReasonCode: row.data.changeReason?.trim() || 'MIGRATION',
        comment: row.data.comment?.trim() || 'Imported from legacy system',
        createdAt,
        createdBy: row.userId!,
      });

      result.imported++;
    } catch (error) {
      result.errors.push({ row: row.rowIndex, message: String(error) });
    }
  }

  return result;
}

/**
 * Import period status records.
 */
export async function importMigrationPeriods(
  rows: Array<{
    employeeEmail: string;
    periodStart: string;
    status: string;
    submittedAt: string;
    reviewedAt: string;
    reviewedByEmail: string;
    reviewComment: string;
  }>
): Promise<MigrationResult> {
  const db = await getDb();
  await requireAdminFresh();

  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const userMap = new Map(allUsers.map((u) => [u.email.toLowerCase(), u.id]));

  const result: MigrationResult = { imported: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const userId = userMap.get(row.employeeEmail.toLowerCase().trim());
      if (!userId) {
        result.errors.push({ row: i + 1, message: `Employee "${row.employeeEmail}" not found` });
        continue;
      }

      const reviewedBy = row.reviewedByEmail?.trim()
        ? userMap.get(row.reviewedByEmail.toLowerCase().trim())
        : null;

      const status = (['draft', 'submitted', 'approved', 'rejected'].includes(row.status?.toLowerCase()))
        ? row.status.toLowerCase() as 'draft' | 'submitted' | 'approved' | 'rejected'
        : 'draft';

      await db.insert(timesheetPeriods).values({
        userId,
        periodStart: parseCalendarDate(row.periodStart.trim()),
        status,
        submittedAt: row.submittedAt?.trim() ? new Date(row.submittedAt.trim()) : null,
        submittedComment: null,
        reviewedAt: row.reviewedAt?.trim() ? new Date(row.reviewedAt.trim()) : null,
        reviewedBy: reviewedBy ?? null,
        reviewComment: row.reviewComment?.trim() || null,
      }).onConflictDoNothing(); // Skip if period already exists

      result.imported++;
    } catch (error) {
      result.errors.push({ row: i + 1, message: String(error) });
    }
  }

  return result;
}
