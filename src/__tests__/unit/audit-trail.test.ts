import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-certified-outputs.md C6 / §9 rows "Audit" (indirect entries appear; sibling codes separate histories;
 * MIGRATION label), "Display" (audit / revision history label imported rows), "Self-approved label" and
 * "Self-approval switch" (audit trail period events: the label and the recorded approval context).
 */

vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb();
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  const sup = async () => ({ id: 'sup-1', email: 's@x', fullName: 'Sam', role: 'supervisor' });
  return { requireApprover: sup, getEmployeeScope: async () => 'all', assertCanAccessEmployee: async () => {} };
});
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: async () => 'UTC' }));
vi.mock('@/server/internal/pay-period-config', () => ({ existingPeriodLength: async (_db: unknown, _s: unknown, n: number | null) => n ?? 15 }));

import * as dbModule from '@/db';
import { periodEvents, timesheetEntries, users } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { getAuditEntries, getAuditPeriodEvents, getCellRevisionHistory } from '@/server/actions/audit';
import { periodEventLabel } from '@/server/internal/approval-label';
import { cellCodeLabel, cellKind } from '@/lib/cell-code';
import { reasonLabel } from '@/lib/reason-codes';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
const ROOT = path.resolve(__dirname, '../../..');
const CELL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
beforeEach(() => db.reset());

const row = (o: Record<string, unknown>) => ({
  id: 'e1', userId: 'u1', userName: 'Pat', userEmail: 'p@x', chargeCodeId: null, clinId: null, indirectCodeId: null,
  chargeCode: null, clinNumber: null, contractName: null, contractNumber: null, slinNumber: null, indirectCode: null, indirectCategory: null,
  entryDate: '2026-09-01', hours: '8.00', revisionNumber: 1, changeReasonCode: null, comment: null, createdAt: new Date('2026-09-01T12:00:00Z'),
  createdById: 'u1', createdByName: 'Pat', source: 'app', originalMetadata: null, importSourceSystem: null, importedAt: null, importedByName: null, ...o,
});

describe('true cell code', () => {
  it('kind and label: charge code, legacy CLIN, indirect with category', () => {
    expect(cellKind({ chargeCodeId: 'c', indirectCodeId: null })).toBe('charge');
    expect(cellKind({ chargeCodeId: null, indirectCodeId: 'i' })).toBe('indirect');
    expect(cellKind({ chargeCodeId: null, indirectCodeId: null })).toBe('clin');
    const base = { chargeCode: 'NAV-1', clinNumber: '0001', indirectCode: 'LV-PTO', indirectCategory: 'leave' };
    expect(cellCodeLabel({ kind: 'charge', ...base })).toBe('NAV-1');
    expect(cellCodeLabel({ kind: 'clin', ...base })).toBe('CLIN 0001');
    expect(cellCodeLabel({ kind: 'indirect', ...base })).toBe('LV-PTO (Leave)');
  });

  it('MIGRATION has a label (REASON_LABELS)', () => {
    expect(reasonLabel('MIGRATION')).toBe('Imported (migration)');
    expect(reasonLabel('CORRECTION')).toBe('Correction of Error');
  });
});

