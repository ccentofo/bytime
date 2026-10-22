'use server';

import { getDb, getDbForWrite } from '@/db';
import { payPeriodConfig, payPeriodTypeEnum, timesheetEntries, timesheetPeriods } from '@/db/schema';
import { requireAdmin, requireAdminFresh, requireSession } from '@/lib/session';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { getPeriodStartForDate } from '@/lib/date-utils';
import { parseCalendarDate, isAfter, addDays, compare, dayOfWeek, type CalendarDate } from '@/lib/calendar-date';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { validateEnum } from '@/lib/validation';

/** effective_from for the first schedule row (matches the migration-0008 backfill sentinel). */
const SCHEDULE_HISTORY_START = '1900-01-01' as CalendarDate;
import { configAt, getCurrentEffectiveConfigInternal, getEffectiveConfigAtInternal, loadScheduleResolver } from '@/server/internal/pay-period-config';
import { eq, desc, gt } from 'drizzle-orm';
import { UserFacingError } from '@/lib/errors';
import { userAction, type ActionResult } from '@/lib/action-result';

// ---------------------------------------------------------------------------
// Resolution layer
// ---------------------------------------------------------------------------

/**
 * Return the pay-period config row whose effective_from is the greatest value
 * that is still <= `date`. Falls back to DEFAULT_PERIOD_CONFIG if no row qualifies.
 * This is the single source of truth for "which schedule applies at date D."
 */
export async function getEffectiveConfigAt(date: CalendarDate): Promise<PeriodConfig> {
  await requireSession();
  return getEffectiveConfigAtInternal(date);
}

/**
 * The config in effect right now (for computing the current period at page load).
 * Kept as a named export for clarity; callers that want "current" should use this.
 */
export async function getCurrentEffectiveConfig(): Promise<PeriodConfig> {
  await requireSession();
  return getCurrentEffectiveConfigInternal();
}

/**
 * Backward-compatible alias — existing callers that want the current-time config.
 */
export async function getPayPeriodConfig(): Promise<PeriodConfig> {
  await requireSession();
  return getCurrentEffectiveConfigInternal();
}

// ---------------------------------------------------------------------------
// Navigation helper (server-side, cross-schedule-aware)
// ---------------------------------------------------------------------------

/**
 * Given a period start and a direction, compute the adjacent period's start,
 * the config effective there, and its numDays. Handles schedule changes at
 * boundaries correctly by doing a two-sided snap.
 *
 * Used by TimesheetContext navigation to avoid replicating the rule client-side.
 */
export async function getNeighborPeriod(
  currentPeriodStart: CalendarDate,
  direction: 'prev' | 'next'
): Promise<{ periodStart: CalendarDate; periodConfig: PeriodConfig; numDays: number }> {
  await requireSession();
  const start = parseCalendarDate(currentPeriodStart);
  if (direction !== 'prev' && direction !== 'next') throw new UserFacingError('Invalid direction.');
  const schedule = await loadScheduleResolver(await getDb());
  const neighbor = schedule.neighbor(start, direction);
  return { periodStart: neighbor.start, periodConfig: neighbor.config, numDays: neighbor.numDays };
}

// ---------------------------------------------------------------------------
// History queries (for the settings UI)
// ---------------------------------------------------------------------------

export type ConfigHistoryRow = {
  id: string;
  periodType: PeriodType;
  anchorDate: CalendarDate;
  weekStartDay: number;
  effectiveFrom: CalendarDate;
  createdAt: Date;
};

/** Return all config rows newest-first. */
export async function getConfigHistory(): Promise<ConfigHistoryRow[]> {
  await requireAdmin();
  const db = await getDb();
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt));

  return rows.map((r) => ({
    id: r.id,
    periodType: r.periodType as PeriodType,
    anchorDate: r.anchorDate as CalendarDate,
    weekStartDay: r.weekStartDay,
    effectiveFrom: r.effectiveFrom as CalendarDate,
    createdAt: r.createdAt,
  }));
}

