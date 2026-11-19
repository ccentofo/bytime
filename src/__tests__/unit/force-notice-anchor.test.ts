import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md §5 A2-D5: `tenant:admin force-notice-sent --anchor <bad>` refuses cleanly instead of crashing
 * (`new Date('bad').toISOString()` threw a RangeError in the refusal message). The refusal comes before any query.
 */

const h = vi.hoisted(() => ({ queries: 0, rows: [] as unknown[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane/locked', () => ({
  withLockedPool: async (fn: (db: unknown) => unknown) => {
    h.queries++;
    const chain = { from: () => chain, where: () => chain, orderBy: async () => h.rows };
    return fn({ select: () => chain });
  },
  withTenantLock: async () => { throw new Error('not used'); },
}));

import { AdminCommandError, findForceableNotice } from '@/lib/tenant/admin-commands';

beforeEach(() => {
  h.queries = 0;
  h.rows = [];
});

describe('A2-D5: findForceableNotice with an invalid --anchor', () => {
  it('refuses with "--anchor must be an ISO date-time." and runs no query', async () => {
    for (const bad of ['bad', '2026-13-45T99:00:00Z', '']) {
      const err = await findForceableNotice('t1', 'deletion-notice', new Date(bad)).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(AdminCommandError);
      expect((err as Error).message).toBe('--anchor must be an ISO date-time.');
    }
    expect(h.queries).toBe(0);
  });

  it('a valid anchor still reaches the lookup (and its normal "no notice" refusal names it)', async () => {
    const anchor = new Date('2026-10-01T00:00:00.000Z');
    await expect(findForceableNotice('t1', 'deletion-notice', anchor))
      .rejects.toThrow('No non-superseded "deletion-notice" notice with anchor 2026-10-01T00:00:00.000Z exists; refusing.');
    expect(h.queries).toBe(1);
  });

  it('no anchor at all is unchanged (looked up by kind)', async () => {
    await expect(findForceableNotice('t1', 'deletion-notice')).rejects.toThrow('No non-superseded "deletion-notice" notice exists; refusing.');
    expect(h.queries).toBe(1);
  });
});