describe('getAuditEntries', () => {
  it('indirect entries appear (no CLIN) with their category; each row carries its true cell code and label', async () => {
    db.onSelect(timesheetEntries, [
      row({ id: 'a', indirectCodeId: 'ind-1', indirectCode: 'LV-PTO', indirectCategory: 'leave' }),
      row({ id: 'b', chargeCodeId: 'cc-1', clinId: 'clin-1', chargeCode: 'NAV-1', clinNumber: '0001', contractName: 'NAVAIR', contractNumber: 'N1' }),
      row({ id: 'c', clinId: 'clin-9', clinNumber: '0009', contractName: 'DISA', contractNumber: 'D1' }),
    ]);
    const out = (await getAuditEntries({})).entries;
    expect(out.map((e) => [e.id, e.kind, e.cellCode, e.codeLabel, e.contractName, e.indirectCategory])).toEqual([
      ['a', 'indirect', 'ind-1', 'LV-PTO (Leave)', null, 'Leave'],
      ['b', 'charge', 'cc-1', 'NAV-1', 'NAVAIR', null],
      ['c', 'clin', 'clin-9', 'CLIN 0009', 'DISA', null],
    ]);
  });

  it('imported rows carry their provenance label; legacy MIGRATION rows the legacy label; app rows none', async () => {
    db.onSelect(timesheetEntries, [
      row({ id: 'm', clinId: 'c', source: 'migration', importSourceSystem: 'Deltek', importedAt: new Date('2026-01-05T00:00:00Z'), importedByName: 'Ann', originalMetadata: { enteredBy: 'Pat' } }),
      row({ id: 'l', clinId: 'c', changeReasonCode: 'MIGRATION' }),
      row({ id: 'p', clinId: 'c' }),
    ]);
    expect(((await getAuditEntries({})).entries).map((e) => e.provenance)).toEqual([
      'Imported from Deltek on 2026-01-05 by Ann — originally entered by Pat', 'Legacy import — details not recorded', null,
    ]);
  });
});

describe('getCellRevisionHistory(userId, cellCode, entryDate)', () => {
  it('returns the cell\'s revisions with provenance and its true code label', async () => {
    db.onSelect(timesheetEntries, [
      { ...row({ id: 'r1', chargeCodeId: CELL, chargeCode: 'NAV-1', clinNumber: '0001', contractName: 'NAVAIR', source: 'migration' }) },
      { ...row({ id: 'r2', chargeCodeId: CELL, chargeCode: 'NAV-1', clinNumber: '0001', contractName: 'NAVAIR', revisionNumber: 2, changeReasonCode: 'CORRECTION' }) },
    ]);
    db.onSelect(users, [{ userName: 'Pat' }]);
    const h = (await getCellRevisionHistory(USER, CELL, '2026-09-01' as never))!;
    expect(h).toMatchObject({ cellCode: CELL, kind: 'charge', codeLabel: 'NAV-1', clinNumber: '0001', contractName: 'NAVAIR' });
    expect(h.revisions.map((r) => [r.revisionNumber, r.provenance === null])).toEqual([[1, false], [2, true]]);
  });

  it('a malformed cell code is refused before any query', async () => {
    await expect(getCellRevisionHistory(USER, 'not-a-uuid', '2026-09-01' as never)).rejects.toThrow(/not a valid identifier/);
  });
});

