import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, createTestIndirectCode, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';
import dayjs from 'dayjs';

describe('Indirect Charge Codes', () => {
  let user: any;

  beforeEach(async () => {
    await cleanupTestData();
    user = await createTestUser();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('creates an indirect charge code', async () => {
    const code = await createTestIndirectCode({
      code: 'OH-TEST',
      name: 'Test Overhead',
      category: 'overhead',
    });

    expect(code.code).toBe('OH-TEST');
    expect(code.category).toBe('overhead');
    expect(code.isActive).toBe(true);
  });

  it('saves timesheet entry with indirect code (null clinId)', async () => {
    const db = getTestDb();
    const indirectCode = await createTestIndirectCode();

    const [entry] = await db.insert(schema.timesheetEntries).values({
      userId: user.id,
      clinId: null,
      indirectCodeId: indirectCode.id,
      entryDate: dayjs('2026-05-20').toDate(),
      hours: '4',
      revisionNumber: 1,
      createdBy: user.id,
    }).returning();

    expect(entry.clinId).toBeNull();
    expect(entry.indirectCodeId).toBe(indirectCode.id);
  });

  it('enforces unique code constraint', async () => {
    await createTestIndirectCode({ code: 'UNIQUE-CODE' });

    await expect(
      createTestIndirectCode({ code: 'UNIQUE-CODE' })
    ).rejects.toThrow();
  });
});
