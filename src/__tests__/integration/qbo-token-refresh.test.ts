import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { encrypt, decrypt } from '@/lib/encryption';
import { getTestDb, createTestUser, cleanupTestData } from './helpers';

/**
 * feature-plan-launch-hardening.md H6 (§8b): one QuickBooks token refresh at a time per connection.
 * The network is stubbed with vi.stubGlobal('fetch') keyed on Intuit's token URL (ensureValidToken calls refreshQBOToken
 * inside its own module, so vi.mock can't intercept it). The test database has ONE connection (setup-db.ts, max 1), so
 * concurrency is proven with separate postgres-js clients: a holder of the advisory lock, an observer of pg_locks, and a
 * second writer whose changes run from INSIDE the fetch stub (the refresh transaction holds no row lock until its update).
 */

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  getDb: async () => getTestDb(),
  getDbForAuth: async () => getTestDb(),
  getDbForUrl: () => getTestDb(),
  getDbForWrite: async () => getTestDb(),
}));

import { ensureValidToken } from '@/lib/integrations/connectors/qbo-api';
import { saveIntegrationConnection } from '@/server/internal/integrations';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const URL_ = process.env.TEST_DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const EXPIRED = () => new Date(Date.now() - 60_000);
const VALID = () => new Date(Date.now() + 60 * 60_000);
const EXPIRED_MSG = /QuickBooks connection has expired/;

const h = vi.hoisted(() => ({
  fetches: 0,
  /** Runs inside the stubbed token call, before it answers (concurrent changes go here). */
  during: null as null | (() => Promise<void>),
  /** Makes the stubbed token call fail instead of answering. */
  fail: null as null | Error,
}));

let adminId: string;
let connectionId: string;
let second: ReturnType<typeof postgres>;

