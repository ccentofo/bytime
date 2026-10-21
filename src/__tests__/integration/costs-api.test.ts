import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  cleanupTestData,
} from './helpers';

// ---------------------------------------------------------------------------
// R2-4: /api/v1/costs regressed to a 500 for every API client after round 1 made
// getDetailedCostReport require an admin SESSION — API-key requests have none.
// The route now calls the internal query (getDetailedCostReportData) directly,
// after validateApiKey() succeeds, same as every other /api/v1/* route.
// ---------------------------------------------------------------------------

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
}));

import { GET } from '@/app/api/v1/costs/route';

describe('/api/v1/costs (R2-4)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let rawKey: string;

  beforeEach(async () => {
    await cleanupTestData();
    const db = getTestDb();
    admin = await createTestUser({ role: 'admin' });

    rawKey = `byt_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await db.insert(schema.apiKeys).values({
      name: 'Test key',
      keyHash,
      keyPrefix: rawKey.substring(0, 8),
      createdByUserId: admin.id,
      permissions: 'read',
      isActive: true,
    });
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('returns 200 with data for a valid API key', async () => {
    const contract = await createTestContract();
    await createTestClin(contract.id);

    const request = new Request(
      'http://localhost:3000/api/v1/costs?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.21' } }
    );

    const response = await GET(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('returns 401 for a missing Authorization header', async () => {
    const request = new Request(
      'http://localhost:3000/api/v1/costs?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { 'x-forwarded-for': '203.0.113.22' } }
    );

    const response = await GET(request as any);
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid API key', async () => {
    const request = new Request(
      'http://localhost:3000/api/v1/costs?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { Authorization: 'Bearer byt_not_a_real_key', 'x-forwarded-for': '203.0.113.23' } }
    );

    const response = await GET(request as any);
    expect(response.status).toBe(401);
  });

  // R2-12 ---------------------------------------------------------------
  it('returns 403 once the key\'s creator is demoted from admin', async () => {
    const db = getTestDb();
    await db.update(schema.users).set({ role: 'employee' }).where(eq(schema.users.id, admin.id));

    const request = new Request(
      'http://localhost:3000/api/v1/costs?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.24' } }
    );
    const response = await GET(request as any);
    expect(response.status).toBe(403);
  });

  it('returns 403 once the key\'s creator is deactivated', async () => {
    const db = getTestDb();
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, admin.id));

    const request = new Request(
      'http://localhost:3000/api/v1/costs?startDate=2026-01-01&endDate=2026-01-31',
      { headers: { Authorization: `Bearer ${rawKey}`, 'x-forwarded-for': '203.0.113.25' } }
    );
    const response = await GET(request as any);
    expect(response.status).toBe(403);
  });
});
