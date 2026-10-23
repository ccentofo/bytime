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

/**
 * Launch-blockers audit A6: unique constraints whose violation is an ordinary "that already exists" — mapped to a
 * specific, safe message (userAction returns it as `{ ok: false, code: 'conflict' }`; the bulk imports use it per row).
 * Constraint names are Drizzle's (`<table>_<column>_unique`) and the named unique indexes in src/db/schema.ts.
 */
export const DUPLICATE_ENTITY_MESSAGES: Readonly<Record<string, string>> = {
  users_email_unique: 'A user with that email already exists.',
  contracts_contract_number_unique: 'A contract with that number already exists.',
  charge_codes_code_unique: 'A charge code with that code already exists.',
  indirect_charge_codes_code_unique: 'An indirect code with that code already exists.',
  cost_classes_name_unique: 'A cost class with that name already exists.',
  clin_slin_unique_idx: 'That SLIN number already exists on this CLIN.',
  clin_lcat_unique_idx: 'That labor category code already exists on this CLIN.',
  user_lcat_effective_unique_idx: 'That employee already has this labor category from that date.',
};

/** The friendly message for a known duplicate (see DUPLICATE_ENTITY_MESSAGES), or null. */
export function duplicateEntityMessage(err: unknown): string | null {
  const pg = pgErrorOf(err);
  if (pg?.code !== '23505' || !pg.constraint_name) return null;
  return DUPLICATE_ENTITY_MESSAGES[pg.constraint_name] ?? null;
}
