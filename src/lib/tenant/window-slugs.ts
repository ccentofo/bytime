import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { opsAlerts } from '@/db/control-plane/schema';

/**
 * feature-plan-control-plane-disaster.md §6.7: a workspace address created in a control-plane rollback window stays
 * unavailable to new signups while its `window-project` alert is open (the leftover project `cadenzpoint-<slug>` still
 * exists, and its signer may sign up again). The alert resolves when the project is deleted, a tenant row references it,
 * or the founder resolves it (runbook B.9), and the address is free again.
 */
export async function isOpenWindowSlug(slug: string): Promise<boolean> {
  const rows = await controlDb.select({ id: opsAlerts.id }).from(opsAlerts)
    .where(and(eq(opsAlerts.kind, 'window-project'), isNull(opsAlerts.resolvedAt), sql`${opsAlerts.detail}->>'slug' = ${slug}`)).limit(1);
  return rows.length > 0;
}
