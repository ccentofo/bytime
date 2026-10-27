'use server';

import { and, eq } from 'drizzle-orm';
import { getDb, getDbForWrite, type DbTx } from '@/db';
import { laborCategories, laborCategoryRates } from '@/db/schema';
import { requireAdminFresh } from '@/lib/session';
import { userAction, type ActionResult } from '@/lib/action-result';
import type { CalendarDate } from '@/lib/calendar-date';
import { ConflictError, UserFacingError } from '@/lib/errors';
import {
  addedPeriod, periodBounds, rateOn, RATE_MESSAGES, sameRate, validateAddInput, validateCorrectInput, validateRemoveInput,
  type AddRateChangeInput, type CorrectRateInput, type RateImpact, type RateImpactInput, type RateSchedule,
  type RateScheduleView, type RemoveRateChangeInput,
} from '@/lib/labor-rates';
import { lockAndReadSchedule, readRateSchedule } from '@/server/internal/labor-rates';
import { pricedHoursFor } from '@/server/internal/cost-basis';
import { logAdminChange } from '@/server/internal/admin-change-log';

/**
 * Dated labor-category rate changes (feature-plan-dated-rates.md D1.5, CO-D7): add a "new rate from a date", correct
 * a period's values (the starting rate or a change), remove a change. Every mutation: requireAdminFresh FIRST →
 * pure validation → write gate → one transaction holding the category row FOR NO KEY UPDATE → state checks (blueprint
 * §4 order, exact messages) → write → one admin_change_log row through logAdminChange(tx) → the fresh schedule.
 * DR-2: a reason is required exactly when the change re-prices recorded hours. DR-Q1 default: backdated adds allowed.
 */

const ENTITY = 'labor_category_rate';

async function view(db: DbTx, laborCategoryId: string): Promise<RateScheduleView> {
  const schedule = await readRateSchedule(db, laborCategoryId);
  if (!schedule) throw new UserFacingError(RATE_MESSAGES.categoryNotFound, 'not_found');
  return { laborCategoryId, ...schedule };
}

function requireReason(hours: string, reason: string | null): void {
  if (Number(hours) > 0 && !reason) throw new UserFacingError(RATE_MESSAGES.reasonRequired);
}

function periodValues(schedule: RateSchedule, target: string): { hourlyRate: string; ceilingRate: string | null } | null {
  if (target === 'starting') return schedule.starting;
  const c = schedule.changes.find((x) => x.id === target);
  return c ? { hourlyRate: c.hourlyRate, ceilingRate: c.ceilingRate } : null;
}

/** Add a "new rate from a date" (DR-Q1: may be backdated; reason required when it re-prices recorded hours). */
export async function addLaborCategoryRateChange(input: AddRateChangeInput): Promise<ActionResult<RateScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateAddInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const schedule = await lockAndReadSchedule(tx, v.laborCategoryId);
      if (!schedule) throw new UserFacingError(RATE_MESSAGES.categoryNotFound, 'not_found');
      if (schedule.changes.some((c) => c.effectiveDate === v.effectiveDate)) throw new ConflictError(RATE_MESSAGES.duplicateOn(v.effectiveDate));
      const before = rateOn(schedule, v.effectiveDate);
      if (sameRate(before.hourlyRate, v.hourlyRate) && sameRate(before.ceilingRate, v.ceilingRate)) {
        throw new UserFacingError(RATE_MESSAGES.alreadyInEffect(v.effectiveDate));
      }
      const period = addedPeriod(schedule, v.effectiveDate);
      const repricedHours = await pricedHoursFor(tx, v.laborCategoryId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const [row] = await tx.insert(laborCategoryRates).values({
        laborCategoryId: v.laborCategoryId, effectiveDate: v.effectiveDate, hourlyRate: v.hourlyRate, ceilingRate: v.ceilingRate, createdBy: actor.id,
      }).returning({ id: laborCategoryRates.id });
      if (!row) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.laborCategoryId, action: 'rate_change_added',
        oldValue: { source: before.source, hourlyRate: before.hourlyRate, ceilingRate: before.ceilingRate },
        newValue: { effectiveDate: v.effectiveDate, hourlyRate: v.hourlyRate, ceilingRate: v.ceilingRate, reason: v.reason, repricedHours },
      });
      return view(tx, v.laborCategoryId);
    });
  });
}

