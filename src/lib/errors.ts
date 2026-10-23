/**
 * Expected-condition errors (feature-plan-launch-blockers.md P4). Thrown by actions, src/lib/validation.ts and the
 * internal helpers they call; `userAction` (src/lib/action-result.ts) turns them into `{ ok: false, code, error }`
 * results, so the message reaches the user verbatim — Next 16 production redacts the message of anything THROWN
 * out of a server action. Anything that is not one of these is a bug: it is rethrown, reported, and shown generically.
 *
 * Messages must be safe to show the user: no SQL, ids of other tenants' data, or stack details.
 */

export type UserFacingCode = 'validation' | 'not_found' | 'forbidden';

export class UserFacingError extends Error {
  readonly code: UserFacingCode;

  constructor(message: string, code: UserFacingCode = 'validation') {
    super(message);
    this.name = 'UserFacingError';
    this.code = code;
  }
}

/**
 * Thrown by the write gate (getTenantForWrite / getDbForWrite) when the workspace's access mode isn't `full`.
 * Lives here — not in src/lib/tenant/context.ts, which re-exports it — so `userAction`'s instanceof check never
 * depends on a module that tests routinely mock.
 */
export class WorkspaceReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceReadOnlyError';
  }
}

/** Someone else changed the same thing first (concurrent edit, stale revision, double decision). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
