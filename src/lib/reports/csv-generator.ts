/**
 * Generate a CSV string from an array of objects.
 * Handles escaping commas, quotes, and newlines per RFC 4180.
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

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Create a downloadable blob from CSV content.
 */
export function csvToBlob(csvContent: string): Blob {
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}