/** Correct a period's values — the starting rate or a change (the rate was entered wrong). */
export async function correctLaborCategoryRate(input: CorrectRateInput): Promise<ActionResult<RateScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateCorrectInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const schedule = await lockAndReadSchedule(tx, v.laborCategoryId);
      if (!schedule) throw new UserFacingError(RATE_MESSAGES.categoryNotFound, 'not_found');
      const current = periodValues(schedule, v.target);
      if (!current) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
      if (sameRate(current.hourlyRate, v.hourlyRate) && sameRate(current.ceilingRate, v.ceilingRate)) {
        throw new UserFacingError(RATE_MESSAGES.nothingToCorrect);
      }
      const period = periodBounds(schedule, v.target);
      const repricedHours = await pricedHoursFor(tx, v.laborCategoryId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const now = new Date();
      const [row] = v.target === 'starting'
        ? await tx.update(laborCategories).set({ hourlyRate: v.hourlyRate, ceilingRate: v.ceilingRate, updatedAt: now })
          .where(eq(laborCategories.id, v.laborCategoryId)).returning({ id: laborCategories.id })
        : await tx.update(laborCategoryRates).set({ hourlyRate: v.hourlyRate, ceilingRate: v.ceilingRate, updatedAt: now })
          .where(and(eq(laborCategoryRates.id, v.target), eq(laborCategoryRates.laborCategoryId, v.laborCategoryId))).returning({ id: laborCategoryRates.id });
      if (!row) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.laborCategoryId, action: 'rate_corrected',
        oldValue: { target: v.target, hourlyRate: current.hourlyRate, ceilingRate: current.ceilingRate },
        newValue: { target: v.target, hourlyRate: v.hourlyRate, ceilingRate: v.ceilingRate, reason: v.reason, period, repricedHours },
      });
      return view(tx, v.laborCategoryId);
    });
  });
}

/** Remove a change; its period falls back to the previous period's values. */
export async function removeLaborCategoryRateChange(input: RemoveRateChangeInput): Promise<ActionResult<RateScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateRemoveInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const schedule = await lockAndReadSchedule(tx, v.laborCategoryId);
      if (!schedule) throw new UserFacingError(RATE_MESSAGES.categoryNotFound, 'not_found');
      const removed = schedule.changes.find((c) => c.id === v.changeId);
      if (!removed) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
      const period = periodBounds(schedule, v.changeId);
      const repricedHours = await pricedHoursFor(tx, v.laborCategoryId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const [row] = await tx.delete(laborCategoryRates)
        .where(and(eq(laborCategoryRates.id, v.changeId), eq(laborCategoryRates.laborCategoryId, v.laborCategoryId)))
        .returning({ id: laborCategoryRates.id });
      if (!row) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.laborCategoryId, action: 'rate_change_removed',
        oldValue: { effectiveDate: removed.effectiveDate, hourlyRate: removed.hourlyRate, ceilingRate: removed.ceilingRate },
        newValue: { reason: v.reason, repricedHours },
      });
      return view(tx, v.laborCategoryId);
    });
  });
}

/**
 * How many recorded hours a change would re-price (and whether a reason is required) — before saving. Read only: no
 * lock, no transaction; validates ids, date and rates only (no reason). Same not_found rules as the mutations.
 */
export async function previewRateChangeImpact(input: RateImpactInput): Promise<ActionResult<RateImpact>> {
  return userAction(async () => {
    await requireAdminFresh();
    // Validate (no reason) and name the period the change would affect, once the schedule is read.
    let laborCategoryId: string;
    let periodOf: (schedule: RateSchedule) => { from: CalendarDate | null; toExclusive: CalendarDate | null };
    if (input?.kind === 'add') {
      const v = validateAddInput(input, { withReason: false });
      laborCategoryId = v.laborCategoryId;
      periodOf = (schedule) => addedPeriod(schedule, v.effectiveDate);
    } else if (input?.kind === 'correct' || input?.kind === 'remove') {
      const v = input.kind === 'correct' ? validateCorrectInput(input, { withReason: false }) : validateRemoveInput(input, { withReason: false });
      const ref = 'target' in v ? v.target : v.changeId;
      laborCategoryId = v.laborCategoryId;
      periodOf = (schedule) => {
        if (ref !== 'starting' && !schedule.changes.some((c) => c.id === ref)) throw new UserFacingError(RATE_MESSAGES.periodGone, 'not_found');
        return periodBounds(schedule, ref);
      };
    } else {
      throw new UserFacingError('Choose a rate change to preview.');
    }
    const db = await getDb();
    const schedule = await readRateSchedule(db, laborCategoryId);
    if (!schedule) throw new UserFacingError(RATE_MESSAGES.categoryNotFound, 'not_found');
    const period = periodOf(schedule);
    const hours = await pricedHoursFor(db, laborCategoryId, period.from, period.toExclusive);
    return { hours, from: period.from, toExclusive: period.toExclusive, reasonRequired: Number(hours) > 0 };
  });
}
