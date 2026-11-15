import 'server-only';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq, count } from 'drizzle-orm';
import { getTenantOrThrow } from '@/lib/tenant/context';
import { displayPlan, seatLimitFor } from '@/lib/billing/plans';
import { STANDARD_CAP_MESSAGE } from '@/lib/billing/plan-copy';
import { UserFacingError } from '@/lib/errors';
import { readPlanFresh } from './plan-source';

/** A Drizzle client or an open transaction — anything with .select(). */
type SeatExecutor = Pick<Awaited<ReturnType<typeof getDb>>, 'select'>;

/**
 * The tenant's seat limit and current active-user count (feature-plan-per-user-billing.md §6.3). `limit: null` means
 * unlimited (Enterprise). The plan is read fresh from the control plane when none is passed — never from the registry
 * cache. `getTenantOrThrow` supplies the tenant id on the request path (the Users page).
 */
export async function getSeatUsage(executor?: SeatExecutor, plan?: string): Promise<{ limit: number | null; currentActive: number; plan: string }> {
  const db = executor ?? await getDb();
  const p = plan ?? await readPlanFresh((await getTenantOrThrow()).id);
  const [result] = await db.select({ value: count() }).from(users).where(eq(users.isActive, true));
  return { limit: seatLimitFor(p), currentActive: Number(result.value), plan: p };
}

/**
 * Throws unless the plan has room for `additionalCount` more active users on top of the current count. Shared by user
 * creation, reactivation and bulk import (which passes the whole batch's new-row count, rejecting the batch
 * atomically). The callers read `plan` with `readPlanFresh` BEFORE opening their transaction and call this inside it,
 * after `lockUserRulesExclusive`, passing the transaction as `executor` (a second pooled connection while the
 * transaction holds one can exhaust the pool and hang).
 *
 * Standard (legacy starter/pro included): the business's exact cap message (BUSINESS-DECISIONS.md §1). Otherwise
 * (trial): today's message, unchanged.
 */
export async function assertSeatsAvailable(additionalCount: number, executor: SeatExecutor, plan: string): Promise<void> {
  const { limit, currentActive } = await getSeatUsage(executor, plan);
  if (limit == null) return; // unlimited
  if (currentActive + additionalCount > limit) {
    if (displayPlan(plan) === 'standard') throw new UserFacingError(STANDARD_CAP_MESSAGE);
    const planLabel = plan === 'trial' ? 'Trial' : 'current';
    throw new UserFacingError(
      `Your ${planLabel} plan allows ${limit} active users (you currently have ${currentActive}). ` +
      `This would add ${additionalCount} more. Upgrade in Billing to add more.`
    );
  }
}

/** §6.8: the active-user count through the row's own URL (billing infrastructure; works in `billing_only`). */
export { countActiveUsers } from '@/lib/billing/tenant-reads';
