'use server';

import { getDb, getDbForWrite } from '@/db';
import {
  apiKeys,
  clins,
  contracts,
  indirectChargeCodes,
  integrationConnections,
  integrationEntityMappings,
  integrationSyncLogs,
  integrationSyncRecords,
  timesheetPeriods,
  users,
} from '@/db/schema';
import { and, count, countDistinct, desc, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { requireAdmin, requireAdminFresh } from '@/lib/session';
import { getAllConnectorMetadata } from '@/lib/integrations/registry';
import { addDays, type CalendarDate } from '@/lib/calendar-date';
import { userAction } from '@/lib/action-result';
import { validateUUID } from '@/lib/validation';
import { UserFacingError } from '@/lib/errors';
import { connectionExpiredError } from '@/lib/integrations/provider-errors';
import { parseSyncRecordId, periodCoverage } from '@/lib/integrations/sync-display';
import { getApprovedEntriesForSync } from '@/lib/integrations/sync-engine';
import { activeConnection, type ActiveConnection } from '@/server/internal/integrations';
import {
  PERSON_ENTITY_TYPES,
  activeUsersById,
  assertActiveQboConnection,
  lockPersonMapping,
  personMappedUserIds,
  validateMappingIds,
  validatePersonMatch,
} from '@/server/internal/integration-mapping';
import { payPeriodStartingOn } from '@/server/internal/integration-send';
import { formatDate } from '@/lib/format';

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

export async function getConnections() {
  const db = await getDb();
  await requireAdmin();
  return db
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      displayName: integrationConnections.displayName,
      externalCompanyName: integrationConnections.externalCompanyName,
      isActive: integrationConnections.isActive,
      autoSyncOnApproval: integrationConnections.autoSyncOnApproval,
      lastSyncAt: integrationConnections.lastSyncAt,
      lastSyncStatus: integrationConnections.lastSyncStatus,
      connectedAt: integrationConnections.connectedAt,
    })
    .from(integrationConnections)
    .orderBy(integrationConnections.createdAt);
}

export async function disconnectIntegration(connectionId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(integrationConnections)
      .set({
        isActive: false,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));
  });
}

export async function toggleAutoSync(connectionId: string, enabled: boolean) {
  return userAction(async () => {
    await requireAdminFresh();
    const db = await getDbForWrite();
    await db.update(integrationConnections)
      .set({
        autoSyncOnApproval: enabled,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));
  });
}

// ---------------------------------------------------------------------------
// Entity Mapping
// ---------------------------------------------------------------------------

export async function getMappings(connectionId: string) {
  const db = await getDb();
  await requireAdmin();
  return db
    .select()
    .from(integrationEntityMappings)
    .where(eq(integrationEntityMappings.connectionId, connectionId))
    .orderBy(integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityName);
}

export async function saveMapping(data: {
  connectionId: string;
  entityType: string;
  bytimeEntityId: string;
  bytimeEntityName: string;
  externalEntityId: string;
  externalEntityName: string;
  metadata?: string;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    // feature-plan-ux-integrations-billing.md I4: a person's employee/vendor match goes through setPersonMapping (one
    // match per person, under its lock) — never this generic upsert.
    if ((PERSON_ENTITY_TYPES as readonly string[]).includes(data.entityType)) throw new UserFacingError('Use the People tab.');
    const db = await getDbForWrite();

    // feature-plan-ux-page-fixes.md C13: one atomic upsert on mapping_unique_idx (connection, entity type, CadenzPoint
    // id), so two saves can't race into a unique violation; the caller gets the row's real id.
    const [row] = await db.insert(integrationEntityMappings)
      .values({
        connectionId: data.connectionId,
        entityType: data.entityType,
        bytimeEntityId: data.bytimeEntityId,
        bytimeEntityName: data.bytimeEntityName,
        externalEntityId: data.externalEntityId,
        externalEntityName: data.externalEntityName,
        metadata: data.metadata,
      })
      .onConflictDoUpdate({
        target: [integrationEntityMappings.connectionId, integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityId],
        set: {
          externalEntityId: data.externalEntityId,
          externalEntityName: data.externalEntityName,
          bytimeEntityName: data.bytimeEntityName,
          metadata: data.metadata,
          updatedAt: new Date(),
        },
      })
      .returning({ id: integrationEntityMappings.id });
    return { id: row.id };
  });
}

