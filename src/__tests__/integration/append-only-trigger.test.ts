import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode, cleanupTestData } from './helpers';

/** UX-3 fix round 1 (L5): the named constraint is the one that failed (its name is in the database message on `cause`). */
const violates = (constraint: string) => (err: unknown): boolean => {
  const e = err as { message?: string; cause?: { message?: string } };
  return `${e?.message ?? ''} ${e?.cause?.message ?? ''}`.includes(constraint);
};

/** Drizzle 0.45 wraps database errors ("Failed query: …"); the trigger's own message is on `cause`. */
function isAppendOnlyError(err: unknown): boolean {
  const e = err as { message?: string; cause?: { message?: string } };
  return /append-only/.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`);
}

/**
 * T8/R11: a database-level trigger makes timesheet_entries and period_events append-only —
 * UPDATE/DELETE raise unless the session opts in with `SET LOCAL cadenzpoint.allow_entry_delete
 * = 'on'`, which only cleanupTestData() is meant to use. This proves the trigger actually blocks
 * mutation, that INSERT is unaffected, and that the test suite's own cleanup escape hatch works.
 */
describe('append-only trigger (T8)', () => {
  let userId: string;
  let chargeCodeId: string;

  beforeEach(async () => {
    await cleanupTestData();
    const user = await createTestUser({ role: 'employee' });
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    userId = user.id;
    chargeCodeId = chargeCode.id;
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('INSERT into timesheet_entries works', async () => {
    const db = getTestDb();
    const [row] = await db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId, entryDate: '2026-02-02', hours: '8', revisionNumber: 1,
    }).returning();
    expect(row.id).toBeDefined();
  });

  it('UPDATE on timesheet_entries is rejected outside the escape hatch', async () => {
    const db = getTestDb();
    const [row] = await db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId, entryDate: '2026-02-03', hours: '8', revisionNumber: 1,
    }).returning();

    await expect(
      db.update(schema.timesheetEntries).set({ hours: '4' }).where(eq(schema.timesheetEntries.id, row.id)),
    ).rejects.toSatisfy(isAppendOnlyError);
  });

  it('DELETE on timesheet_entries is rejected outside the escape hatch', async () => {
    const db = getTestDb();
    const [row] = await db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId, entryDate: '2026-02-04', hours: '8', revisionNumber: 1,
    }).returning();

    await expect(
      db.delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, row.id)),
    ).rejects.toSatisfy(isAppendOnlyError);
  });

  it('DELETE succeeds inside a transaction with the escape hatch set', async () => {
    const db = getTestDb();
    const [row] = await db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId, entryDate: '2026-02-05', hours: '8', revisionNumber: 1,
    }).returning();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL cadenzpoint.allow_entry_delete = 'on'`);
      await tx.delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, row.id));
    });

    const remaining = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, row.id));
    expect(remaining).toEqual([]);
  });

  it('UPDATE and DELETE on period_events are rejected outside the escape hatch; INSERT works', async () => {
    const db = getTestDb();
    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId, periodStart: '2026-02-01', status: 'submitted', submittedAt: new Date(),
    }).returning();
    const [event] = await db.insert(schema.periodEvents).values({
      periodId: period.id, userId, event: 'submitted', actorId: userId,
    }).returning();
    expect(event.id).toBeDefined();

    await expect(
      db.update(schema.periodEvents).set({ comment: 'edited' }).where(eq(schema.periodEvents.id, event.id)),
    ).rejects.toSatisfy(isAppendOnlyError);
    await expect(
      db.delete(schema.periodEvents).where(eq(schema.periodEvents.id, event.id)),
    ).rejects.toSatisfy(isAppendOnlyError);
  });

  it("cleanupTestData() itself (the suite's own escape hatch) succeeds with rows present in both append-only tables", async () => {
    const db = getTestDb();
    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId, periodStart: '2026-02-01', status: 'submitted', submittedAt: new Date(),
    }).returning();
    await db.insert(schema.periodEvents).values({ periodId: period.id, userId, event: 'submitted', actorId: userId });
    await db.insert(schema.timesheetEntries).values({
      userId, chargeCodeId, entryDate: '2026-02-06', hours: '8', revisionNumber: 1,
    });

    await expect(cleanupTestData()).resolves.not.toThrow();

    const entries = await db.select().from(schema.timesheetEntries);
    const events = await db.select().from(schema.periodEvents);
    expect(entries).toEqual([]);
    expect(events).toEqual([]);
  });
});

/** feature-plan-ux-timesheet.md A-T2 (UX3-D1): timesheet_notes is append-only at the database, like the entries. */
describe('append-only trigger on timesheet_notes (UX-3 A-T2)', () => {
  let userId: string;
  let chargeCodeId: string;
  const note = async (entryDate: string, body = 'Site visit') =>
    (await getTestDb().insert(schema.timesheetNotes).values({ userId, chargeCodeId, entryDate, body, revisionNumber: 1, createdBy: userId }).returning())[0];

  beforeEach(async () => {
    await cleanupTestData();
    userId = (await createTestUser({ role: 'employee' })).id;
    chargeCodeId = (await createTestChargeCode((await createTestClin((await createTestContract()).id)).id)).id;
  });
  afterEach(async () => { await cleanupTestData(); });

  it('INSERT works; UPDATE, DELETE and TRUNCATE are rejected outside the escape hatch', async () => {
    const db = getTestDb();
    const row = await note('2026-02-02');
    expect(row.id).toBeDefined();
    await expect(db.update(schema.timesheetNotes).set({ body: 'edited' }).where(eq(schema.timesheetNotes.id, row.id))).rejects.toSatisfy(isAppendOnlyError);
    await expect(db.delete(schema.timesheetNotes).where(eq(schema.timesheetNotes.id, row.id))).rejects.toSatisfy(isAppendOnlyError);
    await expect(db.execute(sql`TRUNCATE timesheet_notes`)).rejects.toSatisfy(isAppendOnlyError);
    expect(await db.select().from(schema.timesheetNotes)).toHaveLength(1);
  });

  it('exactly one code column (CHECK); one row per cell revision (unique index)', async () => {
    const db = getTestDb();
    await note('2026-02-03');
    // L5: the RIGHT constraint fails (drizzle wraps the error; the database message is on `cause`).
    await expect(db.insert(schema.timesheetNotes).values({ userId, chargeCodeId, entryDate: '2026-02-03', body: 'dup', revisionNumber: 1, createdBy: userId }))
      .rejects.toSatisfy(violates('timesheet_notes_cell_rev_unique_idx'));
    await expect(db.insert(schema.timesheetNotes).values({ userId, entryDate: '2026-02-04', body: 'none', revisionNumber: 1, createdBy: userId }))
      .rejects.toSatisfy(violates('timesheet_notes_one_code_check'));
    const otherCode = (await createTestIndirectCode()).id;
    await expect(db.insert(schema.timesheetNotes).values({ userId, chargeCodeId, indirectCodeId: otherCode, entryDate: '2026-02-04', body: 'two', revisionNumber: 1, createdBy: userId }))
      .rejects.toSatisfy(violates('timesheet_notes_one_code_check'));
  });

  it('cleanupTestData() (clearTenantData) succeeds with notes present', async () => {
    await note('2026-02-05');
    await expect(cleanupTestData()).resolves.not.toThrow();
    expect(await getTestDb().select().from(schema.timesheetNotes)).toEqual([]);
  });
});