describe('period events in the audit trail (one helper)', () => {
  const ev = (o: Record<string, unknown>) => ({
    periodId: 'p1', event: 'approved', actorId: 'adm', source: 'app', originalMetadata: null, createdAt: new Date('2026-09-20T14:00:00Z'),
    importSourceSystem: null, importedAt: null, approvalContext: null, ...o,
  }) as Parameters<typeof periodEventLabel>[0];
  const names = (id: string) => ({ adm: 'Ann Admin', boss: 'Bo Boss', emp: 'Pat' } as Record<string, string>)[id] ?? null;

  it('submitted / approved by another / rejected', () => {
    expect(periodEventLabel(ev({ event: 'submitted', actorId: 'emp' }), 'emp', names, 'UTC').text).toBe('Submitted by Pat on Sep 20, 2026 2:00 PM UTC');
    expect(periodEventLabel(ev({ actorId: 'boss' }), 'emp', names, 'UTC')).toEqual({ text: 'Approved by Bo Boss on Sep 20, 2026 2:00 PM UTC', selfApproved: false, context: null });
    expect(periodEventLabel(ev({ event: 'rejected', actorId: 'boss' }), 'emp', names, 'UTC').text).toMatch(/^Rejected by Bo Boss/);
  });

  it('self-approval: labelled by the helper, with the recorded context (active admins, last switch-on and by whom)', () => {
    const l = periodEventLabel(ev({ approvalContext: { selfApproved: true, activeAdminCount: 1, selfApprovalEnabledAt: '2026-09-01T10:00:00Z', selfApprovalEnabledBy: 'boss' } }), 'adm', names, 'UTC');
    expect(l.selfApproved).toBe(true);
    expect(l.text).toMatch(/^Self-approved on Sep 20, 2026/);
    expect(l.context).toMatch(/^1 active admin at the time; self-approval on since Sep 1, 2026( UTC)? \(switched on by Bo Boss\)$/);
  });

  it('imported events: labelled with the source system, the file\'s reviewer, and the import date', () => {
    const m = { source: 'migration', importSourceSystem: 'Deltek', importedAt: new Date('2026-01-05T00:00:00Z') };
    expect(periodEventLabel(ev({ ...m, event: 'submitted', originalMetadata: { submittedAt: '2025-12-16' } }), 'emp', names, 'UTC').text)
      .toBe('Submitted in Deltek on 2025-12-16 (imported 2026-01-05)');
    expect(periodEventLabel(ev({ ...m, originalMetadata: { reviewer: 'boss@old', reviewedAt: '2025-12-17' } }), 'emp', names, 'UTC').text)
      .toBe('Approved in Deltek by boss@old on 2025-12-17 (imported 2026-01-05)');
  });

  it('getAuditPeriodEvents labels each event, loading the names of actors and of whoever switched self-approval on', async () => {
    db.onSelect(periodEvents, [{
      id: 'e1', periodId: 'p1', userId: 'adm', userName: 'Ann Admin', periodStart: '2026-09-01', event: 'approved', actorId: 'adm', comment: null,
      createdAt: new Date('2026-09-20T14:00:00Z'), source: 'app', originalMetadata: null, importSourceSystem: null, importedAt: null,
      approvalContext: { activeAdminCount: 1, selfApprovalEnabledAt: '2026-09-01T10:00:00Z', selfApprovalEnabledBy: 'boss' },
    }]);
    db.onSelect(users, [{ id: 'adm', fullName: 'Ann Admin' }, { id: 'boss', fullName: 'Bo Boss' }]);
    const [e] = (await getAuditPeriodEvents({})).events;
    expect(e).toMatchObject({ selfApproved: true, text: expect.stringMatching(/^Self-approved/), context: expect.stringMatching(/switched on by Bo Boss/) });
  });
});

