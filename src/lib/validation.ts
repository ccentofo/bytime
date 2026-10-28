/**
 * Shared input validation utilities.
 * All validators throw on invalid input with descriptive error messages.
 * Used as guards at the top of server action mutation functions.
 */

import { formatCalendarDate, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { UserFacingError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// String Validators
// ---------------------------------------------------------------------------

export function validateRequired(value: unknown, fieldName: string): string {
  if (value === null || value === undefined) {
    throw new UserFacingError(`${fieldName} is required.`);
  }
  const str = String(value).trim();
  if (str.length === 0) {
    throw new UserFacingError(`${fieldName} cannot be empty.`);
  }
  return str;
}

export function validateStringLength(value: string, fieldName: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new UserFacingError(`${fieldName} must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw new UserFacingError(`${fieldName} must not exceed ${max} characters.`);
  }
  return trimmed;
}

export function validateOptionalString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  if (str.length > maxLength) {
    throw new UserFacingError(`${fieldName} must not exceed ${maxLength} characters.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Email Validator
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: unknown, fieldName: string = 'Email'): string {
  const str = validateRequired(value, fieldName).toLowerCase().trim();
  if (!EMAIL_REGEX.test(str)) {
    throw new UserFacingError(`${fieldName} is not a valid email address.`);
  }
  if (str.length > 255) {
    throw new UserFacingError(`${fieldName} must not exceed 255 characters.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Numeric Validators
// ---------------------------------------------------------------------------

/**
 * One cell's hours from an app save (feature-plan-ux-timesheet.md A4.4, UX3-D3): a real JS number — never a string,
 * so '' or '0x8' can't coerce through Number() and be stored raw — finite, 0–24, in QUARTER hours. Quarter hours are
 * exact in binary floating point, so the check is `Number.isInteger(value * 4)` with NO normalization: 7.2500001 is
 * refused, never rounded (trap T-D). Returns the value unchanged. History import has its own parser (L2).
 */
export function validateHours(value: unknown, fieldName: string = 'Hours', onDate?: CalendarDate): number {
  if (typeof value !== 'number') {
    throw new UserFacingError(`${fieldName} must be a number.`);
  }
  if (!Number.isFinite(value)) {
    throw new UserFacingError(`${fieldName} must be a valid number.`);
  }
  if (value < 0) {
    throw new UserFacingError(`${fieldName} cannot be negative.`);
  }
  if (value > 24) {
    throw new UserFacingError(`${fieldName} cannot exceed 24 hours per day.`);
  }
  if (!Number.isInteger(value * 4)) {
    throw new UserFacingError(
      onDate
        ? `${fieldName} must be in quarter hours (.00, .25, .50 or .75). ${value} on ${formatCalendarDate(onDate, 'MMM D, YYYY')} isn't.`
        : `${fieldName} must be in quarter hours (.00, .25, .50 or .75). ${value} isn't.`,
    );
  }
  return value;
}

export function validateMonetaryValue(value: unknown, fieldName: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new UserFacingError(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new UserFacingError(`${fieldName} cannot be negative.`);
  }
  if (num > 999999999.99) {
    throw new UserFacingError(`${fieldName} exceeds maximum allowed value.`);
  }
  return num.toFixed(2);
}

export function validateRate(value: unknown, fieldName: string): string {
  const str = validateRequired(value, fieldName);
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new UserFacingError(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new UserFacingError(`${fieldName} cannot be negative.`);
  }
  if (num > 9999.99) {
    throw new UserFacingError(`${fieldName} exceeds maximum allowed rate ($9,999.99/hr).`);
  }
  return num.toFixed(2);
}

// ---------------------------------------------------------------------------
// UUID Validator
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(value: unknown, fieldName: string): string {
  const str = validateRequired(value, fieldName);
  if (!UUID_REGEX.test(str)) {
    throw new UserFacingError(`${fieldName} is not a valid identifier.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Enum Validator
// ---------------------------------------------------------------------------

export function validateEnum<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T {
  const str = validateRequired(value, fieldName);
  if (!allowed.includes(str as T)) {
    throw new UserFacingError(`${fieldName} must be one of: ${allowed.join(', ')}.`);
  }
  return str as T;
}

// ---------------------------------------------------------------------------
// Date Validator
// ---------------------------------------------------------------------------

/** A required calendar date from user input → CalendarDate, or a UserFacingError (never parseCalendarDate's plain Error). */
export function validateCalendarDate(value: unknown, fieldName: string): CalendarDate {
  if (!isCalendarDate(value)) throw new UserFacingError(`${fieldName} must be a valid date (YYYY-MM-DD).`);
  return value;
}

export function validateOptionalCalendarDate(value: unknown, fieldName: string): CalendarDate | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isCalendarDate(value)) {
    throw new UserFacingError(`${fieldName} is not a valid date.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Contract Number Validator (specific format)
// ---------------------------------------------------------------------------

export function validateContractNumber(value: unknown): string {
  const str = validateRequired(value, 'Contract number');
  return validateStringLength(str, 'Contract number', 1, 50);
}

export function validateClinNumber(value: unknown): string {
  const str = validateRequired(value, 'CLIN number');
  return validateStringLength(str, 'CLIN number', 1, 50);
}

export function validateSlinNumber(value: unknown): string {
  const str = validateRequired(value, 'SLIN number');
  return validateStringLength(str, 'SLIN number', 1, 50);
}
