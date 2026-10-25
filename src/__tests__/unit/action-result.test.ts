import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P4 §1 / §9 "Action results": userAction converts EXPECTED errors into results,
 * rethrows Next control flow and bugs; runAction never shows raw error text.
 */

vi.mock('server-only', () => ({}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
// The context mock deliberately has NO WorkspaceReadOnlyError: userAction must not depend on that (often mocked) module.
vi.mock('@/lib/tenant/context', () => ({ getTenantOrThrow: async () => ({ plan: 'trial' }) }));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  return { AuthorizationError };
});

import { redirect } from 'next/navigation';
import { userAction } from '@/lib/action-result';
import { runAction, GENERIC_ACTION_ERROR } from '@/lib/run-action';
import { AuthorizationError } from '@/lib/session';
import { ConflictError, UserFacingError, WorkspaceReadOnlyError } from '@/lib/errors';
import { assertSeatsAvailable } from '@/server/internal/seats';
import { assertEntryDatesEditable } from '@/server/internal/periods';
import type { CalendarDate } from '@/lib/calendar-date';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('userAction', () => {
  it('returns { ok: true, data } on success', async () => {
    await expect(userAction(async () => 42)).resolves.toEqual({ ok: true, data: 42 });
  });

  it.each([
    [new AuthorizationError('unauthenticated', 'Unauthorized: No active session'), 'unauthenticated'],
    [new AuthorizationError('forbidden', 'Forbidden: Admin role required'), 'forbidden'],
    [new WorkspaceReadOnlyError('This workspace is read-only.'), 'read_only'],
    [new ConflictError('Someone else saved first.'), 'conflict'],
    [new UserFacingError('Name is required.'), 'validation'],
    [new UserFacingError('Period not found', 'not_found'), 'not_found'],
  ])('known error %s → { ok: false, code: %s, error: message }', async (err, code) => {
    await expect(userAction(async () => { throw err; })).resolves.toEqual({ ok: false, code, error: err.message });
  });

  it('an unexpected DB error is rethrown, never turned into a result carrying its SQL text', async () => {
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint "x"; SELECT * FROM users'), { code: '23505' });
    await expect(userAction(async () => { throw dbError; })).rejects.toBe(dbError);
  });

  it('runAction shows a generic message (no SQL text) when the action throws', async () => {
    const result = await runAction(userAction(async () => { throw new Error('relation "users" does not exist — SELECT ...'); }));
    expect(result).toEqual({ ok: false, code: 'unexpected', error: GENERIC_ACTION_ERROR });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|relation/);
  });

  it('redirect() inside an action still redirects (rethrown, not converted)', async () => {
    const pending = userAction(async () => { redirect('/somewhere'); });
    await expect(pending).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });
  });
});

describe('expected messages reach the client verbatim in production mode', () => {
  it('"seat limit reached" (assertSeatsAvailable)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const executor = { select: () => ({ from: () => ({ where: async () => [{ value: 10 }] }) }) }; // trial: 10 seats, all used
    const result = await userAction(() => assertSeatsAvailable(1, executor as never));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('validation');
    expect(!result.ok && result.error).toMatch(/plan allows 10 active users/);
  });

  it('"period locked" (assertEntryDatesEditable)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const executor = {
      select: () => ({ from: () => ({ where: async () => [{ periodStart: '2026-01-01', status: 'approved', periodNumDays: 15 }] }) }),
    };
    const result = await userAction(() => assertEntryDatesEditable('u1', ['2026-01-05' as CalendarDate], async () => 15, executor as never));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/certified and is locked/);
  });
});
