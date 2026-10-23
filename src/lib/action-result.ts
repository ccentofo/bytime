import { unstable_rethrow } from 'next/navigation';
import { AuthorizationError } from '@/lib/session';
import { ConflictError, UserFacingError, WorkspaceReadOnlyError } from '@/lib/errors';
import { duplicateEntityMessage } from '@/lib/db-errors';

/**
 * Server-action result contract (feature-plan-launch-blockers.md P4). Every exported mutation returns an
 * ActionResult instead of throwing for an expected condition, because Next 16 production redacts the message of any
 * error thrown out of a server action (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md;
 * 01-app/01-getting-started/10-error-handling.md: "model expected errors as return values").
 *
 * Callers MUST read `.ok` (or use runAction) — a client that treats "no throw" as success is a bug the static
 * check in src/__tests__/unit/action-results-static.test.ts catches.
 */
export type ActionErrorCode = 'unauthenticated' | 'forbidden' | 'read_only' | 'conflict' | 'validation' | 'not_found';

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: ActionErrorCode };

/**
 * Run an action body and convert EXPECTED errors into a failed result. Keep the guard as the first statement of
 * `fn` (the guard-coverage test scans the whole exported body, including this callback).
 *
 * - redirect()/notFound() and other Next control flow are rethrown first (unstable_rethrow).
 * - AuthorizationError → unauthenticated/forbidden; WorkspaceReadOnlyError → read_only;
 *   ConflictError → conflict; UserFacingError → its own code; a known duplicate (unique email, contract number,
 *   charge code… — DUPLICATE_ENTITY_MESSAGES in @/lib/db-errors) → conflict with a specific message.
 * - Anything else is a bug: rethrown unchanged (reported to Sentry by instrumentation's onRequestError; the
 *   browser gets Next's generic redacted error, never SQL text).
 */
export async function userAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof AuthorizationError) return { ok: false, code: err.kind, error: err.message };
    if (err instanceof WorkspaceReadOnlyError) return { ok: false, code: 'read_only', error: err.message };
    if (err instanceof ConflictError) return { ok: false, code: 'conflict', error: err.message };
    if (err instanceof UserFacingError) return { ok: false, code: err.code, error: err.message };
    // Audit A6: a known duplicate (unique email, contract number, charge code, …) → a specific, safe message.
    const duplicate = duplicateEntityMessage(err);
    if (duplicate) return { ok: false, code: 'conflict', error: duplicate };
    throw err;
  }
}
