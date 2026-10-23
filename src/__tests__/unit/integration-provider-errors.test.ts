import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Launch-blockers audit R9 (and its ruling): provider failures stay actionable. A QuickBooks sync refreshes its token
 * (if due) after the `running` sync-log row and before the push; a refresh 400/401 or a 401 from any QuickBooks/Gusto
 * call → "connection has expired — reconnect"; any other HTTP failure → the status only. The response body never
 * reaches the sync log or the action result. Driven through the real actions with `fetch` stubbed.
 */

const PROVIDER_BODY = 'provider-secret-body {"error":"invalid_grant","detail":"refresh token revoked for realm 9130"}';
const RECONNECT = 'Your QuickBooks connection has expired — reconnect it on the Integrations page.';

const h = vi.hoisted(() => ({
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  selects: new Map<unknown, unknown[]>(),
  fetches: [] as Array<{ url: string; authorization: string | null }>,
  refresh: { status: 200, body: '' },
  batch: { status: 200, body: '' },
  gusto: { status: 200, body: '[]' },
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'pat@acme.com', fullName: 'Pat', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin, requireApprover: admin, requireApproverFresh: admin };
});
vi.mock('@/lib/encryption', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
vi.mock('@/server/internal/pay-period-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/pay-period-config')>()),
  existingPeriodLength: async () => 15,
}));
vi.mock('@/db', () => {
  const thenable = (run: () => unknown) => {
    const p: Record<string, unknown> = {};
    for (const k of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'returning', 'onConflictDoNothing', 'onConflictDoUpdate']) p[k] = () => p;
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
    return p;
  };
  const db = {
    select: () => ({ from: (table: unknown) => thenable(() => h.selects.get(table) ?? []) }),
    insert: () => ({ values: () => thenable(() => [{ id: 'log-1' }]) }),
    update: (table: unknown) => ({ set: (set: Record<string, unknown>) => { h.updates.push({ table, set }); return thenable(() => []); } }),
  };
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db };
});

import { integrationConnections, integrationEntityMappings, integrationSyncLogs, timesheetEntries, timesheetPeriods } from '@/db/schema';
import { triggerQBOSync, fetchQBOEmployeesForMapping } from '@/server/actions/qbo';
import { fetchGustoEmployeesForMapping } from '@/server/actions/gusto';

const HOUR = 3_600_000;
const connection = (tokenExpiresAt: Date) => ({
  id: 'c1', provider: 'quickbooks_online', isActive: true, externalCompanyId: 'realm-1',
  accessTokenEncrypted: 'enc:old-access', refreshTokenEncrypted: 'enc:old-refresh', tokenExpiresAt,
});
const sync = () => triggerQBOSync({ connectionId: 'c1', periodStart: '2026-10-01' as never, periodEnd: '2026-10-15' as never });
const syncLog = () => h.updates.find((u) => u.table === integrationSyncLogs)?.set;
const batchOk = JSON.stringify({ BatchItemResponse: [{ bId: '0', TimeActivity: { Id: 'ta-1' } }] });

