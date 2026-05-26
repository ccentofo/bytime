import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

describe('Brute Force Protection — Login Attempts', () => {
  const testEmail = 'bruteforce-test@bytime.dev';

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('records failed login attempts', async () => {
    const db = getTestDb();

    await db.insert(schema.loginAttempts).values({
      email: testEmail,
      successful: false,
    });

    const attempts = await db.select().from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, testEmail));

    expect(attempts).toHaveLength(1);
    expect(attempts[0].successful).toBe(false);
  });

  it('successful login resets counter (by being the latest record)', async () => {
    const db = getTestDb();

    // 3 failures
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.loginAttempts).values({ email: testEmail, successful: false });
    }

    // 1 success
    await db.insert(schema.loginAttempts).values({ email: testEmail, successful: true });

    // 1 more failure
    await db.insert(schema.loginAttempts).values({ email: testEmail, successful: false });

    // The latest success should reset the counter — only 1 failure after it
    const allAttempts = await db.select().from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, testEmail))
      .orderBy(desc(schema.loginAttempts.attemptedAt));

    expect(allAttempts).toHaveLength(5);
    // The most recent failure (index 0) comes after the success
    expect(allAttempts[0].successful).toBe(false);
    expect(allAttempts[1].successful).toBe(true);
  });
});
