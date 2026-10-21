import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import {
  getTestDb,
  createTestUser,
  createTestContract,
  createTestClin,
  createTestChargeCode,
  assignUserToClin,
  cleanupTestData,
} from './helpers';
import * as schema from '@/db/schema';

/**
 * T6/R8: the full workspace export (GET /api/export/workspace) against a seeded tenant DB.
 * Asserts every revision is present (not just the latest), the "current" convenience CSV only
 * has the latest revision per cell, and no forbidden secret column name appears anywhere.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDbForAuth: async () => getTestDb(),
}));

const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant' }));

vi.mock('@/lib/tenant/context', () => ({
  getTenantSlug: async () => tenantState.requestSlug,
  getTenantForExport: async () => ({
    id: 'test-tenant-id',
    slug: tenantState.requestSlug,
    name: 'Test Tenant',
    status: 'active',
    plan: 'trial',
    dbUrl: process.env.TEST_DATABASE_URL,
  }),
}));

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? {
          user: {
            id: sessionState.user.id,
            email: sessionState.user.email,
            fullName: sessionState.user.fullName,
            role: sessionState.user.role,
            tenantSlug: tenantState.requestSlug,
          },
        }
      : null,
}));

import { GET } from '@/app/api/export/workspace/route';

const FORBIDDEN_HEADER_TOKENS = [
  'password_hash', 'totp_secret', 'totp_recovery_codes', 'totp_last_used_step', 'session_version',
  'key_hash', 'token_hash', 'access_token_encrypted', 'refresh_token_encrypted',
];

async function unzip(response: Response): Promise<Record<string, string>> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async('string');
  }
  return out;
}

describe('GET /api/export/workspace (T6)', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser({ role: 'admin' });
    sessionState.user = { id: admin.id, role: admin.role, email: admin.email, fullName: admin.fullName };
  });

  afterEach(async () => {
    sessionState.user = null;
    await cleanupTestData();
  });

  it('exports every revision, a latest-revision-only convenience file, and no secret columns', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(admin.id, clin.id);

    const db = getTestDb();
    // Two revisions of the SAME cell — a correction. Only revision 2 should appear in the
    // "current" file; both must appear in the raw file.
    await db.insert(schema.timesheetEntries).values([
      {
        userId: admin.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-05',
        hours: '8', revisionNumber: 1, createdBy: admin.id,
      },
      {
        userId: admin.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-05',
        hours: '6', revisionNumber: 2, changeReasonCode: 'correction', createdBy: admin.id,
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');

    const files = await unzip(response);
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      'manifest.json', 'README.md', 'users.csv', 'timesheet_entries.csv', 'timesheet_entries_current.csv',
    ]));

    // Strip the UTF-8 BOM before splitting into lines.
    const rawLines = files['timesheet_entries.csv'].replace(/^﻿/, '').trim().split('\n');
    const currentLines = files['timesheet_entries_current.csv'].replace(/^﻿/, '').trim().split('\n');
    expect(rawLines.length).toBe(3); // header + both revisions
    expect(currentLines.length).toBe(2); // header + latest revision only

    const hoursColumnIndex = rawLines[0].split(',').indexOf('hours');
    expect(currentLines[1].split(',')[hoursColumnIndex]).toBe('6'); // revision 2's hours
    expect(rawLines.some((l) => l.split(',')[hoursColumnIndex] === '8')).toBe(true); // revision 1 still present in the raw file

    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.tenantSlug).toBe('test-tenant');
    expect(manifest.rowCounts.timesheet_entries).toBe(2);
    expect(manifest.rowCounts.timesheet_entries_current).toBe(1);
    expect(manifest.rowCounts.users).toBeGreaterThanOrEqual(1);

    for (const [name, content] of Object.entries(files)) {
      if (!name.endsWith('.csv')) continue;
      for (const token of FORBIDDEN_HEADER_TOKENS) {
        expect(content, `${name} contains forbidden column "${token}"`).not.toContain(token);
      }
    }
  });

  it('never exports api_keys, login_attempts, or password_reset_tokens as files', async () => {
    const response = await GET();
    const files = await unzip(response);
    expect(Object.keys(files)).not.toEqual(expect.arrayContaining([
      'api_keys.csv', 'login_attempts.csv', 'password_reset_tokens.csv', 'integration_connections.csv',
    ]));
  });
});
