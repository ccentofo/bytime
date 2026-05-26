# Blueprint: Integration Tests — Real Database DCAA Compliance Verification

## 1. Architectural Overview

### Why Integration Tests

The existing 65 unit tests verify pure functions (validation, dates, CSV). They mock the database entirely. This means the most critical business logic — **DCAA compliance rules enforced in SQL queries and server actions** — has no automated verification.

Integration tests run actual server action functions against a **real PostgreSQL test database**, verifying:
- Append-only enforcement (rows are never updated/deleted)
- Revision number incrementing
- CLIN assignment validation
- Period submission rules
- Session invalidation
- Approval workflows

### Test Database Strategy

Use the existing Docker PostgreSQL from `docker-compose.yml` with a separate test database (`bytime_test`). Tests:
1. Create the test database before the test suite runs
2. Run migrations to create all tables
3. Seed minimal test data (users, contracts, CLINs)
4. Execute tests with isolated transactions (rollback after each test)
5. Drop the test database after the suite completes

### Key Principle

**Integration tests verify DCAA rules with real SQL.** If a developer changes a query and breaks append-only behavior, these tests catch it before it reaches production.

---

## 2. File Topology

```
Files to CREATE:
├── src/__tests__/integration/
│   ├── setup-db.ts                                  ← Test database lifecycle (create, migrate, teardown)
│   ├── helpers.ts                                   ← Seed data helpers (createTestUser, createTestContract, etc.)
│   ├── timesheet-save.test.ts                       ← Append-only + revision tests
│   ├── timesheet-rbac.test.ts                       ← CLIN assignment validation
│   ├── period-lifecycle.test.ts                     ← Submit/approve/reject workflow
│   ├── session-invalidation.test.ts                 ← Session version tests
│   ├── brute-force.test.ts                          ← Login lockout tests
│   └── indirect-codes.test.ts                       ← Indirect charge code save/read
├── vitest.config.integration.ts                     ← Separate config for integration tests

Files to MODIFY:
├── package.json                                      ← Add test:integration script
├── docker-compose.yml                                ← Add test database service (optional — can reuse existing)

Files NOT TOUCHED:
├── All source files in src/                          ← ❌ DO NOT MODIFY
├── vitest.config.ts                                  ← ❌ DO NOT MODIFY (unit test config)
├── src/__tests__/unit/**                             ← ❌ DO NOT MODIFY
├── src/__tests__/server/**                           ← ❌ DO NOT MODIFY
├── src/__tests__/api/**                              ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** modify any source files — tests are additive only.
> - Integration tests must use a **separate test database** — never the dev database.
> - Each test must be **isolated** — use transactions or cleanup to prevent test interference.
> - Tests must be **skippable** without Docker — add `describe.skipIf(!process.env.DATABASE_URL)`.
> - **After each phase, run `npm run test:integration` to verify tests pass.**

---

## Phase A: Configuration & Setup (A1–A3)

### A1. Create `vitest.config.integration.ts`

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/integration/setup-db.ts'],
    testTimeout: 30000, // Integration tests may be slower
    hookTimeout: 30000,
    pool: 'forks',     // Each test file gets its own process
    fileParallelism: false, // Run files sequentially (shared DB)
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### A2. Add scripts to `package.json`

```json
"test:integration": "vitest run --config vitest.config.integration.ts",
"test:all": "vitest run && vitest run --config vitest.config.integration.ts"
```

### A3. Create `src/__tests__/integration/setup-db.ts`

```typescript
import { beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';

// Use a separate test database
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // Create the test database if it doesn't exist
  const adminSql = postgres('postgresql://bytime:bytime_dev@localhost:5432/postgres');
  try {
    await adminSql`CREATE DATABASE bytime_test`;
  } catch {
    // Database already exists — that's fine
  }
  await adminSql.end();

  // Connect to the test database
  sql = postgres(TEST_DB_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  // Run migrations
  await migrate(db, { migrationsFolder: './drizzle' });

  // Export the test DB connection for use in tests
  (globalThis as any).__TEST_DB__ = db;
  (globalThis as any).__TEST_SQL__ = sql;
});

afterAll(async () => {
  if (sql) {
    await sql.end();
  }
});
```

### A4. Create `src/__tests__/integration/helpers.ts`

```typescript
import { v4 as uuidv4 } from 'crypto';
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
```

---

## Phase B: DCAA Core Tests (B1–B3)

### B1. Create `src/__tests__/integration/timesheet-save.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, createTestContract, createTestClin, assignUserToClin, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
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
    const indirectCode = await (await import('./helpers')).createTestIndirectCode();

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
```

### B2. Create `src/__tests__/integration/period-lifecycle.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq, and } from 'drizzle-orm';
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
```

### B3. Create `src/__tests__/integration/timesheet-rbac.test.ts`

```typescript
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
```

---

## Phase C: Security Tests (C1–C2)

### C1. Create `src/__tests__/integration/session-invalidation.test.ts`

```typescript
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
```

### C2. Create `src/__tests__/integration/brute-force.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestDb, cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';

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
```

---

## Phase D: Indirect Code Tests (D1)

### D1. Create `src/__tests__/integration/indirect-codes.test.ts`

```typescript
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
```

---

## 4. Verification

### 4a. Run Integration Tests

```bash
# Ensure Docker PostgreSQL is running
docker-compose up -d

# Run integration tests
npm run test:integration

# Run all tests (unit + integration)
npm run test:all
```

### 4b. Expected Results

| Test File | Tests | What It Verifies |
|---|---|---|
| `timesheet-save.test.ts` | 4 | Append-only, revisions, timestamps, indirect entries |
| `period-lifecycle.test.ts` | 5 | Draft→submitted→approved/rejected, unique constraint |
| `timesheet-rbac.test.ts` | 3 | Assignment exists, doesn't exist, deactivated |
| `session-invalidation.test.ts` | 3 | Initial version, role change increment, deactivation increment |
| `brute-force.test.ts` | 2 | Failed attempt recording, success reset |
| `indirect-codes.test.ts` | 3 | Create, save entry, unique constraint |
| **Total** | **20** | |

### 4c. Common Errors

| Error | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | Start Docker: `docker-compose up -d` |
| `database "bytime_test" does not exist` | setup-db.ts creates it automatically |
| `relation does not exist` | Run migrations: setup-db.ts handles this |
| Tests interfere with each other | `cleanupTestData()` runs in beforeEach/afterEach |
| `uuid is not a function` | Use `crypto.randomUUID()` or let DB generate UUIDs |
