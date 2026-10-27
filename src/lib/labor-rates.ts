import { compare, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';
import { validateOptionalCalendarDate, validateRate, validateRequired, validateStringLength, validateUUID } from '@/lib/validation';

/**
 * Dated labor-category rates (feature-plan-dated-rates.md D1.2) — THE pure rate rule. Client-safe (no server-only).
 * Rate of a category on day D = the latest change with effective_date <= D, else the starting rate (inclusive on the
 * effective date; no end dates, so periods never overlap or leave gaps). The SQL twin is hourlyRateOnSql
 * (src/server/internal/labor-rates.ts); an integration test proves they agree. No floats beyond sameRate's comparison,
 * no Date, no money arithmetic.
 */

export interface RatePeriodValues { hourlyRate: string; ceilingRate: string | null }
export interface RateChange extends RatePeriodValues { id: string; effectiveDate: CalendarDate }
export interface RateSchedule { starting: RatePeriodValues; changes: RateChange[] } // changes in ANY order
export type RatePeriodRef = 'starting' | string;                                     // 'starting' or a change id

export function rateOn(s: RateSchedule, day: CalendarDate): RatePeriodValues & { source: RatePeriodRef } {
  let best: RateChange | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, day) <= 0 && (best === null || compare(c.effectiveDate, best.effectiveDate) > 0)) best = c;
  }
  return best ? { hourlyRate: best.hourlyRate, ceilingRate: best.ceilingRate, source: best.id } : { ...s.starting, source: 'starting' };
}

export function periodBounds<S extends { changes: Array<{ id: string; effectiveDate: CalendarDate }> }>(s: S, ref: RatePeriodRef): { from: CalendarDate | null; toExclusive: CalendarDate | null } {
  const sorted = [...s.changes].sort((a, b) => compare(a.effectiveDate, b.effectiveDate));
  if (ref === 'starting') return { from: null, toExclusive: sorted[0]?.effectiveDate ?? null };
  const i = sorted.findIndex((c) => c.id === ref);
  if (i < 0) throw new Error(`periodBounds: unknown change ${ref}`); // programming error only
  return { from: sorted[i].effectiveDate, toExclusive: sorted[i + 1]?.effectiveDate ?? null };
}

/** The period a NEW change on `day` would cover: [day, the next change after day). */
export function addedPeriod(s: { changes: Array<{ effectiveDate: CalendarDate }> }, day: CalendarDate): { from: CalendarDate; toExclusive: CalendarDate | null } {
  let next: CalendarDate | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, day) > 0 && (next === null || compare(c.effectiveDate, next) < 0)) next = c.effectiveDate;
  }
  return { from: day, toExclusive: next };
}

/** Rates compared as numbers (stored values may be '145' or '145.00'); unparseable values never compare equal. */
export function sameRate(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x.toFixed(2) === y.toFixed(2);
}

/** Main-table display (D2), pure so it is unit-testable: current values and the next later change, if any. */
export function rateDisplay(s: RateSchedule, today: CalendarDate): { current: RatePeriodValues; next: RateChange | null } {
  const { hourlyRate, ceilingRate } = rateOn(s, today);
  const current: RatePeriodValues = { hourlyRate, ceilingRate };
  let next: RateChange | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, today) > 0 && (next === null || compare(c.effectiveDate, next.effectiveDate) < 0)) next = c;
  }
  return { current, next };
}

/**
 * Reason input: null / undefined / blank after trim → null (no reason); otherwise
 * validateStringLength(validateRequired(reason, 'Reason'), 'Reason', 1, 500). Pure; lives here, NOT in the 'use server'
 * file (a sync export there breaks the build and the guard test).
 */
export function normalizeReason(reason: unknown): string | null {
  if (reason === null || reason === undefined) return null;
  if (typeof reason === 'string' && reason.trim() === '') return null;
  return validateStringLength(validateRequired(reason, 'Reason'), 'Reason', 1, 500);
}

