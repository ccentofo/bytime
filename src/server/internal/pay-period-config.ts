import 'server-only';
import { payPeriodConfig } from '@/db/schema';
import { desc, lte } from 'drizzle-orm';
import type { getDb } from '@/db';
import {
  DEFAULT_PERIOD_CONFIG,
  getNumDaysInPeriod,
  getPeriodStartForDate,
  type PeriodConfig,
  type PeriodType,
} from '@/lib/date-utils';
import { addDays, compare, type CalendarDate } from '@/lib/calendar-date';

/**
 * Pay-period schedule resolution WITHOUT a session check. INTERNAL — not a server action.
 * Callers authorize first (server actions via requireSession; API routes via validateApiKey;
 * crons via CRON_SECRET), then pass the tenant's db client.
 */
type TenantDb = Pick<Awaited<ReturnType<typeof getDb>>, 'select'>;

type ConfigRow = { periodType: string; anchorDate: string; weekStartDay: number; effectiveFrom: string };

function toConfig(row: ConfigRow): PeriodConfig {
  return {
    periodType: row.periodType as PeriodType,
    anchorDate: row.anchorDate as CalendarDate,
    weekStartDay: row.weekStartDay,
  };
}

/** The config in effect on `day`: the row with the greatest effective_from <= day, else the default. */
export async function configAt(db: TenantDb, day: CalendarDate): Promise<PeriodConfig> {
  const [row] = await db
    .select()
    .from(payPeriodConfig)
    .where(lte(payPeriodConfig.effectiveFrom, day))
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt))
    .limit(1);
  return row ? toConfig(row) : DEFAULT_PERIOD_CONFIG;
}

/** One period of the workspace's schedule. */
export interface ResolvedPeriod {
  start: CalendarDate;
  numDays: number;
  config: PeriodConfig;
}

/**
 * Loads the whole config history once and answers schedule questions in memory. Use it when
 * resolving many periods in one request (period lists, navigation) instead of one query per day.
 */
export async function loadScheduleResolver(db: TenantDb) {
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt));

  const configOn = (day: CalendarDate): PeriodConfig => {
    // rows are newest-first; the first whose effective_from <= day wins (ties: newest created).
    const row = rows.find((r) => compare(r.effectiveFrom as CalendarDate, day) <= 0);
    return row ? toConfig(row) : DEFAULT_PERIOD_CONFIG;
  };

  /** The period containing `day`. */
  const periodContaining = (day: CalendarDate): ResolvedPeriod => {
    const config = configOn(day);
    const start = getPeriodStartForDate(day, config);
    return { start, numDays: getNumDaysInPeriod(start, config), config };
  };

  /**
   * The adjacent period. Steps by DAYS, not by "one period of the current schedule": the day
   * before `start` (prev) or the day after this period's end (next), snapped under whichever
   * schedule is in effect THERE. Stepping by the current schedule's length skips periods when
   * moving from a longer schedule back into a shorter one.
   */
  const neighbor = (start: CalendarDate, direction: 'prev' | 'next'): ResolvedPeriod => {
    const current = periodContaining(start);
    const probe = direction === 'prev' ? addDays(current.start, -1) : addDays(current.start, current.numDays);
    return periodContaining(probe);
  };

  return { configOn, periodContaining, neighbor };
}

/**
 * Length of an EXISTING period, for readers (dashboards, review, exports, reports). Prefers the
 * period row's `period_num_days` snapshot; otherwise derives it from the schedule in effect at
 * `start`. Never throws: a stored period that doesn't line up with today's schedule (e.g. imported
 * history) must still be readable. Validation of NEW periods is resolvePeriod's job.
 */
export async function existingPeriodLength(
  db: TenantDb,
  start: CalendarDate,
  snapshot: number | null | undefined,
): Promise<number> {
  if (snapshot != null && snapshot > 0) return snapshot;
  return getNumDaysInPeriod(start, await configAt(db, start));
}
