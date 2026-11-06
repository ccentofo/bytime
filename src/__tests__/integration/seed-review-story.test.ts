import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, cleanupTestData } from './helpers';

/**
 * feature-plan-ux-approvals-payroll.md §5 / S-1: the demo seed's pending period (the latest completed one) shows what
 * Approvals is for. Jane (submitted once): ≥ 2 corrected cells, 1 late cell and 1 note, every createdAt <
 * submittedAt ≤ now. Robert: events submitted < rejected < submitted, submission_count 2, review_comment null, and
 * exactly one flagged cell with sinceReturned (the correction after the return); Jane has none. A second run gives the
 * same counts (and still one period row per person per period).
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));
vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => 'test-tenant',
  getTenantOrThrow: async () => ({ id: '00000000-0000-4000-8000-0000000000s1', slug: 'test-tenant', plan: 'enterprise', status: 'active', dbUrl: 'test-db' }),
  getTenantState: async () => ({ kind: 'full', tenant: { slug: 'test-tenant', dbUrl: 'test-db' } }),
}));
const h = vi.hoisted(() => ({ user: null as null | { id: string; role: string; email: string; fullName: string } }));
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  const current = async () => { if (!h.user) throw new actual.AuthorizationError('unauthenticated', 'Unauthorized'); return h.user; };
  return { ...actual, getSessionUser: current, requireSession: current, assertCanAccessEmployee: async () => {}, getEmployeeScope: async () => 'all' };
});

import { seedRichData } from '../../../scripts/seed-full';
import { getTimesheetForReview } from '@/server/actions/timesheet';
import type { CalendarDate } from '@/lib/calendar-date';

type SeedDb = Parameters<typeof seedRichData>[0];
const SEED_TIMEOUT = 180_000;

async function story() {
  const db = getTestDb();
  const people = await db.select().from(schema.users);
  const by = (name: string) => people.find((u) => u.fullName === name)!;
  const [admin, jane, robert] = [people.find((u) => u.role === 'admin')!, by('Jane Smith'), by('Robert Taylor')];
  h.user = { id: admin.id, role: 'admin', email: admin.email, fullName: admin.fullName };
  const pending = await db.select().from(schema.timesheetPeriods).where(and(eq(schema.timesheetPeriods.status, 'submitted'), inArray(schema.timesheetPeriods.userId, [jane.id, robert.id])));
  const pj = pending.find((p) => p.userId === jane.id)!;
  const pr = pending.find((p) => p.userId === robert.id)!;
  const janeReview = await getTimesheetForReview(jane.id, pj.periodStart as CalendarDate);
  const robertReview = await getTimesheetForReview(robert.id, pr.periodStart as CalendarDate);
  const entries = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, jane.id));
  const janeNotes = await db.select().from(schema.timesheetNotes).where(eq(schema.timesheetNotes.userId, jane.id));
  const events = await db.select().from(schema.periodEvents).where(eq(schema.periodEvents.periodId, pr.id));
  const periodRows = await db.select().from(schema.timesheetPeriods);
  return { jane, robert, pj, pr, janeReview, robertReview, entries, janeNotes, events, periodRows };
}

describe('the seeded review story (S-1)', () => {
  beforeEach(async () => { await cleanupTestData(); });
  afterEach(async () => { h.user = null; await cleanupTestData(); });

  it('Jane: corrections, a late entry, a note, all before her submission (≤ now); Robert: returned then resubmitted', async () => {
    await seedRichData(getTestDb() as unknown as SeedDb);
    const s = await story();
    const now = Date.now();
    expect(s.pj.submittedAt!.getTime()).toBeLessThanOrEqual(now);
    expect(s.pr.submittedAt!.getTime()).toBeLessThanOrEqual(now);
    const corrections = s.janeReview.flagged.filter((f) => f.kind === 'correction');
    const late = s.janeReview.flagged.filter((f) => f.kind === 'late');
    expect(corrections.length).toBeGreaterThanOrEqual(2);
    expect(late).toHaveLength(1);
    expect(Object.values(s.janeReview.notes).filter((n) => n.body).length).toBe(1);
    const start = s.pj.periodStart;
    // The period's real length (the seed's periods are 15 or 16 days; its rows store none) — L11.
    const end = new Date(new Date(start).getTime() + s.janeReview.numDays * 86_400_000).toISOString().slice(0, 10);
    const inPeriod = s.entries.filter((e) => e.entryDate >= start && e.entryDate < end);
    for (const e of inPeriod) expect(e.createdAt.getTime(), `${e.entryDate} rev ${e.revisionNumber}`).toBeLessThan(s.pj.submittedAt!.getTime());
    for (const n of s.janeNotes.filter((x) => x.entryDate >= start && x.entryDate < end)) expect(n.createdAt.getTime()).toBeLessThan(s.pj.submittedAt!.getTime());
    expect(s.janeReview.flagged.some((f) => f.sinceReturned)).toBe(false);
    expect(s.janeReview.lastReturn).toBeNull();

    expect(s.events.map((e) => e.event)).toEqual(expect.arrayContaining(['submitted', 'rejected', 'submitted']));
    const ordered = [...s.events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(ordered.map((e) => e.event)).toEqual(['submitted', 'rejected', 'submitted']);
    expect(ordered[1].comment).toBe("Please add Tuesday's site visit hours.");
    expect(ordered[1].actorId).not.toBe(s.robert.id);
    expect(ordered[2].createdAt.getTime()).toBe(s.pr.submittedAt!.getTime());
    expect(s.pr.submissionCount).toBe(2);
    expect(s.pr.reviewComment).toBeNull();
    expect(s.robertReview.flagged.filter((f) => f.sinceReturned)).toHaveLength(1);
    const fix = s.robertReview.flagged.find((f) => f.sinceReturned)!;
    expect(fix.current.comment).toBe('Added the Tuesday site visit.');
    expect(new Date(fix.current.createdAt).getTime()).toBeLessThan(s.pr.submittedAt!.getTime());   // before the resubmission (L11)
    expect(s.robertReview.lastReturn).toMatchObject({ comment: "Please add Tuesday's site visit hours." });
  }, SEED_TIMEOUT);

  it('a second run gives the same counts; one period row per person per period', async () => {
    const db = getTestDb() as unknown as SeedDb;
    await seedRichData(db);
    const a = await story();
    await seedRichData(db);
    const b = await story();
    const counts = (x: typeof a) => ({ flaggedJane: x.janeReview.flagged.length, flaggedRobert: x.robertReview.flagged.length, events: x.events.length, periods: x.periodRows.length });
    expect(counts(b)).toEqual(counts(a));
    const keys = b.periodRows.map((p) => `${p.userId}|${p.periodStart}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, SEED_TIMEOUT * 2);
});
