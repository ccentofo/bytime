import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { classifyDatabase } from '@/lib/tenant/delete-tenant';
import { deleteNeonProjectVerified, directNeonHost } from '@/lib/tenant/neon';

/**
 * feature-plan-terms-compliance-fixes.md §5.3 steps 2 and 5: what kind of database a tenant URL points at decides
 * how (and whether) it may be destroyed. Every refusal happens before any change.
 */

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

describe('classifyDatabase (§5.3 step 2, in order)', () => {
  beforeEach(() => {
    delete process.env.DEV_TENANT_ADMIN_DATABASE_URL;
  });

  it('local first: a loopback tenant is local even though the control plane is local too', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@localhost:5432/bytime_control';
    // Same host string as the control plane: a shared-project check run first would wrongly refuse it.
    const c = classifyDatabase('postgresql://u:p@localhost:5432/tenant_throwaway', { neonProjectId: null }, {});
    expect(c).toMatchObject({ kind: 'local', dbName: 'tenant_throwaway' });
  });

  it('local: refuses the control-plane / admin / postgres databases', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@localhost:5432/bytime_control';
    for (const name of ['bytime_control', 'postgres', 'template1']) {
      expect(() => classifyDatabase(`postgresql://u:p@localhost:5432/${name}`, { neonProjectId: null }, {})).toThrow(/protected/);
    }
  });

  it('local: refuses a different server than the admin connection', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@localhost:5432/bytime_control';
    expect(() => classifyDatabase('postgresql://u:p@localhost:5433/tenant_x', { neonProjectId: null }, {})).toThrow(/differs/);
  });

  it('shared-project: refused without --drop-shared-database; allowed with it on the direct host', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/cadenzpoint_control';
    const url = 'postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/tenant_acme';
    expect(() => classifyDatabase(url, { neonProjectId: null }, {})).toThrow(/CONTROL PLANE/);
    const c = classifyDatabase(url, { neonProjectId: null }, { dropSharedDatabase: true });
    expect(c.kind).toBe('shared-project');
    if (c.kind === 'shared-project') {
      expect(new URL(c.adminUrl).hostname).toBe('ep-cool-123.us-east-2.aws.neon.tech');
      expect(new URL(c.adminUrl).pathname).toBe('/cadenzpoint_control');
      expect(c.dbName).toBe('tenant_acme');
    }
  });

  it('shared-project: never drops the control-plane database itself', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/cadenzpoint_control';
    expect(() => classifyDatabase('postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/cadenzpoint_control', { neonProjectId: null }, { dropSharedDatabase: true })).toThrow(/protected/);
  });

  it('dedicated Neon project when neon_project_id is recorded', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@ep-cp-1.us-east-2.aws.neon.tech/cadenzpoint_control';
    const c = classifyDatabase('postgresql://u:p@ep-tenant-9-pooler.us-east-2.aws.neon.tech/tenant_acme', { neonProjectId: 'proj-abc' }, {});
    expect(c).toMatchObject({ kind: 'neon-project', projectId: 'proj-abc' });
  });

  it('anything else fails before any change', () => {
    process.env.CONTROL_PLANE_DATABASE_URL = 'postgresql://u:p@ep-cp-1.us-east-2.aws.neon.tech/cadenzpoint_control';
    expect(() => classifyDatabase('postgresql://u:p@db.example.com/tenant_acme', { neonProjectId: null }, {})).toThrow(/Cannot classify/);
  });
});

describe('deleteNeonProjectVerified (§5.3 step 5 preflight)', () => {
  beforeEach(() => {
    process.env.NEON_API_KEY = 'test-key';
  });

  function mockFetch(responses: Record<string, Array<{ status: number; body?: unknown }>>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      const key = `${init?.method ?? 'GET'} ${url.replace('https://console.neon.tech/api/v2', '')}`;
      calls.push(key);
      const queue = responses[key];
      const r = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!r) throw new Error(`unexpected fetch ${key}`);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }));
    return calls;
  }

  const input = { projectId: 'proj-1', tenantHost: 'ep-t-1-pooler.us-east-2.aws.neon.tech', controlPlaneHost: 'ep-cp-1.us-east-2.aws.neon.tech' };

  it('deletes after the endpoint matches and confirms 404', async () => {
    const calls = mockFetch({
      'GET /projects/proj-1': [{ status: 200, body: { project: { id: 'proj-1' } } }, { status: 404 }],
      'GET /projects/proj-1/endpoints': [{ status: 200, body: { endpoints: [{ host: 'ep-t-1.us-east-2.aws.neon.tech' }] } }],
      'DELETE /projects/proj-1': [{ status: 200, body: {} }],
    });
    await expect(deleteNeonProjectVerified(input)).resolves.toEqual({ alreadyDeleted: false });
    expect(calls).toContain('DELETE /projects/proj-1');
  });

  it('refuses when no endpoint matches the tenant URL host (never deletes)', async () => {
    const calls = mockFetch({
      'GET /projects/proj-1': [{ status: 200, body: {} }],
      'GET /projects/proj-1/endpoints': [{ status: 200, body: { endpoints: [{ host: 'ep-other.us-east-2.aws.neon.tech' }] } }],
    });
    await expect(deleteNeonProjectVerified(input)).rejects.toThrow(/no endpoint/);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('refuses the control plane\'s project (never deletes)', async () => {
    const calls = mockFetch({
      'GET /projects/proj-1': [{ status: 200, body: {} }],
      'GET /projects/proj-1/endpoints': [{ status: 200, body: { endpoints: [{ host: 'ep-t-1.us-east-2.aws.neon.tech' }, { host: 'ep-cp-1-pooler.us-east-2.aws.neon.tech' }] } }],
    });
    await expect(deleteNeonProjectVerified(input)).rejects.toThrow(/CONTROL PLANE/);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('a 404 at preflight means a previous run already deleted it (resume)', async () => {
    mockFetch({ 'GET /projects/proj-1': [{ status: 404 }] });
    await expect(deleteNeonProjectVerified(input)).resolves.toEqual({ alreadyDeleted: true });
  });

  it('directNeonHost strips only the -pooler suffix of the first label', () => {
    expect(directNeonHost('ep-a-1-pooler.us-east-2.aws.neon.tech')).toBe('ep-a-1.us-east-2.aws.neon.tech');
    expect(directNeonHost('ep-a-1.us-east-2.aws.neon.tech')).toBe('ep-a-1.us-east-2.aws.neon.tech');
  });
});
