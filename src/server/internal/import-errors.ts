import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { ConflictError, UserFacingError } from '@/lib/errors';
import { duplicateEntityMessage, isUniqueViolation } from '@/lib/db-errors';
import { isCalendarDate, type CalendarDate } from '@/lib/calendar-date';

/**
 * A message that is safe to show or store (launch-blockers audit A5; R7 for the integration sync log). Never the raw
 * error: a Drizzle error's message is "Failed query: <sql> params: <…>" — for employees that includes the bcrypt hash.
 * - a known duplicate → its specific message (A6); any other unique violation → `duplicateFallback` (else `fallback`);
 * - UserFacingError / ConflictError (incl. a bad date, see parseImportDate) → their own message;
 * - anything else → `fallback`, logged and reported (unless `report: false` — the caller rethrows it).
 */
export function safeErrorMessage(
  error: unknown,
  opts: { fallback: string; duplicateFallback?: string; logLabel: string; report?: boolean },
): string {
  const duplicate = duplicateEntityMessage(error);
  if (duplicate) return duplicate;
  if (isUniqueViolation(error)) return opts.duplicateFallback ?? opts.fallback;
  if (error instanceof UserFacingError || error instanceof ConflictError) return error.message;
  if (opts.report !== false) {
    console.error(opts.logLabel, error);
    Sentry.captureException(error);
  }
  return opts.fallback;
}

/** Per-row error message for the bulk imports (audit A5): safeErrorMessage with the import wording. */
export function importRowMessage(error: unknown, duplicateFallback: string): string {
  return safeErrorMessage(error, { fallback: 'Could not import this row.', duplicateFallback, logLabel: 'Bulk import row failed:' });
}

/** A YYYY-MM-DD import cell → CalendarDate, or a row-level UserFacingError naming the field. */
export function parseImportDate(value: string, label: string): CalendarDate {
  if (!isCalendarDate(value)) throw new UserFacingError(`${label} "${value}" is not a valid date (use YYYY-MM-DD).`);
  return value;
}
