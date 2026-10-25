import 'server-only';
import { inArray, sql } from 'drizzle-orm';
import type { ReadDb } from '@/db';
import { periodEvents } from '@/db/schema';

/**
 * feature-plan-certified-outputs.md C1: a period is IMPORTED iff it has at least one `period_events` row with
 * source 'migration' and no app-sourced event; legacy periods with no events at all count as app periods.
 * Session-free (v1 API routes call it; callers authorize first).
 */
export async function importedPeriodIds(db: Pick<ReadDb, 'select'>, periodIds: string[]): Promise<Set<string>> {
  if (periodIds.length === 0) return new Set();
  const rows = await db
    .select({
      periodId: periodEvents.periodId,
      migration: sql<boolean>`bool_or(${periodEvents.source} = 'migration')`,
      app: sql<boolean>`bool_or(${periodEvents.source} <> 'migration')`,
    })
    .from(periodEvents)
    .where(inArray(periodEvents.periodId, periodIds))
    .groupBy(periodEvents.periodId);
  return new Set(rows.filter((r) => r.migration && !r.app).map((r) => r.periodId));
}