// ── Action inputs / outputs (the client imports these types) ────────────────────────────────────────────────────
export interface AddRateChangeInput { laborCategoryId: string; effectiveDate: string; hourlyRate: string; ceilingRate: string | null; reason?: string }
export interface CorrectRateInput { laborCategoryId: string; target: RatePeriodRef; hourlyRate: string; ceilingRate: string | null; reason?: string }
export interface RemoveRateChangeInput { laborCategoryId: string; changeId: string; reason?: string }
export type RateImpactInput = ({ kind: 'add' } & AddRateChangeInput) | ({ kind: 'correct' } & CorrectRateInput) | ({ kind: 'remove' } & RemoveRateChangeInput);
export interface RateImpact { hours: string /* 2 decimals, e.g. '12.00' */; from: CalendarDate | null; toExclusive: CalendarDate | null; reasonRequired: boolean /* hours > 0 */ }
export interface RateScheduleView extends RateSchedule { laborCategoryId: string }

// ── Pure validation (step 2 of every action; the preview ignores `reason`) ─────────────────────────────────────
export const EFFECTIVE_DATE_INVALID = 'Effective date is not a valid date.';

export function validateEffectiveDate(value: unknown): CalendarDate {
  const d = validateOptionalCalendarDate(value, 'Effective date');
  if (!d) throw new UserFacingError(EFFECTIVE_DATE_INVALID);
  return d;
}

export function validateCeiling(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : validateRate(value, 'Ceiling rate');
}

/** 'starting' or a change id (uuid). */
export function validateTarget(value: unknown): RatePeriodRef {
  return value === 'starting' ? 'starting' : validateUUID(value, 'Rate period');
}

export interface ValidAdd { laborCategoryId: string; effectiveDate: CalendarDate; hourlyRate: string; ceilingRate: string | null; reason: string | null }
export interface ValidCorrect { laborCategoryId: string; target: RatePeriodRef; hourlyRate: string; ceilingRate: string | null; reason: string | null }
export interface ValidRemove { laborCategoryId: string; changeId: string; reason: string | null }

