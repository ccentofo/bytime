import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

import { tenantDatabaseName } from '@/lib/tenant/db-name';
import { toDirectConnectionUrl } from '@/lib/tenant/migrate-tenant';
import { createNeonDatabase } from '@/lib/tenant/neon';

describe('tenantDatabaseName', () => {
  it('prefixes the slug', () => {
    expect(tenantDatabaseName('acme')).toBe('tenant_acme');
  });

  it('turns hyphens into underscores (plain unquoted identifier)', () => {
    expect(tenantDatabaseName('acme-corp-east')).toBe('tenant_acme_corp_east');
  });

  it('never exceeds the 63-char Postgres identifier limit', () => {
    expect(tenantDatabaseName('a'.repeat(63)).length).toBeLessThanOrEqual(63);
  });
});

describe('toDirectConnectionUrl', () => {
  it('strips -pooler from a Neon pooled host, keeping credentials, db, and params', () => {
    const pooled = 'postgresql://owner:s3cr%40t@ep-cool-123-pooler.us-east-1.aws.neon.tech/tenant_acme?sslmode=require';
    expect(toDirectConnectionUrl(pooled)).toBe(
      'postgresql://owner:s3cr%40t@ep-cool-123.us-east-1.aws.neon.tech/tenant_acme?sslmode=require'
    );
  });

  it('leaves a direct Neon host unchanged', () => {
    const direct = 'postgresql://owner:pw@ep-cool-123.us-east-1.aws.neon.tech/tenant_acme?sslmode=require';
    expect(toDirectConnectionUrl(direct)).toBe(direct);
  });

  it('leaves local/CI URLs unchanged', () => {
    const local = 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
    expect(toDirectConnectionUrl(local)).toBe(local);
  });

  it('returns unparseable input unchanged instead of throwing', () => {
    expect(toDirectConnectionUrl('not a url')).toBe('not a url');
  });
});

describe('createNeonDatabase (Neon API mocked)', () => {
  const DIRECT_HOST = 'ep-cool-123.us-east-1.aws.neon.tech';
  const POOLER_HOST = 'ep-cool-123-pooler.us-east-1.aws.neon.tech';

  const createResponse = (overrides: Record<string, unknown> = {}) => ({
    project: { id: 'proj-1' },
    operations: [{ id: 'op-1', action: 'create_timeline', status: 'running' }],
    connection_uris: [{
      connection_uri: `postgresql://owner:pw@${DIRECT_HOST}/tenant_acme?sslmode=require`,
      connection_parameters: { host: DIRECT_HOST, pooler_host: POOLER_HOST, database: 'tenant_acme', role: 'owner' },
    }],
    ...overrides,
  });

  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('NEON_API_KEY', 'test-key');
    vi.stubEnv('NEON_REGION_ID', 'aws-us-east-1');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends region, tenant database name, and cadenzpoint- prefix; waits for operations; returns the pooled URL', async () => {
    fetchMock
      .mockReturnValueOnce(json(createResponse()))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', status: 'running' } }))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', status: 'finished' } }));

    const promise = createNeonDatabase('acme');
    await vi.runAllTimersAsync();
    const { dbUrl: url, neonProjectId } = await promise;

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('https://console.neon.tech/api/v2/projects');
    const body = JSON.parse(createInit.body);
    expect(body.project.name).toBe('cadenzpoint-acme');
    expect(body.project.region_id).toBe('aws-us-east-1');
    expect(body.project.branch.database_name).toBe('tenant_acme');

    // Polled the operation until it finished (running → finished).
    expect(fetchMock.mock.calls[1][0]).toBe('https://console.neon.tech/api/v2/projects/proj-1/operations/op-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(neonProjectId).toBe('proj-1');
    expect(new URL(url).hostname).toBe(POOLER_HOST);
    expect(url).toContain('/tenant_acme');
    expect(url).toContain('sslmode=require');
  });

  it('omits region_id when NEON_REGION_ID is unset', async () => {
    vi.stubEnv('NEON_REGION_ID', '');
    fetchMock
      .mockReturnValueOnce(json(createResponse()))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', status: 'finished' } }));

    await createNeonDatabase('acme');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.project).not.toHaveProperty('region_id');
  });

  it('fails with the project id when a setup operation errors', async () => {
    fetchMock
      .mockReturnValueOnce(json(createResponse()))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', action: 'start_compute', status: 'error', error: 'boom' } }));

    await expect(createNeonDatabase('acme')).rejects.toThrow(/proj-1.*start_compute error: boom/);
  });

  it('keeps waiting while a failed operation is scheduled for retry', async () => {
    fetchMock
      .mockReturnValueOnce(json(createResponse()))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', status: 'failed', retry_at: '2026-01-01T00:00:00Z' } }))
      .mockReturnValueOnce(json({ operation: { id: 'op-1', status: 'finished' } }));

    const promise = createNeonDatabase('acme');
    await vi.runAllTimersAsync();
    const { dbUrl } = await promise;
    expect(dbUrl).toContain(POOLER_HOST);
  });

  it('fails clearly when the response lacks a pooler host', async () => {
    fetchMock.mockReturnValueOnce(json(createResponse({ connection_uris: [{ connection_uri: 'postgresql://x@h/db' }] })));
    await expect(createNeonDatabase('acme')).rejects.toThrow(/proj-1.*pooler_host/);
  });

  it('surfaces Neon API errors on project creation', async () => {
    fetchMock.mockReturnValueOnce(json({ message: 'quota exceeded' }, 422));
    await expect(createNeonDatabase('acme')).rejects.toThrow(/Neon project creation failed: 422/);
  });
});
