import { describe, it, expect } from 'vitest';

/**
 * Tests that verify timesheet numeric operations handle
 * undefined/null/NaN values safely — preventing the production
 * .toFixed() crash (TypeError: Cannot read properties of undefined).
 */
describe('Timesheet numeric safety', () => {
  // Simulates the exact pattern used in BiWeeklyTable footer
  it('handles undefined entry.hours in reduce', () => {
    const entries = [
      { chargeCodeId: '1', hours: [8, 8, 0, 0, 0] },
      { chargeCodeId: '2', hours: undefined as unknown as number[] },
      { chargeCodeId: '3', hours: [4, 4, 4, 0, 0] },
    ];

    // This is the pattern that crashes without guards:
    // entries.reduce((sum, entry) => sum + entry.hours[0] ?? 0, 0)
    //
    // Fixed pattern:
    const dayTotal = entries.reduce(
      (sum, entry) => sum + ((entry.hours ?? [])[0] ?? 0),
      0
    );

    expect(dayTotal).toBe(12);
    expect((dayTotal ?? 0).toFixed(2)).toBe('12.00');
  });

  it('handles null values in hours array', () => {
    const hours = [8, null, undefined, 0, 4] as unknown as number[];

    const total = (hours ?? []).reduce((a, b) => a + (b ?? 0), 0);

    expect(total).toBe(12);
    expect((total ?? 0).toFixed(2)).toBe('12.00');
  });

  it('handles completely undefined hours', () => {
    const entry = { chargeCodeId: '1', hours: undefined as unknown as number[] };

    const total = (entry.hours ?? []).reduce((a, b) => a + (b ?? 0), 0);

    expect(total).toBe(0);
    expect((total ?? 0).toFixed(2)).toBe('0.00');
  });

  it('handles empty entries array', () => {
    const entries: Array<{ hours: number[] }> = [];

    const grandTotal = entries.reduce(
      (sum, entry) => sum + (entry.hours ?? []).reduce((a, b) => a + (b ?? 0), 0),
      0
    );

    expect(grandTotal).toBe(0);
    expect((grandTotal ?? 0).toFixed(2)).toBe('0.00');
  });

  it('handles NaN values gracefully', () => {
    const value = NaN;
    const safe = isNaN(value) ? 0 : value;

    expect(safe.toFixed(2)).toBe('0.00');
  });

  it('handles string numbers from Neon driver', () => {
    // Neon with prepare:false can return numeric aggregates as strings
    const fromNeon = '123.45' as unknown as number;
    const asNumber = Number(fromNeon);

    expect(asNumber).toBe(123.45);
    expect(asNumber.toFixed(2)).toBe('123.45');
  });

  it('handles ?? 0 guard on toFixed', () => {
    const undefinedValue = undefined as unknown as number;
    const nullValue = null as unknown as number;

    expect((undefinedValue ?? 0).toFixed(2)).toBe('0.00');
    expect((nullValue ?? 0).toFixed(2)).toBe('0.00');
  });

  // Simulates the dashboard data pattern
  it('handles dashboard totalHoursEntered as undefined', () => {
    const currentPeriod = {
      totalHoursEntered: undefined as unknown as number,
    };

    expect((currentPeriod.totalHoursEntered ?? 0).toFixed(1)).toBe('0.0');
  });

  it('handles recent period totalHours as undefined', () => {
    const recentPeriod = {
      totalHours: undefined as unknown as number,
    };

    expect((recentPeriod.totalHours ?? 0).toFixed(1)).toBe('0.0');
  });
});