export async function deleteMapping(mappingId: string) {
  return userAction(async () => {
    await requireAdminFresh();
    validateUUID(mappingId, 'Mapping');
    const db = await getDbForWrite();
    const deleted = await db.delete(integrationEntityMappings).where(eq(integrationEntityMappings.id, mappingId)).returning({ id: integrationEntityMappings.id });
    if (deleted.length === 0) throw new UserFacingError('That mapping no longer exists.');
  });
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type SyncLog = Omit<typeof integrationSyncLogs.$inferSelect, 'periodStart' | 'periodEnd'> & {
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
  /** I7: failed sync records stored for this log ("See {n} failures" only when > 0). */
  failedRecords: number;
};

export async function getSyncLogs(connectionId: string, limit = 20): Promise<SyncLog[]> {
  const db = await getDb();
  await requireAdmin();
  const rows = await db
    .select({
      log: integrationSyncLogs,
      // The outer table by name: drizzle renders a column in a select list unqualified ("id"), which inside this
      // subquery would bind to the records table's own id.
      failedRecords: sql<number>`(
        SELECT count(*)::int FROM integration_sync_records r
        WHERE r.sync_log_id = integration_sync_logs.id AND r.status = 'failed'
      )`,
    })
    .from(integrationSyncLogs)
    .where(eq(integrationSyncLogs.connectionId, connectionId))
    .orderBy(desc(integrationSyncLogs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.log, failedRecords: Number(r.failedRecords) })) as SyncLog[];
}

export async function getSyncRecords(syncLogId: string) {
  const db = await getDb();
  await requireAdmin();
  return db
    .select()
    .from(integrationSyncRecords)
    .where(eq(integrationSyncRecords.syncLogId, syncLogId))
    .orderBy(integrationSyncRecords.createdAt);
}

// ---------------------------------------------------------------------------
// Connector Registry (for UI)
// ---------------------------------------------------------------------------

export async function getAvailableConnectors() {
  await requireAdmin();
  return getAllConnectorMetadata();
}

// ---------------------------------------------------------------------------
// People (feature-plan-ux-integrations-billing.md I4, I5)
// ---------------------------------------------------------------------------

/**
 * I4: one QuickBooks match per person. Replaces the person's employee AND vendor mapping in one transaction, under
 * the per-person advisory lock taken first; `match: null` is "Not matched". QuickBooks only (I10), active connection
 * and active person.
 */
export async function setPersonMapping(data: {
  connectionId: string;
  userId: string;
  match: { type: 'employee' | 'vendor'; externalId: string; externalName: string } | null;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const { connectionId, userId } = validateMappingIds(data?.connectionId, data?.userId);
    const match = validatePersonMatch(data?.match);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      await lockPersonMapping(tx, connectionId, userId);
      await assertActiveQboConnection(tx, connectionId);
      const person = (await activeUsersById(tx, [userId])).get(userId);
      if (!person) throw new UserFacingError('That person is inactive or no longer exists.');
      await tx.delete(integrationEntityMappings).where(and(
        eq(integrationEntityMappings.connectionId, connectionId),
        eq(integrationEntityMappings.bytimeEntityId, userId),
        inArray(integrationEntityMappings.entityType, [...PERSON_ENTITY_TYPES]),
      ));
      if (!match) return { mapping: null };
      const [row] = await tx.insert(integrationEntityMappings)
        .values({
          connectionId,
          entityType: match.type,
          bytimeEntityId: userId,
          bytimeEntityName: person.fullName,
          externalEntityId: match.externalId,
          externalEntityName: match.externalName,
        })
        .onConflictDoUpdate({
          target: [integrationEntityMappings.connectionId, integrationEntityMappings.entityType, integrationEntityMappings.bytimeEntityId],
          set: { externalEntityId: match.externalId, externalEntityName: match.externalName, bytimeEntityName: person.fullName, updatedAt: new Date() },
        })
        .returning();
      return { mapping: row };
    });
  });
}

