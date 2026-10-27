'use server';

import { and, eq } from 'drizzle-orm';
import { getDb, getDbForWrite, type DbTx } from '@/db';
import { chargeCodeLaborCategories, chargeCodes } from '@/db/schema';
import { requireAdminFresh } from '@/lib/session';
import { userAction, type ActionResult } from '@/lib/action-result';
import type { CalendarDate } from '@/lib/calendar-date';
import { ConflictError, UserFacingError } from '@/lib/errors';
import {
  addedPeriod, CATEGORY_MESSAGES, categoryFitsCode, chargeCodeCategoryOn, periodBounds,
  validateCategoryAddInput, validateCategoryCorrectInput, validateCategoryRemoveInput,
  type AddCategoryChangeInput, type CategoryImpactInput, type CategorySchedule, type CategoryScheduleView,
  type CorrectCategoryInput, type RateImpact, type RemoveCategoryChangeInput,
} from '@/lib/labor-rates';
import { lockAndReadCategorySchedule, readCategoryPlacement, readCategorySchedule } from '@/server/internal/labor-rates';
import { pricedHoursForChargeCode } from '@/server/internal/cost-basis';
import { logAdminChange } from '@/server/internal/admin-change-log';

/**
 * A charge code's dated labor category (feature-plan-dated-rates.md D3, CO-D13): add a "new category from a date",
 * correct a period's category (the starting category — which may become null — or a change), remove a change. Same
 * skeleton as the rate actions: requireAdminFresh FIRST → pure validation → write gate → one transaction holding the
 * CHARGE CODE row FOR NO KEY UPDATE → state checks → write → one admin_change_log row through logAdminChange(tx).
 * DR-Q2 default: a category must belong to the code's own CLIN (and SLIN when both have one). DR-2: a reason is
 * required exactly when the change re-prices recorded hours on this code.
 */

const ENTITY = 'charge_code_labor_category';

async function view(db: DbTx, chargeCodeId: string): Promise<CategoryScheduleView> {
  const state = await readCategorySchedule(db, chargeCodeId);
  if (!state) throw new UserFacingError(CATEGORY_MESSAGES.codeNotFound, 'not_found');
  return { chargeCodeId, ...state.schedule };
}

/** Existence, then DR-Q2 — for a category that will apply (null — no category — skips both). */
async function checkCategory(tx: DbTx, laborCategoryId: string | null, code: { clinId: string; slinId: string | null }): Promise<void> {
  if (laborCategoryId === null) return;
  const placement = await readCategoryPlacement(tx, laborCategoryId);
  if (!placement) throw new UserFacingError(CATEGORY_MESSAGES.categoryNotFound, 'not_found');
  if (!categoryFitsCode(placement, code)) throw new UserFacingError(CATEGORY_MESSAGES.wrongClin);
}

function requireReason(hours: string, reason: string | null): void {
  if (Number(hours) > 0 && !reason) throw new UserFacingError(CATEGORY_MESSAGES.reasonRequired);
}

function periodCategory(schedule: CategorySchedule, target: string): { laborCategoryId: string | null; effectiveDate: CalendarDate | null } | null {
  if (target === 'starting') return { laborCategoryId: schedule.starting, effectiveDate: null };
  const c = schedule.changes.find((x) => x.id === target);
  return c ? { laborCategoryId: c.laborCategoryId, effectiveDate: c.effectiveDate } : null;
}

/** Add a "new category from a date" (may be backdated — DR-Q1 default; reason required when it re-prices hours). */
export async function addChargeCodeCategoryChange(input: AddCategoryChangeInput): Promise<ActionResult<CategoryScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateCategoryAddInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const state = await lockAndReadCategorySchedule(tx, v.chargeCodeId);
      if (!state) throw new UserFacingError(CATEGORY_MESSAGES.codeNotFound, 'not_found');
      await checkCategory(tx, v.laborCategoryId, state.code);
      const { schedule } = state;
      if (schedule.changes.some((c) => c.effectiveDate === v.effectiveDate)) throw new ConflictError(CATEGORY_MESSAGES.duplicateOn(v.effectiveDate));
      const before = chargeCodeCategoryOn(schedule, v.effectiveDate);
      if (before.laborCategoryId === v.laborCategoryId) throw new UserFacingError(CATEGORY_MESSAGES.alreadyInEffect(v.effectiveDate));
      const period = addedPeriod(schedule, v.effectiveDate);
      const repricedHours = await pricedHoursForChargeCode(tx, v.chargeCodeId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const [row] = await tx.insert(chargeCodeLaborCategories).values({
        chargeCodeId: v.chargeCodeId, effectiveDate: v.effectiveDate, laborCategoryId: v.laborCategoryId, createdBy: actor.id,
      }).returning({ id: chargeCodeLaborCategories.id });
      if (!row) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.chargeCodeId, action: 'category_change_added',
        oldValue: { target: before.source, laborCategoryId: before.laborCategoryId },
        newValue: { target: row.id, effectiveDate: v.effectiveDate, laborCategoryId: v.laborCategoryId, reason: v.reason, period, repricedHours },
      });
      return view(tx, v.chargeCodeId);
    });
  });
}

