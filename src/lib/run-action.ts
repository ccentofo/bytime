import { notifications } from '@mantine/notifications';
import type { ActionResult } from '@/lib/action-result';
import { toastError } from '@/lib/toast';

/**
 * Client-side caller for converted server actions (feature-plan-launch-blockers.md P4). Always resolves:
 * - an expected failure → `{ ok: false, code, error }` with the server's message (shown as a red notification);
 * - an unexpected one (the action threw — a bug, redacted by Next in production) → a generic message, never the
 *   raw error text.
 * Callers branch on the returned `.ok`; nothing may treat "didn't throw" as success.
 */
export const GENERIC_ACTION_ERROR = 'Something went wrong. Please try again.';

export type RunResult<T> = ActionResult<T> | { ok: false; code: 'unexpected'; error: string };

export interface RunActionOptions {
  /** Shown as a green notification on success. */
  successMessage?: string;
  /** Title of the red failure notification (default "Couldn’t complete that"). */
  errorTitle?: string;
  /** Don't show the failure notification (the caller renders the error itself). */
  silent?: boolean;
}

export async function runAction<T>(action: Promise<ActionResult<T>>, opts: RunActionOptions = {}): Promise<RunResult<T>> {
  let result: RunResult<T>;
  try {
    result = await action;
  } catch {
    result = { ok: false, code: 'unexpected', error: GENERIC_ACTION_ERROR };
  }
  if (!result.ok) {
    if (!opts.silent) {
      toastError({ title: opts.errorTitle ?? 'Couldn’t complete that', message: result.error });
    }
  } else if (opts.successMessage) {
    notifications.show({ title: 'Done', message: opts.successMessage, color: 'success' });
  }
  return result;
}
