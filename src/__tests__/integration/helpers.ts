import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

type TestDb = ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export function getTestDb(): TestDb {
  return (globalThis as any).__TEST_DB__;
}

// ---------------------------------------------------------------------------
// Seed Helpers
// ---------------------------------------------------------------------------

export async function createTestUser(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const db = getTestDb();
  const hash = await bcrypt.hash('TestPass123!', 4); // Low cost for speed
  const [user] = await db.insert(schema.users).values({
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@bytime.dev`,
    fullName: 'Test User',
    role: 'employee',
    passwordHash: hash,
    isActive: true,
    ...overrides,
  }).returning();
  return user;
}

export async function createTestContract(overrides: Partial<typeof schema.contracts.$inferInsert> = {}) {
  const db = getTestDb();
  const [contract] = await db.insert(schema.contracts).values({
    contractNumber: `TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Contract',
    status: 'active',
    ...overrides,
  }).returning();
  return contract;
}

export async function createTestClin(contractId: string, overrides: Partial<typeof schema.clins.$inferInsert> = {}) {
  const db = getTestDb();
  const [clin] = await db.insert(schema.clins).values({
    contractId,
    clinNumber: `CLIN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: 'active',
    ...overrides,
  }).returning();
  return clin;
}

export async function assignUserToClin(userId: string, clinId: string) {
  const db = getTestDb();
  const [assignment] = await db.insert(schema.userAssignments).values({
    userId,
    clinId,
    isActive: true,
  }).returning();
  return assignment;
}

export async function createTestIndirectCode(overrides: Partial<typeof schema.indirectChargeCodes.$inferInsert> = {}) {
  const db = getTestDb();
  const [code] = await db.insert(schema.indirectChargeCodes).values({
    code: `IND-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Indirect',
    category: 'overhead',
    isActive: true,
    availableToAll: true,
    ...overrides,
  }).returning();
  return code;
}

// ---------------------------------------------------------------------------
// Cleanup Helper
// ---------------------------------------------------------------------------

export async function cleanupTestData() {
  const db = getTestDb();
  // Delete in reverse FK order
  await db.delete(schema.timesheetEntries);
  await db.delete(schema.timesheetPeriods);
  await db.delete(schema.userAssignments);
  await db.delete(schema.userLaborCategories);
  await db.delete(schema.laborCategories);
  await db.delete(schema.indirectChargeCodes);
  await db.delete(schema.slins);
  await db.delete(schema.clins);
  await db.delete(schema.contracts);
  await db.delete(schema.loginAttempts);
  await db.delete(schema.notificationPreferences);
  await db.delete(schema.apiKeys);
  await db.delete(schema.users);
}
