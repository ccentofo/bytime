import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { duplicateEntityMessage, isUniqueViolation } from '@/lib/db-errors';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * Per-row error message for the bulk imports (launch-blockers audit A5). Never the raw error: a Drizzle error's
 * message is "Failed query: <sql> params: <…>" — for employees that includes the bcrypt hash.
 * - a known duplicate → its specific message (A6); any other unique violation → `duplicateFallback`;
 * - UserFacingError / ConflictError (incl. a bad date, see parseImportDate) → their own message;
 * - anything else → "Could not import this row.", logged and reported.
 */
export function importRowMessage(error: unknown, duplicateFallback: string): string {
  const duplicate = duplicateEntityMessage(error);
  if (duplicate) return duplicate;
  if (isUniqueViolation(error)) return duplicateFallback;
  if (error instanceof UserFacingError || error instanceof ConflictError) return error.message;
  console.error('Bulk import row failed:', error);
  Sentry.captureException(error);
  return 'Could not import this row.';
}

/** A YYYY-MM-DD import cell → CalendarDate, or a row-level UserFacingError naming the field. */
export function parseImportDate(value: string, label: string): CalendarDate {
  if (!isCalendarDate(value)) throw new UserFacingError(`${label} "${value}" is not a valid date (use YYYY-MM-DD).`);
  return value;
}
