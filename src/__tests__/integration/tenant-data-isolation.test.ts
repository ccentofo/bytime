import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { getDbForUrl } from '@/db';

/**
 * PHYSICAL tenant isolation — the core DCAA guarantee. There are NO tenantId columns;
 * isolation is the database boundary. This test proves that the real routing accessor
 * (getDbForUrl) binds each connection string to a separate dataset and that data written
 * through one tenant's client is NEVER visible through another's.
 *
 * Requires TWO migrated tenant databases:
 *   TEST_DATABASE_URL    (tenant A — also migrated by setup-db.ts)
 *   TEST_DATABASE_URL_2  (tenant B)
 * Skips when TEST_DATABASE_URL_2 is not set, so CI/local stay green until a 2nd DB exists.
 *
 * NOTE: header→slug→url resolution is covered separately by the unit/server tests
 * (tenant-host.test.ts, tenant-resolution.test.ts). This file covers the data layer.
 */
const URL_A = process.env.TEST_DATABASE_URL;
const URL_B = process.env.TEST_DATABASE_URL_2;
const ready = !!(URL_A && URL_B && URL_A !== URL_B);

describe.skipIf(!ready)('Tenant data isolation — physical (two databases)', () => {
  const emailA = `iso-a-${Date.now()}@iso.test`;
  const emailB = `iso-b-${Date.now()}@iso.test`;

  beforeAll(async () => {
    // DB-B may be fresh — ensure schema. (DB-A is migrated by setup-db.ts.)
    const sqlB = postgres(URL_B!, { max: 1 });
    try {
      await migrate(drizzle(sqlB, { schema }), { migrationsFolder: './drizzle' });
    } catch (err: any) {
      // 42710 (dup object) / 42P07 (dup table) — schema already present, fine.
      if (err?.cause?.code !== '42710' && err?.cause?.code !== '42P07') throw err;
    } finally {
      await sqlB.end();
    }

    const dbA = getDbForUrl(URL_A!);
    const dbB = getDbForUrl(URL_B!);
    await dbA.insert(schema.users).values({ email: emailA, fullName: 'Tenant A', role: 'admin', isActive: true });
    await dbB.insert(schema.users).values({ email: emailB, fullName: 'Tenant B', role: 'admin', isActive: true });
  });

  afterAll(async () => {
    // Surgical cleanup — delete only the rows we created (do NOT wipe shared test DBs).
    await getDbForUrl(URL_A!).delete(schema.users).where(eq(schema.users.email, emailA));
    await getDbForUrl(URL_B!).delete(schema.users).where(eq(schema.users.email, emailB));
  });

  it('tenant A client sees A’s data and NOT B’s', async () => {
    const dbA = getDbForUrl(URL_A!);
    const own = await dbA.select().from(schema.users).where(eq(schema.users.email, emailA));
    const leak = await dbA.select().from(schema.users).where(eq(schema.users.email, emailB));
    expect(own).toHaveLength(1);
    expect(leak).toHaveLength(0);
  });

  it('tenant B client sees B’s data and NOT A’s', async () => {
    const dbB = getDbForUrl(URL_B!);
    const own = await dbB.select().from(schema.users).where(eq(schema.users.email, emailB));
    const leak = await dbB.select().from(schema.users).where(eq(schema.users.email, emailA));
    expect(own).toHaveLength(1);
    expect(leak).toHaveLength(0);
  });

  it('getDbForUrl is stable per URL and distinct across URLs', () => {
    expect(getDbForUrl(URL_A!)).toBe(getDbForUrl(URL_A!));
    expect(getDbForUrl(URL_A!)).not.toBe(getDbForUrl(URL_B!));
  });
});
