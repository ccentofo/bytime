'use server';

import { getDb } from '@/db';
import { payPeriodConfig } from '@/db/schema';
import { requireAdmin, requireAdminFresh, requireSession } from '@/lib/session';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { DEFAULT_PERIOD_CONFIG, getCurrentPeriodStart, navigatePeriod, getNumDaysInPeriod, getPeriodStartForDate } from '@/lib/date-utils';
import { eq, lte, desc, gt } from 'drizzle-orm';
import dayjs from 'dayjs';

// ---------------------------------------------------------------------------
// Resolution layer
// ---------------------------------------------------------------------------

/**
 * Return the pay-period config row whose effective_from is the greatest value
 * that is still <= `date`. Falls back to DEFAULT_PERIOD_CONFIG if no row qualifies.
 * This is the single source of truth for "which schedule applies at date D."
 */
export async function getEffectiveConfigAt(date: Date): Promise<PeriodConfig> {
  await requireSession();
  const db = await getDb();
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .where(lte(payPeriodConfig.effectiveFrom, date))
    .orderBy(desc(payPeriodConfig.effectiveFrom), desc(payPeriodConfig.createdAt))
    .limit(1);

  if (rows.length === 0) return DEFAULT_PERIOD_CONFIG;

  const row = rows[0];
  return {
    periodType: row.periodType as PeriodType,
    anchorDate: row.anchorDate,
    weekStartDay: row.weekStartDay,
  };
}

/**
 * The config in effect right now (for computing the current period at page load).
 * Kept as a named export for clarity; callers that want "current" should use this.
 */
export async function getCurrentEffectiveConfig(): Promise<PeriodConfig> {
  await requireSession();
  return getEffectiveConfigAt(new Date());
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
  currentPeriodStart: Date,
  direction: 'prev' | 'next'
): Promise<{ periodStart: Date; periodConfig: PeriodConfig; numDays: number }> {
  await requireSession();
  // Step 1: resolve the config at the current period to step correctly
  const currentConfig = await getEffectiveConfigAt(currentPeriodStart);

  // Step 2: step one period in the requested direction → probe date in the neighbor
  const probeDate = navigatePeriod(currentPeriodStart, direction, currentConfig);

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
  anchorDate: Date;
  weekStartDay: number;
  effectiveFrom: Date;
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
    anchorDate: r.anchorDate,
    weekStartDay: r.weekStartDay,
    effectiveFrom: r.effectiveFrom,
    createdAt: r.createdAt,
  }));
}

/**
 * Return the pending (not-yet-effective) config change, if any.
 * A row is "pending" if its effective_from is in the future relative to now.
 */
export async function getPendingConfigChange(): Promise<ConfigHistoryRow | null> {
  await requireAdmin();
  const db = await getDb();
  const now = new Date();
  const rows = await db
    .select()
    .from(payPeriodConfig)
    .where(gt(payPeriodConfig.effectiveFrom, now))
    .orderBy(desc(payPeriodConfig.effectiveFrom))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    periodType: r.periodType as PeriodType,
    anchorDate: r.anchorDate,
    weekStartDay: r.weekStartDay,
    effectiveFrom: r.effectiveFrom,
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Write path — future-effective, non-destructive
// ---------------------------------------------------------------------------

export type UpdatePayPeriodConfigResult = {
  effectiveFrom: Date;
};

/**
 * Insert a new pay-period config row effective at the START OF THE NEXT PERIOD
 * under the current config. Never overwrites existing rows (non-destructive history).
 * If a not-yet-effective pending row already exists, replaces it so admins can
 * adjust a pending change before it takes effect.
 *
 * Rejects any attempt to set effective_from earlier than the next boundary
 * (no retroactive or mid-period changes).
 *
 * Returns the computed effectiveFrom so the UI can display it.
 */
export async function updatePayPeriodConfig(data: {
  periodType: PeriodType;
  anchorDate: Date;
  weekStartDay: number;
}): Promise<UpdatePayPeriodConfigResult> {
  const db = await getDb();
  await requireAdminFresh();

  // Compute the next period boundary under the CURRENT effective config
  const currentConfig = await getCurrentEffectiveConfig();
  const currentPeriodStart = getCurrentPeriodStart(currentConfig);
  const effectiveFrom = navigatePeriod(currentPeriodStart, 'next', currentConfig);

  // Guard: never allow retroactive or mid-period changes
  if (dayjs(effectiveFrom).isBefore(dayjs(), 'day')) {
    throw new Error('Cannot set effective_from to a past or current period. Changes are future-effective only.');
  }

  // If a pending (future) row exists, delete it so we replace it
  const pending = await getPendingConfigChange();
  if (pending) {
    await db.delete(payPeriodConfig).where(eq(payPeriodConfig.id, pending.id));
  }

  // Insert the new history row
  await db.insert(payPeriodConfig).values({
    periodType: data.periodType,
    anchorDate: data.anchorDate,
    weekStartDay: data.weekStartDay,
    effectiveFrom,
  });

  return { effectiveFrom };
}