const MAX_EMAIL_MATCHES = 500;

/**
 * I5: "Match {n} people by email" — fills only people who aren't matched yet. Same validator and per-person locks as
 * setPersonMapping (taken one statement at a time, sorted by key), one batched read, one batched insert.
 */
export async function matchPeopleByEmail(data: {
  connectionId: string;
  pairs: Array<{ userId: string; match: { type: 'employee' | 'vendor'; externalId: string; externalName: string } }>;
}) {
  return userAction(async () => {
    await requireAdminFresh();
    const connectionId = validateUUID(data?.connectionId, 'Connection');
    if (!Array.isArray(data?.pairs) || data.pairs.length === 0) throw new UserFacingError('No one to match.');
    if (data.pairs.length > MAX_EMAIL_MATCHES) throw new UserFacingError(`Match at most ${MAX_EMAIL_MATCHES} people at a time.`);
    const byUser = new Map<string, NonNullable<ReturnType<typeof validatePersonMatch>>>();
    for (const pair of data.pairs) {
      const { userId } = validateMappingIds(connectionId, pair?.userId);
      const match = validatePersonMatch(pair?.match);
      if (!match) throw new UserFacingError('Choose a QuickBooks employee or vendor.');
      if (!byUser.has(userId)) byUser.set(userId, match); // de-duplicated: the first pair per person wins
    }
    const userIds = [...byUser.keys()].sort();
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      for (const userId of userIds) await lockPersonMapping(tx, connectionId, userId);
      await assertActiveQboConnection(tx, connectionId);
      const [people, mapped] = [await activeUsersById(tx, userIds), await personMappedUserIds(tx, connectionId, userIds)];
      const rows = userIds
        .filter((id) => people.has(id) && !mapped.has(id))
        .map((id) => {
          const match = byUser.get(id)!;
          return {
            connectionId,
            entityType: match.type,
            bytimeEntityId: id,
            bytimeEntityName: people.get(id)!.fullName,
            externalEntityId: match.externalId,
            externalEntityName: match.externalName,
          };
        });
      if (rows.length > 0) await tx.insert(integrationEntityMappings).values(rows).onConflictDoNothing();
      return { matched: rows.length, skipped: userIds.length - rows.length };
    });
  });
}

// ---------------------------------------------------------------------------
// Hub, send preview, failures (feature-plan-ux-integrations-billing.md §3.1, I6, I7)
// ---------------------------------------------------------------------------

export interface HubLastSend {
  at: Date;
  pushed: number;
  failed: number;
  skipped: number;
  status: string;
  errorSummary: string | null;
}

export interface HubConnection {
  id: string;
  companyName: string | null;
  connectedAt: Date;
  /** No stored tokens, or the latest send failed as expired AFTER the connection was (re)connected (I9). */
  expired: boolean;
  lastSend: HubLastSend | null;
  /** Active people without an employee or vendor match (QuickBooks). */
  unmatchedPeople: number;
}

