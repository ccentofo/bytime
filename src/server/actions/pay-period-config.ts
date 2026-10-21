'use server';

import { getDb } from '@/db';
import { payPeriodConfig } from '@/db/schema';
import { requireAdmin, requireAdminFresh, requireSession } from '@/lib/session';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { DEFAULT_PERIOD_CONFIG, navigatePeriod, getNumDaysInPeriod, getPeriodStartForDate } from '@/lib/date-utils';
import { parseCalendarDate, isAfter, addDays, compare, dayOfWeek, type CalendarDate } from '@/lib/calendar-date';
import { getWorkspaceToday } from '@/server/internal/workspace-settings';
import { eq, lte, desc, gt } from 'drizzle-orm';

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
  const day = parseCalendarDate(date);
  const db = await getDb();
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .where(lte(payPeriodConfig.effectiveFrom, day))
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt))
    .limit(1);

  if (rows.length === 0) return DEFAULT_PERIOD_CONFIG;

  const row = rows[0];
  return {
    periodType: row.periodType as PeriodType,
    anchorDate: row.anchorDate as CalendarDate,
    weekStartDay: row.weekStartDay,
  };
}

/**
 * The config in effect right now (for computing the current period at page load).
 * Kept as a named export for clarity; callers that want "current" should use this.
 */
export async function getCurrentEffectiveConfig(): Promise<PeriodConfig> {
  await requireSession();
  return getEffectiveConfigAt(await getWorkspaceToday());
}

/**
 * Backward-compatible alias — existing callers that want the current-time config.
 */
export async function getPayPeriodConfig(): Promise<PeriodConfig> {
  await requireSession();
  return getCurrentEffectiveConfig();
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

  // Step 1: resolve the config at the current period to step correctly
  const currentConfig = await getEffectiveConfigAt(start);

  // Step 2: step one period in the requested direction → probe date in the neighbor
  const probeDate = navigatePeriod(start, direction, currentConfig);

  // Step 3: resolve the config effective at the probe date
  const neighborConfig = await getEffectiveConfigAt(probeDate);

  // Step 4: snap the probe date to the period start under the neighbor's config
  const neighborPeriodStart = getPeriodStartForDate(probeDate, neighborConfig);

  return {
    periodStart: neighborPeriodStart,
    periodConfig: neighborConfig,
    numDays: getNumDaysInPeriod(neighborPeriodStart, neighborConfig),
  };
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
  effectiveFrom: CalendarDate;
};

/** A weekly/biweekly anchor that doesn't fall on its own weekStartDay would make
 * getPeriodStartForDate's boundary computation inconsistent with the configured week start. */
function assertAnchorMatchesWeekStartDay(config: { periodType: PeriodType; anchorDate: CalendarDate; weekStartDay: number }): void {
  if (config.periodType !== 'weekly' && config.periodType !== 'biweekly') return;
  if (dayOfWeek(config.anchorDate) !== config.weekStartDay) {
    throw new Error('Anchor date must fall on the selected week start day.');
  }
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
 * List upcoming dates that are valid `effective_from` choices for a proposed new schedule: a
 * period boundary under BOTH the schedule in effect today and the proposed new one. The UI
 * offers these as the only choices — there is no other way to avoid §0.9's overlap bug.
 */
export async function getValidScheduleChangeDates(
  newConfig: { periodType: PeriodType; anchorDate: CalendarDate; weekStartDay: number },
  count = 5
): Promise<CalendarDate[]> {
  await requireAdmin();
  const anchorDate = parseCalendarDate(newConfig.anchorDate);
  const candidateConfig: PeriodConfig = { periodType: newConfig.periodType, anchorDate, weekStartDay: newConfig.weekStartDay };
  assertAnchorMatchesWeekStartDay(candidateConfig);

  const today = await getWorkspaceToday();
  const currentConfig = await getCurrentEffectiveConfig();
  const horizon = addDays(today, SCHEDULE_CHANGE_SEARCH_HORIZON_DAYS);

  const results: CalendarDate[] = [];
  let probe = addDays(today, 1);
  while (results.length < count && compare(probe, horizon) <= 0) {
    if (isCommonBoundary(probe, currentConfig, candidateConfig)) {
      results.push(probe);
    }
    probe = addDays(probe, 1);
  }
  return results;
}

/**
 * Insert a new pay-period config row effective at `data.effectiveFrom`. Never overwrites
 * existing rows (non-destructive history). If a not-yet-effective pending row already exists,
 * replaces it so admins can adjust a pending change before it takes effect.
 *
 * §0.9: `effectiveFrom` is only accepted if it's a period boundary under BOTH the current and
 * the new schedule (see getValidScheduleChangeDates) — otherwise some day would belong to two
 * periods (the old schedule's straddling period and the new schedule's first period) or none.
 * Also rejects a weekly/biweekly anchor that doesn't fall on the selected week start day, and
 * any attempt to set effective_from in the past or current period (future-effective only).
 */
export async function updatePayPeriodConfig(data: {
  periodType: PeriodType;
  anchorDate: CalendarDate;
  weekStartDay: number;
  effectiveFrom: CalendarDate;
}): Promise<UpdatePayPeriodConfigResult> {
  const db = await getDb();
  await requireAdminFresh();
  const anchorDate = parseCalendarDate(data.anchorDate);
  const effectiveFrom = parseCalendarDate(data.effectiveFrom);
  const candidateConfig: PeriodConfig = { periodType: data.periodType, anchorDate, weekStartDay: data.weekStartDay };
  assertAnchorMatchesWeekStartDay(candidateConfig);

  const today = await getWorkspaceToday();
  if (!isAfter(effectiveFrom, today)) {
    throw new Error('Cannot set effective_from to a past or current period. Changes are future-effective only.');
  }

  const currentConfig = await getCurrentEffectiveConfig();
  if (!isCommonBoundary(effectiveFrom, currentConfig, candidateConfig)) {
    throw new Error('effective_from must be a period boundary under both the current and new schedules — use getValidScheduleChangeDates for valid choices.');
  }

  // If a pending (future) row exists, delete it so we replace it
  const pending = await getPendingConfigChange();
  if (pending) {
    await db.delete(payPeriodConfig).where(eq(payPeriodConfig.id, pending.id));
  }

  // Insert the new history row
  await db.insert(payPeriodConfig).values({
    periodType: data.periodType,
    anchorDate,
    weekStartDay: data.weekStartDay,
    effectiveFrom,
  });

  return { effectiveFrom };
}
