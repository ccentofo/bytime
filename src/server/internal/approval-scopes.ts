import 'server-only';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbTx, ReadDb } from '@/db';
import { approvalScopes, clins, contracts } from '@/db/schema';
import { UserFacingError } from '@/lib/errors';
import { logAdminChange } from './admin-change-log';

/**
 * THE writer of `approval_scopes` (feature-plan-approval-scope.md §4.1). INTERNAL, no guard: callers are guarded actions
 * that already hold the user-rules lock EXCLUSIVELY (scopeChange, or updateUser / createUserWithPassword's own locked
 * transaction) and re-route waiting timesheets afterwards. Every grant, removal and keep is logged to admin_change_log
 * (entity `approval_scope`, entity_id = the scope row, values `{ supervisorId, clinId }`) in the caller's transaction. A
 * static test allows `insert` / `update` on approval_scopes only here (and in the demo seed).
 */

/** How a scope was granted. 'migration' is written only by the 0018 backfill. */
export type ScopeSource = 'app' | 'import';

/**
 * S6: an active scope converted by 0018 that no admin has kept or removed yet — for ANY holder (inactive, or no longer a
 * supervisor). The ONE predicate behind the review list (getApprovalScopesView) and Home's count.
 */
export const UNREVIEWED_MIGRATED_SCOPE: SQL = and(
  eq(approvalScopes.source, 'migration'),
  eq(approvalScopes.isActive, true),
  isNull(approvalScopes.reviewedAt),
)!;

/** Home's "approval scopes to review" count (S6). */
export async function approvalScopesToReview(db: Pick<ReadDb, 'select'>): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(approvalScopes).where(UNREVIEWED_MIGRATED_SCOPE);
  return row?.n ?? 0;
}

export const CLIN_NOT_ACTIVE = 'Choose active CLINs on active contracts.';

/** Every id is an active CLIN on an active contract (callers run this AFTER the lock). */
export async function assertActiveClins(tx: Pick<DbTx, 'select'>, clinIds: string[]): Promise<void> {
  if (clinIds.length === 0) return;
  const rows = await tx.select({ id: clins.id }).from(clins).innerJoin(contracts, eq(clins.contractId, contracts.id))
    .where(and(inArray(clins.id, clinIds), eq(clins.status, 'active'), eq(contracts.status, 'active')));
  if (rows.length !== new Set(clinIds).size) throw new UserFacingError(CLIN_NOT_ACTIVE);
}

type ScopeRow = { id: string; supervisorId: string; clinId: string };

/**
 * Give `supervisorId` scope on each CLIN. A row already active is skipped (no grant) — except that a converted row
 * nobody has reviewed yet (S6) is KEPT: the admin just chose it, so it's reviewed now, logged `kept`, and leaves the
 * review list and Home's count (APPROVAL-SCOPE-AUDIT.md L4). A new or inactive one becomes active with `source`, granted
 * now by `actorId`, reviewed now, and is logged `granted`. Returns the rows granted. Validation (active supervisor, active
 * CLINs) is the caller's, after the lock.
 */
export async function grantScopeRows(tx: DbTx, args: { actorId: string; supervisorId: string; clinIds: string[]; source: ScopeSource }): Promise<ScopeRow[]> {
  const { actorId, supervisorId, source } = args;
  const clinIds = [...new Set(args.clinIds)];
  if (clinIds.length === 0) return [];
  const existing = await tx.select({ id: approvalScopes.id, clinId: approvalScopes.clinId, needsReview: sql<boolean>`(${UNREVIEWED_MIGRATED_SCOPE})` })
    .from(approvalScopes)
    .where(and(eq(approvalScopes.supervisorId, supervisorId), inArray(approvalScopes.clinId, clinIds), eq(approvalScopes.isActive, true)));
  await markScopeRowsKept(tx, { actorId, rowIds: existing.filter((r) => r.needsReview).map((r) => r.id) });
  const active = new Set(existing.map((r) => r.clinId));
  const toGrant = clinIds.filter((id) => !active.has(id));
  if (toGrant.length === 0) return [];
  const now = new Date();
  const rows = await tx.insert(approvalScopes)
    .values(toGrant.map((clinId) => ({ supervisorId, clinId, isActive: true, source, grantedAt: now, grantedBy: actorId, reviewedAt: now })))
    .onConflictDoUpdate({
      target: [approvalScopes.supervisorId, approvalScopes.clinId],
      set: { isActive: true, source, grantedAt: now, grantedBy: actorId, reviewedAt: now },
    })
    .returning({ id: approvalScopes.id, supervisorId: approvalScopes.supervisorId, clinId: approvalScopes.clinId });
  for (const r of rows) {
    await logAdminChange(tx, { actorId, entity: 'approval_scope', entityId: r.id, action: 'granted', oldValue: null, newValue: { supervisorId: r.supervisorId, clinId: r.clinId } });
  }
  return rows;
}

/** Deactivate these scope rows (only those still active), set reviewed_at when it's null, and log `removed` for each. */
export async function deactivateScopeRows(tx: DbTx, args: { actorId: string; rowIds: string[] }): Promise<ScopeRow[]> {
  if (args.rowIds.length === 0) return [];
  const rows = await tx.update(approvalScopes)
    .set({ isActive: false, reviewedAt: sql`coalesce(${approvalScopes.reviewedAt}, now())` })
    .where(and(inArray(approvalScopes.id, args.rowIds), eq(approvalScopes.isActive, true)))
    .returning({ id: approvalScopes.id, supervisorId: approvalScopes.supervisorId, clinId: approvalScopes.clinId });
  for (const r of rows) {
    await logAdminChange(tx, { actorId: args.actorId, entity: 'approval_scope', entityId: r.id, action: 'removed', oldValue: null, newValue: { supervisorId: r.supervisorId, clinId: r.clinId } });
  }
  return rows;
}

/** Keep converted scopes (only rows matching the S6 predicate): reviewed now, logged `kept`. */
export async function markScopeRowsKept(tx: DbTx, args: { actorId: string; rowIds: string[] }): Promise<ScopeRow[]> {
  if (args.rowIds.length === 0) return [];
  const rows = await tx.update(approvalScopes)
    .set({ reviewedAt: new Date() })
    .where(and(inArray(approvalScopes.id, args.rowIds), UNREVIEWED_MIGRATED_SCOPE))
    .returning({ id: approvalScopes.id, supervisorId: approvalScopes.supervisorId, clinId: approvalScopes.clinId });
  for (const r of rows) {
    await logAdminChange(tx, { actorId: args.actorId, entity: 'approval_scope', entityId: r.id, action: 'kept', oldValue: null, newValue: { supervisorId: r.supervisorId, clinId: r.clinId } });
  }
  return rows;
}
