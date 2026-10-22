import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P4 §6 / §9 "v1 API" and "Export route". An unauthenticated caller must never learn
 * whether a workspace exists or is suspended: every auth failure is the ONE identical 401; workspace state is revealed
 * (403 workspace_unavailable) only to a caller holding a valid key; any failure is a generic, logged 500.
 */

type State = { kind: string; tenant?: { slug: string; dbUrl: string } };
const h = vi.hoisted(() => ({
  state: { kind: 'none' } as State,
  keyRows: [] as unknown[],
  keyLookupError: null as Error | null,
  stateError: null as Error | null,
  dbForUrlCalls: [] as string[],
  getDbCalls: 0,
  captured: [] as unknown[],
}));

vi.mock('@/lib/tenant/context', () => ({ getTenantState: async () => { if (h.stateError) throw h.stateError; return h.state; } }));
vi.mock('@sentry/nextjs', () => ({ captureException: (e: unknown) => { h.captured.push(e); } }));

// A minimal drizzle-shaped client: the key lookup (select…limit) and the lastUsedAt update.
function fakeKeyDb() {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: async () => [],
    limit: async () => {
      if (h.keyLookupError) throw h.keyLookupError;
      return h.keyRows;
    },
  };
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}
vi.mock('@/db', () => ({
  getDbForUrl: (url: string) => { h.dbForUrlCalls.push(url); return fakeKeyDb(); },
  getDb: async () => { h.getDbCalls++; return fakeKeyDb(); },
}));

import { GET as employeesGET } from '@/app/api/v1/employees/route';
import { GET as contractsGET } from '@/app/api/v1/contracts/route';

const VALID_KEY = `byt_${'a'.repeat(48)}`;
const tenant = { slug: 'acme-test', dbUrl: 'postgres://tenant-db' };
const validRow = {
  id: 'key-1', name: 'k', permissions: 'read', createdByUserId: 'u1', isActive: true, expiresAt: null,
  creatorRole: 'admin', creatorIsActive: true,
};

let ipCounter = 0;
function req(auth?: string) {
  const headers: Record<string, string> = { 'x-forwarded-for': `198.51.100.${(ipCounter++ % 250) + 1}` };
  if (auth !== undefined) headers.Authorization = auth;
  return new Request('https://acme-test.example.com/api/v1/employees', { headers }) as never;
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), wwwAuth: res.headers.get('WWW-Authenticate') };
}

const INVALID = { status: 401, body: JSON.stringify({ error: 'Invalid API key.' }), wwwAuth: 'Bearer' };

beforeEach(() => {
  h.state = { kind: 'none' };
  h.keyRows = [];
  h.keyLookupError = null;
  h.stateError = null;
  h.dbForUrlCalls = [];
  h.getDbCalls = 0;
  h.captured = [];
});

describe('v1 API: every auth failure is the one identical 401', () => {
  const badHeaders: Array<[string, string | undefined]> = [
    ['no header', undefined],
    ['malformed header', `Token ${VALID_KEY}`],
    ['bad prefix', 'Bearer sk_live_abcdef'],
  ];

  for (const [label, auth] of badHeaders) {
    it(`${label} on an UNKNOWN workspace → identical 401 + WWW-Authenticate`, async () => {
      h.state = { kind: 'unknown' };
      expect(await snapshot(await employeesGET(req(auth)))).toEqual(INVALID);
    });

    it(`${label} on an EXISTING workspace → identical 401 + WWW-Authenticate`, async () => {
      h.state = { kind: 'full', tenant };
      expect(await snapshot(await employeesGET(req(auth)))).toEqual(INVALID);
    });
  }

  it('unknown workspace, closed workspace and bad key → identical 401 body', async () => {
    const results = [];
    for (const kind of ['unknown', 'closed', 'none', 'provisioning', 'mismatch']) {
      h.state = { kind };
      results.push(await snapshot(await employeesGET(req(`Bearer ${VALID_KEY}`))));
    }
    h.state = { kind: 'full', tenant };
    h.keyRows = [];
    results.push(await snapshot(await employeesGET(req(`Bearer ${VALID_KEY}`))));
    for (const r of results) expect(r).toEqual(INVALID);
  });

  it('billing_only + bad key / no key → the same 401 (suspension not revealed)', async () => {
    for (const kind of ['billing_only', 'policy_hold']) {
      h.state = { kind, tenant };
      h.keyRows = [];
      expect(await snapshot(await employeesGET(req(`Bearer ${VALID_KEY}`)))).toEqual(INVALID);
      expect(await snapshot(await employeesGET(req()))).toEqual(INVALID);
    }
  });

  it('billing_only / policy_hold + valid key → 403 workspace_unavailable, handler never runs', async () => {
    for (const kind of ['billing_only', 'policy_hold']) {
      h.state = { kind, tenant };
      h.keyRows = [validRow];
      const res = await employeesGET(req(`Bearer ${VALID_KEY}`));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'workspace_unavailable' });
    }
    expect(h.getDbCalls).toBe(0);
  });

  it('the key is validated against the resolved workspace database, and getDb() is not called before auth', async () => {
    h.state = { kind: 'full', tenant };
    h.keyRows = [];
    await employeesGET(req(`Bearer ${VALID_KEY}`));
    expect(h.dbForUrlCalls).toEqual([tenant.dbUrl]);
    expect(h.getDbCalls).toBe(0);
  });

  it('full / read_only + valid key → 200', async () => {
    for (const kind of ['full', 'read_only']) {
      h.state = { kind, tenant };
      h.keyRows = [validRow];
      const res = await employeesGET(req(`Bearer ${VALID_KEY}`));
      expect(res.status).toBe(200);
    }
  });
});

describe('v1 API: failures are a generic, logged 500', () => {
  it('a DB failure during key lookup → generic 500 + console.error + Sentry', async () => {
    h.state = { kind: 'full', tenant };
    h.keyLookupError = new Error('connection terminated: secret-host:5432');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await contractsGET(req(`Bearer ${VALID_KEY}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(spy).toHaveBeenCalled();
    expect(h.captured).toEqual([h.keyLookupError]);
    spy.mockRestore();
  });

  it('a failure resolving the workspace → generic 500, not an unhandled throw', async () => {
    h.stateError = new Error('control plane unreachable');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await contractsGET(req(`Bearer ${VALID_KEY}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(h.captured).toEqual([h.stateError]);
    spy.mockRestore();
  });
});
