import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants, tenantNotices } from '@/db/control-plane/schema';
import { encrypt } from '@/lib/encryption';
import { sendTenantNotice } from '@/lib/tenant/notices';
import { cleanupTestData, createTestUser } from './helpers';
import React from 'react';

/**
 * R14: "notices to admins must be provable" — sendTenantNotice's insert-before-send pattern is
 * what makes that true. These tests prove the unique (tenant_id, kind, scheduled_for) key
 * actually dedupes repeated calls (a cron retry), and that recipients resolve to active admins.
 *
 * Needs a real control plane; skipped if CONTROL_PLANE_DATABASE_URL isn't set (same gate as
 * provision.test.ts).
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const cpReady = !!process.env.CONTROL_PLANE_DATABASE_URL;

async function makeTestTenantRow() {
  const [row] = await controlDb.insert(tenants).values({
    slug: `test-notices-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Notice Test Tenant',
    dbUrlEncrypted: encrypt(TEST_DB_URL),
    status: 'active',
  }).returning();
  return row;
}

async function cleanupTenantRow(tenantId: string) {
  await controlDb.delete(tenantNotices).where(eq(tenantNotices.tenantId, tenantId));
  await controlDb.delete(tenants).where(eq(tenants.id, tenantId));
}

describe.skipIf(!cpReady)('sendTenantNotice (R14)', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });
  afterEach(async () => {
    await cleanupTestData();
  });

  it('insert-before-send dedupes repeated calls for the same (tenant, kind, scheduledFor)', async () => {
    const tenantRow = await makeTestTenantRow();
    try {
      await createTestUser({ role: 'admin', email: `admin-${Date.now()}@test.dev`, isActive: true });
      const scheduledFor = new Date('2026-06-01T00:00:00Z');

      const target = { id: tenantRow.id, dbUrl: TEST_DB_URL, signupEmail: null, billingEmail: null };
      await sendTenantNotice({
        tenant: target, kind: 'trial-ended', scheduledFor,
        subject: 'Test', react: React.createElement('div', null, 'test'),
      });
      await sendTenantNotice({
        tenant: target, kind: 'trial-ended', scheduledFor,
        subject: 'Test', react: React.createElement('div', null, 'test'),
      });

      const rows = await controlDb.select().from(tenantNotices).where(eq(tenantNotices.tenantId, tenantRow.id));
      expect(rows.length).toBe(1); // the second call's insert conflicted and was a no-op
      expect(rows[0].recipients.length).toBeGreaterThan(0);
    } finally {
      await cleanupTenantRow(tenantRow.id);
    }
  });

  it('a different scheduledFor is a distinct notice, not deduped', async () => {
    const tenantRow = await makeTestTenantRow();
    try {
      await createTestUser({ role: 'admin', isActive: true });
      const target = { id: tenantRow.id, dbUrl: TEST_DB_URL, signupEmail: null, billingEmail: null };

      await sendTenantNotice({
        tenant: target, kind: 'deletion-notice', scheduledFor: new Date('2026-06-01T00:00:00Z'),
        subject: 'Test', react: React.createElement('div', null, 'test'),
      });
      await sendTenantNotice({
        tenant: target, kind: 'deletion-notice', scheduledFor: new Date('2026-07-01T00:00:00Z'),
        subject: 'Test', react: React.createElement('div', null, 'test'),
      });

      const rows = await controlDb.select().from(tenantNotices).where(eq(tenantNotices.tenantId, tenantRow.id));
      expect(rows.length).toBe(2);
    } finally {
      await cleanupTenantRow(tenantRow.id);
    }
  });

  it('resolves recipients to active admins only, falling back to signupEmail when there are none', async () => {
    const tenantRow = await makeTestTenantRow();
    try {
      await createTestUser({ role: 'admin', isActive: false }); // inactive — must be excluded
      await createTestUser({ role: 'employee', isActive: true }); // not an admin — must be excluded

      const target = {
        id: tenantRow.id, dbUrl: TEST_DB_URL, signupEmail: 'founder-fallback@test.dev', billingEmail: null,
      };
      await sendTenantNotice({
        tenant: target, kind: 'suspended', scheduledFor: new Date('2026-08-01T00:00:00Z'),
        subject: 'Test', react: React.createElement('div', null, 'test'),
      });

      const [row] = await controlDb.select().from(tenantNotices).where(eq(tenantNotices.tenantId, tenantRow.id));
      expect(row.recipients).toEqual(['founder-fallback@test.dev']);
    } finally {
      await cleanupTenantRow(tenantRow.id);
    }
  });
});