async function connection(over: Partial<typeof schema.integrationConnections.$inferInsert> = {}) {
  const [c] = await getTestDb().insert(schema.integrationConnections).values({
    provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', connectedBy: adminId, externalCompanyId: 'realm-1', isActive: true,
    accessTokenEncrypted: encrypt('old-access'), refreshTokenEncrypted: encrypt('old-refresh'), tokenExpiresAt: EXPIRED(), ...over,
  }).returning();
  return c.id;
}
async function row(id = connectionId) {
  const [r] = await getTestDb().select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, id));
  return {
    isActive: r.isActive,
    access: r.accessTokenEncrypted ? decrypt(r.accessTokenEncrypted) : null,
    refresh: r.refreshTokenEncrypted ? decrypt(r.refreshTokenEncrypted) : null,
    expiresAt: r.tokenExpiresAt,
  };
}
/** Waits (via the observer) until some session is waiting on the advisory lock the holder transaction holds. */
async function waitUntilBlocked(holderTx: postgres.TransactionSql, observer: ReturnType<typeof postgres>, settled: () => boolean) {
  const [key] = await holderTx<{ classid: string; objid: string }[]>`
    SELECT classid::text, objid::text FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`;
  for (let i = 0; ; i++) {
    const [{ w }] = await observer<{ w: number }[]>`
      SELECT count(*)::int AS w FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid::text = ${key.classid} AND objid::text = ${key.objid}`;
    if (w >= 1) return;
    // Without the lock the call finishes (or fetches) instead of waiting, and this fails.
    if (settled() || i > 200) throw new Error(`ensureValidToken never waited on the token lock (settled: ${settled()})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  await cleanupTestData();
  adminId = (await createTestUser({ role: 'admin' })).id;
  connectionId = await connection();
  h.fetches = 0;
  h.during = null;
  h.fail = null;
  vi.stubEnv('QBO_CLIENT_ID', 'client-id');
  vi.stubEnv('QBO_CLIENT_SECRET', 'client-secret');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url) !== TOKEN_URL) throw new Error(`unexpected fetch: ${String(url)}`);
    h.fetches++;
    if (h.during) await h.during();
    if (h.fail) throw h.fail;
    return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  second = postgres(URL_, { max: 1 });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await second.end({ timeout: 1 });
  await cleanupTestData();
});

describe('ensureValidToken: one refresh at a time (H6)', () => {
  it('T18: waits for the integration-token lock; after release exactly one token fetch, and the new pair is stored', async () => {
    const holder = postgres(URL_, { max: 1 });
    const observer = postgres(URL_, { max: 1 });
    let settled = false;
    try {
      let call: Promise<string> | undefined;
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'integration-token:' + connectionId}))`;
        call = ensureValidToken(connectionId).finally(() => { settled = true; });
        await waitUntilBlocked(tx, observer, () => settled);
        expect(settled).toBe(false);
        expect(h.fetches).toBe(0);
      });
      expect(await call).toBe('new-access');
      expect(h.fetches).toBe(1);
      expect(await row()).toMatchObject({ isActive: true, access: 'new-access', refresh: 'new-refresh' });
      expect((await row()).expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    } finally {
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  it('T20: the re-read wins — another request stored a valid token while this one waited → that token, no fetch', async () => {
    const holder = postgres(URL_, { max: 1 });
    const observer = postgres(URL_, { max: 1 });
    let settled = false;
    try {
      let call: Promise<string> | undefined;
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'integration-token:' + connectionId}))`;
        call = ensureValidToken(connectionId).finally(() => { settled = true; });
        await waitUntilBlocked(tx, observer, () => settled);
        // As the request that held the lock would: store a freshly refreshed pair, then commit (releasing the lock).
        await tx`UPDATE integration_connections SET access_token_encrypted = ${encrypt('fresh-access')}, refresh_token_encrypted = ${encrypt('fresh-refresh')},
          token_expires_at = ${VALID().toISOString()}::timestamptz WHERE id = ${connectionId}`;
      });
      expect(await call).toBe('fresh-access');
      expect(h.fetches).toBe(0);
      expect(await row()).toMatchObject({ access: 'fresh-access', refresh: 'fresh-refresh' });
    } finally {
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  it('T19a: the re-read finds the row deactivated (a disconnect won while waiting) → reconnect error, no fetch, no write', async () => {
    const holder = postgres(URL_, { max: 1 });
    const observer = postgres(URL_, { max: 1 });
    let settled = false;
    try {
      let call: Promise<string> | undefined;
      await holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'integration-token:' + connectionId}))`;
        call = ensureValidToken(connectionId).finally(() => { settled = true; });
        call.catch(() => {}); // asserted below
        await waitUntilBlocked(tx, observer, () => settled);
        await tx`UPDATE integration_connections SET is_active = false, access_token_encrypted = NULL, refresh_token_encrypted = NULL WHERE id = ${connectionId}`;
      });
      await expect(call!).rejects.toThrow(EXPIRED_MSG);
      expect(h.fetches).toBe(0);
      expect(await row()).toMatchObject({ isActive: false, access: null, refresh: null });
    } finally {
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  });

  it('T19b: the row is deactivated DURING the refresh → 0 rows, reconnect error, the tokens stay cleared', async () => {
    h.during = async () => {
      await second`UPDATE integration_connections SET is_active = false, access_token_encrypted = NULL, refresh_token_encrypted = NULL,
        disconnected_at = now() WHERE id = ${connectionId}`;
    };
    await expect(ensureValidToken(connectionId)).rejects.toThrow(EXPIRED_MSG);
    expect(h.fetches).toBe(1);
    expect(await row()).toMatchObject({ isActive: false, access: null, refresh: null });
  });

  it('T19c: the SAME row is reconnected (new tokens) during the refresh → 0 rows, reconnect error, the reconnect\'s tokens survive', async () => {
    h.during = async () => {
      // The usual reconnect: same provider + company id → the existing row is reused with the new tokens (I9).
      const { id } = await saveIntegrationConnection(drizzle(second, { schema }) as never, adminId, {
        provider: 'quickbooks_online', displayName: 'QuickBooks — Acme', externalCompanyId: 'realm-1',
        accessToken: 'reconnect-access', refreshToken: 'reconnect-refresh', tokenExpiresAt: VALID(),
      });
      expect(id).toBe(connectionId);
    };
    await expect(ensureValidToken(connectionId)).rejects.toThrow(EXPIRED_MSG);
    expect(h.fetches).toBe(1);
    expect(await row()).toMatchObject({ isActive: true, access: 'reconnect-access', refresh: 'reconnect-refresh' });
  });

  it('T21 (no write): a timeout or a network failure surfaces "QuickBooks didn’t respond…" and the stored pair is unchanged', async () => {
    for (const failure of [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new TypeError('fetch failed')]) {
      h.fail = failure;
      await expect(ensureValidToken(connectionId)).rejects.toThrow('QuickBooks didn’t respond. Try again in a minute.');
      expect(await row()).toMatchObject({ isActive: true, access: 'old-access', refresh: 'old-refresh' });
    }
  });

  it('T21b: a Gusto id (valid token: fast path; expired: refresh path) and an inactive QuickBooks row → reconnect error, no fetch', async () => {
    const gustoValid = await connection({ provider: 'gusto', displayName: 'Gusto', externalCompanyId: 'g-1', tokenExpiresAt: VALID() });
    const gustoExpired = await connection({ provider: 'gusto', displayName: 'Gusto 2', externalCompanyId: 'g-2', tokenExpiresAt: EXPIRED() });
    const inactiveValid = await connection({ externalCompanyId: 'realm-2', isActive: false, tokenExpiresAt: VALID() });
    for (const id of [gustoValid, gustoExpired, inactiveValid]) {
      await expect(ensureValidToken(id)).rejects.toThrow(EXPIRED_MSG);
    }
    expect(h.fetches).toBe(0);
  });
});
