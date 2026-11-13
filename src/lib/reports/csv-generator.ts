import { escapeCsvField as escapeCSV } from '@/lib/csv/escape';

/**
 * The CSV's lines, `[header, ...rows]`, unjoined (feature-plan-large-report-responses.md §6.2): the streamed cost CSV
 * sends them in chunks. Escaping (RFC 4180, CR included) and the formula guard: src/lib/csv/escape.ts.
 */
export function csvLines<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[]
): string[] {
  const header = columns.map((c) => escapeCSV(c.header)).join(',');

  const rows = data.map((row) =>
    columns.map((c) => escapeCSV(String(row[c.key] ?? ''))).join(',')
  );

  return [header, ...rows];
}

/**
 * Generate a CSV string from an array of objects: csvLines joined with '\n' (no trailing newline), so the two can't drift.
 */
export function generateCsv<T extends object>(
  data: T[],
  columns: { key: keyof T; header: string }[]
): string {
  return csvLines(data, columns).join('\n');
}

/**
 * Create a downloadable blob from CSV content.
 */
export function csvToBlob(csvContent: string): Blob {
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}
