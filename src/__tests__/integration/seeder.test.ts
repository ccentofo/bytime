import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { controlDb } from '@/db/control-plane';
import { tenantAuditEvents, tenantNotices, tenants } from '@/db/control-plane/schema';
import { encrypt } from '@/lib/encryption';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';
import { seedRichData } from '../../../scripts/seed-full';
import { registerTenant } from '../../../scripts/register-tenant';
import { cpReady, TEST_DB_URL } from './lifecycle-helpers';

/**
 * feature-plan-terms-compliance-fixes.md §5.4 / §7: the demo seeder refuses to wipe a database holding real users
 * unless told to, clears every table (including ones the old cleanup missed) so it can run twice, and the demo
 * registration marks the workspace lifecycle-exempt (F1) with an audit event.
 */

type SeedDb = Parameters<typeof seedRichData>[0];
const SEED_TIMEOUT = 180_000;

describe('demo seeder (§5.4)', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });
  afterEach(async () => {
    await cleanupTestData();
  });

  it('refuses to wipe a database with users outside the demo domains — nothing is touched', async () => {
    const real = await createTestUser({ email: `real-person-${Date.now()}@customer-company.com` });
    await expect(seedRichData(getTestDb() as unknown as SeedDb)).rejects.toThrow(/Refusing to wipe/);
    const [still] = await getTestDb().select().from(schema.users).where(eq(schema.users.id, real.id));
    expect(still).toBeTruthy();
  }, SEED_TIMEOUT);

  it('--wipe-demo-data overrides the refusal', async () => {
    await createTestUser({ email: `real-person-${Date.now()}@customer-company.com` });
    await expect(seedRichData(getTestDb() as unknown as SeedDb, { wipeDemoData: true })).resolves.toBeTruthy();
  }, SEED_TIMEOUT);

  it('seeds twice even after an integration connection and a period event exist', async () => {
    const db = getTestDb() as unknown as SeedDb;
    await seedRichData(db);
    const [admin] = await getTestDb().select().from(schema.users).where(eq(schema.users.role, 'admin')).limit(1);
    await getTestDb().insert(schema.integrationConnections).values({
      provider: 'quickbooks_online', displayName: 'QuickBooks — Demo', connectedBy: admin.id,
    });
    const [period] = await getTestDb().select().from(schema.timesheetPeriods).limit(1);
    if (period) {
      await getTestDb().insert(schema.periodEvents).values({ periodId: period.id, userId: period.userId, event: 'submitted', actorId: period.userId });
    }
    await expect(seedRichData(db)).resolves.toBeTruthy();
  }, SEED_TIMEOUT);
});

describe.skipIf(!cpReady)('demo registration marks the workspace lifecycle-exempt (F1)', () => {
  const slug = `test-lc-seed-${Date.now().toString(36)}`;

  afterEach(async () => {
    const rows = await controlDb.select({ id: tenants.id }).from(tenants).where(like(tenants.slug, 'test-lc-seed-%'));
    for (const r of rows) {
      await controlDb.delete(tenantNotices).where(eq(tenantNotices.tenantId, r.id));
      await controlDb.delete(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, r.id));
      await controlDb.delete(tenants).where(eq(tenants.id, r.id));
    }
  });

  it('sets lifecycle_exempt, clears D, supersedes pending notices, audits once, and bumps the version', async () => {
    const url = process.env.CONTROL_PLANE_DATABASE_URL!;
    await registerTenant(url, { slug, name: 'Demo', dbUrlEncrypted: encrypt(TEST_DB_URL), exempt: false, actor: 'test' });
    let [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug));
    await controlDb.update(tenants).set({ deletionScheduledFor: new Date() }).where(eq(tenants.id, row.id));
    const [notice] = await controlDb.insert(tenantNotices).values({ tenantId: row.id, kind: 'trial-ended', scheduledFor: new Date() }).returning();
    const v0 = row.lifecycleVersion;

    await registerTenant(url, { slug, name: 'Demo', dbUrlEncrypted: encrypt(TEST_DB_URL), exempt: true, actor: 'seed-demo' });
    await registerTenant(url, { slug, name: 'Demo', dbUrlEncrypted: encrypt(TEST_DB_URL), exempt: true, actor: 'seed-demo' });
    [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug));
    expect(row.lifecycleExempt).toBe(true);
    expect(row.deletionScheduledFor).toBeNull();
    expect(row.lifecycleVersion).toBe(v0 + 2);
    const [n] = await controlDb.select().from(tenantNotices).where(eq(tenantNotices.id, notice.id));
    expect(n.supersededAt).not.toBeNull();
    const audits = await controlDb.select().from(tenantAuditEvents).where(eq(tenantAuditEvents.tenantId, row.id));
    expect(audits.filter((a) => a.kind === 'exempt-on')).toHaveLength(1);
  });
});