/**
 * Return the pending (not-yet-effective) config change, if any.
 * A row is "pending" if its effective_from is in the future relative to the workspace's today.
 */
export async function getPendingConfigChange(): Promise<ConfigHistoryRow | null> {
  await requireAdmin();
  const db = await getDb();
  const today = await getWorkspaceToday();
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .where(gt(payPeriodConfig.effectiveFrom, today))
    .orderBy(desc(payPeriodConfig.effectiveFrom))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    periodType: r.periodType as PeriodType,
    anchorDate: r.anchorDate as CalendarDate,
    weekStartDay: r.weekStartDay,
    effectiveFrom: r.effectiveFrom as CalendarDate,
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Write path — future-effective, non-destructive
// ---------------------------------------------------------------------------

export type UpdatePayPeriodConfigResult = {
  /** When the new schedule applies. `null` = immediately (workspace had no timesheet data). */
  effectiveFrom: CalendarDate | null;
};

const PERIOD_TYPES = payPeriodTypeEnum.enumValues;

/** Validate and normalize the untrusted schedule fields every write/preview receives. */
function parseScheduleInput(input: { periodType: unknown; anchorDate: unknown; weekStartDay: unknown }): PeriodConfig {
  const periodType = validateEnum(input.periodType, 'Period type', PERIOD_TYPES);
  const weekStartDay = input.weekStartDay;
  if (!Number.isInteger(weekStartDay) || (weekStartDay as number) < 0 || (weekStartDay as number) > 6) {
    throw new UserFacingError('Week start day must be an integer from 0 (Sunday) to 6 (Saturday).');
  }
  const anchorDate = parseCalendarDate(input.anchorDate as string);
  return { periodType, anchorDate, weekStartDay: weekStartDay as number };
}

/** A weekly/biweekly anchor that doesn't fall on its own weekStartDay would make
 * getPeriodStartForDate's boundary computation inconsistent with the configured week start.
 * Returns the problem as a message (null when fine). */
function anchorProblem(config: PeriodConfig): string | null {
  if (config.periodType !== 'weekly' && config.periodType !== 'biweekly') return null;
  return dayOfWeek(config.anchorDate) !== config.weekStartDay
    ? 'The anchor date must fall on the selected week start day.'
    : null;
}

/**
 * §0.9: no overlapping periods. `effective_from` is a valid period boundary under BOTH the
 * current schedule and the proposed new one — this is what lets every day belong to exactly
 * one period across the transition, with no straddling "first period of the new schedule that
 * actually started under the old one."
 */
function isCommonBoundary(day: CalendarDate, configA: PeriodConfig, configB: PeriodConfig): boolean {
  return compare(getPeriodStartForDate(day, configA), day) === 0
    && compare(getPeriodStartForDate(day, configB), day) === 0;
}

const SCHEDULE_CHANGE_SEARCH_HORIZON_DAYS = 730; // 2 years — generous for even rare common boundaries

/**
 * True when no timesheet has been entered or submitted yet. Then there are no periods to keep
 * consistent, so a new schedule may replace the old one outright, effective immediately. This is
 * how a new workspace sets its schedule without waiting for a common boundary, which for some
 * changes (e.g. a different week start day) never comes.
 */
async function workspaceHasNoTimesheetData(db: Awaited<ReturnType<typeof getDb>>): Promise<boolean> {
  const [entry] = await db.select({ id: timesheetEntries.id }).from(timesheetEntries).limit(1);
  if (entry) return false;
  const [period] = await db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).limit(1);
  return !period;
}

export type ScheduleChangeOptions = {
  /** The change can apply immediately (no timesheet data exists yet). */
  immediate: boolean;
  /** Upcoming valid `effective_from` dates (boundaries common to both schedules). */
  dates: CalendarDate[];
  /** Why the proposed schedule is invalid, if it is. */
  problem: string | null;
};

/**
 * What a proposed schedule change can be scheduled for. The UI offers exactly these choices.
 */
