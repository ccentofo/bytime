/**
 * Shared input validation utilities.
 * All validators throw on invalid input with descriptive error messages.
 * Used as guards at the top of server action mutation functions.
 */

// ---------------------------------------------------------------------------
// String Validators
// ---------------------------------------------------------------------------

export function validateRequired(value: unknown, fieldName: string): string {
  if (value === null || value === undefined) {
    throw new Error(`${fieldName} is required.`);
  }
  const str = String(value).trim();
  if (str.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return str;
}

export function validateStringLength(value: string, fieldName: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new Error(`${fieldName} must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw new Error(`${fieldName} must not exceed ${max} characters.`);
  }
  return trimmed;
}

export function validateOptionalString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  if (str.length > maxLength) {
    throw new Error(`${fieldName} must not exceed ${maxLength} characters.`);
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
    throw new Error(`${fieldName} is not a valid email address.`);
  }
  if (str.length > 255) {
    throw new Error(`${fieldName} must not exceed 255 characters.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Numeric Validators
// ---------------------------------------------------------------------------

export function validateHours(value: unknown, fieldName: string = 'Hours'): number {
  const num = Number(value);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 24) {
    throw new Error(`${fieldName} cannot exceed 24 hours per day.`);
  }
  return Math.round(num * 100) / 100; // 2 decimal places
}

export function validateMonetaryValue(value: unknown, fieldName: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value).trim();
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 999999999.99) {
    throw new Error(`${fieldName} exceeds maximum allowed value.`);
  }
  return num.toFixed(2);
}

export function validateRate(value: unknown, fieldName: string): string {
  const str = validateRequired(value, fieldName);
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  if (num < 0) {
    throw new Error(`${fieldName} cannot be negative.`);
  }
  if (num > 9999.99) {
    throw new Error(`${fieldName} exceeds maximum allowed rate ($9,999.99/hr).`);
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
    throw new Error(`${fieldName} is not a valid identifier.`);
  }
  return str;
}

// ---------------------------------------------------------------------------
// Enum Validator
// ---------------------------------------------------------------------------

export function validateEnum<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T {
  const str = validateRequired(value, fieldName);
  if (!allowed.includes(str as T)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}.`);
  }
  return str as T;
}

// ---------------------------------------------------------------------------
// Date Validator
// ---------------------------------------------------------------------------

export function validateOptionalDate(value: unknown, fieldName: string): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = new Date(value as string | number | Date);
  if (isNaN(date.getTime())) {
    throw new Error(`${fieldName} is not a valid date.`);
  }
  return date;
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
