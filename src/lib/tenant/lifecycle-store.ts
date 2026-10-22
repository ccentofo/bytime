import 'server-only';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { tenants, opsAlerts, tenantAuditEvents } from '@/db/control-plane/schema';
import { LifecycleVersionConflictError, type ControlTx } from '@/db/control-plane/locked';

/**
 * Shared writes for the lifecycle state machine (feature-plan-terms-compliance-fixes.md §4.1, §4.3).
 * Every lifecycle-fact write goes through `updateTenantGuarded` inside `withTenantLock`.
 */

export type TenantRow = typeof tenants.$inferSelect;
type TenantPatch = Partial<Omit<typeof tenants.$inferInsert, 'id' | 'lifecycleVersion'>>;

/** Read the tenant row inside a locked section (always re-read after taking the lock). */
export async function readTenant(tx: ControlTx, tenantId: string): Promise<TenantRow | null> {
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row ?? null;
}

/**
 * Apply `patch` only if nobody changed the tenant since `row` was read (lifecycle_version guard), bumping the
 * version. Zero rows → LifecycleVersionConflictError (withTenantLock re-runs, max 3). Never a silent no-op.
 * `extraWhere` adds state guards (e.g. status='active' for suspend).
 */
export async function updateTenantGuarded(
  tx: ControlTx,
  row: TenantRow,
  patch: TenantPatch,
  now: Date,
  extraWhere?: SQL,
): Promise<TenantRow> {
  const where = extraWhere
    ? and(eq(tenants.id, row.id), eq(tenants.lifecycleVersion, row.lifecycleVersion), extraWhere)
    : and(eq(tenants.id, row.id), eq(tenants.lifecycleVersion, row.lifecycleVersion));
  const [updated] = await tx.update(tenants)
    .set({ ...patch, lifecycleVersion: row.lifecycleVersion + 1, updatedAt: now })
    .where(where)
    .returning();
  if (!updated) throw new LifecycleVersionConflictError(row.id);
  return updated;
}

type AlertExecutor = Pick<ControlTx, 'insert' | 'update'>;

export interface AlertInput {
  tenantId: string | null;
  kind: string;
  dedupKey?: string;
  detail?: Record<string, unknown>;
}

/** Raise (or bump) an unresolved alert. Deduplicated on (scope, kind, dedup_key) while unresolved. */
export async function raiseAlert(db: AlertExecutor, alert: AlertInput, now: Date): Promise<void> {
  const scope = alert.tenantId ?? 'global';
  await db.insert(opsAlerts).values({
    scope,
    tenantId: alert.tenantId,
    kind: alert.kind,
    dedupKey: alert.dedupKey ?? '',
    detail: alert.detail ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: [opsAlerts.scope, opsAlerts.kind, opsAlerts.dedupKey],
    targetWhere: isNull(opsAlerts.resolvedAt),
    set: { lastSeenAt: now, occurrences: sql`${opsAlerts.occurrences} + 1`, detail: alert.detail ?? null },
  });
}

/** Auto-resolve a condition-based alert once its condition has cleared. */
export async function resolveAlert(
  db: AlertExecutor,
  alert: { tenantId: string | null; kind: string; dedupKey?: string },
  now: Date,
  note = 'condition cleared',
): Promise<void> {
  await db.update(opsAlerts)
    .set({ resolvedAt: now, resolutionNote: note })
    .where(and(
      eq(opsAlerts.scope, alert.tenantId ?? 'global'),
      eq(opsAlerts.kind, alert.kind),
      eq(opsAlerts.dedupKey, alert.dedupKey ?? ''),
      isNull(opsAlerts.resolvedAt),
    ));
}

/** Append an audit event (founder and system actions that change a tenant's lifecycle). */
export async function recordAudit(
  db: Pick<ControlTx, 'insert'>,
  event: { tenantId: string; kind: string; actor: string; detail?: string },
): Promise<string> {
  const [row] = await db.insert(tenantAuditEvents)
    .values({ tenantId: event.tenantId, kind: event.kind, actor: event.actor, detail: event.detail ?? null })
    .returning({ id: tenantAuditEvents.id });
  return row.id;
}
