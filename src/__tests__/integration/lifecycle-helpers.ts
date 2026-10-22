import { and, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import {
  opsAlerts, paymentPendingObservations, tenantAuditEvents, tenantNotices, tenants,
} from '@/db/control-plane/schema';
import { encrypt } from '@/lib/encryption';
import { invalidateTenant } from '@/lib/tenant/registry';

/**
 * Control-plane helpers for the lifecycle / billing / deletion integration suites. Every test tenant's slug starts
 * with `test-lc-`, and cleanup touches ONLY those rows (the developer's local control plane also holds the demo
 * workspaces — never touch them).
 */

export const cpReady = !!process.env.CONTROL_PLANE_DATABASE_URL;
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
export const DAY = 86_400_000;
export const daysFrom = (base: Date, n: number) => new Date(base.getTime() + n * DAY);

export type TenantRow = typeof tenants.$inferSelect;

export async function makeTenant(overrides: Partial<typeof tenants.$inferInsert> = {}): Promise<TenantRow> {
  const slug = `test-lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await controlDb.insert(tenants).values({
    slug,
    name: 'Lifecycle Test Co',
    dbUrlEncrypted: encrypt(TEST_DB_URL),
    status: 'active',
    plan: 'trial',
    trialEndsAt: daysFrom(new Date(), 20),
    signupEmail: 'signup@test.dev',
    ...overrides,
  }).returning();
  return row;
}

export async function getTenantRow(id: string): Promise<TenantRow> {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.id, id));
  invalidateTenant(row.slug);
  return row;
}

export async function setTenant(id: string, patch: Partial<typeof tenants.$inferInsert>): Promise<TenantRow> {
  const [row] = await controlDb.update(tenants).set(patch).where(eq(tenants.id, id)).returning();
  invalidateTenant(row.slug);
  return row;
}

export const noticesOf = (tenantId: string) =>
  controlDb.select().from(tenantNotices).where(eq(tenantNotices.tenantId, tenantId));

export const openAlertsOf = (tenantId: string) =>
  controlDb.select().from(opsAlerts).where(and(eq(opsAlerts.scope, tenantId), isNull(opsAlerts.resolvedAt)));

export const allAlertsOf = (tenantId: string) =>
  controlDb.select().from(opsAlerts).where(eq(opsAlerts.scope, tenantId));

export const auditOf = (tenantId: string) =>
  controlDb.select().from(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, tenantId));

export const observationsOf = (tenantId: string) =>
  controlDb.select().from(paymentPendingObservations).where(eq(paymentPendingObservations.tenantId, tenantId));

/** Insert a notice row directly (state set-up). */
export async function insertNotice(tenantId: string, kind: string, anchor: Date, o: Partial<typeof tenantNotices.$inferInsert> = {}) {
  const [row] = await controlDb.insert(tenantNotices).values({ tenantId, kind, scheduledFor: anchor, ...o }).returning();
  return row;
}

/** Delete every test-lc-* tenant and all of its child rows (FK order). Never touches other tenants. */
export async function cleanupLifecycleTenants(): Promise<void> {
  const rows = await controlDb.select({ id: tenants.id }).from(tenants).where(like(tenants.slug, 'test-lc-%'));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await controlDb.delete(tenantNotices).where(inArray(tenantNotices.tenantId, ids));
  await controlDb.delete(opsAlerts).where(or(inArray(opsAlerts.tenantId, ids), inArray(opsAlerts.scope, ids)));
  await controlDb.delete(tenantAuditEvents).where(inArray(tenantAuditEvents.tenantId, ids));
  await controlDb.delete(paymentPendingObservations).where(inArray(paymentPendingObservations.tenantId, ids));
  await controlDb.delete(tenants).where(inArray(tenants.id, ids));
}
