import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, createTestContract, createTestClin, assignUserToClin, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq, and } from 'drizzle-orm';

describe('Timesheet RBAC — CLIN Assignment Enforcement', () => {
  let user: any;
  let assignedClin: any;
  let unassignedClin: any;

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
    const contract = await createTestContract();
    assignedClin = await createTestClin(contract.id, { clinNumber: 'ASSIGNED-001' });
    unassignedClin = await createTestClin(contract.id, { clinNumber: 'UNASSIGNED-001' });
    await assignUserToClin(user.id, assignedClin.id);
    // Note: user is NOT assigned to unassignedClin
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('user assignment exists for assigned CLIN', async () => {
    const db = getTestDb();
    const assignments = await db.select().from(schema.userAssignments)
      .where(and(
        eq(schema.userAssignments.userId, user.id),
        eq(schema.userAssignments.clinId, assignedClin.id),
        eq(schema.userAssignments.isActive, true),
      ));

    expect(assignments).toHaveLength(1);
  });

  it('no assignment exists for unassigned CLIN', async () => {
    const db = getTestDb();
    const assignments = await db.select().from(schema.userAssignments)
      .where(and(
        eq(schema.userAssignments.userId, user.id),
        eq(schema.userAssignments.clinId, unassignedClin.id),
      ));

    expect(assignments).toHaveLength(0);
  });

  it('deactivated assignment is not active', async () => {
    const db = getTestDb();

    await db.update(schema.userAssignments)
      .set({ isActive: false })
      .where(and(
        eq(schema.userAssignments.userId, user.id),
        eq(schema.userAssignments.clinId, assignedClin.id),
      ));

    const assignments = await db.select().from(schema.userAssignments)
      .where(and(
        eq(schema.userAssignments.userId, user.id),
        eq(schema.userAssignments.clinId, assignedClin.id),
        eq(schema.userAssignments.isActive, true),
      ));

    expect(assignments).toHaveLength(0);
  });
});