describe('F12 — audit reads', () => {
  const ev = (id: string, periodStart: string, periodNumDays: number | null) => ({
    id, periodId: `p-${id}`, userId: 'adm', userName: 'Ann', periodStart, periodNumDays, event: 'submitted', actorId: 'adm', comment: null,
    createdAt: new Date('2026-09-20T14:00:00Z'), source: 'app', originalMetadata: null, importSourceSystem: null, importedAt: null, approvalContext: null,
  });

  it('entries: 501 rows fetched → 500 shown and truncated = true; 500 → not truncated', async () => {
    db.onSelect(timesheetEntries, Array.from({ length: 501 }, (_, i) => row({ id: `e${i}`, clinId: 'c' })));
    const capped = await getAuditEntries({});
    expect(capped.entries).toHaveLength(500);
    expect(capped.truncated).toBe(true);
    db.reset();
    db.onSelect(timesheetEntries, Array.from({ length: 500 }, (_, i) => row({ id: `e${i}`, clinId: 'c' })));
    expect((await getAuditEntries({})).truncated).toBe(false);
  });

  it('period events: a period that STARTED before the range but overlaps it is included; one that ended before is not', async () => {
    db.onSelect(periodEvents, [ev('in', '2026-09-16', 15), ev('overlap', '2026-08-25', 15), ev('before', '2026-08-01', 15), ev('nosnap', '2026-08-28', null)]);
    const { events } = await getAuditPeriodEvents({ startDate: '2026-09-05' as never, endDate: '2026-09-30' as never });
    expect(events.map((e) => e.id)).toEqual(['in', 'overlap', 'nosnap']); // 08-25 + 15 days covers 09-05..09-08; 08-28 + 15 → 09-11
  });

  it('every id / date input is validated after the guard', async () => {
    await expect(getAuditEntries({ userId: 'x' })).rejects.toThrow(/Employee is not a valid identifier/);
    await expect(getAuditEntries({ clinId: 'x' })).rejects.toThrow(/CLIN is not a valid identifier/);
    await expect(getAuditEntries({ contractId: 'x' })).rejects.toThrow(/Contract is not a valid identifier/);
    await expect(getAuditPeriodEvents({ userId: 'x' })).rejects.toThrow(/Employee is not a valid identifier/);
    await expect(getAuditEntries({ startDate: '2026-02-30' as never })).rejects.toThrow(/not a valid date/);
    await expect(getCellRevisionHistory('x', CELL, '2026-09-01' as never)).rejects.toThrow(/Employee is not a valid identifier/);
  });

  it('static: stable order (created_at, then id) on both queries', () => {
    const audit = readFileSync(path.join(ROOT, 'src/server/actions/audit.ts'), 'utf8');
    expect(audit).toMatch(/\.orderBy\(desc\(timesheetEntries\.createdAt\), desc\(timesheetEntries\.id\)\)/);
    expect(audit).toMatch(/\.orderBy\(desc\(periodEvents\.createdAt\), desc\(periodEvents\.id\)\)/);
    const client = readFileSync(path.join(ROOT, 'src/app/(app)/admin/audit-trail/AuditTrailClient.tsx'), 'utf8');
    expect(client).toMatch(/\{hasSearched && entriesTruncated && \(/);
  });
});

describe('wiring (static)', () => {
  const audit = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/audit.ts'), 'utf8'));
  const client = readFileSync(path.join(ROOT, 'src/app/(app)/admin/audit-trail/AuditTrailClient.tsx'), 'utf8');

  it('the audit queries LEFT JOIN clins / contracts (indirect entries included)', () => {
    const queries = audit.slice(audit.indexOf('export async function getAuditEntries'), audit.indexOf('export async function getAuditPeriodEvents'));
    expect(queries).not.toMatch(/\.innerJoin\(clins/);
    expect(queries).not.toMatch(/\.innerJoin\(contracts/);
    expect(audit.match(/\.leftJoin\(indirectChargeCodes, eq\(timesheetEntries\.indirectCodeId, indirectChargeCodes\.id\)\)/g)).toHaveLength(2);
  });

  it('revision history filters by the true cell code (COALESCE), never by clin_id alone', () => {
    const fn = audit.slice(audit.indexOf('export async function getCellRevisionHistory'), audit.indexOf('export async function getAuditPeriodEvents'));
    expect(fn).toMatch(/eq\(sql<string>`COALESCE\(\$\{timesheetEntries\.chargeCodeId\}, \$\{timesheetEntries\.indirectCodeId\}, \$\{timesheetEntries\.clinId\}\)`, cellCode\)/);
    expect(fn).not.toMatch(/eq\(timesheetEntries\.(clinId|indirectCodeId), (clinId|indirectCodeId)/);
    expect(client).toMatch(/getCellRevisionHistory\(entry\.userId, entry\.cellCode, entry\.entryDate\)/);
  });

  it('the UI labels reasons via REASON_LABELS, imported rows / revisions, and shows period events with their context', () => {
    expect(client).not.toMatch(/REASON_LABEL_MAP/);
    expect(client.match(/reasonLabel\(/g)!.length).toBeGreaterThanOrEqual(2);
    expect(client).toMatch(/data-testid="audit-imported"/);
    expect(client).toMatch(/data-testid="revision-imported"/);
    expect(client).toMatch(/if \(row\.original\.provenance\) return/);
    expect(client).toMatch(/getAuditPeriodEvents\(/);
    expect(client).toMatch(/\{e\.context && /);
  });
});
