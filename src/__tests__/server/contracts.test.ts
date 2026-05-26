import { describe, it, expect } from 'vitest';
import { validateContractNumber, validateMonetaryValue, validateOptionalDate } from '@/lib/validation';

describe('Contract Validation', () => {
  it('validates contract number format', () => {
    expect(validateContractNumber('W58RGZ-21-C-0001')).toBe('W58RGZ-21-C-0001');
    expect(() => validateContractNumber('')).toThrow();
    expect(() => validateContractNumber('a'.repeat(51))).toThrow('must not exceed 50');
  });

  it('validates funded value', () => {
    expect(validateMonetaryValue('500000', 'Funded')).toBe('500000.00');
    expect(validateMonetaryValue(null, 'Funded')).toBeUndefined();
    expect(() => validateMonetaryValue('-100', 'Funded')).toThrow('cannot be negative');
  });

  it('validates dates', () => {
    const date = validateOptionalDate('2026-01-01', 'Start');
    expect(date).toBeInstanceOf(Date);
    expect(validateOptionalDate(null, 'Start')).toBeUndefined();
    expect(() => validateOptionalDate('not-a-date', 'Start')).toThrow('not a valid date');
  });
});
