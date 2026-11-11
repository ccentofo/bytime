import 'server-only';

/**
 * The setup imports' dry run (feature-plan-ux-setup-import.md P9, §4.3). A check runs the REAL import — the same
 * per-row code — and rolls everything back: the transaction body's LAST statement is `throwIfDryRun(dryRun, value)`,
 * which throws a sentinel carrying the body's full return value; postgres-js rolls back and rethrows it unchanged
 * (node_modules/postgres/src/index.js:257-279), and `catchDryRun` (around the transaction, outside it) turns it back into
 * that value. So a check and an import return the same shape, and there is no second copy of the validation. No wrapper
 * owns the transaction: each action keeps its own `db.transaction(async (tx) => { await lockUserRulesExclusive(tx); …`
 * where it locks (the lock-first test). INTERNAL.
 */

class DryRunRollback {
  constructor(readonly value: unknown) {}
}

/** The transaction body's last statement: on a dry run, roll back carrying `value`; otherwise return it. */
export function throwIfDryRun<T>(dryRun: boolean | undefined, value: T): T {
  if (dryRun === true) throw new DryRunRollback(value);
  return value;
}

/** Strip generated passwords from an ImportResult (alone or as `{ result }`) — a check never returns them. */
function withoutPasswords<T>(value: T): T {
  const strip = (r: unknown) => (r && typeof r === 'object' && 'generatedPasswords' in r ? { ...(r as object), generatedPasswords: [] } : r);
  if (value && typeof value === 'object' && 'result' in value) return { ...(value as object), result: strip((value as { result: unknown }).result) } as T;
  return strip(value) as T;
}

/** Around the transaction: a dry run's sentinel becomes its carried value (passwords stripped); anything else rethrows. */
export async function catchDryRun<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DryRunRollback) return withoutPasswords(e.value as T);
    throw e;
  }
}
