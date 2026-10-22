'use server';

import { isUniqueViolation } from '@/lib/db-errors';
import { resolvePeriod } from '@/server/internal/periods';
import { getDb, getDbForWrite } from '@/db';
import { timesheetEntries, timesheetPeriods, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { parseCalendarDate } from '@/lib/calendar-date';
import { validateMigrationDataInternal } from '@/server/internal/migration';
import type { MigrationEntryRow, MigrationResult, MigrationValidationResult } from '@/types/migration';
import { userAction, type ActionResult } from '@/lib/action-result';

/**
 * Validate migration rows against existing data.
 * Returns validation results without importing.
 */
export async function validateMigrationData(
  rows: MigrationEntryRow[]
): Promise<MigrationValidationResult[]> {
  const db = await getDb();
  await requireAdmin();
  return validateMigrationDataInternal(db, rows);
}

/**
 * Import validated migration data into the database.
 * Only imports valid rows. Skips duplicates.
 */
export async function importMigrationData(
  rows: MigrationEntryRow[]
): Promise<ActionResult<MigrationResult>> {
  return userAction(async () => {
    const db = await getDbForWrite();
    await requireAdminFresh();

    // Re-validate to get resolved IDs
    const validated = await validateMigrationDataInternal(db, rows);
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
        result.errors.push({
          row: row.rowIndex,
          // Never surface raw SQL (it includes every parameter) to the admin.
          message: isUniqueViolation(error, 'entries_user_code_date_rev_unique_idx')
            ? `An entry for this employee, code and date (${row.data.entryDate}) already exists.`
            : 'Could not import this row.',
        });
        if (!isUniqueViolation(error)) console.error('Migration import row failed:', error);
      }
    }

    return result;
  });
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
): Promise<ActionResult<MigrationResult>> {
  return userAction(async () => {
    const db = await getDbForWrite();
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

        // Must be a real period of this workspace's pay schedule, and is stored with its length
        // snapshot like every other period, so later readers never have to re-derive it.
        const periodStart = parseCalendarDate(row.periodStart.trim());
        let resolved: Awaited<ReturnType<typeof resolvePeriod>>;
        try {
          resolved = await resolvePeriod(periodStart);
        } catch {
          result.errors.push({
            row: i + 1,
            message: `${row.periodStart} is not a period start under this workspace's pay schedule. Set the pay schedule in Settings before importing periods.`,
          });
          continue;
        }

        await db.insert(timesheetPeriods).values({
          userId,
          periodStart,
          periodType: resolved.config.periodType,
          periodNumDays: resolved.numDays,
          status,
          submittedAt: row.submittedAt?.trim() ? new Date(row.submittedAt.trim()) : null,
          submittedComment: null,
          reviewedAt: row.reviewedAt?.trim() ? new Date(row.reviewedAt.trim()) : null,
          reviewedBy: reviewedBy ?? null,
          reviewComment: row.reviewComment?.trim() || null,
        }).onConflictDoNothing(); // Skip if period already exists

        result.imported++;
      } catch (error) {
        console.error('Migration period import row failed:', error);
        result.errors.push({ row: i + 1, message: 'Could not import this row.' });
      }
    }

    return result;
  });
}
