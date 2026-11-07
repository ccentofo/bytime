import { describe, it, expect, vi } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §5.1 / US-2 unit companion: lockoutFromRows is the one lock arithmetic (5 failures in
 * 15 minutes after the latest success; truncated minutes; locked only while > 0), and getLockoutsForEmails reads all
 * emails in ONE query, keyed by the lowercased email, reporting only locked ones.
 */
vi.mock('server-only', () => ({}));
import { getLockoutsForEmails, lockoutFromRows } from '@/server/internal/login-attempts';
import { createFakeControlDb } from '../helpers/fake-control-db';
import { loginAttempts } from '@/db/schema';

const NOW = new Date('2026-11-06T15:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const S = 1000, M = 60 * S;
const fail = (at: Date) => ({ successful: false, attemptedAt: at });
const ok = (at: Date) => ({ successful: true, attemptedAt: at });
const fails = (n: number, newest = M) => Array.from({ length: n }, (_, i) => fail(ago(newest + i * S)));

describe('lockoutFromRows (US-2 companion)', () => {
  it('4 failures: not locked; 5: locked for the rest of 15 minutes from the oldest (truncated)', () => {
    expect(lockoutFromRows(fails(4), NOW)).toMatchObject({ isLocked: false, failedAttempts: 4, minutesRemaining: 0 });
    // oldest at 1 min 4 s ago → expires in 13 min 56 s → 13
    expect(lockoutFromRows(fails(5), NOW)).toMatchObject({ isLocked: true, failedAttempts: 5, minutesRemaining: 13 });
  });

  it('a success after the failures resets the count; one before them changes nothing', () => {
    expect(lockoutFromRows([...fails(5, 2 * M), ok(ago(M))], NOW)).toMatchObject({ isLocked: false, failedAttempts: 0 });
    expect(lockoutFromRows([ok(ago(20 * M)), ...fails(5)], NOW).isLocked).toBe(true);
  });

  it('failures older than 15 minutes don\'t count', () => {
    expect(lockoutFromRows([...fails(3), fail(ago(15 * M + S)), fail(ago(16 * M))], NOW)).toMatchObject({ isLocked: false, failedAttempts: 3 });
  });

  it('14 min 59 s remaining → 14; under a minute remaining → 0 and not locked', () => {
    const at = (oldest: number) => [fail(ago(oldest)), ...fails(4, 0)];
    expect(lockoutFromRows(at(S), NOW)).toMatchObject({ isLocked: true, minutesRemaining: 14 });
    expect(lockoutFromRows(at(14 * M + 30 * S), NOW)).toMatchObject({ isLocked: false, minutesRemaining: 0, failedAttempts: 5 });
  });
});

describe('getLockoutsForEmails (US-2 companion)', () => {
  it('one query; keyed by the lowercased email; only locked emails; an empty list reads nothing', async () => {
    const db = createFakeControlDb();
    db.onSelect(loginAttempts, [
      ...fails(5).map((r, i) => ({ ...r, email: i < 2 ? 'John@X.dev' : 'john@x.dev' })),   // any stored casing groups together
      ...fails(4).map((r) => ({ ...r, email: 'amy@x.dev' })),
    ] as never);
    const out = await getLockoutsForEmails(db as never, ['John@X.dev', 'amy@x.dev', 'nobody@x.dev'], NOW);
    expect(db.ops.filter((o) => o === 'select')).toHaveLength(1);
    expect([...out.keys()]).toEqual(['john@x.dev']);
    expect(out.get('john@x.dev')).toMatchObject({ isLocked: true, minutesRemaining: 13 });
    db.reset();
    expect((await getLockoutsForEmails(db as never, [], NOW)).size).toBe(0);
    expect(db.ops).toEqual([]);
  });
});