export function validateAddInput(input: AddRateChangeInput, opts: { withReason?: boolean } = { withReason: true }): ValidAdd {
  return {
    laborCategoryId: validateUUID(input?.laborCategoryId, 'Labor category'),
    effectiveDate: validateEffectiveDate(input?.effectiveDate),
    hourlyRate: validateRate(input?.hourlyRate, 'Hourly rate'),
    ceilingRate: validateCeiling(input?.ceilingRate),
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

export function validateCorrectInput(input: CorrectRateInput, opts: { withReason?: boolean } = { withReason: true }): ValidCorrect {
  return {
    laborCategoryId: validateUUID(input?.laborCategoryId, 'Labor category'),
    target: validateTarget(input?.target),
    hourlyRate: validateRate(input?.hourlyRate, 'Hourly rate'),
    ceilingRate: validateCeiling(input?.ceilingRate),
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

export function validateRemoveInput(input: RemoveRateChangeInput, opts: { withReason?: boolean } = { withReason: true }): ValidRemove {
  return {
    laborCategoryId: validateUUID(input?.laborCategoryId, 'Labor category'),
    changeId: validateUUID(input?.changeId, 'Rate period'),
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

// ── Exact messages (blueprint §4 D1.5) ──────────────────────────────────────────────────────────────────────────
export const RATE_MESSAGES = {
  categoryNotFound: 'Labor category not found.',
  periodGone: 'That rate period no longer exists. Refresh and try again.',
  duplicateOn: (date: string) => `There is already a rate change on ${date} for this labor category. Correct that one instead.`,
  alreadyInEffect: (date: string) => `That is already the rate in effect on ${date}.`,
  nothingToCorrect: 'Nothing to correct — the values are unchanged.',
  reasonRequired: 'A reason is required because this change re-prices recorded hours.',
} as const;

// ── D3: a charge code's dated labor category (same pattern) ────────────────────────────────────────────────────
/** `starting` = charge_codes.labor_category_id (may be null); a dated change always names a category. */
export interface CategoryChange { id: string; effectiveDate: CalendarDate; laborCategoryId: string }
export interface CategorySchedule { starting: string | null; changes: CategoryChange[] } // changes in ANY order
export interface CategoryScheduleView extends CategorySchedule { chargeCodeId: string }

/** Pure twin of chargeCodeLaborCategoryOnSql: the latest change with effective_date <= day, else the starting category. */
export function chargeCodeCategoryOn(s: CategorySchedule, day: CalendarDate): { laborCategoryId: string | null; source: RatePeriodRef } {
  let best: CategoryChange | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, day) <= 0 && (best === null || compare(c.effectiveDate, best.effectiveDate) > 0)) best = c;
  }
  return best ? { laborCategoryId: best.laborCategoryId, source: best.id } : { laborCategoryId: s.starting, source: 'starting' };
}

export interface AddCategoryChangeInput { chargeCodeId: string; effectiveDate: string; laborCategoryId: string | null; reason?: string }
export interface CorrectCategoryInput { chargeCodeId: string; target: RatePeriodRef; laborCategoryId: string | null; reason?: string }
export interface RemoveCategoryChangeInput { chargeCodeId: string; changeId: string; reason?: string }
export type CategoryImpactInput = ({ kind: 'add' } & AddCategoryChangeInput) | ({ kind: 'correct' } & CorrectCategoryInput) | ({ kind: 'remove' } & RemoveCategoryChangeInput);

export const CATEGORY_MESSAGES = {
  codeNotFound: 'Charge code not found.',
  categoryNotFound: 'Labor category not found.',
  datedNeedsCategory: 'A dated change must name a labor category.',
  periodGone: 'That category period no longer exists. Refresh and try again.',
  duplicateOn: (date: string) => `There is already a category change on ${date} for this charge code. Correct that one instead.`,
  alreadyInEffect: (date: string) => `That is already the category in effect on ${date}.`,
  nothingToCorrect: 'Nothing to correct — the category is unchanged.',
  reasonRequired: 'A reason is required because this change re-prices recorded hours.',
  wrongClin: 'That labor category belongs to a different CLIN or SLIN than this charge code.',
} as const;

/** null is allowed only where `allowNull` (the starting category); otherwise the dated-change message. */
export function validateCategoryRef(value: unknown, allowNull: boolean): string | null {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new UserFacingError(CATEGORY_MESSAGES.datedNeedsCategory);
  }
  return validateUUID(value, 'Labor category');
}

export interface ValidCategoryAdd { chargeCodeId: string; effectiveDate: CalendarDate; laborCategoryId: string; reason: string | null }
export interface ValidCategoryCorrect { chargeCodeId: string; target: RatePeriodRef; laborCategoryId: string | null; reason: string | null }
export interface ValidCategoryRemove { chargeCodeId: string; changeId: string; reason: string | null }

export function validateCategoryAddInput(input: AddCategoryChangeInput, opts: { withReason?: boolean } = { withReason: true }): ValidCategoryAdd {
  return {
    chargeCodeId: validateUUID(input?.chargeCodeId, 'Charge code'),
    effectiveDate: validateEffectiveDate(input?.effectiveDate),
    laborCategoryId: validateCategoryRef(input?.laborCategoryId, false) as string,
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

export function validateCategoryCorrectInput(input: CorrectCategoryInput, opts: { withReason?: boolean } = { withReason: true }): ValidCategoryCorrect {
  const target = input?.target === 'starting' ? 'starting' : validateUUID(input?.target, 'Category period');
  return {
    chargeCodeId: validateUUID(input?.chargeCodeId, 'Charge code'),
    target,
    laborCategoryId: validateCategoryRef(input?.laborCategoryId, target === 'starting'),
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

export function validateCategoryRemoveInput(input: RemoveCategoryChangeInput, opts: { withReason?: boolean } = { withReason: true }): ValidCategoryRemove {
  return {
    chargeCodeId: validateUUID(input?.chargeCodeId, 'Charge code'),
    changeId: validateUUID(input?.changeId, 'Category period'),
    reason: opts.withReason === false ? null : normalizeReason(input?.reason),
  };
}

/** DR-Q2 default: a category must sit on the code's CLIN, and on its SLIN when both have one. */
export function categoryFitsCode(category: { clinId: string; slinId: string | null }, code: { clinId: string; slinId: string | null }): boolean {
  if (category.clinId !== code.clinId) return false;
  return !(category.slinId && code.slinId && category.slinId !== code.slinId);
}
