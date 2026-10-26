// NOT a 'use server' module: every export of one is a public HTTP endpoint, and these helpers
// do no authorization of their own. Callers (the guarded qbo/gusto/payroll-export actions)
// authorize first.
import 'server-only';

import { getDb, getDbForWrite } from '@/db';
import {
  integrationConnections,
  integrationSyncLogs,
  integrationSyncRecords,
  integrationEntityMappings,
  timesheetEntries,
  timesheetPeriods,
  users,
  clins,
  contracts,
  indirectChargeCodes,
} from '@/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { safeErrorMessage } from '@/server/internal/import-errors';
import { UserFacingError } from '@/lib/errors';
import { INTEGRATION_DISCONNECTED_MESSAGE } from './provider-errors';
import { ensureValidToken } from './connectors/qbo-api';
import { getConnector } from './registry';
import { existingPeriodLength } from '@/server/internal/pay-period-config';
import { addDays, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import type { SyncContext, TimesheetSyncEntry, SyncResult, PayrollSyncInput } from './types';
import { loadPayrollData, type PayrollData } from '@/server/internal/payroll-data';
import { fromCents } from '@/lib/payroll/flsa';

/**
 * Get approved timesheet entries for a date range, shaped for sync.
 * Only returns entries from approved periods (DCAA requirement).
 */
export async function getApprovedEntriesForSync(
  periodStart: CalendarDate,
  periodEnd: CalendarDate
): Promise<TimesheetSyncEntry[]> {
  const db = await getDb();
  const start = parseCalendarDate(periodStart);
  const endExclusive = addDays(parseCalendarDate(periodEnd), 1);

  // Get approved periods in the range
  const approvedPeriods = await db
    .select({
      userId: timesheetPeriods.userId,
      periodStart: timesheetPeriods.periodStart,
      periodNumDays: timesheetPeriods.periodNumDays,
      approvedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.status, 'approved'),
        gte(timesheetPeriods.periodStart, start),
        lt(timesheetPeriods.periodStart, endExclusive),
      )
    );

  if (approvedPeriods.length === 0) return [];

  const entries: TimesheetSyncEntry[] = [];

  for (const period of approvedPeriods) {
    const pStart = period.periodStart as CalendarDate;
    // D3/D6 §0.6: this period's REAL length from its effective config, never a hard-coded
    // semimonthly (1st/16th) assumption — a weekly or biweekly tenant would otherwise have its
    // sync window silently truncated or overrun.
    const numDays = await existingPeriodLength(db, pStart, period.periodNumDays);
    const pEndExclusive = addDays(pStart, numDays);

    const rows = await db
      .select({
        userId: timesheetEntries.userId,
        employeeName: users.fullName,
        employeeEmail: users.email,
        entryDate: timesheetEntries.entryDate,
        hours: timesheetEntries.hours,
        clinId: timesheetEntries.clinId,
        indirectCodeId: timesheetEntries.indirectCodeId,
        clinNumber: clins.clinNumber,
        contractId: contracts.id,
        contractNumber: contracts.contractNumber,
        contractName: contracts.name,
        indirectCode: indirectChargeCodes.code,
        indirectName: indirectChargeCodes.name,
      })
      .from(timesheetEntries)
      .innerJoin(users, eq(timesheetEntries.userId, users.id))
      .leftJoin(clins, eq(timesheetEntries.clinId, clins.id))
      .leftJoin(contracts, eq(clins.contractId, contracts.id))
      .leftJoin(indirectChargeCodes, eq(timesheetEntries.indirectCodeId, indirectChargeCodes.id))
      .where(
        and(
          eq(timesheetEntries.userId, period.userId),
          gte(timesheetEntries.entryDate, pStart),
          lt(timesheetEntries.entryDate, pEndExclusive),
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND COALESCE(te2.charge_code_id, te2.indirect_code_id, te2.clin_id) = COALESCE(${timesheetEntries.chargeCodeId}, ${timesheetEntries.indirectCodeId}, ${timesheetEntries.clinId})
                AND te2.entry_date = ${timesheetEntries.entryDate}
            )`
          ),
        )
      );

    for (const row of rows) {
      const hours = parseFloat(row.hours);
      if (hours <= 0) continue; // Skip zero-hour entries

      entries.push({
        userId: row.userId,
        employeeName: row.employeeName,
        employeeEmail: row.employeeEmail,
        entryDate: row.entryDate as CalendarDate,
        hours,
        chargeCodeId: row.clinId ?? row.indirectCodeId ?? '',
        chargeCodeLabel: row.clinId
          ? `${row.contractName ?? row.contractNumber} / ${row.clinNumber}`
          : `${row.indirectCode} — ${row.indirectName}`,
        contractId: row.contractId ?? undefined,
        contractNumber: row.contractNumber ?? undefined,
        clinNumber: row.clinNumber ?? undefined,
        indirectCode: row.indirectCode ?? undefined,
        isBillable: row.clinId !== null,
        periodStart: pStart,
        approvedAt: period.approvedAt,
      });
    }
  }

  return entries;
}

/**
 * Execute a sync operation for a given connection.
 * Creates a sync log, runs the connector's push method, logs per-record results.
 */
export async function executeSyncOperation(
  connectionId: string,
  syncType: string,
  periodStart: CalendarDate,
  periodEnd: CalendarDate,
  triggeredBy: string | null,
  triggerType: 'manual' | 'auto' | 'retry' = 'manual'
): Promise<{ syncLogId: string; result: SyncResult }> {
  // A sync writes logs/records and pushes data out: only in `full` mode (write gate).
  const db = await getDbForWrite();
  // Get connection details
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection || !connection.isActive) {
    throw new UserFacingError(INTEGRATION_DISCONNECTED_MESSAGE); // audit R9
  }

  const connector = getConnector(connection.provider);
  if (!connector) {
    throw new Error(`No connector registered for provider: ${connection.provider}`);
  }

  // certified-outputs C7: payroll connectors (Gusto) get FLSA weekly-overtime totals from payroll-data — QBO stays on
  // getApprovedEntriesForSync. Loaded BEFORE the sync log, so a refusal (workweek start day unset, leave codes without
  // a pay type) creates no log.
  const payroll: PayrollData | null = connector.pushPayroll
    ? await loadPayrollData(db, parseCalendarDate(periodStart), parseCalendarDate(periodEnd))
    : null;

  // Create sync log
  const [syncLog] = await db.insert(integrationSyncLogs).values({
    connectionId,
    syncType,
    periodStart,
    periodEnd,
    triggeredBy,
    triggerType,
    status: 'running',
    startedAt: new Date(),
  }).returning();

  try {
    // Audit R9: QuickBooks access tokens last an hour — refresh (if due) now, after the `running` row exists, so a
    // refresh failure (e.g. "reconnect") lands in this sync's log. Gusto's sync makes no provider call, so its token is
    // not refreshed (that would rotate the refresh token for nothing).
    const accessToken = connection.provider === 'quickbooks_online'
      ? await ensureValidToken(connectionId)
      : connection.accessTokenEncrypted
        ? decrypt(connection.accessTokenEncrypted)
        : '';

    // Load entity mappings
    const mappingRows = await db
      .select()
      .from(integrationEntityMappings)
      .where(eq(integrationEntityMappings.connectionId, connectionId));

    const mappings = new Map<string, Map<string, string>>();
    for (const m of mappingRows) {
      if (!mappings.has(m.entityType)) {
        mappings.set(m.entityType, new Map());
      }
      mappings.get(m.entityType)!.set(m.bytimeEntityId, m.externalEntityId);
    }

    // Build sync context
    const context: SyncContext = {
      connectionId,
      syncLogId: syncLog.id,
      accessToken,
      externalCompanyId: connection.externalCompanyId ?? '',
      mappings,
    };

    // Get approved entries (QBO) or the payroll totals (Gusto)
    const entries = payroll ? [] : await getApprovedEntriesForSync(periodStart, periodEnd);

    if (payroll ? payroll.employees.length === 0 : entries.length === 0) {
      await db.update(integrationSyncLogs)
        .set({
          status: 'success',
          recordsPushed: 0,
          recordsSkipped: 0,
          recordsFailed: 0,
          completedAt: new Date(),
        })
        .where(eq(integrationSyncLogs.id, syncLog.id));

      return { syncLogId: syncLog.id, result: { pushed: 0, failed: 0, skipped: 0, errors: [] } };
    }

    // Execute the connector's push method
    let result: SyncResult;
    if (syncType === 'timesheet_push' && payroll && connector.pushPayroll) {
      result = await connector.pushPayroll(context, toPayrollSyncInput(payroll));
    } else if (syncType === 'timesheet_push' && connector.pushTimesheetEntries) {
      result = await connector.pushTimesheetEntries(context, entries);
    } else {
      throw new Error(`Sync type "${syncType}" not supported by connector "${connection.provider}".`);
    }

    // Determine overall status
    const status = result.failed === 0
      ? 'success'
      : result.pushed > 0
        ? 'partial'
        : 'failed';

    // Update sync log
    await db.update(integrationSyncLogs)
      .set({
        status,
        recordsPushed: result.pushed,
        recordsFailed: result.failed,
        recordsSkipped: result.skipped,
        errorSummary: result.errors.length > 0
          ? `${result.errors.length} records failed. First error: ${result.errors[0]?.error}`
          : null,
        completedAt: new Date(),
      })
      .where(eq(integrationSyncLogs.id, syncLog.id));

    // Update connection last sync info
    await db.update(integrationConnections)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));

    return { syncLogId: syncLog.id, result };

  } catch (error) {
    // Update sync log with failure
    await db.update(integrationSyncLogs)
      .set({
        status: 'failed',
        // Audit R7: error_summary is shown in the admin UI and the export — never a raw DB error (SQL + params). The
        // error itself is rethrown below (and reported by the caller).
        errorSummary: safeErrorMessage(error, { fallback: 'The sync failed.', logLabel: 'Integration sync failed:', report: false }),
        completedAt: new Date(),
      })
      .where(eq(integrationSyncLogs.id, syncLog.id));

    await db.update(integrationConnections)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: 'failed',
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));

    throw error;
  }
}

function toPayrollSyncInput(payroll: PayrollData): PayrollSyncInput {
  return {
    periodStart: payroll.rangeStart,
    periodEnd: payroll.rangeEnd,
    employees: payroll.employees.map((e) => ({
      userId: e.userId,
      employeeName: e.employeeName,
      regularHours: fromCents(e.regular),
      overtimeHours: fromCents(e.overtime),
      ptoHours: fromCents(e.pto),
      sickHours: fromCents(e.sick),
      holidayHours: fromCents(e.holiday),
      uncompensatedOvertimeHours: fromCents(e.uncompensatedOvertime),
      flagged: e.otBasisIncludesUnapprovedDays,
    })),
  };
}
