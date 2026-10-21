import 'server-only';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { eq, count } from 'drizzle-orm';
import { getTenantOrThrow } from '@/lib/tenant/context';
import { PLANS, type PlanKey } from '@/lib/billing/plans';

/** A Drizzle client or an open transaction — anything with .select(). */
type SeatExecutor = Pick<Awaited<ReturnType<typeof getDb>>, 'select'>;

/**
 * Resolve the tenant's plan seat limit and current active-user count.
 * `limit: null` means unlimited (enterprise).
 */
export async function getSeatUsage(executor?: SeatExecutor): Promise<{ limit: number | null; currentActive: number; planLabel: string }> {
  const db = executor ?? await getDb();
  const tenant = await getTenantOrThrow();
  const plan = tenant.plan as PlanKey;
  const limit = PLANS[plan]?.seatLimit ?? PLANS.trial.seatLimit;
  const [result] = await db.select({ value: count() }).from(users).where(eq(users.isActive, true));
  return { limit, currentActive: Number(result.value), planLabel: PLANS[plan]?.label ?? 'current' };
}

/**
 * Throws unless the tenant's plan has room for `additionalCount` more active users on top of
 * the current count. Shared by single-user creation (assertSeatAvailable in users.ts, which
 * calls this with 1) and bulk import (R2-11, which calls this with the whole batch's new-row
 * count up front, rejecting the batch atomically instead of letting it exceed the limit
 * one row at a time).
 *
 * Inside a transaction, pass the transaction as `executor`: taking a second pooled connection
 * while the transaction holds one can exhaust the pool and hang.
 */
export async function assertSeatsAvailable(additionalCount: number, executor?: SeatExecutor): Promise<void> {
  const { limit, currentActive, planLabel } = await getSeatUsage(executor);
  if (limit == null) return; // unlimited
  if (currentActive + additionalCount > limit) {
    throw new Error(
      `Your ${planLabel} plan allows ${limit} active users (you currently have ${currentActive}). ` +
      `This would add ${additionalCount} more. Upgrade in Billing to add more.`
    );
  }
}
