import 'server-only';
import type { ReadDb, TenantWriter } from '@/db';
import { users, contracts, clins, indirectChargeCodes } from '@/db/schema';
import type { MigrationEntryRow, MigrationPeriodRow, MigrationPeriodValidationResult, MigrationValidationResult } from '@/types/migration';
import { isCalendarDate, parseCalendarDate } from '@/lib/calendar-date';
import { resolvePeriod } from '@/server/internal/periods';

/**
 * Validate migration rows against existing data and resolve their ids (feature-plan-launch-blockers.md P4 §2:
 * shared by validateMigrationData and importMigrationData, which must not call each other). INTERNAL: read-only;
 * the caller is a guarded action and passes its client.
 */
export async function validateMigrationDataInternal(
  db: Pick<ReadDb, 'select'> | TenantWriter,
  rows: MigrationEntryRow[],
): Promise<MigrationValidationResult[]> {

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
    } else if (!isCalendarDate(row.entryDate.trim())) {
      errors.push('Entry Date must be a real date in YYYY-MM-DD format');
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
 * Validate period-status rows (feature-plan-certified-outputs.md C1): employee exists, the period start is a real period
 * start under the workspace's pay schedule. Status/date/overlap rules are decided under the locks at import
 * (planPeriodImport); this gives the admin the row-level answer before Import. INTERNAL, read-only.
 */
export async function validateMigrationPeriodsInternal(
  db: Pick<ReadDb, 'select'> | TenantWriter,
  rows: MigrationPeriodRow[],
): Promise<MigrationPeriodValidationResult[]> {
  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const userMap = new Map(allUsers.map((u) => [u.email.toLowerCase(), u.id]));
  const startOk = new Map<string, boolean>();

  const results: MigrationPeriodValidationResult[] = [];
  for (const [index, row] of rows.entries()) {
    const errors: string[] = [];
    const userId = row.employeeEmail?.trim() ? userMap.get(row.employeeEmail.toLowerCase().trim()) : undefined;
    if (!row.employeeEmail?.trim()) errors.push('Employee Email is required');
    else if (!userId) errors.push(`Employee "${row.employeeEmail}" not found in CadenzPoint`);

    const start = row.periodStart?.trim() ?? '';
    if (!isCalendarDate(start)) {
      errors.push('Period Start must be a real date in YYYY-MM-DD format');
    } else {
      if (!startOk.has(start)) startOk.set(start, await resolvePeriod(parseCalendarDate(start)).then(() => true, () => false));
      if (!startOk.get(start)) {
        errors.push(`${start} is not a period start under this workspace's pay schedule. Set the pay schedule in Settings before importing periods.`);
      }
    }
    const status = row.status?.trim().toLowerCase() ?? '';
    if (status === 'draft') errors.push('Draft periods are not imported — only submitted, approved or rejected periods.');
    else if (!['submitted', 'approved', 'rejected'].includes(status)) errors.push(`Status "${row.status}" is not importable. Use submitted, approved or rejected.`);

    results.push({ rowIndex: index + 1, data: row, errors, isValid: errors.length === 0, userId });
  }
  return results;
}
