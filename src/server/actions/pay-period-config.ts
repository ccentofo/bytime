'use server';

import { db } from '@/db';
import { payPeriodConfig } from '@/db/schema';
import { requireAdmin } from '@/lib/session';
import type { PeriodConfig, PeriodType } from '@/lib/date-utils';
import { DEFAULT_PERIOD_CONFIG } from '@/lib/date-utils';

/**
 * Get the current pay period configuration.
 * Returns the default (semi-monthly) if no config row exists.
 */
export async function getPayPeriodConfig(): Promise<PeriodConfig> {
  const rows = await db.select().from(payPeriodConfig).limit(1);

  if (rows.length === 0) {
    return DEFAULT_PERIOD_CONFIG;
  }

  const row = rows[0];
  return {
    periodType: row.periodType as PeriodType,
    anchorDate: row.anchorDate,
    weekStartDay: row.weekStartDay,
  };
}

/**
 * Update the pay period configuration.
 * Creates a new row if none exists, updates the existing row otherwise.
 * Admin only.
 */
export async function updatePayPeriodConfig(data: {
  periodType: PeriodType;
  anchorDate: Date;
  weekStartDay: number;
}): Promise<void> {
  await requireAdmin();

  const existing = await db.select({ id: payPeriodConfig.id }).from(payPeriodConfig).limit(1);

  if (existing.length === 0) {
    await db.insert(payPeriodConfig).values({
      periodType: data.periodType,
      anchorDate: data.anchorDate,
      weekStartDay: data.weekStartDay,
    });
  } else {
    await db.update(payPeriodConfig)
      .set({
        periodType: data.periodType,
        anchorDate: data.anchorDate,
        weekStartDay: data.weekStartDay,
        updatedAt: new Date(),
      });
  }
}
