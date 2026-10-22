import { describe, it, expect, vi } from 'vitest';

const postgresSpy = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('postgres', () => ({ default: postgresSpy }));

// feature-plan-terms-compliance-fixes.md §5.6: a deleted tenant's record carries an empty URL. postgres('') would
// silently fall back to PG* environment defaults (possibly another database) — it must throw before constructing.
describe('clientFor guard', () => {
  it('throws on an empty connection string and never constructs a client', async () => {
    // The unit setup mocks '@/db' globally; this test needs the real module.
    const { getDbForUrl } = await vi.importActual<typeof import('@/db')>('@/db');
    expect(() => getDbForUrl('')).toThrow(/No database URL/);
    expect(postgresSpy).not.toHaveBeenCalled();
  });
});
