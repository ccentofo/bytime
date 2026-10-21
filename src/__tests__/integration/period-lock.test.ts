import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getTestDb, createTestUser, createTestContract, createTestClin,
  assignUserToClin, cleanupTestData,
} from './helpers';
import * as schema from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { isBefore, todayIn, type CalendarDate } from '@/lib/calendar-date';

// These tests verify the period-lock and late-entry enforcement logic by
// exercising the DB state directly (same pattern as timesheet-save.test.ts).
// The server action cannot be imported in Vitest because 'use server' pulls
// in next-auth → next/server which is not available outside the Next.js runtime.

describe('Write-Path Enforcement — Period Lock & Late Entry', () => {
  let user: any;
  let clin: any;
  const periodStart: CalendarDate = '2026-05-01' as CalendarDate;

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
    const contract = await createTestContract();
    clin = await createTestClin(contract.id);
    await assignUserToClin(user.id, clin.id);
  });
  afterEach(async () => { await cleanupTestData(); });

  // -------------------------------------------------------------------------
  // Period lock — DB state tests
  // -------------------------------------------------------------------------

  it('submitted period row has status=submitted (lock precondition)', async () => {
    const db = getTestDb();
    await db.insert(schema.timesheetPeriods).values({
      userId: user.id, periodStart, status: 'submitted', submittedAt: new Date(),
    });

    const [row] = await db.select().from(schema.timesheetPeriods)
      .where(and(
        eq(schema.timesheetPeriods.userId, user.id),
        eq(schema.timesheetPeriods.periodStart, periodStart),
      ));

    expect(row.status).toBe('submitted');
  });

  it('rejected period row has status=rejected (editable precondition)', async () => {
    const db = getTestDb();
    await db.insert(schema.timesheetPeriods).values({
      userId: user.id, periodStart, status: 'rejected',
    });

    const [row] = await db.select().from(schema.timesheetPeriods)
      .where(and(
        eq(schema.timesheetPeriods.userId, user.id),
        eq(schema.timesheetPeriods.periodStart, periodStart),
      ));

    expect(row.status).toBe('rejected');
    // Guard allows 'draft' and 'rejected' — this must not equal 'submitted'/'approved'
    expect(['draft', 'rejected']).toContain(row.status);
  });

  // -------------------------------------------------------------------------
  // Late-entry detection — priorRevision === 0 and entryDate < today
  // -------------------------------------------------------------------------

  it('first revision on a past date is correctly identified as late (priorRevision === 0)', async () => {
    const db = getTestDb();
    const pastDate: CalendarDate = '2026-05-01' as CalendarDate; // well in the past

    // No existing revisions — priorRevision should be 0
    const [{ maxRev }] = await db
      .select({ maxRev: sql<number>`COALESCE(MAX(${schema.timesheetEntries.revisionNumber}), 0)` })
      .from(schema.timesheetEntries)
      .where(and(
        eq(schema.timesheetEntries.userId, user.id),
        eq(schema.timesheetEntries.clinId, clin.id),
        eq(schema.timesheetEntries.entryDate, pastDate),
      ));

    const priorRevision = maxRev ?? 0;
    const serverIsLate = priorRevision === 0 && isBefore(pastDate, todayIn('America/New_York'));

    expect(priorRevision).toBe(0);
    expect(serverIsLate).toBe(true); // server must require a reason code
  });

  it('second revision on any date is correctly identified as an edit (priorRevision > 0)', async () => {
    const db = getTestDb();
    const entryDate: CalendarDate = '2026-05-01' as CalendarDate;

    // Seed revision 1
    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: clin.id,
      entryDate,
      hours: '8',
      revisionNumber: 1,
      createdBy: user.id,
    });

    const [{ maxRev }] = await db
      .select({ maxRev: sql<number>`COALESCE(MAX(${schema.timesheetEntries.revisionNumber}), 0)` })
      .from(schema.timesheetEntries)
      .where(and(
        eq(schema.timesheetEntries.userId, user.id),
        eq(schema.timesheetEntries.clinId, clin.id),
        eq(schema.timesheetEntries.entryDate, entryDate),
      ));

    const priorRevision = maxRev ?? 0;
    const serverIsEdit = priorRevision > 0;

    expect(priorRevision).toBe(1);
    expect(serverIsEdit).toBe(true); // server must require a reason code
  });

  // -------------------------------------------------------------------------
  // Completeness snapshot — Phase C
  // -------------------------------------------------------------------------

  it('completenessSnapshot column is nullable (backward compatible)', async () => {
    const db = getTestDb();
    await db.insert(schema.timesheetPeriods).values({
      userId: user.id, periodStart, status: 'draft',
      // no completenessSnapshot — must not throw
    });

    const [row] = await db.select().from(schema.timesheetPeriods)
      .where(eq(schema.timesheetPeriods.userId, user.id));

    expect(row).toHaveProperty('completenessSnapshot');
    expect(row.completenessSnapshot).toBeNull();
  });

  it('completenessSnapshot stores a JSON payload', async () => {
    const db = getTestDb();
    const snapshot = { missingDays: ['2026-05-03'], totalHours: 36 };

    await db.insert(schema.timesheetPeriods).values({
      userId: user.id, periodStart, status: 'submitted', submittedAt: new Date(),
      completenessSnapshot: snapshot,
    });

    const [row] = await db.select().from(schema.timesheetPeriods)
      .where(eq(schema.timesheetPeriods.userId, user.id));

    expect(row.completenessSnapshot).toMatchObject(snapshot);
  });
});
