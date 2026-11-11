import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '@/db';
import { integrationConnections, integrationEntityMappings, users } from '@/db/schema';
import { UserFacingError } from '@/lib/errors';
import { validateUUID } from '@/lib/validation';
import type { PersonMatchType } from '@/lib/integrations/sync-display';

/**
 * One QuickBooks match per person (feature-plan-ux-integrations-billing.md I4, I5). INTERNAL — the mapping actions
 * authorize (requireAdminFresh) first. Shared by setPersonMapping and matchPeopleByEmail so both validate the same way
 * and take the same per-user lock.
 */

export const PERSON_ENTITY_TYPES = ['employee', 'vendor'] as const;

export interface PersonMatch { type: PersonMatchType; externalId: string; externalName: string }

/** A match from the client → a validated one (null = "Not matched"). */
export function validatePersonMatch(value: unknown): PersonMatch | null {
  if (value === null || value === undefined) return null;
  const m = value as Partial<PersonMatch>;
  if (m.type !== 'employee' && m.type !== 'vendor') throw new UserFacingError('Choose a QuickBooks employee or vendor.');
  const externalId = typeof m.externalId === 'string' ? m.externalId.trim() : '';
  if (!externalId || externalId.length > 255) throw new UserFacingError('Choose a QuickBooks employee or vendor.');
  const externalName = typeof m.externalName === 'string' ? m.externalName.trim().slice(0, 255) : '';
  return { type: m.type, externalId, externalName: externalName || externalId };
}

export function validateMappingIds(connectionId: unknown, userId: unknown): { connectionId: string; userId: string } {
  return { connectionId: validateUUID(connectionId, 'Connection'), userId: validateUUID(userId, 'Person') };
}

/** The per-person lock (I4): taken first in the transaction, one statement per key. */
export async function lockPersonMapping(tx: Pick<DbTx, 'execute'>, connectionId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'integration-mapping:' + connectionId + ':' + userId}))`);
}

/** The connection exists, is active and is QuickBooks — Gusto matching is dropped (I10). */
export async function assertActiveQboConnection(tx: Pick<DbTx, 'select'>, connectionId: string): Promise<void> {
  const [conn] = await tx
    .select({ provider: integrationConnections.provider, isActive: integrationConnections.isActive })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!conn || !conn.isActive) throw new UserFacingError('This integration is disconnected — reconnect it on the Integrations page.');
  if (conn.provider !== 'quickbooks_online') throw new UserFacingError('People can be matched only for QuickBooks Online.');
}

/** The active users among `userIds` (one read), by id. */
export async function activeUsersById(tx: Pick<DbTx, 'select'>, userIds: string[]): Promise<Map<string, { id: string; fullName: string }>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.isActive, true)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The users among `userIds` who already have an employee or vendor match on this connection (one read). */
export async function personMappedUserIds(tx: Pick<DbTx, 'select'>, connectionId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .select({ userId: integrationEntityMappings.bytimeEntityId })
    .from(integrationEntityMappings)
    .where(and(
      eq(integrationEntityMappings.connectionId, connectionId),
      inArray(integrationEntityMappings.entityType, [...PERSON_ENTITY_TYPES]),
      inArray(integrationEntityMappings.bytimeEntityId, userIds),
    ));
  return new Set(rows.map((r) => r.userId));
}
