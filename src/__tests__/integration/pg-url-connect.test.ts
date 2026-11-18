import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

/**
 * url-fix (2026-11-18): Neon's connection strings carry `channel_binding=require`. postgres.js forwards unknown URL
 * keys to the server as startup settings, and Postgres rejects them (42704 unrecognized configuration parameter).
 * Each app client must connect with such a URL. Local Postgres has no TLS, so the URLs carry no `sslmode`; the
 * extra keys are the ones that fail: `channel_binding` (Neon) and `keepalives` (libpq).
 */

const EXTRA = 'channel_binding=require&keepalives=1';
const withExtra = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${EXTRA}`;

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const CP_URL = process.env.CONTROL_PLANE_DATABASE_URL ?? '';
const NEON_URL = withExtra(TEST_DB_URL);

describe('app clients connect with a Neon-shaped URL (channel_binding=require)', () => {
  it('the raw URL really is rejected by postgres.js + Postgres (the defect this suite guards)', async () => {
    const { default: postgres } = await import('postgres');
    const raw = postgres(NEON_URL, { max: 1, onnotice: () => {} });
    try {
      await expect(raw`select 1`).rejects.toMatchObject({ code: '42704' });
    } finally {
      await raw.end({ timeout: 1 });
    }
  });

  it('getDbForUrl (the tenant client, src/db/index.ts clientFor)', async () => {
    const { getDbForUrl } = await import('@/db');
    const db = getDbForUrl(NEON_URL);
    try {
      const rows = await db.execute(sql`select 1 as one`);
      expect(rows[0]).toMatchObject({ one: 1 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  });

  it('migrateTenantDatabase (already migrated: a no-op under the advisory lock)', async () => {
    const { migrateTenantDatabase } = await import('@/lib/tenant/migrate-tenant');
    await expect(migrateTenantDatabase(NEON_URL, { migrationsFolder: './drizzle', connectTimeoutSec: 10 })).resolves.toBeUndefined();
  });

  it('getPendingMigrationCount', async () => {
    const { getPendingMigrationCount } = await import('@/lib/tenant/migrate-tenant');
    expect(await getPendingMigrationCount(NEON_URL, './drizzle')).toBe(0);
  });

  it('databaseExists (neon.ts admin client)', async () => {
    const { databaseExists } = await import('@/lib/tenant/neon');
    const dbName = new URL(TEST_DB_URL).pathname.slice(1);
    expect(await databaseExists(NEON_URL, dbName)).toBe(true);
  });

  it('openExportSnapshot (the workspace export client)', async () => {
    const { openExportSnapshot } = await import('@/lib/export/workspace-export');
    const snap = await openExportSnapshot(NEON_URL);
    try {
      const rows = await snap.conn`select 1 as one`;
      expect(rows[0]).toMatchObject({ one: 1 });
    } finally {
      await snap.close(false);
    }
  });
});

describe.skipIf(!CP_URL)('control-plane clients connect with a Neon-shaped URL (channel_binding=require)', () => {
  const original = process.env.CONTROL_PLANE_DATABASE_URL;
  afterEach(() => {
    process.env.CONTROL_PLANE_DATABASE_URL = original;
    vi.resetModules();
  });

  it('controlDb (src/db/control-plane/index.ts)', async () => {
    vi.resetModules();
    process.env.CONTROL_PLANE_DATABASE_URL = withExtra(CP_URL);
    const { getControlDbInstance } = await import('@/db/control-plane');
    const db = getControlDbInstance();
    try {
      const rows = await db.execute(sql`select 1 as one`);
      expect(rows[0]).toMatchObject({ one: 1 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  });

  it('withLockedPool (src/db/control-plane/locked.ts)', async () => {
    vi.resetModules();
    process.env.CONTROL_PLANE_DATABASE_URL = withExtra(CP_URL);
    const { withLockedPool } = await import('@/db/control-plane/locked');
    await withLockedPool(async (db) => {
      try {
        const rows = await db.execute(sql`select 1 as one`);
        expect(rows[0]).toMatchObject({ one: 1 });
      } finally {
        await db.$client.end({ timeout: 1 });
      }
    });
  });
});
