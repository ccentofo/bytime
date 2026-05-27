// eslint-disable-next-line @typescript-eslint/no-require-imports
const Papa = require('papaparse');

export interface ParsedRow {
  rowIndex: number;
  data: Record<string, string>;
  errors: string[];
  isValid: boolean;
}

export interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
}

/**
 * Parse a CSV file and validate each row against required columns.
 */
export function parseCSV(
  csvText: string,
  requiredColumns: string[],
  validateRow?: (row: Record<string, string>, index: number) => string[]
): ParseResult {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  const headers: string[] = parsed.meta?.fields ?? [];

  // Check for missing required columns
  const missingColumns = requiredColumns.filter((col) => !headers.includes(col));
  if (missingColumns.length > 0) {
    return {
      headers,
      rows: [],
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
    };
  }

  const rows: ParsedRow[] = (parsed.data as Record<string, string>[]).map((data, index) => {
    const errors: string[] = [];

    // Check required fields are not empty
    for (const col of requiredColumns) {
      if (!data[col]?.trim()) {
        errors.push(`${col} is required`);
      }
    }

    // Run custom validation
    if (validateRow) {
      errors.push(...validateRow(data, index));
    }

    return {
      rowIndex: index + 1,
      data,
      errors,
      isValid: errors.length === 0,
    };
  });

  return {
    headers,
    rows,
    totalRows: rows.length,
    validRows: rows.filter((r) => r.isValid).length,
    errorRows: rows.filter((r) => !r.isValid).length,
  };
}

/**
 * Validate email format.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Generate a random password (12 chars, mixed case + numbers).
 */
export function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
