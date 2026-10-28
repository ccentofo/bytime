import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
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
import { createWorkspaceZipStream, openExportSnapshot, type ExportSnapshot } from '@/lib/export/workspace-export';

/**
 * R8 / feature-plan-terms-compliance-fixes.md §5.2 / §7: the full workspace export, streamed from one snapshot.
 * Asserts every revision is present, CSVs round-trip, formula injection is neutralized, reads are lazy, a
 * mid-stream failure can never produce an archive that opens, and an abort releases the connection.
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDbForAuth: async () => getTestDb(),
}));

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const tenantState = vi.hoisted(() => ({ requestSlug: 'test-tenant', blocked: false }));

vi.mock('@/lib/tenant/context', () => {
  class ExportNotAllowedError extends Error {}
  return {
  ExportNotAllowedError,
  getTenantSlug: async () => tenantState.requestSlug,
  getTenantForExport: async () => {
    if (tenantState.blocked) throw new ExportNotAllowedError('This workspace is on hold. Contact support@cadenzpoint.com.');
    return ({
    id: 'test-tenant-id', slug: tenantState.requestSlug, name: 'Test Tenant', status: 'active', plan: 'trial',
    dbUrl: process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test',
    });
  },
  };
});

type FakeSessionUser = { id: string; role: string; email: string; fullName: string };
const sessionState = vi.hoisted(() => ({ user: null as null | FakeSessionUser }));

vi.mock('@/auth', () => ({
  auth: async () =>
    sessionState.user
      ? { user: { ...sessionState.user, tenantSlug: tenantState.requestSlug } }
      : null,
}));

import { GET } from '@/app/api/export/workspace/route';

const FORBIDDEN_HEADER_TOKENS = [
  'password_hash', 'totp_secret', 'totp_recovery_codes', 'totp_last_used_step', 'session_version',
  'key_hash', 'token_hash', 'access_token_encrypted', 'refresh_token_encrypted',
];

async function unzipBytes(bytes: ArrayBuffer | Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async('string');
  }
  return out;
}

const parse = (csv: string) => Papa.parse<string[]>(csv.replace(/^﻿/, ''), { skipEmptyLines: true }).data;
const exportRequest = () => new Request('http://test-tenant.localhost/api/export/workspace') as never;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; error: unknown }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let error: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (err) {
    error = err;
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return { bytes, error };
}

/** Wrap a snapshot so tests can count reads, inject a failure on the Nth select, and observe close(). */
function instrument(snapshot: ExportSnapshot, failOnSelect?: number) {
  let selects = 0;
  const closes: boolean[] = [];
  const db = new Proxy(snapshot.db, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (...args: unknown[]) => {
          selects++;
          if (failOnSelect !== undefined && selects === failOnSelect) throw new Error('injected mid-stream failure');
          return Reflect.apply(target.select as (...a: unknown[]) => unknown, target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const wrapped: ExportSnapshot = {
    db, conn: snapshot.conn,
    close: async (commit) => { closes.push(commit); await snapshot.close(commit); },
  };
  return { snapshot: wrapped, selects: () => selects, closes };
}

describe('workspace export (§5.2)', () => {
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

  it('streams every revision, a latest-revision file, manifest + README, and no secret columns', async () => {
    const contract = await createTestContract();
    const clin = await createTestClin(contract.id);
    const chargeCode = await createTestChargeCode(clin.id);
    await assignUserToClin(admin.id, clin.id);
    await getTestDb().insert(schema.timesheetEntries).values([
      { userId: admin.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-05', hours: '8', revisionNumber: 1, createdBy: admin.id },
      { userId: admin.id, chargeCodeId: chargeCode.id, entryDate: '2026-01-05', hours: '6', revisionNumber: 2, changeReasonCode: 'correction', createdBy: admin.id },
    ]);

    const response = await GET(exportRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    const files = await unzipBytes(await response.arrayBuffer());
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      'manifest.json', 'README.md', 'users.csv', 'workspace_settings.csv', 'timesheet_entries.csv', 'timesheet_entries_current.csv',
    ]));

    const raw = parse(files['timesheet_entries.csv']);
    const current = parse(files['timesheet_entries_current.csv']);
    expect(raw).toHaveLength(3); // header + both revisions
    expect(current).toHaveLength(2); // header + latest only
    const hours = raw[0].indexOf('hours');
    expect(current[1][hours]).toBe('6');
    expect(raw.slice(1).map((r) => r[hours]).sort()).toEqual(['6', '8']);
    expect(files['timesheet_entries.csv']).toMatch(/\r\n/); // CRLF line endings

    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.tenantSlug).toBe('test-tenant');
    expect(manifest.rowCounts.timesheet_entries).toBe(2);
    expect(manifest.rowCounts.timesheet_entries_current).toBe(1);
    expect(files['README.md']).toContain('Leading apostrophe');

    for (const [name, content] of Object.entries(files)) {
      if (!name.endsWith('.csv')) continue;
      const header = parse(content)[0] ?? [];
      for (const token of FORBIDDEN_HEADER_TOKENS) expect(header, `${name} exposes ${token}`).not.toContain(token);
    }
  });

  it('certified-outputs C8: entry provenance + label, import_batches, admin_change_log, period-event provenance, self_approved', async () => {
    const db = getTestDb();
    const emp = await createTestUser({ role: 'employee' });
    const clin = await createTestClin((await createTestContract()).id);
    const [batch] = await db.insert(schema.importBatches).values({ kind: 'entries', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();
    await db.insert(schema.timesheetEntries).values({ userId: emp.id, clinId: clin.id, entryDate: '2026-01-05', hours: '8', revisionNumber: 1, createdBy: admin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { enteredBy: 'Pat (Deltek)' } });
    await db.insert(schema.adminChangeLog).values({ actorId: admin.id, entity: 'workspace_settings', entityId: '00000000-0000-0000-0000-000000000000', action: 'workweek_start_day_changed', oldValue: { workweekStartDay: null }, newValue: { workweekStartDay: 1 } });
    // Self-approved (admin's own), imported approval, and an ordinary approval.
    const [own] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2026-01-01', status: 'approved', reviewedBy: admin.id, reviewedAt: new Date() }).returning();
    const [imp] = await db.insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: '2025-12-16', status: 'approved' }).returning();
    const [ord] = await db.insert(schema.timesheetPeriods).values({ userId: emp.id, periodStart: '2026-01-01', status: 'approved', reviewedBy: admin.id, reviewedAt: new Date() }).returning();
    await db.insert(schema.periodEvents).values([
      { periodId: own.id, userId: admin.id, event: 'approved', actorId: admin.id, approvalContext: { selfApproved: true, activeAdminCount: 1 } },
      { periodId: imp.id, userId: emp.id, event: 'approved', actorId: admin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { reviewer: 'boss@old' } },
      { periodId: ord.id, userId: emp.id, event: 'approved', actorId: admin.id },
    ]);

    const files = await unzipBytes(await (await GET(exportRequest())).arrayBuffer());
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['import_batches.csv', 'admin_change_log.csv']));
    expect(parse(files['import_batches.csv'])[1]).toEqual(expect.arrayContaining([batch.id, 'Deltek']));
    expect(parse(files['admin_change_log.csv'])[1]).toEqual(expect.arrayContaining(['workweek_start_day_changed', '{"workweekStartDay":null}', '{"workweekStartDay":1}']));

    const [eh, er] = parse(files['timesheet_entries.csv']);
    const col = (h: string[], r: string[], name: string) => r[h.indexOf(name)];
    expect(col(eh, er, 'source')).toBe('migration');
    expect(col(eh, er, 'import_batch_id')).toBe(batch.id);
    expect(col(eh, er, 'original_metadata')).toBe('{"enteredBy":"Pat (Deltek)"}');
    expect(col(eh, er, 'provenance')).toMatch(/^Imported from Deltek on \d{4}-\d{2}-\d{2} by .* — originally entered by Pat \(Deltek\)$/);

    const periods = parse(files['timesheet_periods.csv']);
    const selfOf = (id: string) => col(periods[0], periods.find((r) => r[0] === id)!, 'self_approved');
    expect([selfOf(own.id), selfOf(imp.id), selfOf(ord.id)]).toEqual(['true', 'false', 'false']);
    const events = parse(files['period_events.csv']);
    const ev = (id: string) => events.find((r) => r[events[0].indexOf('period_id')] === id)!;
    expect(col(events[0], ev(own.id), 'self_approved')).toBe('true');
    expect(col(events[0], ev(own.id), 'approval_context')).toBe('{"selfApproved":true,"activeAdminCount":1}');
    expect(col(events[0], ev(imp.id), 'source')).toBe('migration');
    expect(col(events[0], ev(imp.id), 'self_approved')).toBe('false');
    expect(files['README.md']).toContain('### admin_change_log.csv');
  });

  it('T6: export self_approved matches approvalLabel — legacy period (no events, reviewed_by = user) and reject → resubmit → approve', async () => {
    const db = getTestDb();
    const other = await createTestUser({ role: 'admin' });
    const t = (m: number) => new Date(Date.UTC(2026, 0, 10, 12, m));
    // Legacy: approved before period_events existed, reviewed by the employee themselves → self-approved.
    const [legacy] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2025-11-01', status: 'approved', reviewedBy: admin.id, reviewedAt: t(0) }).returning();
    // Rejected by someone else, resubmitted, then approved by the employee (sole-admin self-approval) → true.
    const [selfLast] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2025-11-16', status: 'approved', reviewedBy: admin.id, reviewedAt: t(3) }).returning();
    // Self-rejected first, resubmitted, then approved by another admin → false (the LATEST approval decides).
    const [otherLast] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2025-12-01', status: 'approved', reviewedBy: other.id, reviewedAt: t(3) }).returning();
    await db.insert(schema.periodEvents).values([
      { periodId: selfLast.id, userId: admin.id, event: 'submitted', actorId: admin.id, createdAt: t(0) },
      { periodId: selfLast.id, userId: admin.id, event: 'rejected', actorId: other.id, createdAt: t(1) },
      { periodId: selfLast.id, userId: admin.id, event: 'submitted', actorId: admin.id, createdAt: t(2) },
      { periodId: selfLast.id, userId: admin.id, event: 'approved', actorId: admin.id, createdAt: t(3) },
      { periodId: otherLast.id, userId: admin.id, event: 'submitted', actorId: admin.id, createdAt: t(0) },
      { periodId: otherLast.id, userId: admin.id, event: 'rejected', actorId: admin.id, createdAt: t(1) },
      { periodId: otherLast.id, userId: admin.id, event: 'submitted', actorId: admin.id, createdAt: t(2) },
      { periodId: otherLast.id, userId: admin.id, event: 'approved', actorId: other.id, createdAt: t(3) },
    ]);

    const files = await unzipBytes(await (await GET(exportRequest())).arrayBuffer());
    const periods = parse(files['timesheet_periods.csv']);
    const exported = (id: string) => periods.find((r) => r[0] === id)![periods[0].indexOf('self_approved')];
    const { approvalLabels } = await import('@/server/internal/approval-label');
    const rows = await db.select().from(schema.timesheetPeriods);
    const labels = await approvalLabels(db as never, rows.map((r) => ({ id: r.id, userId: r.userId, status: r.status, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt })), 'UTC');
    for (const p of [legacy, selfLast, otherLast]) expect(exported(p.id), p.periodStart).toBe(String(labels.get(p.id)!.selfApproved));
    expect([exported(legacy.id), exported(selfLast.id), exported(otherLast.id)]).toEqual(['true', 'true', 'false']);
  });

  it('UX-3 fix round 2 (M4): export self_approved reads period_events — (a) an imported approval and (b) a later approval by another admin are false even though reviewed_by is the employee; both equal approvalLabel', async () => {
    const db = getTestDb();
    const other = await createTestUser({ role: 'admin' });
    const t = (m: number) => new Date(Date.UTC(2026, 0, 12, 12, m));
    const [batch] = await db.insert(schema.importBatches).values({ kind: 'periods', sourceSystem: 'Deltek', importedBy: admin.id, rowCount: 1, importedCount: 1, skippedCount: 0 }).returning();
    // (a) The admin's own period, reviewed_by the admin, approved by an IMPORTED event whose actor is the admin.
    const [imported] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2025-10-01', status: 'approved', reviewedBy: admin.id, reviewedAt: t(0) }).returning();
    // (b) The admin's own period, reviewed_by the admin, whose LATEST approved event's actor is another admin.
    const [laterOther] = await db.insert(schema.timesheetPeriods).values({ userId: admin.id, periodStart: '2025-10-16', status: 'approved', reviewedBy: admin.id, reviewedAt: t(2) }).returning();
    await db.insert(schema.periodEvents).values([
      { periodId: imported.id, userId: admin.id, event: 'approved', actorId: admin.id, source: 'migration', importBatchId: batch.id, originalMetadata: { reviewer: 'boss@old' }, createdAt: t(0) },
      { periodId: laterOther.id, userId: admin.id, event: 'approved', actorId: admin.id, createdAt: t(1) },
      { periodId: laterOther.id, userId: admin.id, event: 'approved', actorId: other.id, createdAt: t(2) },
    ]);

    const files = await unzipBytes(await (await GET(exportRequest())).arrayBuffer());
    const periods = parse(files['timesheet_periods.csv']);
    const exported = (id: string) => periods.find((r) => r[0] === id)![periods[0].indexOf('self_approved')];
    const { approvalLabels } = await import('@/server/internal/approval-label');
    const rows = await db.select().from(schema.timesheetPeriods);
    const labels = await approvalLabels(db as never, rows.map((r) => ({ id: r.id, userId: r.userId, status: r.status, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt })), 'UTC');
    expect(exported(imported.id), '(a) imported approval').toBe('false');
    expect(exported(laterOther.id), '(b) latest approval by another admin').toBe('false');
    for (const p of [imported, laterOther]) expect(exported(p.id), p.periodStart).toBe(String(labels.get(p.id)!.selfApproved));
  });

  it('F5: a blocked export (policy hold) is a 403 with a reason, never a 500 or a partial archive', async () => {
    tenantState.blocked = true;
    try {
      const response = await GET(exportRequest());
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/on hold/);
    } finally {
      tenantState.blocked = false;
    }
  });

  it('CSVs round-trip exactly; formula / DDE payloads get a leading apostrophe, plain negatives do not', async () => {
    const tricky = {
      formula: '=HYPERLINK("http://evil","x")',
      dde: "-2+3+cmd|' /C calc'!A0",
      at: '@SUM(A1:A2)',
      plus: '+cmd',
      quoted: 'Line one, "quoted"\nline two',
    };
    await getTestDb().insert(schema.contracts).values([
      { contractNumber: 'C-F', name: tricky.formula, description: tricky.dde, fundedValue: '-500' },
      { contractNumber: 'C-A', name: tricky.at, description: tricky.plus, fundedValue: '-12.50' },
      { contractNumber: 'C-Q', name: 'Normal', description: tricky.quoted, fundedValue: '100' },
    ]);
    const files = await unzipBytes(await (await GET(exportRequest())).arrayBuffer());
    const rows = parse(files['contracts.csv']);
    const h = rows[0];
    const byNumber = Object.fromEntries(rows.slice(1).map((r) => [r[h.indexOf('contract_number')], r]));
    const cell = (num: string, col: string) => byNumber[num][h.indexOf(col)];
    expect(cell('C-F', 'name')).toBe(`'${tricky.formula}`);
    expect(cell('C-F', 'description')).toBe(`'${tricky.dde}`);
    expect(cell('C-F', 'funded_value')).toBe('-500');
    expect(cell('C-A', 'name')).toBe(`'${tricky.at}`);
    expect(cell('C-A', 'description')).toBe(`'${tricky.plus}`);
    expect(cell('C-A', 'funded_value')).toBe('-12.50');
    expect(cell('C-Q', 'description')).toBe(tricky.quoted); // embedded comma, quotes and newline survive
  });

  it('reads lazily: nothing is queried until the consumer pulls', async () => {
    await createTestContract();
    const inst = instrument(await openExportSnapshot(TEST_DB_URL));
    const stream = createWorkspaceZipStream(inst.snapshot, { tenantSlug: 'test-tenant' });
    expect(inst.selects()).toBe(0);
    const reader = stream.getReader();
    await reader.read();
    const afterOne = inst.selects();
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(5); // not the whole workspace up front
    await reader.cancel();
    expect(inst.closes).toEqual([false]);
  });

  it('a mid-stream failure errors the stream and the partial archive cannot be opened', async () => {
    await createTestContract();
    const onError = vi.fn();
    const inst = instrument(await openExportSnapshot(TEST_DB_URL), 4);
    const { bytes, error } = await readAll(createWorkspaceZipStream(inst.snapshot, { tenantSlug: 'test-tenant', onError }));
    expect(error).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(inst.closes).toEqual([false]); // rolled back, connection released
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow();
  });

  it('a client abort (signal) releases the snapshot connection', async () => {
    const inst = instrument(await openExportSnapshot(TEST_DB_URL));
    const controller = new AbortController();
    const stream = createWorkspaceZipStream(inst.snapshot, { tenantSlug: 'test-tenant', signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(inst.closes).toContain(false);
    await reader.cancel().catch(() => {});
  });

  it('a complete export commits the snapshot exactly once', async () => {
    const inst = instrument(await openExportSnapshot(TEST_DB_URL));
    const { error } = await readAll(createWorkspaceZipStream(inst.snapshot, { tenantSlug: 'test-tenant' }));
    expect(error).toBeNull();
    expect(inst.closes).toEqual([true]);
  });
});