beforeEach(() => {
  h.updates = [];
  h.fetches = [];
  h.refresh = { status: 200, body: JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) };
  h.batch = { status: 200, body: batchOk };
  h.gusto = { status: 200, body: '[]' };
  h.selects = new Map<unknown, unknown[]>([
    [timesheetPeriods, [{ userId: 'u1', periodStart: '2026-10-01', periodNumDays: 15, approvedAt: new Date() }]],
    [timesheetEntries, [{
      userId: 'u1', employeeName: 'Pat Doe', employeeEmail: 'pat@acme.com', entryDate: '2026-10-02', hours: '8',
      clinId: null, indirectCodeId: 'ic1', clinNumber: null, contractId: null, contractNumber: null, contractName: null,
      indirectCode: 'OH', indirectName: 'Overhead',
    }]],
    [integrationEntityMappings, [{ entityType: 'employee', bytimeEntityId: 'u1', externalEntityId: 'qbo-emp-1' }]],
  ]);
  vi.stubEnv('QBO_CLIENT_ID', 'cid');
  vi.stubEnv('QBO_CLIENT_SECRET', 'csecret');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    h.fetches.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    const r = url.includes('oauth2/v1/tokens/bearer') ? h.refresh : url.includes('/batch') ? h.batch : url.includes('gusto') ? h.gusto : { status: 404, body: 'unexpected' };
    return new Response(r.body, { status: r.status });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('QuickBooks sync: provider errors stay actionable (audit R9)', () => {
  it('(1) expired token, refresh → 401: sync log and action result say reconnect; no response body anywhere', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() - HOUR))]);
    h.refresh = { status: 401, body: PROVIDER_BODY };
    const result = await sync();
    expect(result).toEqual({ ok: false, code: 'validation', error: RECONNECT });
    expect(syncLog()).toMatchObject({ status: 'failed', errorSummary: RECONNECT });
    expect(JSON.stringify([result, h.updates.map((u) => u.set)])).not.toMatch(/provider-secret-body|invalid_grant|9130/);
    expect(h.fetches.some((f) => f.url.includes('/batch'))).toBe(false); // nothing pushed
  });

  it('(2) valid token, batch → 500: the HTTP-status message (status only, no body)', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() + HOUR))]);
    h.batch = { status: 500, body: PROVIDER_BODY };
    const result = await sync();
    const message = 'QuickBooks returned an error (HTTP 500). Try again; if it keeps happening, reconnect the integration.';
    expect(result).toEqual({ ok: false, code: 'validation', error: message });
    expect(syncLog()).toMatchObject({ status: 'failed', errorSummary: message });
    expect(JSON.stringify([result, h.updates.map((u) => u.set)])).not.toMatch(/provider-secret-body|invalid_grant|9130/);
    expect(h.fetches.some((f) => f.url.includes('oauth2/v1/tokens/bearer'))).toBe(false); // not due: no refresh
  });

  it('a 401 from the batch call (right after a valid token) → reconnect', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() + HOUR))]);
    h.batch = { status: 401, body: PROVIDER_BODY };
    expect(await sync()).toEqual({ ok: false, code: 'validation', error: RECONNECT });
    expect(syncLog()).toMatchObject({ errorSummary: RECONNECT });
  });

  it('(3) expired token, refresh succeeds → the push uses the NEW token, tokens are stored, the sync succeeds', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() - HOUR))]);
    const result = await sync();
    expect(result).toMatchObject({ ok: true, data: { syncLogId: 'log-1', result: { pushed: 1, failed: 0 } } });
    const batchCall = h.fetches.find((f) => f.url.includes('/batch'));
    expect(batchCall?.authorization).toBe('Bearer new-access');
    expect(h.updates.find((u) => u.table === integrationConnections && 'accessTokenEncrypted' in u.set)?.set)
      .toMatchObject({ accessTokenEncrypted: 'enc:new-access', refreshTokenEncrypted: 'enc:new-refresh' });
    expect(syncLog()).toMatchObject({ status: 'success', recordsPushed: 1 });
  });

  it('an inactive / missing connection → "disconnected — reconnect"', async () => {
    h.selects.set(integrationConnections, [{ ...connection(new Date()), isActive: false }]);
    expect(await sync()).toEqual({ ok: false, code: 'validation', error: 'This integration is disconnected — reconnect it on the Integrations page.' });
  });
});

describe('mapping actions (audit R9)', () => {
  it('(4) a mapping action whose refresh returns 401 → the reconnect message in its result, no body', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() - HOUR))]);
    h.refresh = { status: 401, body: PROVIDER_BODY };
    const result = await fetchQBOEmployeesForMapping('c1');
    expect(result).toEqual({ ok: false, code: 'validation', error: RECONNECT });
  });

  it('refresh 400 (invalid_grant) → reconnect too; other refresh failures → the HTTP-status message', async () => {
    h.selects.set(integrationConnections, [connection(new Date(Date.now() - HOUR))]);
    h.refresh = { status: 400, body: PROVIDER_BODY };
    expect(await fetchQBOEmployeesForMapping('c1')).toEqual({ ok: false, code: 'validation', error: RECONNECT });
    h.refresh = { status: 503, body: PROVIDER_BODY };
    expect(await fetchQBOEmployeesForMapping('c1')).toEqual({
      ok: false, code: 'validation', error: 'QuickBooks returned an error (HTTP 503). Try again; if it keeps happening, reconnect the integration.',
    });
  });

  it('Gusto: a 401 from an API call → "Your Gusto connection has expired — reconnect"; a 502 → the status message', async () => {
    h.selects.set(integrationConnections, [{ ...connection(new Date(Date.now() + HOUR)), provider: 'gusto' }]);
    h.gusto = { status: 401, body: PROVIDER_BODY };
    expect(await fetchGustoEmployeesForMapping('c1')).toEqual({
      ok: false, code: 'validation', error: 'Your Gusto connection has expired — reconnect it on the Integrations page.',
    });
    h.gusto = { status: 502, body: PROVIDER_BODY };
    expect(await fetchGustoEmployeesForMapping('c1')).toEqual({
      ok: false, code: 'validation', error: 'Gusto returned an error (HTTP 502). Try again; if it keeps happening, reconnect the integration.',
    });
  });
});
