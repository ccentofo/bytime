'use server';

import { db } from '@/db';
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
import dayjs from 'dayjs';
import { decrypt } from '@/lib/encryption';
import { getConnector } from './registry';
import type { SyncContext, TimesheetSyncEntry, SyncResult } from './types';

/**
 * Get approved timesheet entries for a date range, shaped for sync.
 * Only returns entries from approved periods (DCAA requirement).
 */
export async function getApprovedEntriesForSync(
  periodStart: Date,
  periodEnd: Date
): Promise<TimesheetSyncEntry[]> {
  const endExclusive = dayjs(periodEnd).add(1, 'day').toDate();

  // Get approved periods in the range
  const approvedPeriods = await db
    .select({
      userId: timesheetPeriods.userId,
      periodStart: timesheetPeriods.periodStart,
      approvedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.status, 'approved'),
        gte(timesheetPeriods.periodStart, periodStart),
        lt(timesheetPeriods.periodStart, endExclusive),
      )
    );

  if (approvedPeriods.length === 0) return [];

  const entries: TimesheetSyncEntry[] = [];

  for (const period of approvedPeriods) {
    const numDays = dayjs(period.periodStart).date() === 1 ? 15 : dayjs(period.periodStart).daysInMonth() - 15;
    const pEnd = dayjs(period.periodStart).add(numDays, 'day').toDate();

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
          gte(timesheetEntries.entryDate, period.periodStart),
          lt(timesheetEntries.entryDate, pEnd),
          eq(
            timesheetEntries.revisionNumber,
            sql`(
              SELECT MAX(te2.revision_number)
              FROM timesheet_entries te2
              WHERE te2.user_id = ${timesheetEntries.userId}
                AND COALESCE(te2.clin_id, te2.indirect_code_id) = COALESCE(${timesheetEntries.clinId}, ${timesheetEntries.indirectCodeId})
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
        entryDate: row.entryDate,
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
        periodStart: period.periodStart,
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
  periodStart: Date,
  periodEnd: Date,
  triggeredBy: string | null,
  triggerType: 'manual' | 'auto' | 'retry' = 'manual'
): Promise<{ syncLogId: string; result: SyncResult }> {
  // Get connection details
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection || !connection.isActive) {
    throw new Error('Integration connection not found or inactive.');
  }

  const connector = getConnector(connection.provider);
  if (!connector) {
    throw new Error(`No connector registered for provider: ${connection.provider}`);
  }

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
    // Decrypt access token
    const accessToken = connection.accessTokenEncrypted
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

    // Get approved entries
    const entries = await getApprovedEntriesForSync(periodStart, periodEnd);

    if (entries.length === 0) {
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
    if (syncType === 'timesheet_push' && connector.pushTimesheetEntries) {
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
        errorSummary: String(error),
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
