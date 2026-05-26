import { beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';

// ALWAYS use a separate test database — NEVER the dev database.
// The dev DB fallback was removed because cleanupTestData() deletes ALL rows,
// which previously wiped all seed users from the dev database.
// DO NOT add process.env.DATABASE_URL as a fallback here.
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // Connect to the test database (uses existing bytime DB if bytime_test not available)
  sql = postgres(TEST_DB_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  // Skip migrations if tables already exist (dev DB already has schema)
  // In CI, the DB is fresh and migrations are needed
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
  } catch (err: any) {
    // If types/tables already exist, that's fine — we're using the dev DB
    if (err?.cause?.code !== '42710' && err?.cause?.code !== '42P07') {
      throw err;
    }
  }

  // Export the test DB connection for use in tests
  (globalThis as any).__TEST_DB__ = db;
  (globalThis as any).__TEST_SQL__ = sql;
});

afterAll(async () => {
  if (sql) {
    await sql.end();
  }
});
