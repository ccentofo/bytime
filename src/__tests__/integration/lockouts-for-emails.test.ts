import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData } from './helpers';
import { getLockoutInfo, getLockoutsForEmails } from '@/server/internal/login-attempts';

/**
 * feature-plan-ux-people-codes.md §5.1 / US-2: the Users page's one batched lock query gives exactly what getLockoutInfo
 * gives per email — 4 failures; 5; 5 then a success; failures older than 15 minutes; a mixed-case email; 14 min 59 s left.
 */
const S = 1000, M = 60 * S;

describe('getLockoutsForEmails equals getLockoutInfo (US-2)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { await cleanupTestData(); });

  it('per email: the same lock and minutes', async () => {
    const db = getTestDb();
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo);
    const add = (email: string, successful: boolean, msAgo: number) => db.insert(schema.loginAttempts).values({ email, successful, attemptedAt: at(msAgo) });
    for (let i = 0; i < 4; i++) await add('four@x.dev', false, M + i * S);
    for (let i = 0; i < 5; i++) await add('five@x.dev', false, M + i * S);
    for (let i = 0; i < 5; i++) await add('reset@x.dev', false, 2 * M + i * S);
    await add('reset@x.dev', true, M);
    for (let i = 0; i < 5; i++) await add('old@x.dev', false, 16 * M + i * S);
    for (let i = 0; i < 5; i++) await add('mixed@x.dev', false, M + i * S);           // stored lowercased, as recordFailedAttempt does
    await add('edge@x.dev', false, S);                                                // oldest of five: 14 min 59 s remaining
    for (let i = 0; i < 4; i++) await add('edge@x.dev', false, 0);

    const emails = ['four@x.dev', 'five@x.dev', 'reset@x.dev', 'old@x.dev', 'Mixed@X.dev', 'edge@x.dev'];
    // L6: one fixed clock for both (wall-clock time moving between the reads would flake the minutes near a boundary).
    const clock = new Date(now);
    const batch = await getLockoutsForEmails(db as never, emails, clock);
    for (const email of emails) {
      const single = await getLockoutInfo(db as never, email, clock);
      const fromBatch = batch.get(email.toLowerCase());
      expect({ locked: fromBatch?.isLocked ?? false, minutes: fromBatch?.minutesRemaining ?? 0 }, email)
        .toEqual({ locked: single.isLocked, minutes: single.isLocked ? single.minutesRemaining : 0 });
    }
    expect([...batch.keys()].sort()).toEqual(['edge@x.dev', 'five@x.dev', 'mixed@x.dev']);
    expect(batch.get('edge@x.dev')!.minutesRemaining).toBe(14);
  });
});
