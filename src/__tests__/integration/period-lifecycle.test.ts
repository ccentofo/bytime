import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';
import dayjs from 'dayjs';

describe('Period Lifecycle — Submit/Approve/Reject', () => {
  let employee: any;
  let supervisor: any;

  beforeEach(async () => {
    await cleanupTestData();
    employee = await createTestUser({ role: 'employee', email: `emp-${Date.now()}@test.dev` });
    supervisor = await createTestUser({ role: 'supervisor', email: `sup-${Date.now()}@test.dev` });
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('creates a period in draft status', async () => {
    const db = getTestDb();
    const periodStart = dayjs('2026-05-01').toDate();

    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'draft',
    }).returning();

    expect(period.status).toBe('draft');
    expect(period.submittedAt).toBeNull();
  });

  it('transitions from draft to submitted', async () => {
    const db = getTestDb();
    const periodStart = dayjs('2026-05-01').toDate();

    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'draft',
    }).returning();

    const [updated] = await db.update(schema.timesheetPeriods)
      .set({ status: 'submitted', submittedAt: new Date() })
      .where(eq(schema.timesheetPeriods.id, period.id))
      .returning();

    expect(updated.status).toBe('submitted');
    expect(updated.submittedAt).not.toBeNull();
  });

  it('transitions from submitted to approved with reviewer', async () => {
    const db = getTestDb();
    const periodStart = dayjs('2026-05-01').toDate();

    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'submitted',
      submittedAt: new Date(),
    }).returning();

    const [approved] = await db.update(schema.timesheetPeriods)
      .set({
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: supervisor.id,
        reviewComment: 'Looks good',
      })
      .where(eq(schema.timesheetPeriods.id, period.id))
      .returning();

    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe(supervisor.id);
    expect(approved.reviewComment).toBe('Looks good');
  });

  it('transitions from submitted to rejected', async () => {
    const db = getTestDb();
    const periodStart = dayjs('2026-05-01').toDate();

    const [period] = await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'submitted',
      submittedAt: new Date(),
    }).returning();

    const [rejected] = await db.update(schema.timesheetPeriods)
      .set({
        status: 'rejected',
        reviewedAt: new Date(),
        reviewedBy: supervisor.id,
        reviewComment: 'Missing hours on Tuesday',
      })
      .where(eq(schema.timesheetPeriods.id, period.id))
      .returning();

    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewComment).toBe('Missing hours on Tuesday');
  });

  it('enforces unique constraint on (userId, periodStart)', async () => {
    const db = getTestDb();
    const periodStart = dayjs('2026-05-01').toDate();

    await db.insert(schema.timesheetPeriods).values({
      userId: employee.id,
      periodStart,
      status: 'draft',
    });

    await expect(
      db.insert(schema.timesheetPeriods).values({
        userId: employee.id,
        periodStart,
        status: 'draft',
      })
    ).rejects.toThrow();
  });
});
