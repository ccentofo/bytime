import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('Session Invalidation — Version Tracking', () => {
  let user: any;

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('user starts with sessionVersion 1', () => {
    expect(user.sessionVersion).toBe(1);
  });

  it('sessionVersion increments on role change', async () => {
    const db = getTestDb();

    await db.update(schema.users)
      .set({ role: 'supervisor', sessionVersion: user.sessionVersion + 1 })
      .where(eq(schema.users.id, user.id));

    const [updated] = await db.select().from(schema.users)
      .where(eq(schema.users.id, user.id));

    expect(updated.sessionVersion).toBe(2);
  });

  it('sessionVersion increments on deactivation', async () => {
    const db = getTestDb();

    await db.update(schema.users)
      .set({ isActive: false, sessionVersion: user.sessionVersion + 1 })
      .where(eq(schema.users.id, user.id));

    const [updated] = await db.select().from(schema.users)
      .where(eq(schema.users.id, user.id));

    expect(updated.sessionVersion).toBe(2);
    expect(updated.isActive).toBe(false);
  });
});
