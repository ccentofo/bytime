import { describe, it, expect } from 'vitest';

/** feature-plan-ux-kit-contracts.md §3.3 / K-2: currency (cents vs whole), hours, counts; null → "—"; DB strings. */

import { formatCurrency, formatHours, formatCount } from '@/lib/format';

describe('formatters (K-2)', () => {
  it('currency: cents by default, whole dollars on request, separators, DB strings, negatives', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
    expect(formatCurrency('1234567.891')).toBe('$1,234,567.89');
    expect(formatCurrency(1234.5, { cents: false })).toBe('$1,235');
    expect(formatCurrency('5050000.00', { cents: false })).toBe('$5,050,000');
    expect(formatCurrency(-200.4, { cents: false })).toBe('-$200');
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('currency: null, undefined, empty and non-numeric → "—"', () => {
    for (const v of [null, undefined, '', '  ', 'abc', Number.NaN]) expect(formatCurrency(v as never)).toBe('—');
  });

  it('hours: two decimals with separators; blankZero; null → "—"; DB strings', () => {
    expect(formatHours(1719)).toBe('1,719.00');
    expect(formatHours('744.5')).toBe('744.50');
    expect(formatHours(0)).toBe('0.00');
    expect(formatHours(0, { blankZero: true })).toBe('');
    expect(formatHours('0.00', { blankZero: true })).toBe('');
    expect(formatHours(null)).toBe('—');
    expect(formatHours('x')).toBe('—');
  });

  it('counts: whole numbers with separators', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(0)).toBe('0');
  });
});