async function hubConnection(db: Awaited<ReturnType<typeof getDb>>, conn: ActiveConnection, countUnmatched: boolean): Promise<HubConnection> {
  const [log] = await db
    .select({
      at: integrationSyncLogs.createdAt,
      startedAt: integrationSyncLogs.startedAt,
      pushed: integrationSyncLogs.recordsPushed,
      failed: integrationSyncLogs.recordsFailed,
      skipped: integrationSyncLogs.recordsSkipped,
      status: integrationSyncLogs.status,
      errorSummary: integrationSyncLogs.errorSummary,
    })
    .from(integrationSyncLogs)
    .where(eq(integrationSyncLogs.connectionId, conn.id))
    .orderBy(desc(integrationSyncLogs.createdAt))
    .limit(1);
  const expiredLog = !!log
    && log.status === 'failed'
    && log.errorSummary === connectionExpiredError('QuickBooks').message
    && new Date(log.startedAt ?? log.at).getTime() > new Date(conn.connectedAt).getTime();
  let unmatchedPeople = 0;
  if (countUnmatched) {
    const mappedUsers = db
      .select({ id: integrationEntityMappings.bytimeEntityId })
      .from(integrationEntityMappings)
      .where(and(eq(integrationEntityMappings.connectionId, conn.id), inArray(integrationEntityMappings.entityType, [...PERSON_ENTITY_TYPES])));
    const [row] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.isActive, true), notInArray(users.id, mappedUsers)));
    unmatchedPeople = Number(row?.n ?? 0);
  }
  return {
    id: conn.id,
    companyName: conn.externalCompanyName,
    connectedAt: conn.connectedAt,
    expired: !conn.hasTokens || expiredLog,
    lastSend: log ? { at: log.at, pushed: log.pushed, failed: log.failed, skipped: log.skipped, status: log.status, errorSummary: log.errorSummary } : null,
    unmatchedPeople,
  };
}

/** §3.1: the Integrations page — each connector once, with its state and last send in words. Read-only. */
export async function getIntegrationHub(): Promise<{ qbo: HubConnection | null; gusto: HubConnection | null; activeApiKeys: number }> {
  await requireAdmin();
  const db = await getDb();
  const [qbo, gusto] = await Promise.all([activeConnection(db, 'quickbooks_online'), activeConnection(db, 'gusto')]);
  const [keys] = await db
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.isActive, true), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))));
  return {
    qbo: qbo ? await hubConnection(db, qbo, true) : null,
    gusto: gusto ? await hubConnection(db, gusto, false) : null,
    activeApiKeys: Number(keys?.n ?? 0),
  };
}

export interface SendPreview {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  /** People with approved hours in the period who have no QuickBooks match (their hours are skipped). */
  unmatchedPeople: number;
  /** People with a timesheet in the period that isn't approved yet (their hours aren't sent). */
  notApprovedPeople: number;
  /** The newest send that already covered this period (I6 duplicate warning). */
  sentAt: Date | null;
  /** The newest send covering it that didn't finish. */
  partlySentAt: Date | null;
}

