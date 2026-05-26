import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, createTestContract, createTestClin, assignUserToClin, cleanupTestData, createTestIndirectCode } from './helpers';
import * as schema from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import dayjs from 'dayjs';

describe('Timesheet Save — DCAA Append-Only', () => {
  let user: any;
  let clin: any;

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
    const contract = await createTestContract();
    clin = await createTestClin(contract.id);
    await assignUserToClin(user.id, clin.id);
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('creates a new entry with revision 1 on first save', async () => {
    const db = getTestDb();
    const entryDate = dayjs('2026-05-20').toDate();

    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: clin.id,
      entryDate,
      hours: '8',
      revisionNumber: 1,
      createdBy: user.id,
    });

    const entries = await db.select().from(schema.timesheetEntries)
      .where(and(
        eq(schema.timesheetEntries.userId, user.id),
        eq(schema.timesheetEntries.clinId, clin.id),
      ));

    expect(entries).toHaveLength(1);
    expect(entries[0].revisionNumber).toBe(1);
    expect(entries[0].hours).toBe('8');
  });

  it('preserves old revision when saving a correction (append-only)', async () => {
    const db = getTestDb();
    const entryDate = dayjs('2026-05-20').toDate();

    // First save
    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: clin.id,
      entryDate,
      hours: '8',
      revisionNumber: 1,
      createdBy: user.id,
    });

    // Second save (correction)
    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: clin.id,
      entryDate,
      hours: '7.5',
      revisionNumber: 2,
      changeReasonCode: 'CORRECTION',
      comment: 'Fixed hours',
      createdBy: user.id,
    });

    const entries = await db.select().from(schema.timesheetEntries)
      .where(and(
        eq(schema.timesheetEntries.userId, user.id),
        eq(schema.timesheetEntries.clinId, clin.id),
      ))
      .orderBy(schema.timesheetEntries.revisionNumber);

    // BOTH revisions must exist (append-only)
    expect(entries).toHaveLength(2);
    expect(entries[0].revisionNumber).toBe(1);
    expect(entries[0].hours).toBe('8');
    expect(entries[1].revisionNumber).toBe(2);
    expect(entries[1].hours).toBe('7.5');
    expect(entries[1].changeReasonCode).toBe('CORRECTION');
  });

  it('stores createdAt timestamp for audit trail', async () => {
    const db = getTestDb();
    const before = new Date();

    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: clin.id,
      entryDate: dayjs('2026-05-20').toDate(),
      hours: '8',
      revisionNumber: 1,
      createdBy: user.id,
    });

    const [entry] = await db.select().from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.userId, user.id));

    expect(entry.createdAt).toBeDefined();
    expect(new Date(entry.createdAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('supports indirect charge code entries (clinId null)', async () => {
    const db = getTestDb();
    const indirectCode = await createTestIndirectCode();

    await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: null,
      indirectCodeId: indirectCode.id,
      entryDate: dayjs('2026-05-20').toDate(),
      hours: '2',
      revisionNumber: 1,
      createdBy: user.id,
    });

    const [entry] = await db.select().from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.indirectCodeId, indirectCode.id));

    expect(entry.clinId).toBeNull();
    expect(entry.indirectCodeId).toBe(indirectCode.id);
    expect(entry.hours).toBe('2');
  });
});
