import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * SWEEP-FINDINGS.md A1-G4: the v1 API key checks in src/lib/api-auth.ts. A real key that has been revoked or has
 * expired, or whose creator is no longer an active admin, gets a 403 and the route handler never runs. The key is
 * looked up by its SHA-256 only (the raw key never reaches the database). The identical-401 rules are in
 * v1-api-auth.test.ts.
 */

const h = vi.hoisted(() => ({ rows: [] as unknown[], wheres: [] as unknown[], updates: 0 }));
vi.mock('@/lib/tenant/context', () => ({ getTenantState: async () => ({ kind: 'full', tenant: { slug: 'acme', dbUrl: 'postgres://tenant-db' } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('@/db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => { h.wheres.push(w); return chain; },
    limit: async () => h.rows,
  };
  return {
    getDbForUrl: () => ({ select: () => chain, update: () => ({ set: () => ({ where: () => { h.updates++; return Promise.resolve(); } }) }) }),
    getDb: async () => { throw new Error('getDb must not be used by API auth'); },
  };
});

import { handleApiRequest } from '@/lib/api-auth';

const KEY = `byt_${'c'.repeat(48)}`;
const DAY = 86_400_000;
const valid = { id: 'key-1', name: 'k', permissions: 'read', createdByUserId: 'u1', isActive: true, expiresAt: null, creatorRole: 'admin', creatorIsActive: true };

let n = 0;
const req = () => new Request('https://acme.example.com/api/v1/employees', {
  headers: { Authorization: `Bearer ${KEY}`, 'x-forwarded-for': `198.51.100.${(n++ % 250) + 1}` },
});
const handler = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
async function call() {
  const res = await handleApiRequest(req(), handler);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.rows = [valid];
  h.wheres = [];
  h.updates = 0;
  handler.mockClear();
});

describe('A1-G4: v1 API key states', () => {
  it('a valid, active, unexpired key of an active admin → the handler runs (control)', async () => {
    expect((await call()).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['revoked', { isActive: false }, 'API key has been revoked.'],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }, 'API key has expired.'],
    ['created by an admin since demoted to supervisor', { creatorRole: 'supervisor' }, "This API key's creator is no longer an active admin."],
    ['created by an admin since demoted to employee', { creatorRole: 'employee' }, "This API key's creator is no longer an active admin."],
    ['created by an admin since deactivated', { creatorIsActive: false }, "This API key's creator is no longer an active admin."],
  ])('%s → 403 with its message; the handler never runs; lastUsedAt untouched', async (_label, change, error) => {
    h.rows = [{ ...valid, ...change }];
    expect(await call()).toEqual({ status: 403, body: { error } });
    expect(handler).not.toHaveBeenCalled();
    expect(h.updates).toBe(0);
  });

  it('an expiry still in the future is fine', async () => {
    h.rows = [{ ...valid, expiresAt: new Date(Date.now() + DAY) }];
    expect((await call()).status).toBe(200);
  });

  it('the key is looked up by sha256(key) only — the raw key is never sent to the database', async () => {
    await call();
    expect(h.wheres).toHaveLength(1);
    const q = new PgDialect().sqlToQuery(h.wheres[0] as SQL);
    expect(q.sql).toBe('"api_keys"."key_hash" = $1');
    expect(q.params).toEqual([crypto.createHash('sha256').update(KEY).digest('hex')]);
  });
});
