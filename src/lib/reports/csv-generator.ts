import { escapeCsvField as escapeCSV } from '@/lib/csv/escape';

/**
 * Generate a CSV string from an array of objects.
 * Escaping (RFC 4180, CR included) and the formula guard: src/lib/csv/escape.ts.
 */
export function generateCsv<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[]
): string {
  const header = columns.map((c) => escapeCSV(c.header)).join(',');

  const rows = data.map((row) =>
    columns.map((c) => escapeCSV(String(row[c.key] ?? ''))).join(',')
  );

  return [header, ...rows].join('\n');
}

/**
 * Create a downloadable blob from CSV content.
 */
export function csvToBlob(csvContent: string): Blob {
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}