export async function getValidScheduleChangeDates(
  newConfig: { periodType: PeriodType; anchorDate: CalendarDate; weekStartDay: number },
  count = 5
): Promise<ScheduleChangeOptions> {
  await requireAdmin();
  const candidateConfig = parseScheduleInput(newConfig);
  const problem = anchorProblem(candidateConfig);
  if (problem) return { immediate: false, dates: [], problem };
  const limit = Math.min(Math.max(Number.isInteger(count) ? count : 5, 1), 10);

  const db = await getDb();
  const immediate = await workspaceHasNoTimesheetData(db);

  const today = await getWorkspaceToday();
  const currentConfig = await configAt(db, today);
  const horizon = addDays(today, SCHEDULE_CHANGE_SEARCH_HORIZON_DAYS);

  const dates: CalendarDate[] = [];
  let probe = addDays(today, 1);
  while (dates.length < limit && compare(probe, horizon) <= 0) {
    if (isCommonBoundary(probe, currentConfig, candidateConfig)) dates.push(probe);
    probe = addDays(probe, 1);
  }
  return {
    immediate,
    dates,
    problem: !immediate && dates.length === 0
      ? 'There is no date in the next two years when both your current and the new schedule start a period, so this change can\'t be scheduled. Contact support@cadenzpoint.com if you need it.'
      : null,
  };
}

/**
 * Insert a new pay-period config row effective at `data.effectiveFrom`. Never overwrites
 * existing rows (non-destructive history). If a not-yet-effective pending row already exists,
 * replaces it so admins can adjust a pending change before it takes effect.
 *
 * §0.9: `effectiveFrom` is only accepted if it's a period boundary under BOTH the current and
 * the new schedule (see getValidScheduleChangeDates) — otherwise some day would belong to two
 * periods (the old schedule's straddling period and the new schedule's first period) or none.
 * Exception: `effectiveFrom: null` applies the schedule immediately, replacing the history,
 * and is only allowed while the workspace has no timesheet data at all.
 */
export async function updatePayPeriodConfig(data: {
  periodType: PeriodType;
  anchorDate: CalendarDate;
  weekStartDay: number;
  effectiveFrom: CalendarDate | null;
}): Promise<ActionResult<UpdatePayPeriodConfigResult>> {
  return userAction(async () => {
    const db = await getDbForWrite();
    await requireAdminFresh();
    const candidateConfig = parseScheduleInput(data);
    const problem = anchorProblem(candidateConfig);
    if (problem) throw new UserFacingError(problem);

    const values = {
      periodType: candidateConfig.periodType,
      anchorDate: candidateConfig.anchorDate,
      weekStartDay: candidateConfig.weekStartDay,
    };

    if (data.effectiveFrom === null) {
      if (!(await workspaceHasNoTimesheetData(db))) {
        throw new UserFacingError('Timesheets already exist, so a schedule change must start on a future date.');
      }
      // No periods exist to keep consistent: the new schedule becomes the whole history.
      await db.transaction(async (tx) => {
        await tx.delete(payPeriodConfig);
        await tx.insert(payPeriodConfig).values({ ...values, effectiveFrom: SCHEDULE_HISTORY_START });
      });
      return { effectiveFrom: null };
    }

    const effectiveFrom = parseCalendarDate(data.effectiveFrom);
    const today = await getWorkspaceToday();
    if (!isAfter(effectiveFrom, today)) {
      throw new UserFacingError('Cannot set effective_from to a past or current period. Changes are future-effective only.');
    }

    const currentConfig = await configAt(db, today);
    if (!isCommonBoundary(effectiveFrom, currentConfig, candidateConfig)) {
      throw new UserFacingError('effective_from must be a period boundary under both the current and new schedules — use getValidScheduleChangeDates for valid choices.');
    }

    // Replace any pending (future) row and insert the new one atomically, so a failed insert
    // can't leave the pending change deleted.
    await db.transaction(async (tx) => {
      await tx.delete(payPeriodConfig).where(gt(payPeriodConfig.effectiveFrom, today));
      await tx.insert(payPeriodConfig).values({ ...values, effectiveFrom });
    });

    return { effectiveFrom };
  });
}
