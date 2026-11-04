import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * feature-plan-ux-approvals-payroll.md §5 / S-1, unit companion to integration/seed-review-story.test.ts, runnable
 * without Postgres: seedRichData runs against the recording fake database and its inserts are inspected — the pending
 * period gets Jane's two corrections, one late entry and one note, and Robert's returned-then-resubmitted history (events
 * submitted < rejected < submitted, the correction between the return and the resubmission, submission_count 2 set
 * in the period insert, review_comment null); every pending-period timestamp is in the past and ordered; no extra
 * period row.
 */

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ db: null as unknown }));

import { createFakeControlDb, type FakeControlDb } from '../helpers/fake-control-db';
import * as schema from '@/db/schema';
import { seedRichData } from '../../../scripts/seed-full';

let db: FakeControlDb & { transaction: (cb: (tx: unknown) => unknown) => unknown };
type Row = Record<string, unknown>;
const rows = (table: unknown) => db.inserts.filter((i) => i.table === table).flatMap((i) => (Array.isArray(i.values) ? i.values : [i.values])) as Row[];

// Seeding on the 1st (§5): the latest completed period is Oct 16 – 31, and its planned submission (Nov 2) would be
// in the future — `base` must cap it at now − 1 h.
const NOW = new Date('2026-11-01T10:00:00Z'); // Nov 1 in UTC, Los Angeles, New York and Auckland (test:tz)
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createFakeControlDb() as typeof db;
  db.transaction = async (cb) => cb(db);
  db.onSelect(schema.workspaceSettings, [{ timezone: 'America/New_York' }]);
  h.db = db;
  await seedRichData(db as never);
}, 60_000);
afterAll(() => { vi.useRealTimers(); });

describe('the seeded review story (S-1 companion)', () => {
  it('Jane\'s pending period: two corrections, one late entry, one note — before her submission, which is in the past', () => {
    const users = rows(schema.users);
    const id = (name: string) => users.find((u) => u.fullName === name)!.id as string;
    const periods = rows(schema.timesheetPeriods);
    const pj = periods.find((p) => p.userId === id('Jane Smith') && p.status === 'submitted')!;
    const submittedAt = pj.submittedAt as Date;
    expect(pj.periodStart).toBe('2026-10-16');
    expect(submittedAt.getTime()).toBe(NOW.getTime() - 3_600_000);         // capped: never in the future
    const mine = rows(schema.timesheetEntries).filter((e) => e.userId === id('Jane Smith'));
    const startP = pj.periodStart as string;
    const inPending = mine.filter((e) => (e.entryDate as string) >= startP && (e.entryDate as string) < nextPeriodStart(startP));
    const corrections = inPending.filter((e) => e.revisionNumber === 2 && e.changeReasonCode === 'CORRECTION');
    expect(corrections.map((c) => c.comment)).toEqual(["Left early for a doctor's appointment.", 'Forgot the afternoon site visit.']);
    for (const c of corrections) {
      const rev1 = inPending.find((e) => e.revisionNumber === 1 && e.entryDate === c.entryDate && e.chargeCodeId === c.chargeCodeId && e.clinId === c.clinId);
      expect(rev1, `rev 1 under ${c.entryDate}`).toBeDefined();
      expect((rev1!.createdAt as Date).getTime()).toBeLessThan((c.createdAt as Date).getTime());
    }
    const late = inPending.filter((e) => e.changeReasonCode === 'LATE_ENTRY');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ revisionNumber: 1, comment: 'Entered the next morning.', hours: '1.00' });
    expect(inPending.filter((e) => e.entryDate === late[0].entryDate && e.indirectCodeId === late[0].indirectCodeId)).toHaveLength(1); // an empty cell
    for (const e of inPending) expect((e.createdAt as Date).getTime(), `${e.entryDate} rev ${e.revisionNumber}`).toBeLessThan(submittedAt.getTime());
    const notes = rows(schema.timesheetNotes).filter((n) => n.userId === id('Jane Smith'));
    expect(notes).toEqual([expect.objectContaining({ revisionNumber: 1, createdBy: id('Jane Smith'), body: 'Site visit at Pax River.' })]);
    expect(pj.submissionCount).toBe(1);
  });

  it('Robert: submitted < rejected < submitted (the right actors), the correction between, submission_count 2 and no review comment', () => {
    const users = rows(schema.users);
    const robert = users.find((u) => u.fullName === 'Robert Taylor')!.id;
    const pr = rows(schema.timesheetPeriods).find((p) => p.userId === robert && p.status === 'submitted')!;
    expect(pr).toMatchObject({ submissionCount: 2, reviewComment: null });
    const events = rows(schema.periodEvents).filter((e) => e.periodId === pr.id);
    expect(events.map((e) => [e.event, e.actorId === robert])).toEqual([['submitted', true], ['rejected', false], ['submitted', true]]);
    const [s1, r, s2] = events.map((e) => (e.createdAt as Date).getTime());
    expect(s1).toBeLessThan(r);
    expect(r).toBeLessThan(s2);
    expect(s2).toBe((pr.submittedAt as Date).getTime());
    expect(s2).toBe(NOW.getTime() - 3_600_000);
    expect(events[1].comment).toBe("Please add Tuesday's site visit hours.");
    const fix = rows(schema.timesheetEntries).filter((e) => e.userId === robert && e.comment === 'Added the Tuesday site visit.');
    expect(fix).toHaveLength(1);
    const at = (fix[0].createdAt as Date).getTime();
    expect(at).toBeGreaterThan(r);
    expect(at).toBeLessThan(s2);
    // Every revision 1 in his pending period was recorded before his first submission.
    const start = pr.periodStart as string;
    const rev1 = rows(schema.timesheetEntries)
      .filter((e) => e.userId === robert && e.revisionNumber === 1 && (e.entryDate as string) >= start && (e.entryDate as string) < nextPeriodStart(start));
    expect(rev1.length).toBeGreaterThan(0);
    for (const e of rev1) expect((e.createdAt as Date).getTime(), e.entryDate as string).toBeLessThan(s1);
  });

  it('never a second period row: one per person per period', () => {
    const keys = rows(schema.timesheetPeriods).map((p) => `${p.userId}|${p.periodStart}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/** The seed's semi-monthly periods: the 1st → the 16th; the 16th → the 1st of the next month. */
function nextPeriodStart(start: string): string {
  const [y, m, d] = start.split('-').map(Number);
  if (d === 1) return `${start.slice(0, 8)}16`;
  const next = new Date(Date.UTC(y, m, 1));
  return next.toISOString().slice(0, 10);
}
