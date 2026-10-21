/**
 * Postgres error detection through Drizzle's wrapper. Drizzle 0.45 rethrows driver errors as
 * DrizzleQueryError, whose `message` is only "Failed query: <sql> params: <...>"; the Postgres
 * error (with its SQLSTATE `code` and `constraint_name`) is on `.cause`. Never match on message
 * text: it contains the caller's parameters.
 */
type PgErrorLike = { code?: string; constraint_name?: string };

function pgErrorOf(err: unknown): PgErrorLike | null {
  if (!err || typeof err !== 'object') return null;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause) return cause as PgErrorLike;
  if ('code' in err) return err as PgErrorLike;
  return null;
}

/** True if `err` is a unique-constraint violation (SQLSTATE 23505), optionally on `constraint`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint_name === constraint);
}
