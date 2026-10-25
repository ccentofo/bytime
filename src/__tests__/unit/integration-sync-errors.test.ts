import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-blockers audit R7 (A5-class): a DB error during an integration sync must not put SQL or its params into
 * `integration_sync_logs.error_summary` (shown in the admin UI and the workspace export) or the per-record errors.
 * A Drizzle error's message is "Failed query: <sql> params: <…>". Both paths: the Gusto connector's per-record catch
 * (summarised by the engine as "First error: …") and the engine's own catch.
 */

const DB_ERROR = new Error('Failed query: insert into "integration_sync_records" ("sync_log_id", "request_payload") values ($1, $2)\nparams: log-1,{"secret":"s3cr3t-param"}');

const h = vi.hoisted(() => ({
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  failInsertInto: null as unknown,
  failSelectFrom: null as unknown,
  selects: new Map<unknown, unknown[]>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', () => {
  const thenable = (run: () => unknown) => {
    const p: Record<string, unknown> = {};
    for (const k of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'returning', 'onConflictDoNothing', 'onConflictDoUpdate']) p[k] = () => p;
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
    return p;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => thenable(() => {
        if (table === h.failSelectFrom) throw DB_ERROR;
        return h.selects.get(table) ?? [];
      }),
    }),
    insert: (table: unknown) => ({
      values: () => thenable(() => {
        if (table === h.failInsertInto) throw DB_ERROR;
        return [{ id: 'log-1' }];
      }),
    }),
    update: (table: unknown) => ({ set: (set: Record<string, unknown>) => { h.updates.push({ table, set }); return thenable(() => []); } }),
  };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

import { integrationConnections, integrationEntityMappings, integrationSyncLogs, integrationSyncRecords, workspaceSettings } from '@/db/schema';
import { gustoConnector } from '@/lib/integrations/connectors/gusto';
import { executeSyncOperation } from '@/lib/integrations/sync-engine';
import type { PayrollSyncInput, SyncContext } from '@/lib/integrations/types';

const leaks = (s: unknown) => /Failed query|params:|insert into|s3cr3t/i.test(String(s));

beforeEach(() => {
  h.updates = [];
  h.failInsertInto = null;
  h.failSelectFrom = null;
  h.selects = new Map();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('integration sync errors are sanitised (audit R7)', () => {
  it('Gusto connector: a DB error writing a sync record → a generic per-record error, no SQL/params', async () => {
    h.failInsertInto = integrationSyncRecords;
    const context = { connectionId: 'c1', syncLogId: 'log-1', accessToken: '', externalCompanyId: 'co', mappings: new Map([['employee', new Map([['u1', 'g1']])]]) } as SyncContext;
    // certified-outputs C7: the Gusto connector records FLSA payroll totals (pushPayroll), not raw entries.
    const payroll = { periodStart: '2026-10-01', periodEnd: '2026-10-15', employees: [{ userId: 'u1', employeeName: 'Pat Doe', regularHours: 8, overtimeHours: 0, ptoHours: 0, sickHours: 0, holidayHours: 0, uncompensatedOvertimeHours: 0, flagged: false }] } as unknown as PayrollSyncInput;
    const result = await gustoConnector.pushPayroll!(context, payroll);
    expect(result.failed).toBe(1);
    expect(result.pushed).toBe(0); // fix round 1 F10: a failed record is not also counted as pushed
    expect(result.errors).toEqual([{ bytimeEntityId: 'u1', error: 'Could not sync this employee.' }]);
    expect(result.errors.some((e) => leaks(e.error))).toBe(false);
  });

  it('sync engine: a DB error mid-sync → error_summary is generic, no SQL/params (the error is still rethrown)', async () => {
    h.selects.set(integrationConnections, [{ id: 'c1', provider: 'gusto', isActive: true, accessTokenEncrypted: null, externalCompanyId: 'co' }]);
    h.selects.set(workspaceSettings, [{ day: 1 }]); // C7: the workweek start day is set (else refused before any log)
    h.failSelectFrom = integrationEntityMappings;
    await expect(executeSyncOperation('c1', 'timesheet_push', '2026-10-01' as never, '2026-10-15' as never, 'admin-1')).rejects.toBe(DB_ERROR);
    const log = h.updates.find((u) => u.table === integrationSyncLogs);
    expect(log?.set).toMatchObject({ status: 'failed', errorSummary: 'The sync failed.' });
    expect(leaks(log?.set.errorSummary)).toBe(false);
  });
});