/** Correct a period's category — the starting category (may be set to null) or a change (never null). */
export async function correctChargeCodeCategory(input: CorrectCategoryInput): Promise<ActionResult<CategoryScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateCategoryCorrectInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const state = await lockAndReadCategorySchedule(tx, v.chargeCodeId);
      if (!state) throw new UserFacingError(CATEGORY_MESSAGES.codeNotFound, 'not_found');
      const { schedule } = state;
      const current = periodCategory(schedule, v.target);
      if (!current) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
      await checkCategory(tx, v.laborCategoryId, state.code);
      if (current.laborCategoryId === v.laborCategoryId) throw new UserFacingError(CATEGORY_MESSAGES.nothingToCorrect);
      const period = periodBounds(schedule, v.target);
      const repricedHours = await pricedHoursForChargeCode(tx, v.chargeCodeId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const now = new Date();
      const [row] = v.target === 'starting'
        ? await tx.update(chargeCodes).set({ laborCategoryId: v.laborCategoryId, updatedAt: now })
          .where(eq(chargeCodes.id, v.chargeCodeId)).returning({ id: chargeCodes.id })
        : await tx.update(chargeCodeLaborCategories).set({ laborCategoryId: v.laborCategoryId as string, updatedAt: now })
          .where(and(eq(chargeCodeLaborCategories.id, v.target), eq(chargeCodeLaborCategories.chargeCodeId, v.chargeCodeId)))
          .returning({ id: chargeCodeLaborCategories.id });
      if (!row) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.chargeCodeId, action: 'category_corrected',
        oldValue: { target: v.target, laborCategoryId: current.laborCategoryId },
        newValue: { target: v.target, effectiveDate: current.effectiveDate, laborCategoryId: v.laborCategoryId, reason: v.reason, period, repricedHours },
      });
      return view(tx, v.chargeCodeId);
    });
  });
}

/** Remove a change; its period falls back to the previous period's category. */
export async function removeChargeCodeCategoryChange(input: RemoveCategoryChangeInput): Promise<ActionResult<CategoryScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();
    const v = validateCategoryRemoveInput(input);
    const db = await getDbForWrite();
    return db.transaction(async (tx) => {
      const state = await lockAndReadCategorySchedule(tx, v.chargeCodeId);
      if (!state) throw new UserFacingError(CATEGORY_MESSAGES.codeNotFound, 'not_found');
      const { schedule } = state;
      const removed = schedule.changes.find((c) => c.id === v.changeId);
      if (!removed) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
      const period = periodBounds(schedule, v.changeId);
      const repricedHours = await pricedHoursForChargeCode(tx, v.chargeCodeId, period.from, period.toExclusive);
      requireReason(repricedHours, v.reason);
      const fallsBackTo = chargeCodeCategoryOn({ ...schedule, changes: schedule.changes.filter((c) => c.id !== v.changeId) }, removed.effectiveDate);
      const [row] = await tx.delete(chargeCodeLaborCategories)
        .where(and(eq(chargeCodeLaborCategories.id, v.changeId), eq(chargeCodeLaborCategories.chargeCodeId, v.chargeCodeId)))
        .returning({ id: chargeCodeLaborCategories.id });
      if (!row) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
      await logAdminChange(tx, {
        actorId: actor.id, entity: ENTITY, entityId: v.chargeCodeId, action: 'category_change_removed',
        oldValue: { target: v.changeId, laborCategoryId: removed.laborCategoryId },
        newValue: { target: v.changeId, effectiveDate: removed.effectiveDate, laborCategoryId: fallsBackTo.laborCategoryId, reason: v.reason, period, repricedHours },
      });
      return view(tx, v.chargeCodeId);
    });
  });
}

/**
 * How many recorded hours on this code a category change would re-price — before saving. Read only; validates ids,
 * date and category (no reason). Same not_found and DR-Q2 rules as the mutations.
 */
export async function previewChargeCodeCategoryImpact(input: CategoryImpactInput): Promise<ActionResult<RateImpact>> {
  return userAction(async () => {
    await requireAdminFresh();
    let chargeCodeId: string;
    let category: string | null | undefined; // undefined = no category to check (remove)
    let periodOf: (schedule: CategorySchedule) => { from: CalendarDate | null; toExclusive: CalendarDate | null };
    if (input?.kind === 'add') {
      const v = validateCategoryAddInput(input, { withReason: false });
      chargeCodeId = v.chargeCodeId;
      category = v.laborCategoryId;
      periodOf = (schedule) => addedPeriod(schedule, v.effectiveDate);
    } else if (input?.kind === 'correct' || input?.kind === 'remove') {
      const v = input.kind === 'correct' ? validateCategoryCorrectInput(input, { withReason: false }) : validateCategoryRemoveInput(input, { withReason: false });
      const ref = 'target' in v ? v.target : v.changeId;
      chargeCodeId = v.chargeCodeId;
      category = 'target' in v ? v.laborCategoryId : undefined;
      periodOf = (schedule) => {
        if (ref !== 'starting' && !schedule.changes.some((c) => c.id === ref)) throw new UserFacingError(CATEGORY_MESSAGES.periodGone, 'not_found');
        return periodBounds(schedule, ref);
      };
    } else {
      throw new UserFacingError('Choose a category change to preview.');
    }
    const db = await getDb();
    const state = await readCategorySchedule(db, chargeCodeId);
    if (!state) throw new UserFacingError(CATEGORY_MESSAGES.codeNotFound, 'not_found');
    if (category !== undefined && category !== null) {
      const placement = await readCategoryPlacement(db, category);
      if (!placement) throw new UserFacingError(CATEGORY_MESSAGES.categoryNotFound, 'not_found');
      if (!categoryFitsCode(placement, state.code)) throw new UserFacingError(CATEGORY_MESSAGES.wrongClin);
    }
    const period = periodOf(state.schedule);
    const hours = await pricedHoursForChargeCode(db, chargeCodeId, period.from, period.toExclusive);
    return { hours, from: period.from, toExclusive: period.toExclusive, reasonRequired: Number(hours) > 0 };
  });
}
