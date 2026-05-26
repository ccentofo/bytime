import { describe, it, expect } from 'vitest';
import { generateCsv } from '@/lib/reports/csv-generator';

describe('generateCsv', () => {
  it('generates correct CSV header and rows', () => {
    const data = [
      { name: 'Alice', hours: 8, date: '2026-05-01' },
      { name: 'Bob', hours: 6.5, date: '2026-05-01' },
    ];
    const columns = [
      { key: 'name' as const, header: 'Employee' },
      { key: 'hours' as const, header: 'Hours' },
      { key: 'date' as const, header: 'Date' },
    ];
    const csv = generateCsv(data, columns);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Employee,Hours,Date');
    expect(lines[1]).toBe('Alice,8,2026-05-01');
    expect(lines[2]).toBe('Bob,6.5,2026-05-01');
  });

  it('escapes commas in values', () => {
    const data = [{ name: 'Smith, John', value: '100' }];
    const columns = [
      { key: 'name' as const, header: 'Name' },
      { key: 'value' as const, header: 'Value' },
    ];
    const csv = generateCsv(data, columns);
    expect(csv).toContain('"Smith, John"');
  });

  it('escapes quotes in values', () => {
    const data = [{ name: 'The "Boss"', value: '100' }];
    const columns = [
      { key: 'name' as const, header: 'Name' },
      { key: 'value' as const, header: 'Value' },
    ];
    const csv = generateCsv(data, columns);
    expect(csv).toContain('"The ""Boss"""');
  });

  it('handles empty data', () => {
    const csv = generateCsv([], [{ key: 'name' as const, header: 'Name' }]);
    expect(csv).toBe('Name');
  });
});
