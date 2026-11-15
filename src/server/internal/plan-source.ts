import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { UserFacingError } from '@/lib/errors';

/**
 * The tenant's plan, read fresh from the control plane (feature-plan-per-user-billing.md §6.3). The registry cache can
 * hold a stale `trial` for minutes after payment on another instance, so the seat cap never reads it. Called BEFORE a
 * tenant transaction opens, never inside one. A missing row throws (never a silent default). Its own module so test
 * suites can mock it.
 */
export async function readPlanFresh(tenantId: string): Promise<string> {
  const [row] = await controlDb.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!row) throw new UserFacingError('Unknown workspace.', 'not_found');
  return row.plan;
}
