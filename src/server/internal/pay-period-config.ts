import 'server-only';
import { payPeriodConfig, timesheetEntries, timesheetPeriods } from '@/db/schema';
import { desc, gt, lte } from 'drizzle-orm';
import { getDb, type ReadDb } from '@/db';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import {
  DEFAULT_PERIOD_CONFIG,
  getNumDaysInPeriod,
  getPeriodStartForDate,
  type PeriodConfig,
  type PeriodType,
} from '@/lib/date-utils';
import { addDays, compare, parseCalendarDate, type CalendarDate } from '@/lib/calendar-date';

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
export async function configAt(db: Pick<TenantDb, 'select'>, day: CalendarDate): Promise<PeriodConfig> {
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
 * The N most recent COMPLETED periods before the one containing `today`, oldest first (feature-plan-ux-kit-contracts.md
 * §3.8, §4.5). Each period resolves under its own schedule, so the list is right across a schedule change. Shared by
 * resolvePeriodRange (lastPeriod / lastN) and getPeriodCostByPeriod — internal, no session check.
 */
export async function lastCompletedPeriods(db: TenantDb, n: number, today: CalendarDate): Promise<ResolvedPeriod[]> {
  const schedule = await loadScheduleResolver(db);
  const out: ResolvedPeriod[] = [];
  let cursor = schedule.periodContaining(today);
  for (let i = 0; i < n; i++) {
    cursor = schedule.neighbor(cursor.start, 'prev');
    out.unshift(cursor);
  }
  return out;
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

/**
 * The schedule in effect on `date` (feature-plan-launch-blockers.md P4 §2: shared by the exported
 * getEffectiveConfigAt/getCurrentEffectiveConfig/getPayPeriodConfig actions and employee-dashboard, which must not
 * call each other). Session-free like everything here — callers authorize first.
 */
export async function getEffectiveConfigAtInternal(date: CalendarDate): Promise<PeriodConfig> {
  return configAt(await getDb(), parseCalendarDate(date));
}

/** The schedule in effect on the workspace's "today". */
export async function getCurrentEffectiveConfigInternal(): Promise<PeriodConfig> {
  return getEffectiveConfigAtInternal(await getWorkspaceToday());
}

/** A schedule change that hasn't taken effect yet (effective_from after the workspace's today). */
export interface PendingConfigChange {
  id: string;
  periodType: PeriodType;
  anchorDate: CalendarDate;
  weekStartDay: number;
  effectiveFrom: CalendarDate;
  createdAt: Date;
}

/**
 * The pending (not-yet-effective) pay-schedule change, if any. INTERNAL (UX-2 §4.5): Home's "Pay schedule changes on
 * {date}" item; the getPendingConfigChange action guards + calls.
 */
export async function pendingConfigChangeInternal(db: Pick<ReadDb, 'select'>, today: CalendarDate): Promise<PendingConfigChange | null> {
  const [r] = await db.select().from(payPeriodConfig).where(gt(payPeriodConfig.effectiveFrom, today)).orderBy(desc(payPeriodConfig.effectiveFrom)).limit(1);
  if (!r) return null;
  return {
    id: r.id,
    periodType: r.periodType as PeriodType,
    anchorDate: r.anchorDate as CalendarDate,
    weekStartDay: r.weekStartDay,
    effectiveFrom: r.effectiveFrom as CalendarDate,
    createdAt: r.createdAt,
  };
}

/**
 * True when no timesheet has been entered or submitted yet. Then there are no periods to keep consistent, so a new
 * schedule may replace the old one outright, effective immediately. This is how a new workspace sets its schedule without
 * waiting for a common boundary, which for some changes (e.g. a different week start day) never comes. INTERNAL (moved
 * out of the 'use server' actions file, where an export would be an unguarded endpoint — feature-plan-ux-setup-import.md §3.1).
 */
export async function workspaceHasNoTimesheetData(db: Pick<ReadDb, 'select'>): Promise<boolean> {
  const [entry] = await db.select({ id: timesheetEntries.id }).from(timesheetEntries).limit(1);
  if (entry) return false;
  const [period] = await db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).limit(1);
  return !period;
}
