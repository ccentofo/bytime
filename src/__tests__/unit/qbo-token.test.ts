import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-launch-hardening.md H6. T21: the token fetch is bounded by an AbortSignal, and a timeout or a network
 * failure (during the fetch or the body read) surfaces "QuickBooks didn't respond…" while HTTP errors keep their mapping.
 * T22 (guard): a valid token takes the fast path without a transaction; a read-only workspace still throws before Intuit
 * is called.
 */

const h = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  transaction: vi.fn(),
  writeDb: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/encryption', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
vi.mock('@/db', () => ({
  getDb: async () => ({ select: () => ({ from: () => ({ where: async () => (h.row ? [h.row] : []) }) }) }),
  getDbForWrite: async () => { h.writeDb(); return { transaction: h.transaction }; },
}));

import { ensureValidToken, refreshQBOToken } from '@/lib/integrations/connectors/qbo-api';
import { WorkspaceReadOnlyError } from '@/lib/errors';

const NO_RESPONSE = 'QuickBooks didn’t respond. Try again in a minute.';
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  h.transaction.mockReset();
  h.writeDb.mockReset();
  h.row = null;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('QBO_CLIENT_ID', 'client-id');
  vi.stubEnv('QBO_CLIENT_SECRET', 'client-secret');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('refreshQBOToken (T21)', () => {
  it('(a) fetch receives an AbortSignal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 }));
    await expect(refreshQBOToken('old')).resolves.toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('(b) a TimeoutError → "QuickBooks didn’t respond…"', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(refreshQBOToken('old')).rejects.toThrow(NO_RESPONSE);
  });

  it('(c) a TypeError (network failure) → "QuickBooks didn’t respond…"', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(refreshQBOToken('old')).rejects.toThrow(NO_RESPONSE);
  });

  it('(d) the body read is covered too: a timeout while reading the JSON → the same message', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
    await expect(refreshQBOToken('old')).rejects.toThrow(NO_RESPONSE);
  });

  it('HTTP errors keep the existing mapping (400 → reconnect)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(refreshQBOToken('old')).rejects.toThrow(/QuickBooks connection has expired/);
  });
});

describe('ensureValidToken fast path (T22 guard)', () => {
  const qboRow = (expiresAt: Date) => ({
    provider: 'quickbooks_online', isActive: true, accessTokenEncrypted: 'enc:valid-access', refreshTokenEncrypted: 'enc:refresh', tokenExpiresAt: expiresAt,
  });

  it('a token valid for more than 5 minutes returns without a write client or a transaction', async () => {
    h.row = qboRow(new Date(Date.now() + 60 * 60_000));
    await expect(ensureValidToken('c1')).resolves.toBe('valid-access');
    expect(h.writeDb).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('read-only mode: an expiring token throws from the write client before Intuit is called', async () => {
    h.row = qboRow(new Date(Date.now() + 60_000));
    h.writeDb.mockImplementation(() => { throw new WorkspaceReadOnlyError('This workspace is read-only.'); });
    await expect(ensureValidToken('c1')).rejects.toBeInstanceOf(WorkspaceReadOnlyError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
