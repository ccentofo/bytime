import { describe, it, expect } from 'vitest';
import {
  validateRequired,
  validateStringLength,
  validateOptionalString,
  validateEmail,
  validateHours,
  validateMonetaryValue,
  validateRate,
  validateUUID,
  validateEnum,
  validateContractNumber,
  validateClinNumber,
  validateSlinNumber,
} from '@/lib/validation';

describe('validateRequired', () => {
  it('returns trimmed string for valid input', () => {
    expect(validateRequired('  hello  ', 'Name')).toBe('hello');
  });
  it('throws for null', () => {
    expect(() => validateRequired(null, 'Name')).toThrow('Name is required');
  });
  it('throws for undefined', () => {
    expect(() => validateRequired(undefined, 'Name')).toThrow('Name is required');
  });
  it('throws for empty string', () => {
    expect(() => validateRequired('', 'Name')).toThrow('Name cannot be empty');
  });
  it('throws for whitespace-only string', () => {
    expect(() => validateRequired('   ', 'Name')).toThrow('Name cannot be empty');
  });
});

describe('validateEmail', () => {
  it('returns lowercase email for valid input', () => {
    expect(validateEmail('Admin@ByTime.Dev')).toBe('admin@bytime.dev');
  });
  it('throws for invalid email format', () => {
    expect(() => validateEmail('notanemail')).toThrow('not a valid email');
  });
  it('throws for empty email', () => {
    expect(() => validateEmail('')).toThrow('cannot be empty');
  });
});

describe('validateHours', () => {
  it('returns number for valid hours', () => {
    expect(validateHours(8)).toBe(8);
  });
  it('returns 0 for zero hours', () => {
    expect(validateHours(0)).toBe(0);
  });
  // UX-3 A4.4 (UX3-D3): quarter hours only, never rounded (was: rounds to 2 decimals).
  it('A-T5: accepts quarter hours exactly; refuses anything else with the day, never rounding', () => {
    for (const q of [0.25, 0.5, 0.75, 7.25, 23.75, 24]) expect(validateHours(q)).toBe(q);
    expect(() => validateHours(7.3, 'Hours', '2026-10-05' as never)).toThrow('Hours must be in quarter hours (.00, .25, .50 or .75). 7.3 on Oct 5, 2026 isn\'t.');
    expect(() => validateHours(7.2500001)).toThrow('quarter hours');
    expect(() => validateHours(8.125)).toThrow('quarter hours');
    expect(() => validateHours(0.1)).toThrow('quarter hours');
  });
  it('throws for negative hours', () => {
    expect(() => validateHours(-1)).toThrow('cannot be negative');
  });
  it('throws for hours > 24', () => {
    expect(() => validateHours(25)).toThrow('cannot exceed 24');
  });
  it('throws for NaN', () => {
    expect(() => validateHours(NaN)).toThrow('must be a valid number');
  });
  it('throws for Infinity', () => {
    expect(() => validateHours(Infinity)).toThrow('must be a valid number');
  });
  it('A-T5: only a real number — strings (even numeric ones), \'\', \'0x8\', null are refused (was: coerced through Number())', () => {
    for (const bad of ['abc', '8', '', '0x8', '7.25', null, undefined, true]) expect(() => validateHours(bad), String(bad)).toThrow('Hours must be a number.');
  });
});

describe('validateUUID', () => {
  it('accepts valid UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateUUID(uuid, 'ID')).toBe(uuid);
  });
  it('throws for invalid UUID', () => {
    expect(() => validateUUID('not-a-uuid', 'ID')).toThrow('not a valid identifier');
  });
  it('throws for empty string', () => {
    expect(() => validateUUID('', 'ID')).toThrow('cannot be empty');
  });
});

describe('validateMonetaryValue', () => {
  it('returns formatted value for valid input', () => {
    expect(validateMonetaryValue('100', 'Amount')).toBe('100.00');
  });
  it('returns undefined for null/empty', () => {
    expect(validateMonetaryValue(null, 'Amount')).toBeUndefined();
    expect(validateMonetaryValue('', 'Amount')).toBeUndefined();
  });
  it('throws for negative values', () => {
    expect(() => validateMonetaryValue('-50', 'Amount')).toThrow('cannot be negative');
  });
  it('throws for non-numeric input', () => {
    expect(() => validateMonetaryValue('abc', 'Amount')).toThrow('must be a valid number');
  });
});

describe('validateContractNumber', () => {
  it('accepts valid contract number', () => {
    expect(validateContractNumber('W58RGZ-21-C-0001')).toBe('W58RGZ-21-C-0001');
  });
  it('throws for empty', () => {
    expect(() => validateContractNumber('')).toThrow('cannot be empty');
  });
  it('throws for > 50 chars', () => {
    expect(() => validateContractNumber('a'.repeat(51))).toThrow('must not exceed 50');
  });
});