/** I6: what "Send hours" would do for one pay period. Read-only (the approved-entry reader writes nothing). */
export async function getSendPreview(connectionId: string, periodStart: CalendarDate): Promise<SendPreview> {
  await requireAdmin();
  const id = validateUUID(connectionId, 'Connection');
  const db = await getDb();
  const period = await payPeriodStartingOn(db, periodStart);

  const entries = await getApprovedEntriesForSync(period.start, period.end);
  const peopleWithHours = [...new Set(entries.map((e) => e.userId))];
  const mapped = peopleWithHours.length > 0
    ? new Set((await db
      .select({ userId: integrationEntityMappings.bytimeEntityId })
      .from(integrationEntityMappings)
      .where(and(
        eq(integrationEntityMappings.connectionId, id),
        inArray(integrationEntityMappings.entityType, [...PERSON_ENTITY_TYPES]),
        inArray(integrationEntityMappings.bytimeEntityId, peopleWithHours),
      ))).map((r) => r.userId))
    : new Set<string>();

  const [notApproved] = await db
    .select({ n: countDistinct(timesheetPeriods.userId) })
    .from(timesheetPeriods)
    .innerJoin(users, eq(users.id, timesheetPeriods.userId))
    .where(and(
      eq(users.isActive, true),
      ne(timesheetPeriods.status, 'approved'),
      gte(timesheetPeriods.periodStart, period.start),
      lt(timesheetPeriods.periodStart, addDays(period.end, 1)),
    ));

  // UX-4C2B-AUDIT.md F1: sends from EVERY row of the same QuickBooks company count (legacy reconnects inserted new
  // rows), so a period sent from an older row still warns.
  const [conn] = await db
    .select({ provider: integrationConnections.provider, companyId: integrationConnections.externalCompanyId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id))
    .limit(1);
  const sameCompany = conn?.companyId
    ? (await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(and(eq(integrationConnections.provider, conn.provider), eq(integrationConnections.externalCompanyId, conn.companyId))))
      .map((r) => r.id)
    : [id];
  const logs = await db
    .select({
      status: integrationSyncLogs.status,
      recordsPushed: integrationSyncLogs.recordsPushed,
      periodStart: integrationSyncLogs.periodStart,
      periodEnd: integrationSyncLogs.periodEnd,
      startedAt: integrationSyncLogs.startedAt,
      createdAt: integrationSyncLogs.createdAt,
    })
    .from(integrationSyncLogs)
    .where(inArray(integrationSyncLogs.connectionId, sameCompany.length > 0 ? sameCompany : [id]));
  const coverage = periodCoverage(
    logs.map((l) => ({ ...l, periodStart: l.periodStart as CalendarDate | null, periodEnd: l.periodEnd as CalendarDate | null })),
    period.start,
    Date.now(),
  );

  return {
    periodStart: period.start,
    periodEnd: period.end,
    unmatchedPeople: peopleWithHours.filter((u) => !mapped.has(u)).length,
    notApprovedPeople: Number(notApproved?.n ?? 0),
    ...coverage,
  };
}

const MAX_FAILURES_SHOWN = 500;

/** I7: a send's failed records, labelled on the server ("{person} · {code} · {date}"; unknown → the raw id). */
export async function getSyncFailures(syncLogId: string): Promise<Array<{ id: string; label: string; error: string | null }>> {
  await requireAdmin();
  const id = validateUUID(syncLogId, 'Send');
  const db = await getDb();
  const records = await db
    .select({ id: integrationSyncRecords.id, entityId: integrationSyncRecords.bytimeEntityId, error: integrationSyncRecords.errorMessage })
    .from(integrationSyncRecords)
    .where(and(eq(integrationSyncRecords.syncLogId, id), eq(integrationSyncRecords.status, 'failed')))
    .orderBy(integrationSyncRecords.createdAt)
    .limit(MAX_FAILURES_SHOWN);

  const parsed = records.map((r) => ({ ...r, key: parseSyncRecordId(r.entityId) }));
  const userIds = [...new Set(parsed.flatMap((r) => (r.key ? [r.key.userId] : [])))];
  const codeIds = [...new Set(parsed.flatMap((r) => (r.key ? [r.key.codeId] : [])))];
  const [people, clinRows, indirectRows] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, userIds)) : [],
    codeIds.length
      ? db.select({ id: clins.id, clinNumber: clins.clinNumber, contract: sql<string>`coalesce(${contracts.name}, ${contracts.contractNumber})` })
        .from(clins).leftJoin(contracts, eq(contracts.id, clins.contractId)).where(inArray(clins.id, codeIds))
      : [],
    codeIds.length
      ? db.select({ id: indirectChargeCodes.id, code: indirectChargeCodes.code }).from(indirectChargeCodes).where(inArray(indirectChargeCodes.id, codeIds))
      : [],
  ]);
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const codeLabel = new Map<string, string>([
    ...clinRows.map((c) => [c.id, c.contract ? `${c.contract} / ${c.clinNumber}` : c.clinNumber] as [string, string]),
    ...indirectRows.map((c) => [c.id, c.code] as [string, string]),
  ]);

  return parsed.map((r) => {
    const name = r.key && personName.get(r.key.userId);
    const code = r.key && codeLabel.get(r.key.codeId);
    return {
      id: r.id,
      label: r.key && name && code ? `${name} · ${code} · ${formatDate(r.key.date)}` : r.entityId,
      error: r.error,
    };
  });
}
