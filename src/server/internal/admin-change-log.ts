import 'server-only';
import type { TenantWriter } from '@/db';
import { adminChangeLog } from '@/db/schema';

/**
 * THE writer of `admin_change_log` (feature-plan-dated-rates.md D1.5 ruling, D0). Every change log row goes through
 * here, in the CALLER's transaction (pass `tx`) — never a client of its own — so a change and its log row commit or
 * roll back together. A static test forbids `insert(adminChangeLog)` anywhere else.
 */
export interface AdminChangeLogRow {
  actorId: string;
  entity: string;
  entityId: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Insert one log row with the caller's client; returns its id. */
export async function logAdminChange(tx: TenantWriter, row: AdminChangeLogRow): Promise<string> {
  // Explicit columns (no spread): only these six fields can ever reach the table.
  const [inserted] = await tx.insert(adminChangeLog).values({
    actorId: row.actorId, entity: row.entity, entityId: row.entityId, action: row.action, oldValue: row.oldValue, newValue: row.newValue,
  }).returning({ id: adminChangeLog.id });
  return inserted?.id as string;
}
