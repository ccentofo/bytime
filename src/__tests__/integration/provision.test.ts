import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanupTestData } from './helpers';
import * as schema from '@/db/schema';
import { provisionTenant, isValidSlug } from '@/lib/tenant/provision';
import { getDbForUrl } from '@/db';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { encrypt } from '@/lib/encryption';
import { invalidateTenant } from '@/lib/tenant/registry';
import { eq, like } from 'drizzle-orm';

// Use the test DB as the "tenant database" — the provisioning engine accepts a
// pluggable createDatabase that returns any postgres:// URL.
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

async function fakeCreateDatabase(_slug: string): Promise<string> {
  return TEST_DB_URL;
}

// provisionTenant writes to the control-plane registry, so those tests need a control plane.
// Gate on it so the suite stays green when CONTROL_PLANE_DATABASE_URL isn't provided.
const cpReady = !!process.env.CONTROL_PLANE_DATABASE_URL;

/** Remove any 'test-*' registry rows so the suite is re-runnable and doesn't pollute the CP. */
async function cleanControlPlaneTestRows() {
  await controlDb.delete(tenants).where(like(tenants.slug, 'test-%'));
}

// -------------------------------------------------------------------------
// isValidSlug — pure, always runs (no DB required)
// -------------------------------------------------------------------------
describe('isValidSlug', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('my-company')).toBe(true);
    expect(isValidSlug('acme123')).toBe(true);
  });

  it('rejects invalid slugs', () => {
    expect(isValidSlug('WWW')).toBe(false);     // uppercase
    expect(isValidSlug('a_b')).toBe(false);     // underscore
    expect(isValidSlug('-acme')).toBe(false);   // leading hyphen
    expect(isValidSlug('acme-')).toBe(false);   // trailing hyphen
    expect(isValidSlug('www')).toBe(false);     // reserved
    expect(isValidSlug('admin')).toBe(false);   // reserved
    expect(isValidSlug('')).toBe(false);        // empty
  });
});

// -------------------------------------------------------------------------
// provisionTenant — needs a control plane; skipped if CONTROL_PLANE_DATABASE_URL unset
// -------------------------------------------------------------------------
describe.skipIf(!cpReady)('provisionTenant', () => {
  beforeEach(async () => {
    await cleanupTestData();            // tenant DB
    await cleanControlPlaneTestRows();  // control-plane registry
  });
  afterEach(async () => {
    await cleanupTestData();
    await cleanControlPlaneTestRows();
  });

  it('creates an admin user with null passwordHash', async () => {
    const result = await provisionTenant({
      slug: 'test-acme',
      name: 'Acme Corp',
      adminEmail: 'admin@acme.com',
      adminName: 'Admin User',
      createDatabase: fakeCreateDatabase,
    });

    expect(result.slug).toBe('test-acme');
    expect(result.adminUserId).toBeTruthy();

    const db = getDbForUrl(TEST_DB_URL);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, result.adminUserId));

    expect(user.email).toBe('admin@acme.com');
    expect(user.role).toBe('admin');
    expect(user.isActive).toBe(true);
    expect(user.passwordHash).toBeNull(); // dormant until invite flow
  });

  // D8: signup captures the browser timezone, which provisionTenant writes into the new
  // tenant's workspace_settings row (seeded by migration 0011, then updated here).
  it('seeds workspace_settings with the captured timezone', async () => {
    await provisionTenant({
      slug: 'test-tz',
      name: 'TZ Corp',
      adminEmail: 'admin@tz.com',
      adminName: 'Admin',
      timezone: 'America/Los_Angeles',
      createDatabase: fakeCreateDatabase,
    });

    const db = getDbForUrl(TEST_DB_URL);
    const [settings] = await db.select().from(schema.workspaceSettings);
    expect(settings.timezone).toBe('America/Los_Angeles');
  });

  it('falls back to the column default when no timezone is captured', async () => {
    await provisionTenant({
      slug: 'test-tz-default',
      name: 'Default TZ Corp',
      adminEmail: 'admin@tzdefault.com',
      adminName: 'Admin',
      createDatabase: fakeCreateDatabase,
    });

    const db = getDbForUrl(TEST_DB_URL);
    const [settings] = await db.select().from(schema.workspaceSettings);
    expect(settings.timezone).toBe('America/New_York');
  });

  it('ignores an invalid captured timezone and keeps the column default', async () => {
    await provisionTenant({
      slug: 'test-tz-invalid',
      name: 'Invalid TZ Corp',
      adminEmail: 'admin@tzinvalid.com',
      adminName: 'Admin',
      timezone: 'Not/A_Real_Zone',
      createDatabase: fakeCreateDatabase,
    });

    const db = getDbForUrl(TEST_DB_URL);
    const [settings] = await db.select().from(schema.workspaceSettings);
    expect(settings.timezone).toBe('America/New_York');
  });

  it('blank slate — zero indirect codes and zero contracts', async () => {
    await provisionTenant({
      slug: 'test-blank',
      name: 'Blank Corp',
      adminEmail: 'admin@blank.com',
      adminName: 'Admin',
      createDatabase: fakeCreateDatabase,
    });

    const db = getDbForUrl(TEST_DB_URL);
    const codes = await db.select().from(schema.indirectChargeCodes);
    const contracts = await db.select().from(schema.contracts);

    expect(codes).toHaveLength(0);
    expect(contracts).toHaveLength(0);
  });

  it('is idempotent — second run with same active slug throws', async () => {
    const input = {
      slug: 'test-idempotent',
      name: 'Idempotent Corp',
      adminEmail: 'admin@idempotent.com',
      adminName: 'Admin',
      createDatabase: fakeCreateDatabase,
    };
    await provisionTenant(input);
    await expect(provisionTenant(input)).rejects.toThrow(/already exists/i);
  });

  it('resumes a provisioning tenant without duplicating the admin', async () => {
    // Simulate a prior partial run: a 'provisioning' registry row + an admin already created
    // in the tenant DB, but never activated.
    await controlDb.insert(tenants).values({
      slug: 'test-resume',
      name: 'Resume Corp',
      dbUrlEncrypted: encrypt(TEST_DB_URL),
      status: 'provisioning',
      plan: 'trial',
    });
    invalidateTenant('test-resume');
    const tdb = getDbForUrl(TEST_DB_URL);
    await tdb.insert(schema.users).values({
      email: 'admin@resume.com', fullName: 'Admin', role: 'admin', isActive: true,
    });

    // Re-running must NOT throw (status is 'provisioning', not 'active') and must finish active.
    const result = await provisionTenant({
      slug: 'test-resume',
      name: 'Resume Corp',
      adminEmail: 'admin@resume.com',
      adminName: 'Admin',
      createDatabase: fakeCreateDatabase,
    });

    expect(result.slug).toBe('test-resume');
    const users = await tdb.select().from(schema.users).where(eq(schema.users.email, 'admin@resume.com'));
    expect(users).toHaveLength(1); // no duplicate admin
    const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, 'test-resume'));
    expect(row.status).toBe('active'); // resume completed activation
  });

  it('throws for an invalid slug', async () => {
    await expect(
      provisionTenant({
        slug: 'INVALID_SLUG',
        name: 'Bad Corp',
        adminEmail: 'admin@bad.com',
        adminName: 'Admin',
        createDatabase: fakeCreateDatabase,
      })
    ).rejects.toThrow(/Invalid workspace name/i);
  });
});
