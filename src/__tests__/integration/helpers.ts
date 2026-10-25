import * as schema from '@/db/schema';
import { clearTenantData } from '@/db/clear-tenant-data';
import bcrypt from 'bcryptjs';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';

type TestDb = ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export function getTestDb(): TestDb {
  return (globalThis as any).__TEST_DB__;
}

/**
 * Converted server actions return ActionResult (feature-plan-launch-blockers.md P4). On a success path, unwrap with
 * expectOk — a returned failure must fail the test, not be silently ignored the way an unawaited result would be.
 */
export async function expectOk<T>(promise: Promise<ActionResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`Expected ok, got ${result.code}: ${result.error}`);
  return result.data;
}

/** Assert a converted action returned `{ ok: false, code }` (and, optionally, a message matching `message`). */
export async function expectFailure<T>(promise: Promise<ActionResult<T>>, code: ActionErrorCode, message?: RegExp): Promise<string> {
  const result = await promise;
  if (result.ok) throw new Error(`Expected failure (${code}), got ok`);
  if (result.code !== code) throw new Error(`Expected code ${code}, got ${result.code}: ${result.error}`);
  if (message && !message.test(result.error)) throw new Error(`Expected message ${message}, got: ${result.error}`);
  return result.error;
}

/** Await every `after()` callback scheduled so far (setup-db.ts runs them immediately and records the promise). */
export async function flushAfter(): Promise<void> {
  const pending = (globalThis as any).__AFTER_PROMISES__ as Promise<unknown>[] | undefined;
  if (!pending) return;
  while (pending.length > 0) await Promise.all(pending.splice(0));
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

export async function createTestCostClass(name?: string) {
  const db = getTestDb();
  const [row] = await db.insert(schema.costClasses).values({
    name: name ?? `Test Class ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    isActive: true,
  }).returning();
  return row;
}

export async function createTestChargeCode(clinId: string, overrides: Partial<typeof schema.chargeCodes.$inferInsert> = {}) {
  const db = getTestDb();
  const [code] = await db.insert(schema.chargeCodes).values({
    clinId,
    code: `CC-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Charge Code',
    isActive: true,
    billable: true,
    ...overrides,
  }).returning();
  return code;
}

// ---------------------------------------------------------------------------
// Cleanup Helper
// ---------------------------------------------------------------------------

export async function cleanupTestData() {
  // Shared with the demo seeder (src/db/clear-tenant-data.ts): one transaction, FK order, and the only
  // permitted bypass of the append-only trigger. Clears every table, including the pay schedule and
  // integration connections, and resets workspace_settings.
  await clearTenantData(getTestDb() as any);
}
